#!/usr/bin/env node
'use strict';

// scripts/warchestHudWorker.js
// Long-running HUD worker: given wallet info via CLI args,
// connect to SolanaTracker RPC, maintain simple state, and render a
// multi-wallet dashboard in the terminal.
//
// NOTE: v1 stops before metadata/price pulls. Tokens/prices are stubbed.

require("dotenv").config({ quiet: true });

const chalk = require('chalk');
const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
const { createRpcMethods } = require('../lib/solana/rpcMethods');
const { createSolanaTrackerDataClient } = require('../lib/solanaTrackerDataClient');
const { ensureTokenInfo } = require('../lib/services/tokenInfoService');
const logger = require('../lib/logger');

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

// Shared SolanaTracker Data API client for token metadata lookups.
const dataClient = createSolanaTrackerDataClient();

// ---------- colorizer (reuse palette semantics from warchest) ----------
function colorizer(color) {
  if (!color) return (text) => text;
  switch (color) {
    case 'green':
      return chalk.green;
    case 'cyan':
      return chalk.cyan;
    case 'magenta':
      return chalk.magenta;
    case 'yellow':
      return chalk.yellow;
    case 'blue':
      return chalk.blue;
    case 'red':
      return chalk.red;
    default:
      return (text) => text;
  }
}

// ---------- CLI arg parsing ----------
// For now we keep it dead simple and independent of commander:
//   --wallet alias:pubkey:color
//   --wallet sniper:AbCd...:magenta
//
// Later, warchest will launch this worker like:
//   node scripts/warchestHudWorker.js \
//     --wallet warlord:DDkF...:green \
//     --wallet sniper:ABCD...:magenta

function parseArgs(argv) {
  const wallets = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--wallet') {
      const spec = args[i + 1];
      i += 1;
      if (!spec) continue;
      const [alias, pubkey, color] = spec.split(':');
      if (!alias || !pubkey) {
        // eslint-disable-next-line no-console
        logger.warn('[HUD] ignoring malformed --wallet spec:', spec);
        continue;
      }
      wallets.push({ alias, pubkey, color: color || null });
    }
  }

  return { wallets };
}

// ---------- HUD state ----------

/**
 * @typedef {Object} TokenRow
 * @property {string} symbol
 * @property {string} mint
 * @property {number} balance
 * @property {number} sessionDelta
 * @property {number|null} usdEstimate
 * @property {number|null} decimals
 */

/**
 * @typedef {Object} WalletState
 * @property {string} alias
 * @property {string} pubkey
 * @property {string|null} color
 * @property {number|null} startSolBalance
 * @property {number} solBalance
 * @property {number} solSessionDelta
 * @property {number} openedAt
 * @property {number} lastActivityTs
 * @property {Object<string, number>} startTokenBalances
 * @property {TokenRow[]} tokens
 * @property {boolean|null} hasToken22
 */

/**
 * Build initial HUD state from CLI wallets.
 * In v1, tokens are just an empty list (to be filled later).
 * @param {{alias:string,pubkey:string,color:string|null}[]} walletSpecs
 * @returns {Record<string,WalletState>}
 */
function buildInitialState(walletSpecs) {
  const now = Date.now();
  const state = {};
  for (const w of walletSpecs) {
    state[w.alias] = {
      alias: w.alias,
      pubkey: w.pubkey,
      color: w.color || null,
      startSolBalance: null,
      solBalance: 0,
      solSessionDelta: 0,
      openedAt: now,
      lastActivityTs: now,
      startTokenBalances: {},
      tokens: [],
      hasToken22: null,
    };
  }
  return state;
}

// ---------- HUD rendering ----------

function shortenPubkey(pubkey) {
  if (!pubkey || pubkey.length <= 8) return pubkey;
  return `${pubkey.slice(0, 3)}...${pubkey.slice(-5)}`;
}

/**
 * Format a number with fixed decimals and thousands separators.
 */
function fmtNum(value, decimals = 3) {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Render a single wallet section in the style you described.
 * For now, tokens are whatever is in state.tokens (stubbed until we wire metadata/prices).
 * @param {WalletState} w
 * @returns {string}
 */
function renderWalletSection(w) {
  const c = colorizer(w.color);

  const headerWidth = 65;
  const borderTop = `┌${'─'.repeat(headerWidth)}┐`;
  const borderMid = `├${'─'.repeat(headerWidth)}┤`;
  const borderBottom = `└${'─'.repeat(headerWidth)}┘`;

  const shortPk = shortenPubkey(w.pubkey);
  const solStr = `SOL: ${fmtNum(w.solBalance, 3)}`;
  let deltaStr = '';

  if (w.solSessionDelta !== 0) {
    const deltaRaw = `${w.solSessionDelta > 0 ? '+' : ''}${fmtNum(w.solSessionDelta, 3)}`;
    const deltaColored = w.solSessionDelta > 0 ? chalk.green(deltaRaw) : chalk.red(deltaRaw);
    deltaStr = ` (${deltaColored})`;
  }

  const solWithDelta = `${solStr}${deltaStr}`;

  let solPriceStr = '';
  if (typeof lastSolPriceUsd === 'number' && Number.isFinite(lastSolPriceUsd)) {
    solPriceStr = ` @ $${fmtNum(lastSolPriceUsd, 2)}`;
  }

  const headerText = `${c(w.alias)} (${shortPk})   ${solWithDelta}${solPriceStr}`;
  const headerLine = `│ ${headerText.padEnd(headerWidth - 1, ' ')}│`;

  // Table header
  const colSym = 'Sym'.padEnd(6, ' ');
  const colMint = 'Mint'.padEnd(15, ' ');
  // Numeric columns: right-align headers to match right-aligned values.
  const colBal = 'Balance'.padStart(14, ' ');
  const colDelta = 'Δ Session'.padStart(14, ' ');
  const colUsd = 'Est. USD'.padStart(10, ' ');

  const colsHeader = `│ ${colSym}│ ${colMint}│ ${colBal}│ ${colDelta}│ ${colUsd}│`;

  const sepRow = '├────────┼───────────────┼──────────────┼──────────────┼──────────┤';

  const rows = [];

  if (!w.tokens || w.tokens.length === 0) {
    const emptyMsg = '(no tokens yet)';
    const line = `│ ${emptyMsg.padEnd(headerWidth - 1, ' ')}│`;
    rows.push(line);
  } else {
    const stableTokens = [];
    const otherTokens = [];

    for (const t of w.tokens) {
      if (t.mint && STABLE_MINTS.has(t.mint)) {
        stableTokens.push(t);
      } else {
        otherTokens.push(t);
      }
    }

    const makeRow = (t, isStable) => {
      const sym = (t.symbol || '').slice(0, 6).padEnd(6, ' ');
      const mint = shortenPubkey(t.mint || '').slice(0, 15).padEnd(15, ' ');
      const rawBal = fmtNum(t.balance, 2);
      const bal = (isStable ? `$${rawBal}` : rawBal).padStart(14, ' ');
      const delta = fmtNum(t.sessionDelta, 2).padStart(14, ' ');
      const usd = t.usdEstimate == null
        ? '-'.padStart(10, ' ')
        : (`$${fmtNum(t.usdEstimate, 2)}`).padStart(10, ' ');

      const row = `│ ${sym}│ ${mint}│ ${bal}│ ${delta}│ ${usd}│`;
      return isStable ? chalk.green(row) : row;
    };

    if (stableTokens.length > 0) {
      for (const t of stableTokens) {
        rows.push(makeRow(t, true));
      }
      if (otherTokens.length > 0) {
        // visual divider between stables and the rest
        rows.push(sepRow);
      }
    }

    for (const t of otherTokens) {
      rows.push(makeRow(t, false));
    }
  }

  const lines = [
    borderTop,
    headerLine,
    borderMid,
    colsHeader,
    sepRow,
    ...rows,
    borderBottom,
  ];

  return lines.join('\n');
}

/**
 * Render the full HUD screen for all wallets.
 * @param {Record<string,WalletState>} state
 */
function renderHud(state) {
  // Clear the screen + move cursor to top-left
  // eslint-disable-next-line no-console
  process.stdout.write('\x1b[2J\x1b[H');

  const aliases = Object.keys(state).sort();
  if (aliases.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No wallets configured for HUD worker.\n');
    return;
  }

  const now = Date.now();
  const sections = aliases.map((alias) => renderWalletSection(state[alias]));
  const combined = sections.join('\n\n');

  const footer = `Last redraw: ${new Date(now).toLocaleTimeString()}  |  Wallets: ${aliases.length}  |  Ctrl-C to exit`;

  // eslint-disable-next-line no-console
  console.log(combined);
  // eslint-disable-next-line no-console
  console.log('\n' + footer);
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
 * @param {Record<string,WalletState>} state
 */
async function refreshAllSolBalances(rpcMethods, state) {
  const aliases = Object.keys(state);
  if (!rpcMethods || aliases.length === 0) return;

  const now = Date.now();

  await Promise.all(
    aliases.map(async (alias) => {
      const w = state[alias];
      const bal = await fetchSolBalance(rpcMethods, w.pubkey);
      if (bal == null) return;

      if (w.startSolBalance == null) {
        w.startSolBalance = bal;
        w.solSessionDelta = 0;
      } else {
        w.solSessionDelta = bal - w.startSolBalance;
      }

      w.solBalance = bal;
      w.lastActivityTs = now;
    })
  );
}

/**
 * Refresh token balances for all wallets and update HUD state.
 *
 * @param {*} rpcMethods
 * @param {Record<string,WalletState>} state
 * @returns {Promise<void>}
 */
async function refreshAllTokenBalances(rpcMethods, state) {
  const aliases = Object.keys(state);
  if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwnerV2 !== 'function' || aliases.length === 0) {
    return;
  }

  const now = Date.now();
  const tokenInfoCache = new Map(); // mint -> tokenInfo or null

  await Promise.all(
    aliases.map(async (alias) => {
      const wallet = state[alias];
      try {
        const allAccounts = [];

        // Always query Token-2022 program; cheap extra call and ensures we
        // pick up new Token-22 balances even if they appear after the HUD starts.
        const res22 = await rpcMethods.getTokenAccountsByOwnerV2(wallet.pubkey, {
          programId: TOKEN_PROGRAM_22,
          limit: 100,
          excludeZero: true,
        });
        const accounts22 = Array.isArray(res22?.accounts) ? res22.accounts : [];
        if (accounts22.length > 0) {
          // Track that this wallet has seen Token-22 accounts, but do not
          // use this to skip future checks. We always probe both programs.
          wallet.hasToken22 = true;
          allAccounts.push(...accounts22);
        if (res22?.hasMore) {
          logger.debug(`[HUD] Token-22 fetch truncated for ${wallet.alias}; pagination TBD.`);
        }
        }

        // Always query legacy SPL (Tokenkeg) for fungible tokens.
        const resLegacy = await rpcMethods.getTokenAccountsByOwnerV2(wallet.pubkey, {
          programId: TOKEN_PROGRAM_LEGACY,
          limit: 100,
          excludeZero: true,
        });
        const accountsLegacy = Array.isArray(resLegacy?.accounts) ? resLegacy.accounts : [];
        if (accountsLegacy.length > 0) {
          allAccounts.push(...accountsLegacy);
        if (resLegacy?.hasMore) {
          logger.debug(`[HUD] Legacy token fetch truncated for ${wallet.alias}; pagination TBD.`);
        }
        }

        const aggregated = new Map();
        for (const account of allAccounts) {
          const mint = account?.mint;
          if (!mint) continue;
          const amount =
            typeof account.uiAmount === 'number'
              ? account.uiAmount
              : Number(account.uiAmount);
          if (!Number.isFinite(amount)) continue;
          aggregated.set(mint, (aggregated.get(mint) || 0) + amount);
        }

        // Best-effort price lookup for all mints in this wallet using SolanaTracker Data API.
        const pricesByMint = {};
        const mints = Array.from(aggregated.keys());
        // Ensure SOL is always included so we can price the header, even if this wallet holds no SOL directly.
        if (!mints.includes(SOL_MINT)) {
          mints.push(SOL_MINT);
        }

        if (
          mints.length > 0 &&
          dataClient &&
          typeof dataClient.getMultipleTokenPrices === 'function'
        ) {
          try {
            // API expects an array of mints.
            const resp = await dataClient.getMultipleTokenPrices({
              mints,
            });

            if (resp && typeof resp === 'object') {
              for (const [mintKey, info] of Object.entries(resp)) {
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
            const msg =
              priceErr && priceErr.message ? priceErr.message : priceErr;
            logger.error(
              `[HUD] Failed to fetch token prices for ${wallet.alias} ${wallet.pubkey} - ${msg}`
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
              const msg =
                metaErr && metaErr.message ? metaErr.message : metaErr;
              logger.error(
                `[HUD] Failed to ensure token info for mint ${mint} - ${msg}`
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
    })
  );
}

// ---------- main loop ----------

async function main() {
  const { wallets } = parseArgs(process.argv);

  if (!wallets || wallets.length === 0) {
    // eslint-disable-next-line no-console
    logger.error('[HUD] No wallets provided. Use --wallet alias:pubkey:color');
    process.exit(1);
  }

  const state = buildInitialState(wallets);

  // Create SolanaTracker RPC client (HTTP + WS).
  const { rpc, rpcSubs, close } = createSolanaTrackerRPCClient();
  const rpcMethods = createRpcMethods(rpc, rpcSubs);

  // TODO (later): wire up actual subscriptions:
  // - account notifications for SOL
  // - token account notifications
  // - signature notifications (to trigger on-demand price refresh)
  //
  // For now, we just log that we created the client so we know WS is live.
  logger.info('[HUD] SolanaTracker RPC client initialized.');
  if (!rpcSubs) {
    // eslint-disable-next-line no-console
    logger.warn('[HUD] rpcSubs is null; WS subscriptions are disabled (no SOLANATRACKER_RPC_WS_URL?).');
  }

  // Initial SOL balance fetch
  await refreshAllSolBalances(rpcMethods, state);
  await refreshAllTokenBalances(rpcMethods, state);

  // Periodic SOL refresh using HTTP RPC
  const solTimer = setInterval(() => {
    refreshAllSolBalances(rpcMethods, state).catch((err) => {
      // eslint-disable-next-line no-console
      logger.error('[HUD] Error refreshing SOL balances:', err.message || err);
    });
  }, HUD_SOL_REFRESH_SEC * 1000);

  const tokenTimer = setInterval(() => {
    refreshAllTokenBalances(rpcMethods, state).catch((err) => {
      // eslint-disable-next-line no-console
      logger.error('[HUD] Error refreshing token balances:', err.message || err);
    });
  }, HUD_TOKENS_REFRESH_SEC * 1000);

  // Render loop
  const renderTimer = setInterval(() => {
    renderHud(state);
  }, HUD_RENDER_INTERVAL_MS);

  // Graceful shutdown
  function shutdown() {
    clearInterval(solTimer);
    clearInterval(tokenTimer);
    clearInterval(renderTimer);
    Promise.resolve()
      .then(() => close())
      .catch(() => {})
      .finally(() => {
        process.exit(0);
      });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Initial render
  renderHud(state);
}

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    const msg = err && err.message ? err.message : err;
    logger.error(`[HUD] Fatal error: ${msg}`);
    process.exit(1);
  });
}
