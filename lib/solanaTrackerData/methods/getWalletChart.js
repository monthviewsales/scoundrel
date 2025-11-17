'use strict';

/**
 * Bind helper returning wallet chart + PnL history.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(wallet: string) => Promise<any>}
 */
function createGetWalletChart({ client, call }) {
  if (!client || !call) throw new Error('createGetWalletChart: missing dependencies');

  return async function getWalletChart(wallet) {
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new Error('getWalletChart: wallet is required');
    }
    const owner = wallet.trim();
    const response = await call('getWalletChart', () => client.getWalletChart(owner));
    return response?.chart ?? response?.chartData ?? response ?? [];
  };
}

module.exports = { createGetWalletChart };
