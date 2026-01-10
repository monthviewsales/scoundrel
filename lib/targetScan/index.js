'use strict';

const path = require('path');

const BootyBox = require('../../db');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const { ensureTokenInfo } = require('../services/tokenInfoService');
const { buildMetaBlock, buildTokenSummary, buildMarketOverview, pruneNullishPayload } = require('../analysis/payloadBuilders');
const { buildOhlcvContext } = require('../analysis/ohlcvContext');
const {
  buildAthPriceArtifact,
  buildPriceRangeArtifact,
  buildDevscanMetadataArtifact,
} = require('../analysis/apiArtifacts');
const { createAnalysisFlow } = require('../cli/analysisFlow');
const { ensureBootyBoxInit } = require('../bootyBoxInit');
const { spawnWorkerDetached } = require('../warchest/workers/harness');
const { analyzeTargetScan } = require('../../ai/jobs/targetScan');
const logger = require('../logger').child({ scope: 'targetScan' });
const pkg = require('../../package.json');

const DEFAULT_CONCURRENCY = 4;
const OHLCV_LOOKBACK_SEC = 20 * 60;
const DEVSCAN_SOURCE = 'devscan';

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

/**
 * Normalize options for a target scan.
 *
 * @param {Object} options
 * @returns {{ mints: string[], runAnalysis: boolean, concurrency: number, client?: Object }}
 */
function normalizeTargetScanOptions(options = {}) {
  const mints = normalizeMintList([options.mint, options.mints, options.list, options.input]);
  const runAnalysis = options.runAnalysis !== false;
  const concurrency = Number.isFinite(Number(options.concurrency))
    ? Math.max(1, Number(options.concurrency))
    : DEFAULT_CONCURRENCY;

  return {
    mints,
    runAnalysis,
    concurrency,
    client: options.client,
  };
}

/**
 * Spawn a detached DevScan worker for mint metadata (best-effort).
 *
 * @param {string} mint
 */
function spawnDevscanMintWorker(mint) {
  if (!mint) return;
  if (!process.env.DEVSCAN_API_KEY) return;

  try {
    const workerPath = path.join(__dirname, '..', 'warchest', 'workers', 'devscanWorker.js');
    spawnWorkerDetached(workerPath, {
      payload: {
        mint,
        runAnalysis: false,
      },
      payloadFilePrefix: `devscan-mint-${mint}`,
    });
  } catch (err) {
    logger.debug('[targetScan] devscan spawn failed', { mint, err: err?.message || err });
  }
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
 * Build the targetScan payload for a single mint.
 *
 * @param {Object} params
 * @param {string} params.mint
 * @param {Object} params.client
 * @param {Object} params.artifacts
 * @param {string} params.runId
 * @returns {Promise<{ payload: Object, meta: Object }>}
 */
async function buildTargetScanPayload({ mint, client, artifacts, runId }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const timeFrom = nowSec - OHLCV_LOOKBACK_SEC;
  const timeTo = nowSec;
  const fetchedAt = new Date().toISOString();

  spawnDevscanMintWorker(mint);

  let tokenInfo = null;
  try {
    tokenInfo = await ensureTokenInfo({ mint, client });
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
      });
      return {
        payload,
        meta,
        runAnalysis: options.runAnalysis,
        mint,
        promptPrefix: `${mint}_prompt`,
        responsePrefix: `${mint}_response`,
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
    model: 'gpt-5-mini',
    purpose: 'Score target mints for buy opportunity based on provided metadata.',
  }),
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

  const sharedClient = normalized.client || createSolanaTrackerDataClient();
  const shouldClose = !normalized.client;

  const results = new Array(normalized.mints.length);
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= normalized.mints.length) return;
      const mint = normalized.mints[idx];
      try {
        const res = await runTargetScanFlow({
          mint,
          runAnalysis: normalized.runAnalysis,
          client: sharedClient,
        });
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

  return { mints: normalized.mints, results };
}

module.exports = {
  normalizeMintList,
  normalizeTargetScanOptions,
  runTargetScan,
};
