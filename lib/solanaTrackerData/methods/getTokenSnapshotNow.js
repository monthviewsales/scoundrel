'use strict';

/**
 * Bind helper returning the latest token snapshot.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { mint?: string, tokenAddress?: string }) => Promise<any>}
 */
function createGetTokenSnapshotNow({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenSnapshotNow: missing dependencies');

  return async function getTokenSnapshotNow(options = {}) {
    const { mint, tokenAddress } = options;
    const target = typeof mint === 'string' && mint.trim() !== '' ? mint.trim() : tokenAddress?.trim();
    if (!target) throw new Error('getTokenSnapshotNow: mint/tokenAddress is required');
    return call('getTokenSnapshotNow', () => client.getTokenInfo(target));
  };
}

module.exports = { createGetTokenSnapshotNow };
