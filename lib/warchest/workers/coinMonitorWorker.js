#!/usr/bin/env node
'use strict';

const logger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { setup } = require('../client');
const { createMonitorPersistence } = require('./monitors/persistence');

const DEFAULT_RENDER_MS = 1000;
const DEFAULT_EXIT_BALANCE = 0;

function normalizeMint(mint) {
  if (!mint || typeof mint !== 'string' || mint.trim() === '') {
    throw new Error('coin monitor requires a mint');
  }
  return mint.trim();
}

function normalizeWallet(wallet) {
  const alias = wallet && (wallet.alias || wallet.walletAlias || wallet.name);
  const pubkey = wallet && (wallet.pubkey || wallet.wallet || wallet.address);
  if (!alias || !pubkey) {
    throw new Error('coin monitor requires wallet alias and pubkey');
  }
  return {
    alias,
    pubkey,
    color: wallet.color || null,
  };
}

function parseTokenAmount(data) {
  const value = data && (data.value || data.account || data);
  const parsed = value && value.data && value.data.parsed && value.data.parsed.info;
  const tokenAmount = parsed && parsed.tokenAmount ? parsed.tokenAmount : null;
  const uiAmount = tokenAmount && Number.isFinite(Number(tokenAmount.uiAmount))
    ? Number(tokenAmount.uiAmount)
    : null;
  const decimals = tokenAmount && Number.isFinite(Number(tokenAmount.decimals))
    ? Number(tokenAmount.decimals)
    : tokenAmount && Number.isFinite(Number(tokenAmount.uiAmountDecimals))
      ? Number(tokenAmount.uiAmountDecimals)
      : null;
  const lamportsAmount = value && Number.isFinite(Number(value.lamports)) ? Number(value.lamports) : null;

  if (uiAmount != null) {
    return { amount: uiAmount, decimals };
  }
  if (lamportsAmount != null) {
    return { amount: lamportsAmount, decimals: 9 };
  }
  return null;
}

function toAccountEntry(raw) {
  const address = raw && (raw.pubkey || raw.address || raw.account?.pubkey || raw.id);
  if (!address) return null;
  const parsedAmount = parseTokenAmount(raw.account || raw.value || raw);
  return {
    address,
    balance: parsedAmount ? parsedAmount.amount : 0,
    decimals: parsedAmount ? parsedAmount.decimals : null,
  };
}

function summarizeAccounts(accountsMap) {
  return Array.from(accountsMap.values());
}

/**
 * Create a coin monitor controller.
 *
 * @param {Object} payload
 * @param {string} payload.mint - Mint address to monitor.
 * @param {{alias?:string,pubkey?:string,color?:string}|Object} payload.wallet - Wallet context for subscriptions/logging.
 * @param {boolean} [payload.exitOnZero=true] - Whether to stop when balance reaches zero.
 * @param {number} [payload.renderIntervalMs] - Interval for rendering/log output.
 * @param {string} [payload.statusDir] - Optional directory for status snapshots.
 * @param {Object} [tools]
 * @param {*} [tools.rpcMethods] - Optional RPC method helpers (injected for testing).
 * @param {*} [tools.client] - Optional warchest client (from setup) to reuse.
 * @param {Function} [tools.track] - harness tracker for cleanup.
 * @param {Function} [tools.writeStatusSnapshot] - Optional snapshot writer override.
 * @returns {{start: Function, stop: Function}}
 */
function createCoinMonitorController(payload, tools = {}) {
  const mint = normalizeMint(payload.mint);
  const wallet = normalizeWallet(payload.wallet || {});
  const exitOnZero = payload.exitOnZero !== false;
  const renderIntervalMs = payload.renderIntervalMs || DEFAULT_RENDER_MS;
  const track = typeof tools.track === 'function' ? tools.track : () => {};

  let rpcMethods = tools.rpcMethods || null;
  let client = tools.client || null;
  const ownsClient = !client;
  let stopped = false;
  let stopReason = null;
  let renderTimer = null;
  let logSub = null;
  let stopFn = null;
  const accountSubs = [];
  const state = {
    accounts: new Map(),
    totalBalance: 0,
  };

  const finalPromise = new Promise((resolve, reject) => {
    const persistence = createMonitorPersistence({
      writeStatusSnapshot: tools.writeStatusSnapshot || (client && client.writeStatusSnapshot),
      mint,
      walletAlias: wallet.alias,
    });

    async function cleanup() {
      if (renderTimer) {
        clearInterval(renderTimer);
      }
      if (logSub && typeof logSub.unsubscribe === 'function') {
        try {
          await logSub.unsubscribe();
        } catch (err) {
          logger.warn(`[coinMonitor] failed to unsubscribe logs: ${err?.message || err}`);
        }
      }
      for (const sub of accountSubs) {
        if (sub && typeof sub.unsubscribe === 'function') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await sub.unsubscribe();
          } catch (err) {
            logger.warn(`[coinMonitor] failed to unsubscribe account: ${err?.message || err}`);
          }
        }
      }
      if (client && ownsClient && typeof client.close === 'function') {
        try {
          await client.close();
        } catch (err) {
          logger.warn(`[coinMonitor] client close failed: ${err?.message || err}`);
        }
      }
    }

    async function finish(reason) {
      if (stopped) return;
      stopped = true;
      stopReason = reason || 'stopped';
      const result = {
        status: stopReason === 'drained' ? 'drained' : 'stopped',
        stopReason,
        mint,
        walletAlias: wallet.alias,
        finalBalance: state.totalBalance,
        accounts: summarizeAccounts(state.accounts),
      };
      try {
        persistence.snapshot({
          stopReason: result.stopReason,
          balance: result.finalBalance,
          accounts: result.accounts,
        });
      } catch (err) {
        logger.warn(`[coinMonitor] snapshot failed: ${err?.message || err}`);
      }
      await cleanup();
      resolve(result);
    }

    async function refreshAccounts() {
      if (!rpcMethods || typeof rpcMethods.getTokenAccountsByOwner !== 'function') {
        logger.warn('[coinMonitor] rpcMethods.getTokenAccountsByOwner unavailable');
        return [];
      }
      try {
        const res = await rpcMethods.getTokenAccountsByOwner(wallet.pubkey, {
          mint,
          encoding: 'jsonParsed',
        });
        const accounts = Array.isArray(res?.value)
          ? res.value
          : Array.isArray(res?.accounts)
            ? res.accounts
            : [];
        return accounts
          .map((entry) => toAccountEntry(entry))
          .filter(Boolean);
      } catch (err) {
        logger.warn(`[coinMonitor] failed to fetch token accounts: ${err?.message || err}`);
        return [];
      }
    }

    function recomputeTotals() {
      state.totalBalance = 0;
      state.accounts.forEach((acc) => {
        state.totalBalance += acc.balance;
      });
      if (exitOnZero && state.totalBalance <= DEFAULT_EXIT_BALANCE) {
        finish('drained');
      }
    }

    function handleAccountUpdate(address, ev) {
      const parsed = parseTokenAmount(ev);
      if (!parsed) return;
      const existing = state.accounts.get(address) || { address, balance: 0, decimals: parsed.decimals };
      existing.balance = parsed.amount;
      existing.decimals = parsed.decimals;
      state.accounts.set(address, existing);
      recomputeTotals();
    }

    function render() {
      logger.info(
        `[coinMonitor] mint=${mint} wallet=${wallet.alias} balance=${state.totalBalance.toFixed(6)} (${state.accounts.size} accounts)`
      );
    }

    async function openSubscriptions(accounts) {
      if (!rpcMethods) return;
      for (const account of accounts) {
        if (!account.address) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const sub = await rpcMethods.subscribeAccount(
            account.address,
            (ev) => handleAccountUpdate(account.address, ev),
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
              onError: (err) => {
                logger.warn(
                  `[coinMonitor] account subscription error for ${account.address}: ${err?.message || err}`
                );
              },
            }
          );
          if (sub) {
            accountSubs.push(sub);
            track(sub);
          }
        } catch (err) {
          logger.warn(
            `[coinMonitor] failed to subscribe to account ${account.address}: ${err?.message || err}`
          );
        }
      }

      if (rpcMethods && typeof rpcMethods.subscribeLogs === 'function') {
        try {
          logSub = await rpcMethods.subscribeLogs(
            { mentions: [wallet.pubkey] },
            (ev) => {
              if (ev && ev.value) {
                logger.debug?.('[coinMonitor] log event', ev.value);
              }
            },
            {
              onError: (err) => {
                logger.warn(`[coinMonitor] logs subscription error: ${err?.message || err}`);
              },
            }
          );
          if (logSub) {
            track(logSub);
          }
        } catch (err) {
          logger.warn(`[coinMonitor] failed to subscribe to logs: ${err?.message || err}`);
        }
      }
    }

    async function bootstrap() {
      if (!rpcMethods) {
        client = client || (await setup({ walletSpecs: [wallet], mode: 'daemon', statusDir: payload.statusDir }));
        rpcMethods = rpcMethods || client.rpcMethods;
      }
      if (!rpcMethods) {
        throw new Error('coin monitor missing rpcMethods');
      }

      const accounts = await refreshAccounts();
      accounts.forEach((entry) => state.accounts.set(entry.address, entry));
      recomputeTotals();
      await openSubscriptions(accounts);
      renderTimer = setInterval(render, renderIntervalMs);
      track({
        close: () => {
          if (renderTimer) clearInterval(renderTimer);
        },
      });
      render();
      if (exitOnZero && state.totalBalance <= DEFAULT_EXIT_BALANCE) {
        finish('drained');
      }
    }

    bootstrap().catch((err) => {
      reject(err);
    });

    stopFn = finish;
  });

  return {
    start() {
      return finalPromise;
    },
    stop(reason) {
      if (stopFn) stopFn(reason);
      return finalPromise;
    },
  };
}

/**
 * Start coin monitor via IPC harness.
 *
 * @returns {void}
 */
function startHarness() {
  let controller = null;

  createWorkerHarness(
    async (payload, { track }) => {
      controller = createCoinMonitorController(payload, { track });
      return controller.start();
    },
    {
      exitOnComplete: true,
      onClose: async () => {
        if (controller && typeof controller.stop === 'function') {
          await controller.stop('terminated');
        }
      },
    }
  );

  process.on('message', (msg) => {
    if (!msg || msg.type !== 'stop') return;
    if (controller && typeof controller.stop === 'function') {
      controller.stop('stop-request');
    }
  });
}

if (require.main === module) {
  startHarness();
}

module.exports = {
  createCoinMonitorController,
  startHarness,
};
