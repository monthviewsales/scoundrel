'use strict';

const path = require('path');

const BootyBox = require('../../db');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { ensureTokenInfo } = require('../services/tokenInfoService');
const {
  buildMetaBlock,
  buildTokenSummary,
  buildMarketOverview,
  buildFinalPayload,
  pruneNullishPayload,
} = require('../analysis/payloadBuilders');
const { queueVectorStoreUpload } = require('../ai/vectorStoreUpload');
const { buildOhlcvContext } = require('../analysis/ohlcvContext');
const {
  buildAthPriceArtifact,
  buildPriceRangeArtifact,
  buildDevscanMetadataArtifact,
} = require('../analysis/apiArtifacts');
const { createAnalysisFlow } = require('../cli/analysisFlow');
const { ensureBootyBoxInit } = require('../bootyBoxInit');
const { spawnWorkerDetached } = require('../warchest/workers/harness');
const { appendHubEvent } = require('../warchest/events');
const { analyzeTargetScan } = require('../../ai/jobs/targetScan');
const logger = require('../logger').child({ scope: 'targetScan' });
const pkg = require('../../package.json');

const DEFAULT_CONCURRENCY = 4;
const OHLCV_LOOKBACK_SEC = 20 * 60;
const DEVSCAN_SOURCE = 'devscan';
const TARGETSCAN_SKIP_VECTOR_STORE_ENV = 'TARGETSCAN_SKIP_VECTOR_STORE';
const TARGETSCAN_SEND_VECTOR_STORE_ENV = 'TARGETSCAN_SEND_VECTOR_STORE';

/**
 * Build a compact prompt payload for vector store uploads.
 * Drops large arrays and keeps summary fields for RAG retrieval.
 *
 * @param {Object} payload
 * @returns {Object}
 */
function buildTargetScanVectorPrompt(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const tokenSummary = payload?.token?.summary || null;
  const market = payload?.token?.market || null;
  const analytics = payload?.analytics || null;

  const compactMarket = market && typeof market === 'object'
    ? {
        holders: market.holders ?? null,
        txns: market.txns ?? null,
        risk: market.risk ?? null,
        pool: market.pool ?? null,
      }
    : null;

  const priceRange = analytics?.priceRange || null;
  const athPrice = analytics?.athPrice || null;
  const ohlcv = analytics?.ohlcv || null;

  const compactOhlcv = ohlcv && typeof ohlcv === 'object'
    ? {
        granularity: ohlcv.granularity ?? null,
        startTimestamp: ohlcv.startTimestamp ?? null,
        endTimestamp: ohlcv.endTimestamp ?? null,
        points: ohlcv.points ?? null,
        indicatorPoints: ohlcv.indicatorPoints ?? null,
        summary: ohlcv.summary ?? null,
        summaryWindows: ohlcv.summaryWindows ?? null,
        volumeProfile: ohlcv.volumeProfile ?? null,
        indicators: ohlcv.indicators ?? null,
        derived: ohlcv.derived ?? null,
        regime: ohlcv.regime ?? null,
        warnings: ohlcv.warnings ?? null,
      }
    : null;

  const compactAnalytics = pruneNullishPayload({
    priceRange: priceRange
      ? {
          request: priceRange.request ?? null,
          fetchedAt: priceRange.fetchedAt ?? null,
          summary: priceRange.summary ?? null,
        }
      : null,
    athPrice: athPrice
      ? {
          fetchedAt: athPrice.fetchedAt ?? null,
          summary: athPrice.summary ?? null,
        }
      : null,
    ohlcv: compactOhlcv,
  });

  return pruneNullishPayload({
    meta: payload?.meta || null,
    token: {
      summary: tokenSummary,
      market: compactMarket,
    },
    analytics: compactAnalytics,
    devscan: payload?.devscan || null,
  });
}

/**
 * Build a compact final payload for vector store ingestion.
 *
 * @param {Object} params
 * @param {Object} params.payload
 * @param {Object} params.analysis
 * @returns {Object}
 */
function buildTargetScanVectorPayload({ payload, analysis }) {
  const prompt = buildTargetScanVectorPrompt(payload);
  return buildFinalPayload({ prompt, response: analysis });
}

/**
 * Normalize mint input into a unique list.
 *
 * @param {string|string[]|Array} input
 * @returns {string[]}
 */
function normalizeMintList(input) {
  const raw = [];

  const pushValue = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    if (typeof value === 'string') {
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => raw.push(item));
      return;
    }
    raw.push(String(value));
  };

  pushValue(input);

  const seen = new Set();
  const unique = [];
  for (const mint of raw) {
    const key = String(mint).trim();
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(key);
  }
  return unique;
}

function parseBooleanFlag(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

/**
 * Normalize options for a target scan.
 *
 * @param {Object} options
 * @returns {{ mints: string[], runAnalysis: boolean, concurrency: number, skipVectorStore: boolean, forceTokenRefresh: boolean, sendVectorStore: boolean, manual: boolean, client?: Object }}
 */
function normalizeTargetScanOptions(options = {}) {
  const mints = normalizeMintList([options.mint, options.mints, options.list, options.input]);
  const runAnalysis = options.runAnalysis !== false;
  const envSkipVectorStore = parseBooleanFlag(process.env[TARGETSCAN_SKIP_VECTOR_STORE_ENV]);
  const envSendVectorStore = parseBooleanFlag(process.env[TARGETSCAN_SEND_VECTOR_STORE_ENV]);
  const explicitSkipVectorStore =
    typeof options.skipVectorStore === 'boolean'
      ? options.skipVectorStore
      : null;
  const explicitSendVectorStore =
    typeof options.sendVectorStore === 'boolean'
      ? options.sendVectorStore
      : null;
  const sendVectorStore =
    explicitSendVectorStore !== null
      ? explicitSendVectorStore === true
      : envSendVectorStore === true;
  const skipVectorStore =
    explicitSkipVectorStore === true
      ? true
      : (!sendVectorStore && envSkipVectorStore === true)
        ? true
        : !sendVectorStore;
  const concurrency = Number.isFinite(Number(options.concurrency))
    ? Math.max(1, Number(options.concurrency))
    : DEFAULT_CONCURRENCY;
  const forceTokenRefresh =
    typeof options.forceTokenRefresh === 'boolean'
      ? options.forceTokenRefresh
      : false;
  const manual = parseBooleanFlag(options.manual) === true;

  return {
    mints,
    runAnalysis,
    skipVectorStore,
    concurrency,
    forceTokenRefresh,
    sendVectorStore,
    manual,
    client: options.client,
  };
}

/**
 * Spawn a detached DevScan worker for mint metadata (best-effort).
 *
 * @param {string} mint
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onSpawn]
 */
function spawnDevscanMintWorker(mint, options = {}) {
  if (!mint) return;
  if (!process.env.DEVSCAN_API_KEY) return;
  if (options.signal && options.signal.aborted) return;

  try {
    const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'devscanWorker.js');
    const spawned = spawnWorkerDetached(workerPath, {
      payload: {
        mint,
        runAnalysis: false,
      },
      payloadFilePrefix: `devscan-mint-${mint}`,
    });
    if (options.onSpawn) options.onSpawn(spawned);
  } catch (err) {
    logger.debug('[targetScan] devscan spawn failed', { mint, err: err?.message || err });
  }
}

/**
 * Create a cancellation-aware spawn helper for devscan workers.
 *
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onSpawn]
 * @returns {(mint: string) => void}
 */
function createDevscanSpawner(opts = {}) {
  const signal = opts.signal || null;
  const onSpawn = typeof opts.onSpawn === 'function' ? opts.onSpawn : null;
  return (mint) => spawnDevscanMintWorker(mint, { signal, onSpawn });
}

/**
 * Track detached worker PIDs and terminate them on abort.
 *
 * @param {AbortSignal} [signal]
 * @returns {{ onSpawn: Function, killAll: Function }}
 */
function createDetachedWorkerTracker(signal) {
  const pids = new Set();
  let killTimer = null;

  const onSpawn = (spawned) => {
    if (spawned && Number.isFinite(Number(spawned.pid))) {
      pids.add(Number(spawned.pid));
    }
  };

  const killAll = () => {
    if (!pids.size) return;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (_) {
        // Ignore kill failures; process may already be gone.
      }
    }
    killTimer = setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) {
          // Ignore kill failures.
        }
      }
    }, 2000);
  };

  if (signal) {
    if (signal.aborted) {
      killAll();
    } else {
      signal.addEventListener('abort', killAll, { once: true });
    }
  }

  return { onSpawn, killAll };
}

/**
 * Load devscan metadata from the DB if available.
 *
 * @param {string} mint
 * @returns {Promise<Object|null>}
 */
async function loadDevscanMetadata(mint) {
  if (!mint) return null;
  try {
    await ensureBootyBoxInit();
  } catch (err) {
    return null;
  }
  if (typeof BootyBox.getCoinMetadataByMint !== 'function') return null;
  try {
    return BootyBox.getCoinMetadataByMint(mint, DEVSCAN_SOURCE);
  } catch (err) {
    logger.debug('[targetScan] devscan metadata lookup failed', { mint, err: err?.message || err });
    return null;
  }
}

/**
 * Normalize OHLCV responses into candle rows.
 *
 * @param {any} response
 * @returns {Array}
 */
function extractOhlcvRows(response) {
  if (!response) return [];
  if (Array.isArray(response?.oclhv)) return response.oclhv;
  if (Array.isArray(response?.candles)) return response.candles;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

/**
 * Map targetscan rating to target status.
 *
 * @param {string} rating
 * @returns {string|null}
 */
function mapRatingToStatus(rating) {
  if (!rating) return null;
  const normalized = String(rating).trim().toLowerCase();
  const allowed = new Set(['strong_buy', 'buy', 'watch', 'avoid']);
  return allowed.has(normalized) ? normalized : null;
}

function formatBuyScore(score) {
  if (!Number.isFinite(score)) return null;
  const text = score.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/**
 * Build a readable label for HUD event summaries.
 *
 * @param {{ mint: string, symbol?: string|null, name?: string|null }} params
 * @returns {string}
 */
function formatTargetLabel({ mint, symbol, name }) {
  const parts = [];
  if (symbol) parts.push(symbol);
  if (name && (!symbol || name.toLowerCase() !== symbol.toLowerCase())) {
    parts.push(name);
  }
  if (!parts.length) return mint;
  return `${parts.join(' / ')} (${mint})`;
}

/**
 * Append a HUD event when a target is added/updated from targetscan.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {string|null} params.symbol
 * @param {string|null} params.name
 * @param {string|null} params.status
 * @param {string|null} params.rating
 * @param {number|null} params.score
 * @param {string|null} params.source
 * @param {boolean} [params.manual]
 * @param {{ symbol?: string|null, buyScore?: number, summary?: string|null }} [params.analysis]
 */
function appendTargetAddedEvent({
  mint,
  symbol,
  name,
  status,
  rating,
  score,
  source,
  manual,
  analysis,
}) {
  if (!mint) return;
  const analysisSummary = typeof analysis?.summary === 'string' ? analysis.summary.trim() : '';
  const analysisScore = Number.isFinite(analysis?.buyScore) ? analysis.buyScore : null;
  const analysisSymbol = analysis?.symbol || symbol || name || mint;
  let summary;

  if (manual === true && analysisSummary && Number.isFinite(analysisScore)) {
    const scoreText = formatBuyScore(analysisScore);
    summary = `${analysisSymbol} buyScore=${scoreText} ${analysisSummary}`;
  } else {
    const label = formatTargetLabel({ mint, symbol, name });
    const statusLabel = status ? `status=${status}` : null;
    const ratingLabel = rating ? `rating=${rating}` : null;
    const scoreLabel = Number.isFinite(score) ? `score=${Math.round(score)}` : null;
    const suffix = [statusLabel, ratingLabel, scoreLabel].filter(Boolean).join(' ');
    summary = suffix ? `Target added: ${label} ${suffix}` : `Target added: ${label}`;
  }
  try {
    appendHubEvent({
      type: 'targetAdded',
      summary,
      observedAt: new Date().toISOString(),
      mint,
      symbol: symbol || null,
      name: name || null,
      buyScore: Number.isFinite(analysisScore) ? analysisScore : null,
      analysisSummary: analysisSummary || null,
      status: status || null,
      rating: rating || null,
      score: Number.isFinite(score) ? score : null,
      source: source || 'targetscan',
    });
  } catch (err) {
    logger.warn('[targetScan] failed to append hub event:', err?.message || err);
  }
}

/**
 * Build an addUpdateTarget payload from a scan result.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {Object} params.payload
 * @param {Object} params.analysis
 * @param {Object|null} params.existing
 * @returns {Object}
 */
function buildTargetUpdateFromScan({
  mint, payload, analysis, existing,
}) {
  const now = Date.now();
  const analysisSummary = typeof analysis?.summary === 'string' ? analysis.summary.trim() : '';
  const existingNotes = typeof existing?.notes === 'string' ? existing.notes.trim() : '';
  const analysisScore = Number(analysis?.buyScore);
  const analysisConfidence = Number(analysis?.confidence);
  const statusFromRating = mapRatingToStatus(analysis?.rating);

  const resolvedScore = Number.isFinite(analysisScore)
    ? analysisScore
    : (Number.isFinite(existing?.score) ? existing.score : null);
  const resolvedConfidence = Number.isFinite(analysisConfidence)
    ? analysisConfidence
    : (Number.isFinite(existing?.confidence) ? existing.confidence : null);
  const resolvedNotes = analysisSummary
    ? (existingNotes && !existingNotes.includes(analysisSummary)
      ? `${existingNotes}\n${analysisSummary}`
      : (existingNotes || analysisSummary))
    : (existingNotes || null);

  return {
    mint,
    symbol: payload?.token?.summary?.symbol || existing?.symbol || null,
    name: payload?.token?.summary?.name || existing?.name || null,
    status: statusFromRating || existing?.status || 'new',
    strategy: existing?.strategy || null,
    strategyId: existing?.strategy_id || existing?.strategyId || null,
    source: existing?.source || 'targetscan',
    tags: existing?.tags || null,
    notes: resolvedNotes,
    vectorStoreId: existing?.vector_store_id || existing?.vectorStoreId || null,
    vectorStoreFileId: existing?.vector_store_file_id || existing?.vectorStoreFileId || null,
    vectorStoreUpdatedAt: Number.isFinite(existing?.vector_store_updated_at)
      ? existing.vector_store_updated_at
      : (Number.isFinite(existing?.vectorStoreUpdatedAt) ? existing.vectorStoreUpdatedAt : null),
    confidence: resolvedConfidence,
    score: resolvedScore,
    mintVerified: typeof existing?.mint_verified === 'number'
      ? existing.mint_verified === 1
      : Boolean(existing?.mintVerified),
    createdAt: Number.isFinite(existing?.created_at) ? existing.created_at : now,
    updatedAt: now,
    lastCheckedAt: now,
  };
}

/**
 * Upsert a targetscan result into sc_targets and emit a HUD event.
 *
 * @param {{ mint: string, payload: Object, analysis: Object|null, manual?: boolean }} params
 * @returns {Promise<{ existingTarget: Object|null, updatedTarget: Object|null }|null>}
 */
async function upsertTargetFromScan({ mint, payload, analysis, manual }) {
  if (!mint) return null;

  let existingTarget = null;
  try {
    await ensureBootyBoxInit();
    if (typeof BootyBox.addUpdateTarget !== 'function') {
      logger.debug('[targetScan] BootyBox.addUpdateTarget missing; skipping target persistence.');
      return null;
    }
    if (typeof BootyBox.getTarget === 'function') {
      existingTarget = BootyBox.getTarget(mint);
    }
  } catch (err) {
    logger.warn('[targetScan] failed to init BootyBox for target persistence:', err?.message || err);
    return null;
  }

  const updatePayload = buildTargetUpdateFromScan({
    mint,
    payload,
    analysis,
    existing: existingTarget,
  });
  let updatedTarget = null;
  try {
    updatedTarget = BootyBox.addUpdateTarget(updatePayload);
  } catch (err) {
    logger.warn('[targetScan] failed to update target record:', err?.message || err);
    return { existingTarget, updatedTarget: null };
  }

  const resolvedTarget = updatedTarget || updatePayload;
  const score = Number(analysis?.buyScore);
  appendTargetAddedEvent({
    mint,
    symbol: resolvedTarget.symbol || null,
    name: resolvedTarget.name || null,
    status: resolvedTarget.status || null,
    rating: analysis?.rating || null,
    score: Number.isFinite(score) ? score : null,
    source: resolvedTarget.source || updatePayload.source || 'targetscan',
    manual: manual === true,
    analysis,
  });

  return { existingTarget, updatedTarget };
}

/**
 * Build the targetScan payload for a single mint.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {Object} params.client
 * @param {Object} params.artifacts
 * @param {string} params.runId
 * @returns {Promise<{ payload: Object, meta: Object }>}
 */
async function buildTargetScanPayload({
  mint,
  client,
  artifacts,
  runId,
  forceTokenRefresh,
  devscanSpawner,
  signal,
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const timeFrom = nowSec - OHLCV_LOOKBACK_SEC;
  const timeTo = nowSec;
  const fetchedAt = new Date().toISOString();

  if (!signal || !signal.aborted) {
    if (devscanSpawner) {
      devscanSpawner(mint);
    } else {
      spawnDevscanMintWorker(mint);
    }
  }

  let tokenInfo = null;
  try {
    tokenInfo = await ensureTokenInfo({ mint, client, forceRefresh: forceTokenRefresh === true });
  } catch (err) {
    logger.debug('[targetScan] token info fetch failed', { mint, err: err?.message || err });
    tokenInfo = null;
  }
  if (artifacts) {
    artifacts.write('raw', 'tokenInfo', { tokenInfo });
  }

  const settled = await Promise.allSettled([
    client.getPriceRange(mint, timeFrom, timeTo),
    client.getAthPrice(mint),
    client.getTokenOhlcvData({
      mint,
      type: '1m',
      timeFrom,
      timeTo,
      removeOutliers: true,
    }),
    loadDevscanMetadata(mint),
  ]);

  const priceRangeResp = settled[0].status === 'fulfilled'
    ? settled[0].value
    : { error: settled[0].reason?.message || String(settled[0].reason) };
  const athResp = settled[1].status === 'fulfilled'
    ? settled[1].value
    : { error: settled[1].reason?.message || String(settled[1].reason) };
  const ohlcvResp = settled[2].status === 'fulfilled'
    ? settled[2].value
    : { error: settled[2].reason?.message || String(settled[2].reason) };
  const devscanRow = settled[3].status === 'fulfilled' ? settled[3].value : null;

  const priceRangeArtifact = buildPriceRangeArtifact({
    mint,
    timeFrom,
    timeTo,
    response: priceRangeResp,
    fetchedAt,
  });
  const athPriceArtifact = buildAthPriceArtifact({
    mint,
    response: athResp,
    fetchedAt,
  });

  if (artifacts) {
    artifacts.write('raw', 'priceRange', priceRangeArtifact);
    artifacts.write('raw', 'athPrice', athPriceArtifact);
    artifacts.write('raw', 'ohlcv', {
      request: {
        mint,
        type: '1m',
        timeFrom,
        timeTo,
        removeOutliers: true,
      },
      response: ohlcvResp,
    });
  }

  const ohlcvRows = extractOhlcvRows(ohlcvResp);
  const candles = ohlcvRows.map((row) => ({
    t: row.time,
    o: row.open,
    c: row.close,
    l: row.low,
    h: row.high,
    v: row.volume,
  }));
  const ohlcvContext = buildOhlcvContext({
    granularity: '1m',
    startTimestamp: timeFrom * 1000,
    endTimestamp: timeTo * 1000,
    candles,
    summaryWindows: ['5m', '10m', '20m'],
  });

  const devscanArtifact = devscanRow
    ? buildDevscanMetadataArtifact({
        mint,
        source: DEVSCAN_SOURCE,
        metadataRow: devscanRow,
        fetchedAt,
      })
    : null;

  if (devscanArtifact && artifacts) {
    artifacts.write('raw', 'devscanMetadata', devscanArtifact);
  }

  const tokenSummary = buildTokenSummary(tokenInfo);
  if (!tokenSummary.mint) {
    tokenSummary.mint = mint;
  }
  const marketOverview = buildMarketOverview(tokenInfo);

  const meta = buildMetaBlock({
    command: 'targetscan',
    runId,
    mode: 'mint',
    scoundrelVersion: pkg.version,
    fetchedAt,
    mint,
  });

  const payload = pruneNullishPayload({
    meta,
    token: {
      summary: tokenSummary,
      market: marketOverview,
    },
    analytics: {
      priceRange: priceRangeArtifact,
      athPrice: athPriceArtifact,
      ohlcv: ohlcvContext,
    },
    devscan: devscanArtifact,
  });

  return { payload, meta };
}

const runTargetScanFlow = createAnalysisFlow({
  command: 'targetscan',
  logger,
  build: async ({ options, createArtifacts }) => {
    const mint = options?.mint ? String(options.mint).trim() : '';
    if (!mint) {
      throw new Error('[targetScan] mint is required');
    }

    const runContext = createArtifacts([`mint-${mint}`]);
    const client = options.client || createSolanaTrackerDataClient();
    const shouldClose = !options.client;

    try {
      const { payload, meta } = await buildTargetScanPayload({
        mint,
        client,
        artifacts: runContext.artifacts,
        runId: runContext.runId,
        forceTokenRefresh: options.forceTokenRefresh,
        devscanSpawner: options.devscanSpawner,
        signal: options.signal,
      });
      return {
        payload,
        meta,
        runAnalysis: options.runAnalysis,
        mint,
        promptPrefix: `${mint}_prompt`,
        responsePrefix: `${mint}_response`,
        artifacts: runContext.artifacts,
      };
    } finally {
      if (shouldClose && typeof client.close === 'function') {
        try {
          await client.close();
        } catch (err) {
          logger.debug('[targetScan] failed to close data client', { mint, err: err?.message || err });
        }
      }
    }
  },
  analyze: async ({ payload }) => analyzeTargetScan({
    payload,
    purpose: 'Score target mints for buy opportunity based on provided metadata.',
  }),
  persist: async ({ payload, analysis, buildResult, options }) => {
    if (!buildResult?.artifacts) return;
    const mint = buildResult.mint || payload?.meta?.mint || null;
    const tokenLabel = payload?.token?.summary?.name
      || payload?.token?.summary?.symbol
      || mint
      || 'token';
    const prefix = `targetscan_${tokenLabel}_final`;
    const finalPayload = buildFinalPayload({ prompt: payload, response: analysis });
    const finalPath = buildResult.artifacts.write('final', prefix, finalPayload);
    let existingTarget = null;
    if (mint) {
      const upsertResult = await upsertTargetFromScan({
        mint,
        payload,
        analysis,
        manual: options?.manual === true,
      });
      existingTarget = upsertResult?.existingTarget || null;
    }
    if (options?.skipVectorStore) {
      logger.debug('[targetScan] vector store upload skipped by payload flag');
      return;
    }
    const vectorPayload = buildTargetScanVectorPayload({ payload, analysis });
    await queueVectorStoreUpload({
      source: 'targetscan',
      name: mint,
      attributes: {
        source: 'targetscan',
        mint: payload?.meta?.mint || mint || null,
        tokenName: payload?.token?.summary?.name || null,
        tokenSymbol: payload?.token?.summary?.symbol || null,
      },
      jsonPath: null,
      data: vectorPayload,
      targetMint: mint || null,
      replaceFileId: existingTarget?.vector_store_file_id || null,
      replaceVectorStoreId: existingTarget?.vector_store_id || null,
      deleteReplacedFile: true,
    }, {
      signal: options?.signal,
      onSpawn: options?.vectorWorkerTracker?.onSpawn,
    }).catch((err) => logger.warn('[targetScan] vector store ingest failed:', err?.message));
  },
  buildSegments: (options) => {
    const mint = options?.mint ? String(options.mint).trim() : '';
    return mint ? [`mint-${mint}`] : ['targetscan'];
  },
});

/**
 * Run targetScan for a list of mints.
 *
 * @param {Object} options
 * @returns {Promise<{ mints: string[], results: Array }>}
 */
async function runTargetScan(options = {}) {
  const normalized = normalizeTargetScanOptions(options);
  if (!normalized.mints.length) {
    throw new Error('[targetScan] requires at least one mint');
  }

  const controller = new AbortController();
  const signal = options.signal || controller.signal;
  const detachedTracker = createDetachedWorkerTracker(signal);
  const devscanSpawner = createDevscanSpawner({ signal, onSpawn: detachedTracker.onSpawn });
  const onSignal = () => controller.abort();
  let signalHandlersAttached = false;

  if (!options.signal) {
    process.prependOnceListener('SIGINT', onSignal);
    process.prependOnceListener('SIGTERM', onSignal);
    signalHandlersAttached = true;
  }

  const sharedClient = normalized.client || createSolanaTrackerDataClient();
  const shouldClose = !normalized.client;

  const results = new Array(normalized.mints.length);
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= normalized.mints.length) return;
      if (signal.aborted) return;
      const mint = normalized.mints[idx];
      try {
        const res = await runTargetScanFlow({
          mint,
          runAnalysis: normalized.runAnalysis,
          skipVectorStore: normalized.skipVectorStore,
          client: sharedClient,
          devscanSpawner,
          vectorWorkerTracker: detachedTracker,
          manual: normalized.manual,
          signal,
        });
        if (!res.analysis) {
          await upsertTargetFromScan({
            mint,
            payload: res.payload,
            analysis: null,
            manual: normalized.manual,
          });
        }
        results[idx] = {
          mint,
          payload: res.payload,
          analysis: res.analysis,
          promptPath: res.promptPath,
          responsePath: res.responsePath,
        };
      } catch (err) {
        results[idx] = {
          mint,
          error: err?.message || String(err),
        };
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(normalized.concurrency, normalized.mints.length) },
    () => runOne(),
  );
  await Promise.all(workers);

  if (shouldClose && typeof sharedClient.close === 'function') {
    try {
      await sharedClient.close();
    } catch (err) {
      logger.debug('[targetScan] failed to close shared data client', { err: err?.message || err });
    }
  }

  if (signalHandlersAttached) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  return { mints: normalized.mints, results };
}

module.exports = {
  normalizeMintList,
  normalizeTargetScanOptions,
  runTargetScan,
};
