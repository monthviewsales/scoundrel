'use strict';

require('./env/safeDotenv').loadDotenv();
const baseLogger = require('./logger');
const { createDataClientContext } = require('./solanaTrackerData/context');
const { createDataMethods } = require('./solanaTrackerData/methods');

const defaultLogger = typeof baseLogger.solanaTrackerData === 'function'
  ? baseLogger.solanaTrackerData()
  : baseLogger.child({ scope: 'SolanaTrackerDataClient' });

/**
 * Factory function mirroring the RPC client ergonomics.
 *
 * @param {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   maxAttempts?: number,
 *   retryBaseMs?: number,
 *   artifacts?: { write?: Function } | null,
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function } | null
 * }} [options]
 * @returns {{ client: import('@solana-tracker/data-api').Client, close: () => Promise<void> } & Record<string, Function>}
 */
function createSolanaTrackerDataClient(options = {}) {
  const context = createDataClientContext({
    ...options,
    logger: options.logger || defaultLogger,
  });
  const methods = createDataMethods(context);
  return {
    ...methods,
    client: context.client,
    close: async () => {},
  };
}

class SolanaTrackerDataClient {
  /**
   * @param {{
   *   apiKey?: string,
   *   baseUrl?: string,
   *   maxAttempts?: number,
   *   retryBaseMs?: number,
   *   artifacts?: { write?: Function } | null,
   *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function } | null
   * }} [options]
   */
  constructor(options = {}) {
    this._context = createDataClientContext({
      ...options,
      logger: options.logger || defaultLogger,
    });
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
