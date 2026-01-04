'use strict';

const baseLogger = require('../../logger');
const { createWorkerHarness } = require('./harness');
const { createWorkerLogger } = require('./workerLogger');
const { createArtifactWriter } = require('../../persist/jsonArtifacts');

const DEVSCAN_BASE_URL = 'https://ds-final-backend-production.up.railway.app/api/v1/public';

const logger = createWorkerLogger({
  workerName: 'devscanWorker',
  scope: 'devscanWorker',
  baseLogger,
  includeCallsite: true,
});

/**
 * @typedef {Object} DevscanWorkerPayload
 * @property {string} [mint] - Token mint address.
 * @property {string} [developerWallet] - Developer wallet address.
 * @property {string} [developerTokensWallet] - Developer wallet for token list lookup.
 */

/**
 * @typedef {Object} DevscanWorkerResult
 * @property {{ response: any, artifactPath: string|null }|null} mint
 * @property {{ response: any, artifactPath: string|null }|null} developer
 * @property {{ response: any, artifactPath: string|null }|null} developerTokens
 */

/**
 * Validate and normalize devscan worker payloads.
 *
 * @param {DevscanWorkerPayload} payload
 * @returns {DevscanWorkerPayload}
 */
function validateDevscanPayload(payload) {
  const out = {};
  if (payload && typeof payload.mint === 'string' && payload.mint.trim()) {
    out.mint = payload.mint.trim();
  }
  if (payload && typeof payload.developerWallet === 'string' && payload.developerWallet.trim()) {
    out.developerWallet = payload.developerWallet.trim();
  }
  if (payload && typeof payload.developerTokensWallet === 'string' && payload.developerTokensWallet.trim()) {
    out.developerTokensWallet = payload.developerTokensWallet.trim();
  }
  if (!out.mint && !out.developerWallet && !out.developerTokensWallet) {
    throw new Error('Devscan payload requires at least one of mint, developerWallet, or developerTokensWallet');
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
 * Run the devscan worker and persist raw JSON artifacts.
 *
 * @param {DevscanWorkerPayload} payload
 * @returns {Promise<DevscanWorkerResult>}
 */
async function runDevscanWorker(payload) {
  const normalized = validateDevscanPayload(payload);
  const apiKey = process.env.DEVSCAN_API_KEY;
  if (!apiKey) {
    throw new Error('DEVSCAN_API_KEY is required to call DevScan APIs');
  }

  const result = {
    mint: null,
    developer: null,
    developerTokens: null,
  };

  if (normalized.mint) {
    const response = await fetchDevscan(`/tokens/${encodeURIComponent(normalized.mint)}`, apiKey);
    const writer = createArtifactWriter({
      command: 'devscan',
      segments: ['mint', normalized.mint],
      logger,
    });
    const artifactPath = writer.write('raw', 'token', response);
    result.mint = { response, artifactPath };
  }

  if (normalized.developerWallet) {
    const response = await fetchDevscan(
      `/developers/${encodeURIComponent(normalized.developerWallet)}`,
      apiKey,
    );
    const writer = createArtifactWriter({
      command: 'devscan',
      segments: ['developer', normalized.developerWallet],
      logger,
    });
    const artifactPath = writer.write('raw', 'developer', response);
    result.developer = { response, artifactPath };
  }

  if (normalized.developerTokensWallet) {
    const response = await fetchDevscan(
      `/developer/tokens/${encodeURIComponent(normalized.developerTokensWallet)}`,
      apiKey,
    );
    const writer = createArtifactWriter({
      command: 'devscan',
      segments: ['developer-tokens', normalized.developerTokensWallet],
      logger,
    });
    const artifactPath = writer.write('raw', 'developer-tokens', response);
    result.developerTokens = { response, artifactPath };
  }

  return result;
}

createWorkerHarness(runDevscanWorker, { workerName: 'devscanWorker', logger });

module.exports = { validateDevscanPayload, runDevscanWorker };
