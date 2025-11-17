'use strict';

/**
 * Bind helper composing a token snapshot at a fixed timestamp.
 *
 * @param {{ client: import('@solana-tracker/data-api').Client, call: Function }} deps
 * @returns {(options: { mint?: string, tokenAddress?: string, timestamp?: number, ts?: number }) => Promise<{ token: any, pools: any[], priceAt: { usd: number|null, time: number }, raw: { price: any, info: any } }>}
 */
function createGetTokenSnapshotAt({ client, call }) {
  if (!client || !call) throw new Error('createGetTokenSnapshotAt: missing dependencies');

  return async function getTokenSnapshotAt(options = {}) {
    const { mint, tokenAddress, timestamp, ts } = options;
    const target = typeof mint === 'string' && mint.trim() !== '' ? mint.trim() : tokenAddress?.trim();
    if (!target) throw new Error('getTokenSnapshotAt: mint/tokenAddress is required');
    const targetTs = Number(timestamp ?? ts);
    if (!Number.isFinite(targetTs)) {
      throw new Error('getTokenSnapshotAt: timestamp (ts) is required');
    }

    const price = await call(
      'getTokenSnapshotAt.price',
      () => client.getPriceAtTimestamp(target, targetTs),
    );
    const info = await call(
      'getTokenSnapshotAt.info',
      () => client.getTokenInfo(target),
    );

    const usd = price?.price ?? price?.priceUsd ?? null;
    return {
      token: info?.token ?? info ?? null,
      pools: info?.pools ?? [],
      priceAt: { usd, time: targetTs },
      raw: { price, info },
    };
  };
}

module.exports = { createGetTokenSnapshotAt };
