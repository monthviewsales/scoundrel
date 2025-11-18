

'use strict';

/**
 * Factory to create a function that fetches user token trades
 * from the SolanaTracker Data API SDK.
 *
 * This wraps `client.getUserTokenTrades(tokenAddress, walletAddress)`
 * so it fits into Scoundrel's `call()` abstraction for logging,
 * metrics, and error handling.
 *
 * @param {object} deps
 * @param {import('@solana-tracker/data-api').Client} deps.client
 *   An initialized SolanaTracker Data API client.
 * @param {(name: string, fn: () => Promise<unknown>) => Promise<unknown>} deps.call
 *   Wrapper used throughout Scoundrel to invoke SDK methods.
 * @returns {(tokenAddress: string, walletAddress: string) => Promise<unknown>}
 *   Function that fetches trades for a specific token and wallet.
 */
function createGetUserTokenTrades({ client, call }) {
  if (!client) {
    throw new Error('getUserTokenTrades: client is required');
  }

  if (typeof call !== 'function') {
    throw new Error('getUserTokenTrades: call function is required');
  }

  /**
   * Get trades for a specific token and wallet.
   *
   * @param {string} tokenAddress - Token mint address.
   * @param {string} walletAddress - User wallet address.
   * @returns {Promise<unknown>} Resolves with the SDK response.
   */
  return async function getUserTokenTrades(tokenAddress, walletAddress) {
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getUserTokenTrades: tokenAddress is required');
    }

    if (typeof walletAddress !== 'string' || walletAddress.trim() === '') {
      throw new Error('getUserTokenTrades: walletAddress is required');
    }

    const mint = tokenAddress.trim();
    const owner = walletAddress.trim();

    return call('getUserTokenTrades', () =>
      client.getUserTokenTrades(mint, owner)
    );
  };
}

module.exports = {
  createGetUserTokenTrades,
};