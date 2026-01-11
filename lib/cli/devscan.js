'use strict';

const BootyBox = require('../../db');
const { analyzeDevscan } = require('../../ai/jobs/devscanAnalysis');
const { createAnalysisFlow } = require('./analysisFlow');
const { persistProfileSnapshot, persistCoinMetadata } = require('../persist/aiPersistence');
const { requestId } = require('../id/issuer');
const { buildMetaBlock, buildFinalPayload } = require('../analysis/payloadBuilders');
const { queueVectorStoreUpload } = require('../ai/vectorStoreUpload');
const logger = require('../logger');
const pkg = require('../../package.json');

const DEVSCAN_BASE_URL = 'https://ds-final-backend-production.up.railway.app/api/v1/public';

/**
 * @typedef {Object} DevscanOptions
 * @property {string} [mint] - Token mint address.
 * @property {string} [developerWallet] - Developer wallet address.
 * @property {string} [developerTokensWallet] - Developer wallet for token list lookup.
 * @property {boolean} [runAnalysis=true] - Whether to run OpenAI analysis.
 */

/**
 * @typedef {Object} DevscanRunResult
 * @property {Object|null} token
 * @property {Object|null} developer
 * @property {Object|null} developerTokens
 * @property {Object|null} payload
 * @property {Object|null} openAiResult
 * @property {string|null} promptPath
 * @property {string|null} responsePath
 */

/**
 * Validate and normalize devscan inputs.
 *
 * @param {DevscanOptions} options
 * @returns {DevscanOptions}
 */
function normalizeDevscanOptions(options) {
  const out = {};
  if (options && typeof options.mint === 'string' && options.mint.trim()) {
    out.mint = options.mint.trim();
  }
  if (options && typeof options.developerWallet === 'string' && options.developerWallet.trim()) {
    out.developerWallet = options.developerWallet.trim();
  }
  if (options && typeof options.developerTokensWallet === 'string' && options.developerTokensWallet.trim()) {
    out.developerTokensWallet = options.developerTokensWallet.trim();
  }
  if (options && options.runAnalysis === false) {
    out.runAnalysis = false;
  } else {
    out.runAnalysis = true;
  }

  if (!out.mint && !out.developerWallet && !out.developerTokensWallet) {
    throw new Error('[devscan] requires at least one of mint, developerWallet, or developerTokensWallet');
  }

  if (out.mint && !out.developerWallet && !out.developerTokensWallet) {
    out.runAnalysis = false;
  }

  return out;
}

/**
 * Issue a GET request to DevScan and parse the JSON response.
 *
 * @param {string} path
 * @param {string} apiKey
 * @returns {Promise<any>}
 */
async function fetchDevscan(path, apiKey) {
  const url = `${DEVSCAN_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = text;
    }
  }

  if (!res.ok) {
    const statusLine = `${res.status} ${res.statusText}`.trim();
    const details = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
    const suffix = details ? ` - ${details}` : '';
    const err = new Error(`[devscan] request failed (${statusLine || res.status})${suffix}`);
    err.status = res.status;
    err.body = data;
    if (data && typeof data === 'object' && data.success === false) {
      const code = data.error && data.error.code ? data.error.code : 'DEVSCAN_ERROR';
      const message = data.error && data.error.message ? data.error.message : 'DevScan request failed';
      err.devscanError = { code, message, body: data };
    }
    throw err;
  }

  if (data && typeof data === 'object' && data.success === false) {
    const code = data.error && data.error.code ? data.error.code : 'DEVSCAN_ERROR';
    const message = data.error && data.error.message ? data.error.message : 'DevScan request failed';
    const err = new Error(`[devscan] request failed (${code}) - ${message}`);
    err.devscanError = { code, message, body: data };
    err.body = data;
    throw err;
  }

  return data;
}

/**
 * Normalize DevScan errors into user-friendly messages.
 *
 * @param {Error} err
 * @param {DevscanOptions} normalized
 * @returns {Error}
 */
function formatDevscanError(err, normalized) {
  const devscan = err && err.devscanError;
  if (!devscan) return err;

  let message = null;
  if (devscan.code === 'DEVELOPER_NOT_FOUND') {
    const wallet = normalized.developerWallet || normalized.developerTokensWallet || '';
    message = wallet
      ? `[devscan] developer not found for wallet ${wallet}`
      : '[devscan] developer not found';
  } else if (devscan.code === 'TOKEN_NOT_FOUND' || devscan.code === 'MINT_NOT_FOUND') {
    const mint = normalized.mint || '';
    message = mint
      ? `[devscan] token not found for mint ${mint}`
      : '[devscan] token not found';
  }

  if (!message) {
    const msg = devscan.message || 'DevScan request failed';
    message = `[devscan] request failed (${devscan.code || 'DEVSCAN_ERROR'}) - ${msg}`;
  }

  const out = new Error(message);
  out.devscanError = devscan;
  out.status = err.status;
  out.body = err.body;
  return out;
}

/**
 * Build an ordered list of artifact path segments.
 *
 * @param {DevscanOptions} options
 * @returns {string[]}
 */
function buildArtifactSegments(options) {
  const segments = [];
  if (options.mint) segments.push(`mint-${options.mint}`);
  if (options.developerWallet) segments.push(`dev-${options.developerWallet}`);
  if (options.developerTokensWallet) segments.push(`devtokens-${options.developerTokensWallet}`);
  return segments.length ? segments : ['devscan'];
}

/**
 * Resolve a devscan mode label for artifact metadata.
 *
 * @param {DevscanOptions} options
 * @returns {string}
 */
function resolveDevscanMode(options) {
  const modes = [];
  if (options.mint) modes.push('mint');
  if (options.developerWallet) modes.push('developer');
  if (options.developerTokensWallet) modes.push('developer_tokens');
  if (!modes.length) return 'devscan';
  return modes.length === 1 ? modes[0] : modes.join('+');
}

/**
 * Run the DevScan fetch + AI summary flow.
 *
 * @param {DevscanOptions} options
 * @returns {Promise<DevscanRunResult>}
 */
const runDevscanFlow = createAnalysisFlow({
  command: 'devscan',
  logger,
  build: async ({ options, createArtifacts }) => {
    const normalized = normalizeDevscanOptions(options);
    const apiKey = options.apiKey;
    const runContext = createArtifacts(buildArtifactSegments(normalized));

    const result = {
      token: null,
      developer: null,
      developerTokens: null,
    };

    if (normalized.mint) {
      const response = await fetchDevscan(`/tokens/${encodeURIComponent(normalized.mint)}`, apiKey);
      const artifactPath = runContext.artifacts.write('raw', 'token', response);
      result.token = { response, artifactPath };
    }

    if (normalized.developerWallet) {
      const response = await fetchDevscan(
        `/developers/${encodeURIComponent(normalized.developerWallet)}`,
        apiKey,
      );
      const artifactPath = runContext.artifacts.write('raw', 'developer', response);
      result.developer = { response, artifactPath };
    }

    if (normalized.developerTokensWallet) {
      const response = await fetchDevscan(
        `/developer/tokens/${encodeURIComponent(normalized.developerTokensWallet)}`,
        apiKey,
      );
      const artifactPath = runContext.artifacts.write('raw', 'developer-tokens', response);
      result.developerTokens = { response, artifactPath };
    }

    const payload = {
      meta: buildMetaBlock({
        command: 'devscan',
        runId: runContext.runId,
        mode: resolveDevscanMode(normalized),
        scoundrelVersion: pkg.version,
        fetchedAt: new Date().toISOString(),
        mint: normalized.mint || null,
        developerWallet: normalized.developerWallet || null,
        developerTokensWallet: normalized.developerTokensWallet || null,
      }),
      token: result.token ? result.token.response : null,
      developer: result.developer ? result.developer.response : null,
      developerTokens: result.developerTokens ? result.developerTokens.response : null,
    };

    const prefixBase = normalized.mint || normalized.developerWallet || normalized.developerTokensWallet || null;
    const promptPrefix = prefixBase ? `${prefixBase}_prompt` : 'prompt';
    const responsePrefix = prefixBase ? `${prefixBase}_response` : 'response';

    return {
      payload,
      promptPrefix,
      responsePrefix,
      artifacts: runContext.artifacts,
      normalized,
      token: result.token,
      developer: result.developer,
      developerTokens: result.developerTokens,
    };
  },
  analyze: async ({ payload }) => analyzeDevscan({
    payload,
    model: process.env.DEVSCAN_RESPONSES_MODEL,
    purpose: 'Summarize DevScan token/developer data for trading context.',
  }),
  persist: async ({ payload, analysis, buildResult }) => {
    const normalized = buildResult?.normalized || {};
    try {
      const profileIdRaw = await requestId({ prefix: 'devscan' });
      const profileId = String(profileIdRaw).slice(-26);
      const finalPayload = buildFinalPayload({ prompt: payload, response: analysis });
      let finalPath = null;
      if (buildResult?.artifacts) {
        const tokenData = buildResult?.token?.response?.data
          || buildResult?.token?.response?.token
          || buildResult?.token?.response
          || null;
        const developerData = buildResult?.developer?.response?.data?.developer
          || buildResult?.developer?.response?.developer
          || buildResult?.developer?.response?.data
          || null;
        const developerTokensData = buildResult?.developerTokens?.response?.data?.developer
          || buildResult?.developerTokens?.response?.developer
          || buildResult?.developerTokens?.response?.data
          || null;
        const label = tokenData?.name
          || tokenData?.symbol
          || developerData?.name
          || developerTokensData?.name
          || normalized.mint
          || normalized.developerWallet
          || normalized.developerTokensWallet
          || 'profile';
        finalPath = buildResult.artifacts.write('final', `devscan_${label}_final`, finalPayload);
      }
      const name = normalized.mint
        ? `mint:${normalized.mint}`
        : normalized.developerWallet
          ? `dev:${normalized.developerWallet}`
          : `devtokens:${normalized.developerTokensWallet}`;
      await queueVectorStoreUpload({
        source: 'devscan',
        name,
        jsonPath: finalPath || null,
        data: finalPath ? null : finalPayload,
      }).catch((err) => logger.warn('[devscan] vector store ingest failed:', err?.message));
      await persistProfileSnapshot({
        BootyBox,
        profileId,
        name,
        wallet: normalized.developerWallet || normalized.developerTokensWallet || null,
        source: 'devscan',
        profile: finalPayload,
        logger,
      });
    } catch (persistErr) {
      logger.warn('[devscan] failed to persist analysis:', persistErr?.message || persistErr);
    }
  },
  buildSegments: (options) => buildArtifactSegments(options),
});

async function runDevscan(options) {
  const normalized = normalizeDevscanOptions(options);
  const apiKey = process.env.DEVSCAN_API_KEY;
  if (!apiKey) {
    throw new Error('DEVSCAN_API_KEY is required to call DevScan APIs');
  }
  if (normalized.runAnalysis && !process.env.xAI_API_KEY) {
    throw new Error('xAI_API_KEY is required to run DevScan AI summaries');
  }

  let flowResult;
  try {
    flowResult = await runDevscanFlow({
      ...normalized,
      apiKey,
    });
  } catch (err) {
    const formatted = formatDevscanError(err, normalized);
    if (formatted !== err) {
      logger.debug('[devscan] normalized error:', err?.message || err);
    }
    throw formatted;
  }

  if (normalized.mint && flowResult?.buildResult?.token?.response) {
    try {
      const metadataIdRaw = await requestId({ prefix: 'coinmeta' });
      const metadataId = String(metadataIdRaw).slice(-26);
      await persistCoinMetadata({
        BootyBox,
        metadataId,
        mint: normalized.mint,
        source: 'devscan',
        response: flowResult.buildResult.token.response,
        logger,
      });
    } catch (persistErr) {
      logger.warn('[devscan] failed to persist mint metadata:', persistErr?.message || persistErr);
    }
  }

  return {
    token: flowResult.buildResult.token,
    developer: flowResult.buildResult.developer,
    developerTokens: flowResult.buildResult.developerTokens,
    payload: flowResult.payload,
    openAiResult: flowResult.analysis,
    promptPath: flowResult.promptPath,
    responsePath: flowResult.responsePath,
  };
}

module.exports = { runDevscan };
