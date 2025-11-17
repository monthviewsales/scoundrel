'use strict';

/**
 * Bind helper returning wallet-wide PnL metrics.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { wallet: string, showHistoricPnl?: boolean, holdingCheck?: boolean, hideDetails?: boolean }) => Promise<any>}
 */
function createGetWalletPnl({ client, call }) {
  if (!client || !call) throw new Error('createGetWalletPnl: missing dependencies');

  return async function getWalletPnl(options = {}) {
    const {
      wallet,
      showHistoricPnl = false,
      holdingCheck = false,
      hideDetails = false,
    } = options;

    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getWalletPnl: wallet is required');
    }
    const owner = wallet.trim();

    return call('getWalletPnl', () => client.getWalletPnL(
      owner,
      showHistoricPnl === true,
      holdingCheck === true,
      hideDetails === true,
    ));
  };
}

module.exports = { createGetWalletPnl };
