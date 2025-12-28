#!/usr/bin/env node
'use strict';

const logger = require('../../logger');
const BootyBox = require('../../../db/src/adapters/sqlite');
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

function emitToParent(type, payload) {
  // Worker processes launched by the harness can send structured messages to the parent.
  // The parent (warchest daemon/HUD) can forward these to the HUD renderer.
  if (typeof process.send === 'function') {
    process.send({ type, payload });
  }
}

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && /(key|secret|token|password|private)/i.test(k)) {
      out[k] = v ? '[redacted]' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
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

function computeRegime(evaluation) {
  const ind = evaluation?.indicators || null;
  const chart = evaluation?.chart || null;

  if (!ind || !chart) {
    return { status: 'unknown', reasons: ['missing_indicators_or_chart'] };
  }

  const last = Number.isFinite(Number(ind.lastClose)) ? Number(ind.lastClose) : null;
  const emaFast = Number.isFinite(Number(ind.emaFast)) ? Number(ind.emaFast) : null;
  const emaSlow = Number.isFinite(Number(ind.emaSlow)) ? Number(ind.emaSlow) : null;
  const rsi = Number.isFinite(Number(ind.rsi)) ? Number(ind.rsi) : null;
  const atr = Number.isFinite(Number(ind.atr)) ? Number(ind.atr) : null;
  const vwap = Number.isFinite(Number(ind.vwap)) ? Number(ind.vwap) : null;
  const macd = ind.macd && typeof ind.macd === 'object' ? ind.macd : null;

  const reasons = [];

  // Trend
  let trend = 'unknown';
  if (emaFast != null && emaSlow != null) {
    if (emaFast > emaSlow) trend = 'up';
    else if (emaFast < emaSlow) trend = 'down';
    else trend = 'flat';
    reasons.push(`trend:${trend}`);
  }

  // Momentum (MACD)
  let momentum = 'unknown';
  if (macd && Number.isFinite(Number(macd.hist))) {
    const h = Number(macd.hist);
    momentum = h > 0 ? 'bullish' : h < 0 ? 'bearish' : 'neutral';
    reasons.push(`macd:${momentum}`);
  }

  // RSI bands
  if (rsi != null) {
    if (rsi >= 70) reasons.push('rsi:overbought');
    else if (rsi <= 30) reasons.push('rsi:oversold');
    else reasons.push('rsi:mid');
  }

  // Price vs VWAP
  if (last != null && vwap != null) {
    if (last > vwap) reasons.push('price>vwap');
    else if (last < vwap) reasons.push('price<vwap');
    else reasons.push('price=vwap');
  }

  // Volatility (ATR relative)
  if (last != null && atr != null && last !== 0) {
    const atrPct = (atr / last) * 100;
    if (Number.isFinite(atrPct)) {
      reasons.push(`atrPct:${atrPct.toFixed(2)}`);
    }
  }

  // Regime label (simple)
  let status = 'chop';
  if (trend === 'up' && momentum === 'bullish') status = 'trend_up';
  else if (trend === 'down' && momentum === 'bearish') status = 'trend_down';
  else if (trend === 'up' && momentum !== 'bearish') status = 'bias_up';
  else if (trend === 'down' && momentum !== 'bullish') status = 'bias_down';

  return { status, reasons };
}


// --- Full evaluation snapshot ---
async function evaluatePosition({ position, db, dataClient, eventIntervals, payload }) {
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
    ohlcv: {
      type: payload?.ohlcvType || '1m',
      lookbackMs: payload?.ohlcvLookbackMs || 60 * 60 * 1000, // 60m default
      fastCache: true,
      removeOutliers: true,
    },
    indicators: {
      // VWAP over last N candles if provided; otherwise full lookback
      vwapPeriods: payload?.vwapPeriods ?? null,
    },
    includeCandles: Boolean(payload?.includeCandles),
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

  // Ensure BootyBox sqlite adapter/context is initialized once per worker process.
  try {
    if (typeof BootyBox.init === 'function') BootyBox.init();
  } catch (err) {
    logger.warn(`[sellOps] BootyBox.init() failed: ${err?.message || err}`);
  }

  let client = tools.client || null;
  const ownsClient = !client;
  let db = null;
  let dataClient = null;

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
          // Prefer explicit payload override, otherwise fall back to the normal SolanaTracker env vars.
          const resolvedDataEndpoint =
            (payload?.dataEndpoint && String(payload.dataEndpoint).trim()) ||
            (workerEnv.SOLANATRACKER_URL && String(workerEnv.SOLANATRACKER_URL).trim()) ||
            (workerEnv.SOLANATRACKER_DATA_ENDPOINT && String(workerEnv.SOLANATRACKER_DATA_ENDPOINT).trim()) ||
            (workerEnv.WARCHEST_DATA_ENDPOINT && String(workerEnv.WARCHEST_DATA_ENDPOINT).trim()) ||
            undefined;

          logger.debug(
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
            // Allow setup() to use its own defaults if undefined.
            ...(resolvedDataEndpoint ? { dataEndpoint: resolvedDataEndpoint } : {}),
          });
          logger.debug(`[sellOps] setup() returned client keys=${Object.keys(client || {}).join(',') || 'none'}`);
        }
        // SQLite-only: DB should come from BootyBox sqlite context (or injected tools.db)
        const ctx = BootyBox.modules && BootyBox.modules.context ? BootyBox.modules.context : null;

        // Prefer injected db (tests), otherwise use BootyBox context.
        if (!db) {
          db = tools.db || (ctx && ctx.db) || null;
        }

        // If context exposes a getter, fall back to it.
        if (!db && ctx && typeof ctx.getDb === 'function') {
          try {
            db = ctx.getDb();
          } catch (err) {
            logger.warn(`[sellOps] ctx.getDb() failed: ${err?.message || err}`);
          }
        }

        logger.debug(
          `[sellOps] db resolved source=${tools.db ? 'tools.db' : db ? 'bootyboxContext' : 'none'} ` +
            `keys=${Object.keys(db || {}).slice(0, 15).join(',') || 'none'} ` +
            `hasAll=${db && typeof db.all === 'function'} hasPrepare=${db && typeof db.prepare === 'function'}`
        );

        // Data API client: let the client load defaults from env (safeDotenv + context).
        // This keeps SellOps consistent with the rest of Scoundrel and avoids harness-only env names.
        if (!dataClient) {
          dataClient = tools.dataClient || createSolanaTrackerDataClient({ logger });
          logger.debug('[sellOps] dataClient created (defaults from env)');
        }

        const { rows } = await BootyBox.loadOpenPositions(wallet.alias);

        if (!rows.length) {
          logger.info(`[sellOps] wallet=${wallet.alias} no open positions; rechecking in ${Math.round(pollIntervalMs / 1000)}s`);
          emitToParent('sellOps:heartbeat', {
            ts: Date.now(),
            walletAlias: wallet.alias,
            status: 'idle',
            openPositions: 0,
            nextTickMs: pollIntervalMs,
          });
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
              payload,
            });

            const regime = computeRegime(evalResult.evaluation);

            // Final assembled snapshot (in-memory for now; persistence later)
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

            // Emit a compact payload for HUD display (avoid huge candle arrays).
            const indForHud = snapshot.evaluation?.indicators || {};
            const hudPayload = {
              ts: snapshot.ts,
              walletAlias: snapshot.walletAlias,
              tradeUuid: snapshot.tradeUuid,
              mint: snapshot.mint,
              decision: snapshot.decision,
              reasons: snapshot.reasons,
              regime: snapshot.regime,
              chart: snapshot.evaluation?.chart
                ? {
                    type: snapshot.evaluation.chart.type,
                    points: snapshot.evaluation.chart.points,
                    poolAddress: snapshot.evaluation.chart.poolAddress,
                    timeFrom: snapshot.evaluation.chart.timeFrom,
                    timeTo: snapshot.evaluation.chart.timeTo,
                  }
                : null,
              metrics: {
                priceUsd: snapshot.evaluation?.coin?.priceUsd ?? snapshot.evaluation?.coin?.price_usd ?? null,
                liquidityUsd: snapshot.evaluation?.pool?.liquidity_usd ?? snapshot.evaluation?.coin?.liquidityUsd ?? null,
                unrealizedUsd: snapshot.evaluation?.pnl?.unrealized_usd ?? null,
                totalUsd: snapshot.evaluation?.pnl?.total_usd ?? null,
                roiUnrealizedPct: snapshot.evaluation?.derived?.roiUnrealizedPct ?? null,
              },
              indicators: {
                rsi: indForHud.rsi ?? null,
                atr: indForHud.atr ?? null,
                emaFast: indForHud.emaFast ?? null,
                emaSlow: indForHud.emaSlow ?? null,
                macdHist: indForHud.macd?.hist ?? null,
                vwap: indForHud.vwap ?? null,
                vwapVolume: indForHud.vwapVolume ?? null,
              },
              warnings: snapshot.evaluation?.warnings || [],
            };

            emitToParent('sellOps:evaluation', hudPayload);

            const tradeTag = summary.tradeUuid ? `trade_uuid=${summary.tradeUuid}` : 'trade_uuid=?';
            const mintTag = summary.mint ? `mint=${summary.mint}` : 'mint=?';

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

            logger.info(
              `[sellOps] wallet=${wallet.alias} ${tradeTag} ${mintTag} decision=${evalResult.decision} reasons=${evalResult.reasons.join(',')} ` +
                `priceUsd=${priceUsd ?? 'n/a'} liquidityUsd=${liqUsd ?? 'n/a'} unrealUsd=${unrealUsd ?? 'n/a'} totalUsd=${totalUsd ?? 'n/a'} ` +
                `roiPct=${roiPct != null ? roiPct.toFixed(2) : 'n/a'} ` +
                `chart=${chartType && chartPoints != null ? `${chartType}:${chartPoints}` : 'n/a'} ` +
                `regime=${snapshot.regime?.status || 'n/a'} rsi=${rsi != null ? rsi.toFixed(2) : 'n/a'} ` +
                `macdHist=${macdHist != null ? Number(macdHist).toFixed(6) : 'n/a'} vwap=${vwap ?? 'n/a'} ` +
                `warnings=${(snapshot.evaluation?.warnings || []).length}`
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

      logger.debug(
        `[sellOps] IPC payload received keys=${Object.keys(payload || {}).join(',') || 'none'} ` +
          `walletAlias=${walletAlias || 'n/a'} walletPubkey=${walletPubkey ? String(walletPubkey).slice(0, 6) + '…' : 'n/a'}`
      );

      logger.debug(`[sellOps] IPC payload snapshot ${JSON.stringify(redact(payload || {}))}`);

      logger.debug(
        `[sellOps] env presence WARCHEST_DATA_ENDPOINT=${env?.WARCHEST_DATA_ENDPOINT ? 'yes' : 'no'} ` +
          `SOLANATRACKER_API_KEY=${env?.SOLANATRACKER_API_KEY ? 'yes' : 'no'}`
      );

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
