'use strict';

const BootyBox = require('../../db');
const { analyzeDevscan } = require('../../ai/jobs/devscanAnalysis');
const { createCommandRun } = require('./aiRun');
const { persistProfileSnapshot } = require('../persist/aiPersistence');
const { requestId } = require('../id/issuer');
const logger = require('../logger');

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
 * Run the DevScan fetch + AI summary flow.
 *
 * @param {DevscanOptions} options
 * @returns {Promise<DevscanRunResult>}
 */
async function runDevscan(options) {
  const normalized = normalizeDevscanOptions(options);
  const apiKey = process.env.DEVSCAN_API_KEY;
  if (!apiKey) {
    throw new Error('DEVSCAN_API_KEY is required to call DevScan APIs');
  }

  const { artifacts } = createCommandRun({
    command: 'devscan',
    segments: buildArtifactSegments(normalized),
    logger,
  });

  const result = {
    token: null,
    developer: null,
    developerTokens: null,
    payload: null,
    openAiResult: null,
    promptPath: null,
    responsePath: null,
  };

  if (normalized.mint) {
    const response = await fetchDevscan(`/tokens/${encodeURIComponent(normalized.mint)}`, apiKey);
    const artifactPath = artifacts.write('raw', 'token', response);
    result.token = { response, artifactPath };
  }

  if (normalized.developerWallet) {
    const response = await fetchDevscan(
      `/developers/${encodeURIComponent(normalized.developerWallet)}`,
      apiKey,
    );
    const artifactPath = artifacts.write('raw', 'developer', response);
    result.developer = { response, artifactPath };
  }

  if (normalized.developerTokensWallet) {
    const response = await fetchDevscan(
      `/developer/tokens/${encodeURIComponent(normalized.developerTokensWallet)}`,
      apiKey,
    );
    const artifactPath = artifacts.write('raw', 'developer-tokens', response);
    result.developerTokens = { response, artifactPath };
  }

  const payload = {
    meta: {
      mint: normalized.mint || null,
      developerWallet: normalized.developerWallet || null,
      developerTokensWallet: normalized.developerTokensWallet || null,
      fetchedAt: new Date().toISOString(),
    },
    token: result.token ? result.token.response : null,
    developer: result.developer ? result.developer.response : null,
    developerTokens: result.developerTokens ? result.developerTokens.response : null,
  };

  result.payload = payload;

  result.promptPath = artifacts.write('prompt', 'prompt', payload);

  if (!normalized.runAnalysis) {
    return result;
  }

  const openAiResult = await analyzeDevscan({
    payload,
    model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini',
    purpose: 'Summarize DevScan token/developer data for trading context.',
  });

  result.openAiResult = openAiResult;
  result.responsePath = artifacts.write('response', 'response', openAiResult);

  try {
    const profileIdRaw = await requestId({ prefix: 'devscan' });
    const profileId = String(profileIdRaw).slice(-26);
    const name = normalized.mint
      ? `mint:${normalized.mint}`
      : normalized.developerWallet
        ? `dev:${normalized.developerWallet}`
        : `devtokens:${normalized.developerTokensWallet}`;
    await persistProfileSnapshot({
      BootyBox,
      profileId,
      name,
      wallet: normalized.developerWallet || normalized.developerTokensWallet || null,
      source: 'devscan',
      prompt: payload,
      response: openAiResult,
      logger,
    });
  } catch (persistErr) {
    logger.warn('[devscan] failed to persist analysis:', persistErr?.message || persistErr);
  }

  return result;
}

module.exports = { runDevscan };
