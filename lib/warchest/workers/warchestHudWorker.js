#!/usr/bin/env node
'use strict';

// lib/warchest/workers/warchestHudWorker.js
// Long-running HUD worker: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain simple state, and render a
// multi-wallet dashboard in the terminal.
//
// NOTE: v1 stops before metadata/price pulls. Tokens/prices are stubbed.

require('dotenv').config({ quiet: true });

const logger = require('../../logger');
const { updateFromSlotEvent } = require('../../solana/rpcMethods/internal/chainState');
const { updateSol } = require('../../solana/rpcMethods/internal/walletState');
const { renderHud } = require('../../hud/warchestHudRenderer');
const { updateHealth } = require('../health');
const { fetchAllTokenAccounts } = require('../fetchAllTokenAccounts');
const { ensureTokenInfo } = require('../../services/tokenInfoService');
const WalletManagerV2 = require('../../WalletManagerV2');
const txInsightService = require('../../services/txInsightService');
const { setup } = require('../client');

// ---------- env helpers ----------
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HUD_RENDER_INTERVAL_MS = intFromEnv('HUD_RENDER_INTERVAL_MS', 750);
const HUD_SOL_REFRESH_SEC = intFromEnv('HUD_SOL_REFRESH_SEC', 15);
const HUD_TOKENS_REFRESH_SEC = intFromEnv('HUD_TOKENS_REFRESH_SEC', 30);

const TOKEN_PROGRAM_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const STABLE_MINTS = new Set([
  // USDC (Solana mainnet)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // USDT (Solana mainnet)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  // USD1 (World Liberty Financial USD1)
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);

// SOL wrapped mint for pricing (SolanaTracker Data API)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Last known SOL price in USD (shared across wallets for HUD header).
let lastSolPriceUsd = null;

// ---------- CLI arg parsing ----------
// For now we keep it dead simple and independent of commander:
//   --wallet alias:pubkey:color
//   --wallet sniper:AbCd...:magenta
//
// Later, warchest will launch this worker like:
//   node lib/warchest/workers/warchestHudWorker.js \
//     --wallet warlord:DDkF...:green \
//     --wallet sniper:ABCD...:magenta

function parseArgs(argv) {
  const wallets = [];
  const args = argv.slice(2);
  let mode = 'daemon'; // default: headless daemon mode

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--wallet') {
      const spec = args[i + 1];
      i += 1;
      if (!spec) continue;
      const [alias, pubkey, color] = spec.split(':');
      if (!alias || !pubkey) {
        logger.warn('[HUD] ignoring malformed --wallet spec:', spec);
        continue;
      }
      wallets.push({ alias, pubkey, color: color || null });
    } else if (arg === '-hud' || arg === '--hud') {
      mode = 'hud';
    }
  }

  return { wallets, mode };
}

// ---------- HUD state helpers ----------

// Helper to push recent activity events for a wallet.
function pushRecentEvent(wallet, summary) {
  if (!wallet.recentEvents) wallet.recentEvents = [];
  wallet.recentEvents.unshift({ ts: Date.now(), summary });
  if (wallet.recentEvents.length > 5) {
    wallet.recentEvents.length = 5;
  }
}

// ---------- helpers for SOL balance refresh ----------

/**
 * Fetch the SOL balance for a single wallet via RPC methods helper.
 *
 * @param {*} rpcMethods
 * @param {string} pubkey
 * @returns {Promise<number|null>} balance in SOL or null on error
 */
async function fetchSolBalance(rpcMethods, pubkey) {
  if (!rpcMethods || typeof rpcMethods.getSolBalance !== 'function') return null;
  try {
    return await rpcMethods.getSolBalance(pubkey);
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Failed to fetch SOL balance for ${pubkey} - ${msg}`);
    return null;
  }
}

/**
 * Refresh SOL balances for all wallets and update HUD state.
 * @param {*} rpcMethods
*/
async function refreshAllSolBalances(rpcMethods, state, rpcStats) {
  const aliases = Object.keys(state);
  if (!rpcMethods || aliases.length === 0) return;

  const now = Date.now();
  const start = Date.now();

  await Promise.all(
    aliases.map(async (alias) => {
      const w = state[alias];
      const bal = await fetchSolBalance(rpcMethods, w.pubkey);
      if (bal == null) return;

      // Keep the shared walletState in sync (approximate lamports from SOL).
      const lamportsApprox = Math.round(bal * 1_000_000_000);
      updateSol(w.pubkey, lamportsApprox);

      if (w.startSolBalance == null) {
        w.startSolBalance = bal;
        w.solSessionDelta = 0;
      } else {
        w.solSessionDelta = bal - w.startSolBalance;
      }

      w.solBalance = bal;
      w.lastActivityTs = now;
    }),
  );
  if (rpcStats) {
    rpcStats.lastSolMs = Date.now() - start;
  }
}

/**
 * Refresh token balances for all wallets and update HUD state.
 *
 * @param {*} rpcMethods
 * @param {Record<string,import('../client').WalletState>} state
 * @param {*} dataClient
 * @param {{lastTokenMs:number|null}} rpcStats
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state, dataClient, rpcStats) {
  const aliases = Object.keys(state);
  if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function' || aliases.length === 0) {
    return;
  }

  const now = Date.now();
  const tokenStart = Date.now();
  const tokenInfoCache = new Map(); // mint -> tokenInfo or null

  await Promise.all(
    aliases.map(async (alias) => {
      const wallet = state[alias];
      try {
        const allAccounts = [];

        const res22 = await fetchAllTokenAccounts(rpcMethods, wallet.pubkey, {
          programId: TOKEN_PROGRAM_22,
          limit: 500,
          excludeZero: true,
          pageLimit: 20,
        });
        const accounts22 = Array.isArray(res22?.accounts) ? res22.accounts : [];
        if (accounts22.length > 0) {
          wallet.hasToken22 = true;
        }
        allAccounts.push(...accounts22);

        const resLegacy = await fetchAllTokenAccounts(rpcMethods, wallet.pubkey, {
          programId: TOKEN_PROGRAM_LEGACY,
          limit: 500,
          excludeZero: true,
          pageLimit: 20,
        });
        const accountsLegacy = Array.isArray(resLegacy?.accounts) ? resLegacy.accounts : [];
        if (accountsLegacy.length > 0 && wallet.hasToken22 == null) {
          wallet.hasToken22 = false;
        }
        allAccounts.push(...accountsLegacy);

        const aggregated = new Map();
        const pricesByMint = {};

        for (const acct of allAccounts) {
          if (!acct || typeof acct !== 'object') continue;
          const mint = acct.mint;
          if (!mint || typeof mint !== 'string') continue;

          const amount = acct.balance;
          const decimals = acct.decimals;

          if (!(amount > 0)) continue;

          const factor = typeof decimals === 'number' && decimals > 0 ? 10 ** decimals : 1;
          const balance = decimals ? amount / factor : amount;

          if (aggregated.has(mint)) {
            aggregated.set(mint, aggregated.get(mint) + balance);
          } else {
            aggregated.set(mint, balance);
          }
        }

        if (aggregated.size > 0 && dataClient) {
          try {
            const mints = [...aggregated.keys()];
            const resp = await dataClient.getMultipleTokenPrices({
              mints,
            });

            const priceData =
              resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object'
                ? resp.data
                : resp;

            if (priceData && typeof priceData === 'object') {
              for (const [mintKey, info] of Object.entries(priceData)) {
                if (!info || typeof info !== 'object') continue;
                const price = typeof info.price === 'number' ? info.price : null;
                if (price != null && Number.isFinite(price)) {
                  pricesByMint[mintKey] = price;
                }
              }

              // Update global SOL price if present.
              if (
                Object.prototype.hasOwnProperty.call(pricesByMint, SOL_MINT) &&
                typeof pricesByMint[SOL_MINT] === 'number'
              ) {
                lastSolPriceUsd = pricesByMint[SOL_MINT];
              }
            }
          } catch (priceErr) {
            const msg = priceErr && priceErr.message ? priceErr.message : priceErr;
            logger.error(
              `[HUD] Failed to fetch token prices for ${wallet.alias} ${wallet.pubkey} - ${msg}`,
            );
          }
        }

        const tokenRows = [];
        for (const [mint, balance] of aggregated.entries()) {
          if (!(balance > 0)) continue;

          let baseline = wallet.startTokenBalances[mint];
          if (baseline == null) {
            baseline = balance;
            wallet.startTokenBalances[mint] = balance;
          }

          let tokenMeta = tokenInfoCache.get(mint);
          if (tokenMeta === undefined) {
            try {
              // Best-effort metadata fetch; tokenInfoService will handle DB/Data API details.
              tokenMeta = await ensureTokenInfo({ mint, client: dataClient });
            } catch (metaErr) {
              const msg = metaErr && metaErr.message ? metaErr.message : metaErr;
              logger.error(
                `[HUD] Failed to ensure token info for mint ${mint} - ${msg}`,
              );
              tokenMeta = null;
            }
            tokenInfoCache.set(mint, tokenMeta);
          }

          let symbol = '';
          let decimals = null;

          if (tokenMeta) {
            // Handle both API shape ({ token: {...} }) and DB row shape ({ symbol, decimals, ... }).
            const tokenLike = tokenMeta.token || tokenMeta;

            if (tokenLike.symbol) {
              symbol = String(tokenLike.symbol);
            } else if (tokenLike.name) {
              // Fallback: show truncated name instead of blank.
              symbol = String(tokenLike.name).slice(0, 6);
            }

            if (typeof tokenLike.decimals === 'number') {
              decimals = tokenLike.decimals;
            }
          }

          // Optional debug: see what we're getting if symbol is still empty
          if (!symbol && tokenMeta && process.env.HUD_DEBUG_METADATA === '1') {
            // eslint-disable-next-line no-console
            logger.debug('[HUD] tokenMeta had no symbol', { mint, tokenMeta });
          }

          const priceUsd = pricesByMint[mint];
          const usdEstimate =
            priceUsd != null && Number.isFinite(priceUsd)
              ? priceUsd * balance
              : null;

          tokenRows.push({
            symbol,
            mint,
            balance,
            sessionDelta: balance - baseline,
            usdEstimate,
            decimals,
          });
        }

        wallet.tokens = tokenRows;
        wallet.lastActivityTs = now;
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.error(`[HUD] Failed to fetch tokens for ${wallet.alias} ${wallet.pubkey} - ${msg}`);
      }
    }),
  );
  if (rpcStats) {
    rpcStats.lastTokenMs = Date.now() - tokenStart;
  }
}

// ---------- main loop ----------

async function main() {
  const { wallets, mode } = parseArgs(process.argv);

  const client = await setup({ walletSpecs: wallets, mode });
  const {
    state,
    resolvedWallets,
    rpc,
    rpcSubs,
    rpcMethods,
    dataClient,
    bootyBox,
    rpcStats,
    trackInterval,
    trackSubscription,
    writeStatusSnapshot,
    close,
  } = client;

  if (resolvedWallets.length !== wallets.length) {
    logger.warn(
      `[HUD] Resolved ${resolvedWallets.length}/${wallets.length} wallets; unresolved entries will not be persisted.`,
    );
  }

  logger.info(`[HUD] Starting warchest HUD worker in ${mode} mode.`);

  // WalletManagerV2 instances per wallet alias. These are responsible for
  // turning log notifications into trade events and position updates.
  const walletManagers = {};

  resolvedWallets.forEach((w) => {
    if (w.walletId == null) {
      logger.warn(`[HUD] Skipping WalletManagerV2 for ${w.alias}; walletId not resolved.`);
      return;
    }
    try {
      walletManagers[w.alias] = new WalletManagerV2({
        rpc,
        walletId: w.walletId,
        walletAlias: w.alias,
        walletPubkey: w.pubkey,
        txInsightService,
        // tokenPriceService is optional; HUD already has a global SOL price
        // via lastSolPriceUsd and token price pulls, so we can omit it here
        // for now and add it later if needed.
        tokenPriceService: null,
        bootyBox,
        // Strategy / WarlordAI decision context provider is optional and
        // will be wired in once that layer is ready.
        strategyContextProvider: null,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(
        `[HUD] Failed to initialize WalletManagerV2 for ${w.alias} (${w.pubkey}): ${msg}`,
      );
    }
  });

  let slotSub = null;
  // Recent activity via logsSubscribe (best-effort, may not be supported on all endpoints).
  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeLogs === 'function') {
    const aliasesForLogs = Object.keys(state);

    for (const alias of aliasesForLogs) {
      const wallet = state[alias];
      try {
        logger.info(`[HUD] Subscribing to logs for ${wallet.alias} (${wallet.pubkey}).`);
        // eslint-disable-next-line no-await-in-loop
        const sub = await rpcMethods.subscribeLogs(
          { mentions: [wallet.pubkey] },
          (ev) => {
            try {
              const value = ev && (ev.value || ev.result || ev);
              if (!value) return;

              const logs = Array.isArray(value.logs) ? value.logs : [];
              const signature = typeof value.signature === 'string' ? value.signature : null;
              const firstLog = logs[0] || '';
              const shortSig = signature
                ? `${signature.slice(0, 4)}...${signature.slice(-4)}`
                : 'unknown sig';
              const msg = firstLog ? firstLog.slice(0, 60) : 'log event';
              const summary = `${new Date().toLocaleTimeString()} ${shortSig} ${msg}`;
              pushRecentEvent(wallet, summary);

              // Forward the raw log notification to WalletManagerV2 so it can
              // derive trade events and position updates. This is best-effort
              // and should never crash the HUD loop.
              const wm = walletManagers[alias];
              if (wm && typeof wm.handleLogNotification === 'function') {
                Promise.resolve(wm.handleLogNotification(ev)).catch((wmErr) => {
                  const wmsg = wmErr && wmErr.message ? wmErr.message : wmErr;
                  logger.warn(
                    `[HUD] WalletManagerV2 error for ${wallet.alias}: ${wmsg}`,
                  );
                });
              }
            } catch (logErr) {
              const msg = logErr && logErr.message ? logErr.message : logErr;
              logger.warn(`[HUD] Error processing logs event for ${wallet.alias}: ${msg}`);
            }
          },
        );

        trackSubscription(sub);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to subscribe to logs for ${wallet.alias} (${wallet.pubkey}): ${msg}`);
      }
    }
  } else if (!rpcSubs) {
    logger.warn('[HUD] Logs subscriptions skipped: rpcSubs not available.');
  } else {
    logger.warn('[HUD] Logs subscriptions skipped: rpcMethods.subscribeLogs is not available.');
  }

  // WebSocket RPC is used for a chain heartbeat (slotSubscribe) and, where
  // available, live SOL balance updates via accountSubscribe. Tokens remain
  // on HTTP polling for now.
  logger.info('[HUD] SolanaTracker RPC client initialized.');
  if (!rpcSubs) {
    // eslint-disable-next-line no-console
    logger.warn('[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?).');
  }

  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeSlot === 'function') {
    try {
      logger.info('[HUD] Subscribing to slot updates for chain heartbeat.');
      slotSub = await rpcMethods.subscribeSlot((ev) => {
        updateFromSlotEvent(ev);
      });
      trackSubscription(slotSub);
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      logger.warn(`[HUD] Failed to subscribe to slot updates: ${msg}`);
    }
  }

  if (rpcSubs && rpcMethods && typeof rpcMethods.subscribeAccount === 'function') {
    const aliasesForAccounts = Object.keys(state);

    for (const alias of aliasesForAccounts) {
      const wallet = state[alias];
      try {
        logger.info(`[HUD] Subscribing to SOL account for ${wallet.alias} (${wallet.pubkey}).`);
        // eslint-disable-next-line no-await-in-loop
        const sub = await rpcMethods.subscribeAccount(wallet.pubkey, (ev) => {
          try {
            const value = ev && (ev.value || ev.result || ev);
            const lamports = value && typeof value.lamports === 'number' ? value.lamports : null;
            if (lamports == null) return;

            const sol = lamports / 1_000_000_000;
            updateSol(wallet.pubkey, lamports);

            if (wallet.startSolBalance == null) {
              wallet.startSolBalance = sol;
              wallet.solSessionDelta = 0;
            } else {
              wallet.solSessionDelta = sol - wallet.startSolBalance;
            }

            wallet.solBalance = sol;
            wallet.lastActivityTs = Date.now();
          } catch (subErr) {
            const msg = subErr && subErr.message ? subErr.message : subErr;
            logger.warn(`[HUD] Error processing SOL account event for ${wallet.alias}: ${msg}`);
          }
        });

        trackSubscription(sub);
      } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Failed to subscribe to SOL account for ${wallet.alias} (${wallet.pubkey}): ${msg}`);
      }
    }
  } else if (!rpcSubs) {
    logger.warn('[HUD] SOL account subscriptions skipped: rpcSubs not available.');
  } else {
    logger.warn('[HUD] SOL account subscriptions skipped: rpcMethods.subscribeAccount is not available.');
  }

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state, rpcStats);
  await refreshAllTokenBalances(rpcMethods, state, dataClient, rpcStats);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state, rpcStats).catch((err) => {
      logger.error('[HUD] Error refreshing SOL balances:', err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);
  trackInterval(solTimer);

  const tokenTimer = setInterval(() => {
    refreshAllTokenBalances(rpcMethods, state, dataClient, rpcStats).catch((err) => {
      logger.error('[HUD] Error refreshing token balances:', err.message || err);
    });
  }, HUD_TOKENS_REFRESH_SEC * 1000);
  trackInterval(tokenTimer);

  const healthTimer = setInterval(() => {
    const health = updateHealth(state, rpcStats);
    if (mode === 'daemon' && health && health.process && health.ws && health.wallets) {
      const rssMb = Math.round(health.process.rssBytes / 1024 / 1024);
      const lagMs = health.process.eventLoopLagMs;

      // Persist a snapshot for other commands to inspect.
      writeStatusSnapshot(health);

      logger.info(
        `[warchest] Health: up=${health.process.uptimeSec}s rss=${rssMb}MB slot=${health.ws.slot} wsAge=${health.ws.lastSlotAgeMs}ms lag=${lagMs}ms wallets=${health.wallets.count}`,
      );
    }
  }, 5000);
  trackInterval(healthTimer);

  // Render loop (only in HUD mode)
  if (mode === 'hud') {
    const renderTimer = setInterval(() => {
      renderHud(state, { lastSolPriceUsd, rpcStats, stableMints: STABLE_MINTS });
    }, HUD_RENDER_INTERVAL_MS);
    trackInterval(renderTimer);
  }

  // Graceful shutdown
  function shutdown() {
    close()
      .catch((err) => {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[HUD] Error during shutdown: ${msg}`);
      })
      .finally(() => {
        process.exit(0);
      });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Initial render only in HUD mode
  if (mode === 'hud') {
    renderHud(state, { lastSolPriceUsd, rpcStats, stableMints: STABLE_MINTS });
  }
}

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Fatal error: ${msg}`);
    process.exit(1);
  });
}
