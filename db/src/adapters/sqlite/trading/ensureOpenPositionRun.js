'use strict';

const crypto = require('crypto');
const {
  db,
  logger,
  resolveTradeUuid,
  setTradeUuid,
} = require('../context');

/**
 * Ensure there is an open position-run (sc_positions row) for (wallet_id, coin_mint).
 *
 * This is intended for:
 * - Warchest discovery (external buys/airdrops)
 * - Any resync job that needs a position-run id for a holding
 *
 * Behavior:
 * - If an open row exists, returns it.
 * - If missing, creates a new open row with a new trade_uuid.
 * - Attempts to persist the trade_uuid via context helpers so subsequent trades can reuse it.
 *
 * IMPORTANT:
 * - This does NOT insert into sc_trades. It only ensures sc_positions has an open run.
 * - PnL rollups are driven by sc_trades triggers; discovery may optionally create synthetic trades elsewhere.
 *
 * @param {Object} args
 * @param {number} args.walletId
 * @param {string} args.coinMint
 * @param {string|null} [args.walletAlias]
 * @param {string|null} [args.source]        e.g. 'discovery', 'airdrop'
 * @param {number|null} [args.openAt]        ms epoch
 * @param {number|null} [args.currentTokenAmount]
 * @param {string|null} [args.strategyId]
 * @param {string|null} [args.strategyName]
 * @returns {{ position: Object, trade_uuid: string, created: boolean }}
 */
function ensureOpenPositionRun(args) {
  if (!args || typeof args !== 'object') {
    throw new TypeError('ensureOpenPositionRun(args) requires an args object');
  }

  const walletId = args.walletId ?? args.wallet_id;
  const coinMint = args.coinMint ?? args.coin_mint;
  const walletAlias = args.walletAlias ?? args.wallet_alias ?? null;
  const source = args.source ?? 'discovery';
  const openAt = args.openAt ?? args.open_at ?? Date.now();
  const currentTokenAmount = args.currentTokenAmount ?? args.current_token_amount ?? null;
  const strategyId = args.strategyId ?? args.strategy_id ?? null;
  const strategyName = args.strategyName ?? args.strategy_name ?? null;

  if (!walletId || !coinMint) {
    throw new Error(`ensureOpenPositionRun missing required fields: walletId=${walletId}, coinMint=${coinMint}`);
  }

  const getOpen = db.prepare(
    'SELECT * FROM sc_positions WHERE wallet_id = ? AND coin_mint = ? AND (closed_at IS NULL OR closed_at = 0)'
  );

  const insertOpen = db.prepare(
    `
    INSERT INTO sc_positions (
      wallet_id,
      wallet_alias,
      coin_mint,
      trade_uuid,
      strategy_id,
      strategy_name,
      open_at,
      closed_at,
      last_trade_at,
      last_updated_at,
      entry_token_amount,
      current_token_amount,
      total_tokens_bought,
      total_tokens_sold,
      entry_price_sol,
      entry_price_usd,
      last_price_sol,
      last_price_usd,
      source
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @coin_mint,
      @trade_uuid,
      @strategy_id,
      @strategy_name,
      @open_at,
      NULL,
      @last_trade_at,
      @last_updated_at,
      NULL,
      @current_token_amount,
      0,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      @source
    )
  `
  );

  const tx = db.transaction(() => {
    const existing = getOpen.get(walletId, coinMint);
    if (existing) {
      // Ensure trade_uuid is persisted/cached for future trade inserts.
      if (existing.trade_uuid) {
        setTradeUuid(walletId, coinMint, existing.trade_uuid);
        return { position: existing, trade_uuid: existing.trade_uuid, created: false };
      }

      // No uuid on open row: resolve or create and attach.
      const resolved = resolveTradeUuid(walletId, coinMint) || crypto.randomUUID();
      setTradeUuid(walletId, coinMint, resolved);

      db.prepare('UPDATE sc_positions SET trade_uuid = ?, last_updated_at = ? WHERE position_id = ?').run(
        resolved,
        Date.now(),
        existing.position_id
      );

      const updated = getOpen.get(walletId, coinMint);
      return { position: updated, trade_uuid: resolved, created: false };
    }

    // Create new position-run
    // IMPORTANT: If there is no open run, this is a new campaign. Always mint a fresh UUID.
    // Do NOT reuse cached/pending UUIDs here, or closed campaigns can be accidentally reused.
    const newUuid = crypto.randomUUID();

    // Persist uuid (will stash pending if the position doesn't exist yet; after insert it will bind)
    setTradeUuid(walletId, coinMint, newUuid);

    const info = insertOpen.run({
      wallet_id: walletId,
      wallet_alias: walletAlias,
      coin_mint: coinMint,
      trade_uuid: newUuid,
      strategy_id: strategyId,
      strategy_name: strategyName,
      open_at: openAt,
      last_trade_at: openAt,
      last_updated_at: Date.now(),
      current_token_amount: currentTokenAmount,
      source,
    });

    const created = db.prepare('SELECT * FROM sc_positions WHERE position_id = ?').get(info.lastInsertRowid);

    // Just in case setTradeUuid stashed pending before the row existed, rebind now.
    if (created?.trade_uuid) {
      setTradeUuid(walletId, coinMint, created.trade_uuid);
    }

    return { position: created, trade_uuid: created.trade_uuid || newUuid, created: true };
  });

  try {
    return tx();
  } catch (err) {
    // If the partial unique index is hit by a race, just re-read and return.
    // This can happen if discovery and trade insert race each other.
    const msg = err?.message || String(err);
    if (msg.includes('uniq_sc_positions_open_wallet_mint') || msg.includes('UNIQUE')) {
      try {
        const existing = getOpen.get(walletId, coinMint);
        if (existing) {
          if (existing.trade_uuid) setTradeUuid(walletId, coinMint, existing.trade_uuid);
          return { position: existing, trade_uuid: existing.trade_uuid || resolveTradeUuid(walletId, coinMint), created: false };
        }
      } catch (_) {
        // fall through
      }
    }

    logger?.warn?.(`[BootyBox] ensureOpenPositionRun error: ${msg}`);
    throw err;
  }
}

module.exports = ensureOpenPositionRun;
