'use strict';

/**
 * Normalize a wallet payload into the internal wallet spec shape.
 * @param {any} payloadWallet
 * @returns {{ alias: string, pubkey: string|null, color: string|null }}
 * @throws {Error}
 */
function normalizeWallet(payloadWallet) {
  const wallet = payloadWallet || {};
  const alias = wallet && (wallet.alias || wallet.walletAlias || wallet.name);
  const pubkey = wallet && (wallet.pubkey || wallet.wallet || wallet.address);

  if (!alias) {
    throw new Error('sellOps requires wallet alias');
  }

  // pubkey is optional for SellOps (DB-driven), but keep it if provided.
  return {
    alias: String(alias).trim(),
    pubkey: pubkey ? String(pubkey).trim() : null,
    color: wallet.color || null,
  };
}

/**
 * Convert a DB row from BootyBox.loadOpenPositions() into a position summary.
 * @param {any} row
 * @returns {Object}
 */
function toPositionSummary(row) {
  return {
    positionId: row.position_id,
    walletId: row.wallet_id,
    walletAlias: row.wallet_alias,
    mint: row.coin_mint,
    tradeUuid: row.trade_uuid,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    openAt: row.open_at,
    closedAt: row.closed_at,
    lastTradeAt: row.last_trade_at,
    lastUpdatedAt: row.last_updated_at,
    entryTokenAmount: row.entry_token_amount,
    currentTokenAmount: row.current_token_amount,
    totalTokensBought: row.total_tokens_bought,
    totalTokensSold: row.total_tokens_sold,
    entryPriceSol: row.entry_price_sol,
    entryPriceUsd: row.entry_price_usd,
    lastPriceSol: row.last_price_sol,
    lastPriceUsd: row.last_price_usd,
    source: row.source,
  };
}

module.exports = {
  normalizeWallet,
  toPositionSummary,
};
