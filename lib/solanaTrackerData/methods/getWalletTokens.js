'use strict';

/**
 * Bind helper fetching wallet token holdings.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { wallet: string, page?: number }) => Promise<any>}
 */
function createGetWalletTokens({ client, call }) {
  if (!client || !call) throw new Error('createGetWalletTokens: missing dependencies');

  return async function getWalletTokens(options = {}) {
    const { wallet, page } = options;
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getWalletTokens: wallet is required');
    }
    const owner = wallet.trim();
    if (page != null && (!Number.isInteger(page) || page <= 0)) {
      throw new Error('getWalletTokens: page must be a positive integer when provided');
    }

    if (page != null) {
      return call('getWalletTokens', () => client.getWalletPage(owner, page));
    }
    return call('getWalletTokens', () => client.getWallet(owner));
  };
}

module.exports = { createGetWalletTokens };
