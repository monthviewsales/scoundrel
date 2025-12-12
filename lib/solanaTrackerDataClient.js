'use strict';

require('dotenv').config({ quiet: true });
const logger = require('../lib/logger');
const { createDataClientContext } = require('./solanaTrackerData/context');
const { createDataMethods } = require('./solanaTrackerData/methods');

/**
 * Factory function mirroring the RPC client ergonomics.
 *
 * @param {{ apiKey?: string, baseUrl?: string, maxAttempts?: number, retryBaseMs?: number }} [options]
 * @returns {{ client: import('@solana-tracker/data-api').Client, close: () => Promise<void> } & Record<string, Function>}
 */
function createSolanaTrackerDataClient(options = {}) {
  const context = createDataClientContext(options);
  const methods = createDataMethods(context);
  return {
    ...methods,
    client: context.client,
    close: async () => {},
  };
}

class SolanaTrackerDataClient {
  /**
   * @param {{ apiKey?: string, baseUrl?: string, maxAttempts?: number, retryBaseMs?: number }} [options]
   */
  constructor(options = {}) {
    this._context = createDataClientContext(options);
    Object.assign(this, createDataMethods(this._context));
  }

  /**
   * Access underlying SDK client for advanced workflows.
   * @returns {import('@solana-tracker/data-api').Client}
   */
  get client() {
    return this._context.client;
  }

  /**
   * included for parity with RPC client.
   * @returns {Promise<void>}
   */
  async close() {
    this._context.log?.info?.('solanaTrackerData close');
  }
}

module.exports = {
  SolanaTrackerDataClient,
  createSolanaTrackerDataClient,
};
