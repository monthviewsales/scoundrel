'use strict';

const path = require('path');

const logger = require('../../../logger');
const BootyBox = require('../../../../db/src/adapters/sqlite');
const { setup } = require('../../client');
const { createSolanaTrackerDataClient } = require('../../../solanaTrackerDataClient');
const { computeMarketRegime } = require('../../../analysis/indicators');
const { buildEvaluation } = require('../../../../db/src/services/evaluationService');
const { forkWorkerWithPayload } = require('../harness');
const { getHubCoordinator } = require('../../hub');
const { loadStrategyDocs } = require('./strategyDocs');
const { evaluatePosition, DEFAULT_EVENT_INTERVALS } = require('./evaluationEngine');
const { normalizeWallet, toPositionSummary } = require('./positionAdapter');
const { buildHudPayload, emitToParent } = require('./hudPublisher');
const { persistSellOpsEvaluation } = require('./persistence');
const { resolveAvgCostUsd, getTrailingStopConfig } = require('./trailingStop');

const DEFAULT_POLL_MS = 60_000;
const MAX_PRICE_STALE_MS = 15_000;

/**
 * @typedef {Object} PositionSummary
 * @property {number|string} positionId
 * @property {number|string} walletId
 * @property {string} walletAlias
 * @property {string} mint
 * @property {string|null} tradeUuid
 * @property {number|string|null} strategyId
 * @property {string|null} strategyName
 * @property {number|null} openAt
 * @property {number|null} closedAt
 * @property {number|null} lastTradeAt
 * @property {number|null} lastUpdatedAt
 * @property {number|null} entryTokenAmount
 * @property {number|null} currentTokenAmount
 * @property {number|null} totalTokensBought
 * @property {number|null} totalTokensSold
 * @property {number|null} entryPriceSol
 * @property {number|null} entryPriceUsd
 * @property {number|null} lastPriceSol
 * @property {number|null} lastPriceUsd
 * @property {string|null} source
 */

// Normalize sellOps logger: supports factory-style (logger.sellOps()) and object-style (logger.sellOps).
// Fall back to the base logger when sellOps scoping is unavailable (tests/mocks).
const sellOpsLogger = (() => {
  if (typeof logger.sellOps === 'function') return logger.sellOps();
  if (logger.sellOps) return logger.sellOps;
  return logger;
})();

// Strategy docs are versioned JSON stored in the repo.
// Load once at startup; if a file is missing or invalid JSON, fail fast (so we don't trade blind).
const STRATEGY_DOCS = loadStrategyDocs();
const hub = getHubCoordinator({ attachSignals: false });

/**
 * Run a swap through the hub coordinator and optionally start a tx monitor.
 *
 * @param {Object} payload
 * @param {NodeJS.ProcessEnv} workerEnv
 * @returns {Promise<Object|null>}
 */
async function runSwapWithMonitor(payload, workerEnv) {
  const response = await hub.runSwap(payload, { env: workerEnv, timeoutMs: 0 });
  const result = response && response.result ? response.result : response;
  if (result && result.monitorPayload) {
    try {
      const monitorEnv = { ...workerEnv };
      if (result.monitorPayload.rpcEndpoint && !monitorEnv.SOLANATRACKER_RPC_HTTP_URL) {
        monitorEnv.SOLANATRACKER_RPC_HTTP_URL = result.monitorPayload.rpcEndpoint;
      }
      const monitorResult = await hub.runTxMonitor(result.monitorPayload, {
        env: monitorEnv,
        timeoutMs: 120_000,
      });
      result.monitor = monitorResult;
    } catch (err) {
      sellOpsLogger.warn(`[sellOps] tx monitor failed to start: ${err?.message || err}`);
    }
  }
  return result || null;
}

/**
 * Run autopsy for a recently-closed position.
 *
 * NOTE: We intentionally require `wallet.pubkey` and `position.tradeUuid` to avoid
 * producing ambiguous artifacts or running expensive analysis without identity.
 *
 * @param {Object} args
 * @param {PositionSummary} args.position
 * @param {{ alias: string, pubkey: string|null }} args.wallet
 * @param {NodeJS.ProcessEnv} args.workerEnv
 * @param {Function} [args.runAutopsy] - Optional injected autopsy runner (tests).
 * @returns {Promise<any|null>}
 */
async function runAutopsyForClosedPosition({ position, wallet, workerEnv, runAutopsy }) {
  if (!position || !wallet) return null;
  if (!wallet.pubkey) {
    sellOpsLogger.warn(`[sellOps] autopsy skipped for ${position.mint || 'mint?'}: missing wallet pubkey`);
    return null;
  }
  if (!position.tradeUuid) {
    sellOpsLogger.warn(`[sellOps] autopsy skipped for ${position.mint || 'mint?'}: missing trade_uuid`);
    return null;
  }

  if (typeof runAutopsy === 'function') {
    return runAutopsy({
      walletAddress: wallet.pubkey,
      mint: position.mint,
      walletLabel: wallet.alias,
    });
  }

  const workerPath = path.join(__dirname, '..', 'autopsyWorker.js');
  const { result } = await forkWorkerWithPayload(workerPath, {
    payload: {
      walletAddress: wallet.pubkey,
      mint: position.mint,
      walletLabel: wallet.alias,
    },
    env: workerEnv,
    timeoutMs: 0,
  });

  return result || null;
}

/**
 * Create a SellOps controller.
 *
 * Payload contract:
 * - payload.wallet: { alias|walletAlias|name, pubkey? }
 * - payload.pollIntervalMs?: number (defaults to 60s)
 * - payload.statusDir?: optional status dir forwarded to setup()
 * @param {Object} payload
 * @param {Object} [tools]
 * @param {Object} [log]
 * @returns {{ start: Function, stop: Function }}
 */
function createSellOpsController(payload, tools = {}, log = sellOpsLogger) {
  const wallet = normalizeWallet(payload.wallet || payload);
  const pollIntervalMs = payload.pollIntervalMs || DEFAULT_POLL_MS;

  const track = typeof tools.track === 'function' ? tools.track : () => {};
  const workerEnv = tools.env || process.env;
  const sendFn = tools.sendFn
    || (typeof process.send === 'function' ? process.send.bind(process) : null);

  // Ensure BootyBox sqlite adapter/context is initialized once per worker process.
  try {
    if (typeof BootyBox.init === 'function') BootyBox.init();
  } catch (err) {
    log.warn(`[sellOps] BootyBox.init() failed: ${err?.message || err}`);
  }

  let client = tools.client || null;
  const ownsClient = !client;
  let db = null;
  let dataClient = null;
  let previousOpenPositions = new Map(); // trade_uuid -> position summary

  // Trailing-stop state (in-memory only)
  const costUsdByTradeUuid = new Map(); // tradeUuid -> avg cost USD
  const trailingStateByTradeUuid = new Map();
  let trailingTimer = null;
  let lastTrailingHeartbeatTsMs = 0;
  let trailingRunning = false;

  const autopsiedTradeUuids = new Set();

  let stopped = false;
  let stopReason = null;
  let pollTimer = null;
  let stopFn = null;

  const finalPromise = new Promise((resolve, reject) => {
    async function cleanup() {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      trailingRunning = false;

      if (dataClient && typeof dataClient.close === 'function') {
        try {
          await dataClient.close();
        } catch (err) {
          log.warn(`[sellOps] data client close failed: ${err?.message || err}`);
        }
      }

      if (client && ownsClient && typeof client.close === 'function') {
        try {
          await client.close();
        } catch (err) {
          log.warn(`[sellOps] client close failed: ${err?.message || err}`);
        }
      }
    }

    async function finish(reason) {
      if (stopped) return;
      stopped = true;
      stopReason = reason || 'stopped';

      const result = {
        status: 'stopped',
        stopReason,
        walletAlias: wallet.alias,
      };

      await cleanup();
      trailingRunning = false;
      resolve(result);
    }

    /**
     * Start a fast trailing-stop loop that watches open positions.
     * No DB writes. Best-effort only; errors never stop SellOps.
     */
    function ensureTrailingLoopStarted() {
      if (trailingRunning) return;
      trailingRunning = true;

      const docsForDefaults = STRATEGY_DOCS?.flash || null;
      const defaults = getTrailingStopConfig(docsForDefaults);

      const hardStopLossPct = Number.isFinite(Number(payload?.hardStopLossPct))
        ? Number(payload.hardStopLossPct)
        : defaults.hardStopLossPct;

      const basePollMs = Number.isFinite(Number(payload?.trailingPollMs)) ? Number(payload.trailingPollMs) : defaults.pollMs;
      const pollMs = Math.max(1_000, basePollMs);

      async function trailingTick() {
        if (stopped) return;

        try {
          if (!dataClient || typeof dataClient.getMultipleTokenPrices !== 'function') {
            return;
          }

          let skipMissingIds = 0;
          let skipZeroAmt = 0;
          let skipDuplicateMint = 0;
          let skipBadMint = 0;
          const mints = [];
          const seen = new Set();
          for (const pos of previousOpenPositions.values()) {
            if (!pos || !pos.mint || !pos.tradeUuid) {
              skipMissingIds += 1;
              continue;
            }
            const amtRaw = pos.currentTokenAmount;
            const amt = Number(amtRaw);
            if (Number.isFinite(amt) && amt <= 0) {
              skipZeroAmt += 1;
              continue;
            }
            if (seen.has(pos.mint)) {
              skipDuplicateMint += 1;
              continue;
            }
            seen.add(pos.mint);
            mints.push(pos.mint);
          }

          const mintList = Array.isArray(mints)
            ? mints.filter((m) => {
                if (typeof m === 'string' && m.trim().length > 0) return true;
                skipBadMint += 1;
                return false;
              })
            : [];

          if (!mintList.length) {
            sellOpsLogger.debug(
              `[sellOps] trailing-stop mintList empty wallet=${wallet.alias} openPositions=${previousOpenPositions.size} ` +
                `skipMissingIds=${skipMissingIds} skipZeroAmt=${skipZeroAmt} skipDuplicateMint=${skipDuplicateMint} skipBadMint=${skipBadMint}`
            );

            const now = Date.now();
            if (now - lastTrailingHeartbeatTsMs >= 15_000) {
              lastTrailingHeartbeatTsMs = now;
              const hb = {
                ts: now,
                walletAlias: wallet.alias,
                status: 'trailing_stop_idle',
                openPositions: previousOpenPositions.size,
                watchedMints: 0,
                activeStops: 0,
                note: 'no eligible mints to watch',
              };
              sellOpsLogger.debug(
                `[sellOps] heartbeat wallet=${wallet.alias} status=${hb.status} open=${hb.openPositions} watched=${hb.watchedMints} activeStops=${hb.activeStops}`
              );
              emitToParent('sellOps:heartbeat', hb, sendFn);
            }

            return;
          }

          sellOpsLogger.debug(`[sellOps] trailing-stop price fetch wallet=${wallet.alias} mintListLen=${mintList.length} mints=${mintList.join(',')}`);
          const prices = await dataClient.getMultipleTokenPrices(mintList);
          const now = Date.now();

          let watchedCount = 0;
          let activeStops = 0;
          let pricedCount = 0;
          let stalePriceSkips = 0;
          let missingCostSkips = 0;

          for (const pos of previousOpenPositions.values()) {
            if (!pos || !pos.mint || !pos.tradeUuid) continue;
            const mint = pos.mint;
            const tradeUuid = pos.tradeUuid;
            watchedCount += 1;

            const priceObj = prices && prices[mint] ? prices[mint] : null;
            const priceUsd = priceObj && Number.isFinite(Number(priceObj.price)) ? Number(priceObj.price) : null;
            const lastUpdated = priceObj && Number.isFinite(Number(priceObj.lastUpdated)) ? Number(priceObj.lastUpdated) : null;

            if (priceUsd != null && priceUsd > 0) pricedCount += 1;
            if (lastUpdated != null && now - lastUpdated > MAX_PRICE_STALE_MS) {
              stalePriceSkips += 1;
              continue;
            }
            if (priceUsd == null || priceUsd <= 0) continue;

            const existing = trailingStateByTradeUuid.get(tradeUuid) || null;
            const activationPct = existing?.activationPct ?? defaults.activationPct;
            const trailPct = existing?.trailPct ?? defaults.trailPct;
            const breachConfirmations = defaults.breachConfirmations;
            const actionDebounceMs = defaults.actionDebounceMs;

            const costUsd = costUsdByTradeUuid.get(tradeUuid) || null;
            if (!costUsd || !Number.isFinite(Number(costUsd)) || Number(costUsd) <= 0) {
              missingCostSkips += 1;
              continue;
            }

            const roiPct = ((priceUsd / Number(costUsd)) - 1) * 100;

            const state = existing || {
              active: false,
              activationPct,
              trailPct,
              highWaterUsd: priceUsd,
              stopUsd: 0,
              breachCount: 0,
              lastPriceUsd: priceUsd,
              lastPriceTsMs: now,
              lastActionTsMs: 0,
            };

            const stopLossEligible = roiPct <= -Math.abs(Number(hardStopLossPct));
            const stopLossDebounceOk = now - (state.lastActionTsMs || 0) >= actionDebounceMs;

            if (stopLossEligible && stopLossDebounceOk) {
              state.lastActionTsMs = now;

              const actionPayload = {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
                breachCount: state.breachCount,
                breachConfirmations,
                action: 'exit',
                reason: 'stop_loss',
                hardStopLossPct,
              };

              emitToParent('sellOps:stopLoss:trigger', actionPayload, sendFn);

              try {
                const amtNum = Number(pos.currentTokenAmount);
                const amountDecimal = Number.isFinite(amtNum) && amtNum > 0 ? String(amtNum) : null;

                if (!amountDecimal) {
                  sellOpsLogger.warn(
                    `[sellOps] stop-loss swap payload missing amountDecimal; falling back to percent-only wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint} currentTokenAmount=${pos.currentTokenAmount}`
                  );
                }

                await runSwapWithMonitor({
                  walletAlias: wallet.alias,
                  mint,
                  tradeUuid,
                  side: 'sell',

                  ...(amountDecimal ? { amountDecimal, amount: amountDecimal, fromAmountDecimal: amountDecimal } : {}),

                  percent: 1,
                  sellPercent: 100,
                  sellPct: 100,
                  sellAll: true,
                  isSellAll: true,

                  reason: 'stop_loss',
                  source: 'sellOpsWorker',
                  hardStopLossPct,
                }, workerEnv);
              } catch (err) {
                sellOpsLogger.warn(
                  `[sellOps] stop-loss execution failed wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
                );
              }

              trailingStateByTradeUuid.set(tradeUuid, state);
              continue;
            }

            state.lastPriceUsd = priceUsd;
            state.lastPriceTsMs = now;

            if (!state.active && roiPct >= state.activationPct) {
              state.active = true;
              state.highWaterUsd = priceUsd;
              state.stopUsd = priceUsd * (1 - state.trailPct / 100);
              state.breachCount = 0;

              emitToParent('sellOps:trailingStop:armed', {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                activationPct: state.activationPct,
                trailPct: state.trailPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
              }, sendFn);
            }

            if (!state.active) {
              trailingStateByTradeUuid.set(tradeUuid, state);
              continue;
            }
            activeStops += 1;

            if (priceUsd > state.highWaterUsd) {
              state.highWaterUsd = priceUsd;
              state.stopUsd = state.highWaterUsd * (1 - state.trailPct / 100);
              state.breachCount = 0;

              emitToParent('sellOps:trailingStop:high', {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
              }, sendFn);
            }

            if (state.stopUsd > 0 && priceUsd <= state.stopUsd) {
              state.breachCount += 1;
            } else {
              state.breachCount = 0;
            }

            const eligible = state.breachCount >= breachConfirmations;
            const debounceOk = now - (state.lastActionTsMs || 0) >= actionDebounceMs;

            if (eligible && debounceOk) {
              state.lastActionTsMs = now;

              const actionPayload = {
                ts: now,
                walletAlias: wallet.alias,
                tradeUuid,
                mint,
                priceUsd,
                costUsd,
                roiPct,
                highWaterUsd: state.highWaterUsd,
                stopUsd: state.stopUsd,
                breachCount: state.breachCount,
                breachConfirmations,
                action: 'exit',
                reason: 'trailing_stop',
              };

              emitToParent('sellOps:trailingStop:trigger', actionPayload, sendFn);

              try {
                const amtNum = Number(pos.currentTokenAmount);
                const amountDecimal = Number.isFinite(amtNum) && amtNum > 0 ? String(amtNum) : null;

                if (!amountDecimal) {
                  sellOpsLogger.warn(
                    `[sellOps] trailing-stop swap payload missing amountDecimal; falling back to percent-only wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint} currentTokenAmount=${pos.currentTokenAmount}`
                  );
                }

                await runSwapWithMonitor({
                  walletAlias: wallet.alias,
                  mint,
                  tradeUuid,
                  side: 'sell',

                  ...(amountDecimal ? { amountDecimal, amount: amountDecimal, fromAmountDecimal: amountDecimal } : {}),

                  percent: 1,
                  sellPercent: 100,
                  sellPct: 100,
                  sellAll: true,
                  isSellAll: true,

                  reason: 'trailing_stop',
                  source: 'sellOpsWorker',
                }, workerEnv);
              } catch (err) {
                sellOpsLogger.warn(
                  `[sellOps] trailing-stop execution failed wallet=${wallet.alias} trade_uuid=${tradeUuid} mint=${mint}: ${err?.message || err}`
                );
              }
            }

            trailingStateByTradeUuid.set(tradeUuid, state);
          }

          if (now - lastTrailingHeartbeatTsMs >= 15_000) {
            lastTrailingHeartbeatTsMs = now;
            const hb = {
              ts: now,
              walletAlias: wallet.alias,
              status: activeStops > 0 ? 'trailing_stop_armed' : 'trailing_stop',
              openPositions: previousOpenPositions.size,
              watchedMints: mintList.length,
              watchedPositions: watchedCount,
              pricedMints: pricedCount,
              activeStops,
              stalePriceSkips,
              missingCostSkips,
              lastPriceTsMs: now,
            };
            sellOpsLogger.debug(
              `[sellOps] heartbeat wallet=${wallet.alias} status=${hb.status} open=${hb.openPositions} watched=${hb.watchedMints} priced=${hb.pricedMints} activeStops=${hb.activeStops} stale=${hb.stalePriceSkips} missingCost=${hb.missingCostSkips}`
            );
            emitToParent('sellOps:heartbeat', hb, sendFn);
          }
        } catch (err) {
          sellOpsLogger.warn(`[sellOps] trailing-stop tick failed wallet=${wallet.alias}: ${err?.message || err}`);
        } finally {
          if (!stopped) {
            trailingTimer = setTimeout(trailingTick, pollMs);
          }
        }
      }

      trailingTimer = setTimeout(trailingTick, pollMs);
      sellOpsLogger.info(`[sellOps] trailing-stop loop started wallet=${wallet.alias} pollMs=${pollMs}`);
    }

    async function tick() {
      if (stopped) return;

      const tickStartedAt = Date.now();
      try {
        if (!client) {
          const resolvedDataEndpoint =
            (payload?.dataEndpoint && String(payload.dataEndpoint).trim()) ||
            (workerEnv.SOLANATRACKER_URL && String(workerEnv.SOLANATRACKER_URL).trim()) ||
            (workerEnv.SOLANATRACKER_DATA_ENDPOINT && String(workerEnv.SOLANATRACKER_DATA_ENDPOINT).trim()) ||
            (workerEnv.WARCHEST_DATA_ENDPOINT && String(workerEnv.WARCHEST_DATA_ENDPOINT).trim()) ||
            undefined;

          sellOpsLogger.debug(
            `[sellOps] calling setup() walletSpecs[0]=${JSON.stringify({
              alias: wallet.alias,
              pubkey: wallet.pubkey ? String(wallet.pubkey).slice(0, 6) + '…' : null,
              color: wallet.color || null,
            })} dataEndpoint=${
              (payload?.dataEndpoint || workerEnv.SOLANATRACKER_URL || workerEnv.SOLANATRACKER_DATA_ENDPOINT || workerEnv.WARCHEST_DATA_ENDPOINT)
                ? 'set'
                : 'missing'
            }`
          );

          client = await setup({
            walletSpecs: [wallet],
            mode: 'daemon',
            statusDir: payload.statusDir,
            ...(resolvedDataEndpoint ? { dataEndpoint: resolvedDataEndpoint } : {}),
          });
          sellOpsLogger.debug(`[sellOps] setup() returned client keys=${Object.keys(client || {}).join(',') || 'none'}`);
        }
        const ctx = BootyBox.modules && BootyBox.modules.context ? BootyBox.modules.context : null;

        if (!db) {
          db = tools.db || (ctx && ctx.db) || null;
        }

        if (!db && ctx && typeof ctx.getDb === 'function') {
          try {
            db = ctx.getDb();
          } catch (err) {
            sellOpsLogger.warn(`[sellOps] ctx.getDb() failed: ${err?.message || err}`);
          }
        }

        sellOpsLogger.debug(
          `db resolved source=${tools.db ? 'tools.db' : db ? 'bootyboxContext' : 'none'} ` +
            `keys=${Object.keys(db || {}).slice(0, 15).join(',') || 'none'} ` +
            `hasAll=${db && typeof db.all === 'function'} hasPrepare=${db && typeof db.prepare === 'function'}`
        );

        if (!dataClient) {
          dataClient = tools.dataClient || createSolanaTrackerDataClient({ logger: log });
          log.debug('[sellOps] dataClient created (defaults from env)');
        }

        const { rows } = await BootyBox.loadOpenPositions(wallet.alias);
        const summaries = rows.map(toPositionSummary);
        const currentPositions = new Map();
        for (const summary of summaries) {
          if (!summary.tradeUuid) continue;
          currentPositions.set(summary.tradeUuid, summary);
        }

        const closedPositions = [];
        for (const [tradeUuid, summary] of previousOpenPositions.entries()) {
          if (!currentPositions.has(tradeUuid) && !autopsiedTradeUuids.has(tradeUuid)) {
            closedPositions.push(summary);
          }
        }

        for (const tradeUuid of trailingStateByTradeUuid.keys()) {
          if (!currentPositions.has(tradeUuid)) {
            trailingStateByTradeUuid.delete(tradeUuid);
            costUsdByTradeUuid.delete(tradeUuid);
          }
        }

        previousOpenPositions = currentPositions;

        ensureTrailingLoopStarted();

        if (!rows.length) {
          sellOpsLogger.info(`[sellOps] wallet=${wallet.alias} no open positions; rechecking in ${Math.round(pollIntervalMs / 1000)}s`);
          const hb = {
            ts: Date.now(),
            walletAlias: wallet.alias,
            status: 'idle',
            openPositions: 0,
            nextTickMs: pollIntervalMs,
          };
          sellOpsLogger.debug(
            `[sellOps] heartbeat wallet=${wallet.alias} status=${hb.status} open=${hb.openPositions} nextTickMs=${hb.nextTickMs}`
          );
          emitToParent('sellOps:heartbeat', hb, sendFn);
        } else {
          sellOpsLogger.info(`[sellOps] wallet=${wallet.alias} evaluating ${rows.length} open position(s)`);

          for (const summary of summaries) {
            const evalResult = await evaluatePosition({
              position: summary,
              db,
              dataClient,
              eventIntervals: payload.eventIntervals || DEFAULT_EVENT_INTERVALS,
              payload,
              strategyDocs: STRATEGY_DOCS,
              buildEvaluation,
            });
            try {
              const costUsd = resolveAvgCostUsd(summary, evalResult.evaluation);
              if (summary.tradeUuid && costUsd && Number.isFinite(Number(costUsd)) && Number(costUsd) > 0) {
                costUsdByTradeUuid.set(summary.tradeUuid, Number(costUsd));
              }
            } catch (_) {
              // ignore
            }

            const regime = computeMarketRegime(evalResult.evaluation);

            const snapshot = {
              ts: Date.now(),
              walletAlias: wallet.alias,
              tradeUuid: summary.tradeUuid || null,
              mint: summary.mint,
              decision: evalResult.decision,
              reasons: evalResult.reasons,
              regime,
              evaluation: evalResult.evaluation,
            };

            const hudPayload = buildHudPayload(snapshot);
            emitToParent('sellOps:evaluation', hudPayload, sendFn);

            persistSellOpsEvaluation({
              bootyBox: BootyBox,
              summary,
              snapshot,
              hudPayload,
              logger: log,
              walletAlias: wallet.alias,
            });

            const tradeTag = summary.tradeUuid ? `trade_uuid=${summary.tradeUuid}` : 'trade_uuid=?';
            const mintTag = summary.mint ? `mint=${summary.mint}` : 'mint=?';

            const symbolTag = snapshot.evaluation?.symbol ? `symbol=${snapshot.evaluation.symbol}` : 'symbol=n/a';
            const tokenTag = `token=${snapshot.evaluation?.symbol || (summary.mint ? summary.mint.slice(0, 4) : 'mint')}`;

            const priceUsd = snapshot.evaluation?.coin?.priceUsd ?? snapshot.evaluation?.coin?.price_usd;
            const liqUsd = snapshot.evaluation?.pool?.liquidity_usd || snapshot.evaluation?.coin?.liquidityUsd;
            const unrealUsd = snapshot.evaluation?.pnl?.unrealized_usd;
            const totalUsd = snapshot.evaluation?.pnl?.total_usd;
            const roiPct = snapshot.evaluation?.derived?.roiUnrealizedPct;

            const chartType = snapshot.evaluation?.chart?.type;
            const chartPoints = snapshot.evaluation?.chart?.points;
            const ind = snapshot.evaluation?.indicators;
            const rsi = ind?.rsi;
            const macdHist = ind?.macd?.hist;
            const vwap = ind?.vwap;

            sellOpsLogger.info(
              `[sellOps] wallet=${wallet.alias} ${tradeTag} ${tokenTag} ${symbolTag} ${mintTag} decision=${evalResult.decision} reasons=${evalResult.reasons.join(',')} ` +
                `priceUsd=${priceUsd ?? 'n/a'} liquidityUsd=${liqUsd ?? 'n/a'} unrealUsd=${unrealUsd ?? 'n/a'} totalUsd=${totalUsd ?? 'n/a'} ` +
                `roiPct=${roiPct != null ? roiPct.toFixed(2) : 'n/a'} ` +
                `chart=${chartType && chartPoints != null ? `${chartType}:${chartPoints}` : 'n/a'} ` +
                `regime=${snapshot.regime?.status || 'n/a'} rsi=${rsi != null ? rsi.toFixed(2) : 'n/a'} ` +
                `macdHist=${macdHist != null ? Number(macdHist).toFixed(6) : 'n/a'} vwap=${vwap ?? 'n/a'} ` +
                `warnings=${(snapshot.evaluation?.warnings || []).length}`
            );
          }
        }

        if (closedPositions.length) {
          for (const summary of closedPositions) {
            const tradeUuid = summary.tradeUuid;
            if (!tradeUuid || autopsiedTradeUuids.has(tradeUuid)) continue;
            try {
              const result = await runAutopsyForClosedPosition({
                position: summary,
                wallet,
                workerEnv,
                runAutopsy: tools.runAutopsy,
              });
              autopsiedTradeUuids.add(tradeUuid);
              const ai = result?.ai || null;
              emitToParent('sellOps:autopsy', {
                ts: Date.now(),
                walletAlias: wallet.alias,
                tradeUuid,
                mint: summary.mint,
                grade: ai?.grade || null,
                summary: ai?.summary || null,
                tags: Array.isArray(ai?.tags) ? ai.tags : [],
                ai: ai || null,
                artifactPath: result?.artifactPath || null,
              }, sendFn);
            } catch (err) {
              const msg = err?.message || err;
              log.warn(`[sellOps] autopsy failed trade_uuid=${tradeUuid} mint=${summary.mint || 'n/a'}: ${msg}`);
            }
          }
        }
      } catch (err) {
        log.error(`[sellOps] tick failed for wallet=${wallet.alias}: ${err?.message || err}`);
      }

      const elapsedMs = Date.now() - tickStartedAt;
      const nextDelayMs = Math.max(0, pollIntervalMs - elapsedMs);
      pollTimer = setTimeout(tick, nextDelayMs);
      track({
        close: () => {
          if (pollTimer) clearTimeout(pollTimer);
        },
      });
    }

    async function bootstrap() {
      log.info(`[sellOps] started wallet=${wallet.alias} pollIntervalMs=${pollIntervalMs}`);
      await tick();
    }

    bootstrap().catch(reject);
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

module.exports = {
  createSellOpsController,
};
