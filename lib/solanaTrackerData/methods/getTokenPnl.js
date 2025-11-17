'use strict';

/**
 * Bind helper fetching token-level PnL for a wallet.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { wallet: string, tokenAddress: string, holdingCheck?: boolean }) => Promise<any>}
 */
function createGetTokenPnl({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenPnl: missing dependencies');

  return async function getTokenPnL({ wallet, tokenAddress, holdingCheck = false } = {}) {
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getTokenPnL: wallet is required');
    }
    if (typeof tokenAddress !== 'string' || tokenAddress.trim() === '') {
      throw new Error('getTokenPnL: tokenAddress is required');
    }

    const owner = wallet.trim();
    const mint = tokenAddress.trim();

    return call('getTokenPnL', () => client.getTokenPnL(owner, mint, holdingCheck === true));
  };
}

module.exports = { createGetTokenPnl };
