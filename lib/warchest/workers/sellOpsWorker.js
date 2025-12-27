#!/usr/bin/env node
'use strict';

const logger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { setup } = require('../client');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');
const { buildEvaluation } = require('../../../db/src/services/evaluationService');

const DEFAULT_POLL_MS = 60_000;
// Coin freshness guardrail (how stale is too stale)
const MAX_COIN_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_POOL_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_EVENTS_STALE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_RISK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// Which event intervals we want on every evaluation snapshot
const DEFAULT_EVENT_INTERVALS = ['5m', '15m', '1h'];

/**
 * Token+Pool OHLCV helper.
 *
 * This is intentionally explicit (no name guessing). We create our own SolanaTracker Data client
 * and call the underlying SDK method `getPoolChartData`.
 *
 * @param {object} options
 * @param {{ client: import('@solana-tracker/data-api').Client }} options.dataClient - wrapper returned by createSolanaTrackerDataClient
 * @param {() => number} [options.now] - Clock function, overridable for tests.
 * @returns {(params: { mint: string, poolAddress: string, type?: string, timeFrom?: number, timeTo?: number, marketCap?: boolean, removeOutliers?: boolean, timezone?: string, fastCache?: boolean }) => Promise<any>}
 */
function createTokenPoolOhlcvData(options = {}) {
  const { dataClient, now = () => Date.now() } = options;

  const sdkClient = dataClient?.client;

  if (!sdkClient || typeof sdkClient.getPoolChartData !== 'function') {
    throw new Error('[sellOps] Data client must expose .client.getPoolChartData(...)');
  }

  return async function getTokenPoolOhlcvData(params = {}) {
    const {
      mint,
      poolAddress,
      type,
      timeFrom,
      timeTo,
      marketCap,
      removeOutliers,
      timezone,
      fastCache,
    } = params;

    if (typeof mint !== 'string' || mint.trim() === '') {
      throw new Error('getTokenPoolOhlcvData: mint is required');
    }
    if (typeof poolAddress !== 'string' || poolAddress.trim() === '') {
      throw new Error('getTokenPoolOhlcvData: poolAddress is required');
    }

    const tTo = Number.isFinite(Number(timeTo)) ? Number(timeTo) : now();
    const tFrom = Number.isFinite(Number(timeFrom)) ? Number(timeFrom) : (tTo - 6 * 60 * 60 * 1000);

    return sdkClient.getPoolChartData({
      tokenAddress: mint.trim(),
      poolAddress: poolAddress.trim(),
      type,
      timeFrom: tFrom,
      timeTo: tTo,
      marketCap,
      removeOutliers,
      timezone,
      fastCache,
    });
  };
}

function normalizeWallet(payloadWallet) {
  const wallet = payloadWallet || {};
  const alias = wallet && (wallet.alias || wallet.walletAlias || wallet.name);
  const pubkey = wallet && (wallet.pubkey || wallet.wallet || wallet.address);

  if (!alias) {
    throw new Error('sellOps requires wallet alias');
  }

  // pubkey is optional for SellOps (DB-driven), but keep it if provided.
  return {
    alias: String(alias).trim(),
    pubkey: pubkey ? String(pubkey).trim() : null,
    color: wallet.color || null,
  };
}

function resolveDb(client) {
  // We intentionally support a few common shapes to avoid tight coupling.
  // The returned object must support either `query(sql, params)` or `execute(sql, params)`.
  return (
    client?.db ||
    client?.bootybox?.db ||
    client?.bootyBox?.db ||
    client?.bootybox ||
    client?.bootyBox ||
    client?.mysql ||
    client?.pool ||
    null
  );
}

async function dbQuery(db, sql, params) {
  if (!db) throw new Error('sellOps missing DB handle (expected client.db or BootyBox adapter)');

  if (typeof db.query === 'function') {
    return db.query(sql, params);
  }
  if (typeof db.execute === 'function') {
    return db.execute(sql, params);
  }

  throw new Error('sellOps DB handle does not support query() or execute()');
}

function normalizeRows(result) {
  // mysql2: [rows, fields]
  // some adapters: { rows }
  // some: rows
  if (Array.isArray(result)) {
    // mysql2 returns [rows, fields]
    if (Array.isArray(result[0])) return result[0];
    return result;
  }
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.result)) return result.result;
  return [];
}


function toPositionSummary(row) {
  return {
    positionId: row.position_id,
    walletId: row.wallet_id,
    walletAlias: row.wallet_alias,
    mint: row.coin_mint,
    tradeUuid: row.trade_uuid,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    openAt: row.open_at,
    closedAt: row.closed_at,
    lastTradeAt: row.last_trade_at,
    lastUpdatedAt: row.last_updated_at,
    entryTokenAmount: row.entry_token_amount,
    currentTokenAmount: row.current_token_amount,
    totalTokensBought: row.total_tokens_bought,
    totalTokensSold: row.total_tokens_sold,
    entryPriceSol: row.entry_price_sol,
    entryPriceUsd: row.entry_price_usd,
    lastPriceSol: row.last_price_sol,
    lastPriceUsd: row.last_price_usd,
    source: row.source,
  };
}

async function loadOpenPositions(db, walletAlias) {
  // sc_positions schema (provided):
  // - closed_at: INTEGER NOT NULL DEFAULT 0  -> open positions have closed_at = 0
  // - current_token_amount: REAL            -> open positions should generally have > 0
  //
  // NOTE: The user message said "closed_at <> 0" but the schema implies the opposite.
  // We treat "open" as closed_at = 0.
  const sql = `
    SELECT *
    FROM sc_positions
    WHERE wallet_alias = ?
      AND COALESCE(current_token_amount, 0) > 0
      AND COALESCE(closed_at, 0) = 0
  `;

  const res = await dbQuery(db, sql, [walletAlias]);
  const rows = normalizeRows(res);

  return { rows };
}

// --- Full evaluation snapshot ---
async function evaluatePosition({ position, db, dataClient, eventIntervals }) {
  const reasons = [];

  // Build a complete, DB-backed snapshot (shared across apps)
  const { evaluation, warnings } = await buildEvaluation({
    db,
    position,
    dataClient,
    eventIntervals: eventIntervals || DEFAULT_EVENT_INTERVALS,
    freshness: {
      coin: MAX_COIN_STALE_MS,
      pool: MAX_POOL_STALE_MS,
      events: MAX_EVENTS_STALE_MS,
      risk: MAX_RISK_STALE_MS,
    },
  });

  // For now we do not take action. Phase 2 will score and pick buy/hold/sell.
  const decision = 'hold';

  if (!warnings || !warnings.length) {
    reasons.push('evaluation_ready');
  } else {
    reasons.push('evaluation_partial');
  }

  return { decision, reasons, evaluation };
}

/**
 * Create a SellOps controller.
 *
 * Payload contract:
 * - payload.wallet: { alias|walletAlias|name, pubkey? }
 * - payload.pollIntervalMs?: number (defaults to 60s)
 * - payload.statusDir?: optional status dir forwarded to setup()
 */
function createSellOpsController(payload, tools = {}) {
  const wallet = normalizeWallet(payload.wallet || payload);
  const pollIntervalMs = payload.pollIntervalMs || DEFAULT_POLL_MS;

  const track = typeof tools.track === 'function' ? tools.track : () => {};
  const workerEnv = tools.env || process.env;

  let client = tools.client || null;
  const ownsClient = !client;
  let db = null;
  let dataClient = null;
  let tokenPoolOhlcv = null;

  let stopped = false;
  let stopReason = null;
  let pollTimer = null;
  let stopFn = null;

  const finalPromise = new Promise((resolve, reject) => {
    async function cleanup() {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }

      if (dataClient && typeof dataClient.close === 'function') {
        try {
          await dataClient.close();
        } catch (err) {
          logger.warn(`[sellOps] data client close failed: ${err?.message || err}`);
        }
      }

      if (client && ownsClient && typeof client.close === 'function') {
        try {
          await client.close();
        } catch (err) {
          logger.warn(`[sellOps] client close failed: ${err?.message || err}`);
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
      resolve(result);
    }

    async function tick() {
      if (stopped) return;

      try {
        // Ensure client/db are available
        if (!client) {
          client = await setup({
            walletSpecs: [wallet],
            mode: 'daemon',
            statusDir: payload.statusDir,
            // Harness/buildWorkerEnv sets this; keep SellOps explicit and predictable.
            dataEndpoint: workerEnv.WARCHEST_DATA_ENDPOINT,
          });
        }

        db = db || tools.db || resolveDb(client);

        // Data API client: create explicitly from harness env (no name guessing).
        if (!dataClient) {
          const baseUrl = workerEnv.WARCHEST_DATA_ENDPOINT;
          const apiKey = workerEnv.SOLANATRACKER_API_KEY;

          if (!baseUrl) {
            throw new Error('[sellOps] WARCHEST_DATA_ENDPOINT is required to fetch chart/OHLCV data');
          }

          dataClient = tools.dataClient || createSolanaTrackerDataClient({
            baseUrl,
            apiKey,
            logger,
          });
        }

        // Bind our token+pool OHLCV helper once.
        tokenPoolOhlcv = tokenPoolOhlcv || createTokenPoolOhlcvData({ dataClient });

        const { rows } = await loadOpenPositions(db, wallet.alias);

        if (!rows.length) {
          logger.info(`[sellOps] wallet=${wallet.alias} no open positions; rechecking in ${Math.round(pollIntervalMs / 1000)}s`);
        } else {
          // Evaluate each open position every tick (per your spec).
          // We group logs by trade_uuid if present.
          logger.info(`[sellOps] wallet=${wallet.alias} evaluating ${rows.length} open position(s)`);

          for (const row of rows) {
            const summary = toPositionSummary(row);
            const evalResult = await evaluatePosition({
              position: summary,
              db,
              dataClient,
              eventIntervals: payload.eventIntervals || DEFAULT_EVENT_INTERVALS,
            });

            // Phase 1 chart pull (best-effort): token + pool pair.
            // We keep this lightweight for now: fetch recent candles and attach a summary.
            if (tokenPoolOhlcv) {
              const poolAddress =
                evalResult.evaluation?.pool?.poolAddress ||
                evalResult.evaluation?.pool?.address ||
                evalResult.evaluation?.pool?.market ||
                null;

              if (poolAddress) {
                const now = Date.now();
                const lookbackMs = payload.ohlcvLookbackMs || 6 * 60 * 60 * 1000; // 6h
                const type = payload.ohlcvType || '5m';

                try {
                  const ohlcv = await tokenPoolOhlcv({
                    mint: summary.mint,
                    poolAddress,
                    type,
                    timeFrom: now - lookbackMs,
                    timeTo: now,
                    // fastCache keeps the API cheap if supported
                    fastCache: true,
                  });

                  const points = Array.isArray(ohlcv?.data) ? ohlcv.data.length : Array.isArray(ohlcv) ? ohlcv.length : null;

                  evalResult.evaluation = evalResult.evaluation || {};
                  evalResult.evaluation.ohlcv = {
                    type,
                    lookbackMs,
                    poolAddress,
                    points,
                    // keep raw payload optional (off by default)
                    raw: payload.includeOhlcvRaw ? ohlcv : undefined,
                  };
                } catch (err) {
                  logger.warn(
                    `[sellOps] OHLCV fetch failed wallet=${wallet.alias} mint=${summary.mint} pool=${poolAddress}: ${err?.message || err}`
                  );
                }
              }
            }

            const tradeTag = summary.tradeUuid ? `trade_uuid=${summary.tradeUuid}` : 'trade_uuid=?';
            const mintTag = summary.mint ? `mint=${summary.mint}` : 'mint=?';

            const priceUsd = evalResult.evaluation?.coin?.priceUsd ?? evalResult.evaluation?.coin?.price_usd;
            const liqUsd = evalResult.evaluation?.pool?.liquidity_usd || evalResult.evaluation?.coin?.liquidityUsd;
            const unrealUsd = evalResult.evaluation?.pnl?.unrealized_usd;
            const totalUsd = evalResult.evaluation?.pnl?.total_usd;
            const roiPct = evalResult.evaluation?.derived?.roiUnrealizedPct;

            const ohlcvType = evalResult.evaluation?.ohlcv?.type;
            const ohlcvPoints = evalResult.evaluation?.ohlcv?.points;

            logger.info(
              `[sellOps] wallet=${wallet.alias} ${tradeTag} ${mintTag} decision=${evalResult.decision} reasons=${evalResult.reasons.join(',')} ` +
                `priceUsd=${priceUsd ?? 'n/a'} liquidityUsd=${liqUsd ?? 'n/a'} unrealUsd=${unrealUsd ?? 'n/a'} totalUsd=${totalUsd ?? 'n/a'} ` +
                `roiPct=${roiPct != null ? roiPct.toFixed(2) : 'n/a'} ` +
                `ohlcv=${ohlcvType && ohlcvPoints != null ? `${ohlcvType}:${ohlcvPoints}` : 'n/a'} ` +
                `warnings=${(evalResult.evaluation?.warnings || []).length}`
            );
          }
        }
      } catch (err) {
        // Don’t crash the worker on transient errors; log + continue.
        logger.error(`[sellOps] tick failed for wallet=${wallet.alias}: ${err?.message || err}`);
      }

      // Schedule next tick
      pollTimer = setTimeout(tick, pollIntervalMs);
      track({
        close: () => {
          if (pollTimer) clearTimeout(pollTimer);
        },
      });
    }

    async function bootstrap() {
      logger.info(`[sellOps] started wallet=${wallet.alias} pollIntervalMs=${pollIntervalMs}`);
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

/**
 * Start SellOps via IPC harness.
 */
function startHarness() {
  let controller = null;

  createWorkerHarness(
    async (payload, { track, env }) => {
      // Accept either `{ wallet: { alias } }` or `{ walletAlias }` style payloads.
      const walletAlias = payload?.walletAlias || payload?.alias || payload?.wallet?.alias || payload?.wallet?.walletAlias;
      const walletPubkey = payload?.walletPubkey || payload?.pubkey || payload?.wallet?.pubkey;

      controller = createSellOpsController(
        {
          ...payload,
          wallet: payload?.wallet || { alias: walletAlias, pubkey: walletPubkey },
        },
        { track, env }
      );

      return controller.start();
    },
    {
      exitOnComplete: false, // long-lived loop
      workerName: 'sellOps',
      metricsReporter: (event) => {
        logger.debug?.(`[sellOps][metrics] ${JSON.stringify(event)}`);
      },
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
  createSellOpsController,
  startHarness,
};
