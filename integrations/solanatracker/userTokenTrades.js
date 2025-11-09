

'use strict';

/**
 * integrations/solanatracker/userTokenTrades.js
 * Custom integration for SolanaTracker Data API:
 *   GET /trades/{tokenAddress}/by-wallet/{owner}
 * Docs: https://docs.solanatracker.io/data-api/trades/get-user-specific-token-trades
 *
 * Example:
 * const { getUserTokenTradesByWallet } = require('../../integrations/solanatracker/userTokenTrades');
 * const data = await getUserTokenTradesByWallet({
 *   tokenAddress: 'Hf2...pump',
 *   owner: '9Yp...sol',
 *   apiKey: process.env.SOLANATRACKER_API_KEY
 * });
 */

/**
 * Fetch user-specific trades for a given token from SolanaTracker.
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  - Token mint address
 * @param {string} opts.owner         - Wallet address
 * @param {string} [opts.apiKey]      - SolanaTracker API key (defaults to env)
 * @param {string} [opts.cursor]      - Pagination cursor
 * @param {boolean} [opts.showMeta=false]
 * @param {boolean} [opts.parseJupiter=true]
 * @param {boolean} [opts.hideArb=true]
 * @param {string} [opts.sortDirection='DESC']
 * @returns {Promise<Object>} Parsed JSON response from the API
 */
async function getUserTokenTradesByWallet(opts) {
  const {
    tokenAddress,
    owner,
    apiKey = process.env.SOLANATRACKER_API_KEY,
    cursor,
    showMeta = false,
    parseJupiter = true,
    hideArb = true,
    sortDirection = 'DESC',
  } = opts;

  if (!tokenAddress || !owner) {
    throw new Error('getUserTokenTradesByWallet: tokenAddress and owner are required');
  }

  const base = process.env.SOLANATRACKER_BASE_URL || 'https://data.solanatracker.io';
  const endpoint = `${base}/trades/${tokenAddress}/by-wallet/${owner}`;
  const params = new URLSearchParams({
    ...(cursor ? { cursor } : {}),
    showMeta: String(showMeta),
    parseJupiter: String(parseJupiter),
    hideArb: String(hideArb),
    sortDirection
  });

  const url = `${endpoint}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'x-api-key': apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SolanaTracker user token trades fetch failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data;
}

module.exports = { getUserTokenTradesByWallet };