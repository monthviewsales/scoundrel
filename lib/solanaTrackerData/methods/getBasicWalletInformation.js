'use strict';

/**
 * Bind helper for fetching basic wallet metadata.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(wallet: string) => Promise<any>}
 */
function createGetBasicWalletInformation({ client, call }) {
  if (!client || !call) throw new Error('createGetBasicWalletInformation: missing dependencies');

  return async function getBasicWalletInformation(wallet) {
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getBasicWalletInformation: wallet is required');
    }
    const owner = wallet.trim();
    return call('getBasicWalletInformation', () => client.getWalletBasic(owner));
  };
}

module.exports = { createGetBasicWalletInformation };
