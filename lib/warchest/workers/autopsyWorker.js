'use strict';

const path = require('path');

const { createWorkerHarness } = require('./harness');
const { createSolanaTrackerDataClient } = require('../../solanaTrackerDataClient');

/**
 * @typedef {Object} AutopsyWorkerPayload
 * @property {string} walletAddress - Base58 wallet pubkey.
 * @property {string} mint - Token mint address.
 * @property {string} [walletLabel] - Optional human-friendly label for output artifacts.
 */

/**
 * @typedef {Object} AutopsyWorkerResult
 * @property {Object} payload - Enriched autopsy payload sent to the AI service.
 * @property {Object} ai - Structured AI response.
 * @property {string} artifactPath - File path where the payload + AI output were written.
 */

function loadAutopsyRunner() {
  if (process.env.AUTOPSY_WORKER_RUNNER) {
    const modPath = path.isAbsolute(process.env.AUTOPSY_WORKER_RUNNER)
      ? process.env.AUTOPSY_WORKER_RUNNER
      : path.join(process.cwd(), process.env.AUTOPSY_WORKER_RUNNER);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(modPath);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.runAutopsy === 'function') return mod.runAutopsy;
    throw new Error('AUTOPSY_WORKER_RUNNER must export a function or runAutopsy');
  }

  // eslint-disable-next-line global-require
  const { runAutopsy } = require('../../cli/autopsy');
  return runAutopsy;
}

function loadClientFactory() {
  if (process.env.AUTOPSY_WORKER_CLIENT_FACTORY) {
    const modPath = path.isAbsolute(process.env.AUTOPSY_WORKER_CLIENT_FACTORY)
      ? process.env.AUTOPSY_WORKER_CLIENT_FACTORY
      : path.join(process.cwd(), process.env.AUTOPSY_WORKER_CLIENT_FACTORY);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const factory = require(modPath);
    if (typeof factory !== 'function') {
      throw new Error('AUTOPSY_WORKER_CLIENT_FACTORY must export a function');
    }
    return factory;
  }

  return () => createSolanaTrackerDataClient();
}

/**
 * Validate autopsy payloads.
 *
 * @param {AutopsyWorkerPayload} payload
 * @returns {AutopsyWorkerPayload}
 */
function validateAutopsyPayload(payload) {
  const walletAddress = payload && typeof payload.walletAddress === 'string'
    ? payload.walletAddress.trim()
    : '';
  const mint = payload && typeof payload.mint === 'string' ? payload.mint.trim() : '';
  if (!walletAddress) {
    throw new Error('Autopsy payload requires walletAddress');
  }
  if (!mint) {
    throw new Error('Autopsy payload requires mint');
  }

  const out = { walletAddress, mint };
  if (payload.walletLabel) out.walletLabel = String(payload.walletLabel).trim();
  return out;
}

async function runAutopsyWorker(payload, { track }) {
  const normalized = validateAutopsyPayload(payload);
  const createClient = loadClientFactory();
  const client = await Promise.resolve(createClient());
  track(client);

  const runAutopsy = loadAutopsyRunner();
  const res = await runAutopsy({ ...normalized, client });
  return res;
}

createWorkerHarness(runAutopsyWorker);

module.exports = { validateAutopsyPayload, runAutopsyWorker };
