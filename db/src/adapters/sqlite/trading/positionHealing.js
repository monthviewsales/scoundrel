'use strict';

const { db, logger } = require('../context');

if (!db) throw new Error('[BootyBox] positionHealing requires a sqlite db instance');
if (typeof db.prepare !== 'function') {
  throw new Error('[BootyBox] positionHealing requires a sqlite db instance');
}

let ensuredTxidIndex = false;

function ensureTxidIndex() {
  if (ensuredTxidIndex) return;
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_trades_txid ON sc_trades(txid)');
  } catch (err) {
    logger?.warn?.(`[BootyBox] positionHealing ensureTxidIndex failed: ${err?.message || err}`);
  } finally {
    ensuredTxidIndex = true;
  }
}

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toAbsNumber(value, fallback = 0) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.abs(parsed) : fallback;
}

function pickFirstAlias(trades) {
  if (!Array.isArray(trades)) return null;
  for (const trade of trades) {
    const alias = trade?.wallet_alias ?? trade?.walletAlias ?? null;
    if (alias) return alias;
  }
  return null;
}

function normalizeTradeInput(trade, now) {
  if (!trade || typeof trade !== 'object') return null;
  const walletId = trade.wallet_id ?? trade.walletId ?? null;
  const walletAlias = trade.wallet_alias ?? trade.walletAlias ?? null;
  const tradeUuid = trade.trade_uuid ?? trade.tradeUuid ?? null;
  const coinMint = trade.coin_mint ?? trade.coinMint ?? null;
  const side = trade.side ?? null;
  const txid = trade.txid ?? trade.tx ?? trade.signature ?? null;
  const executedAt = toNumber(trade.executed_at ?? trade.executedAt, now);

  if (!walletId || !coinMint || !side || !txid) return null;

  const createdAt = toNumber(trade.created_at ?? trade.createdAt, now);
  const updatedAt = toNumber(trade.updated_at ?? trade.updatedAt, createdAt);

  return {
    wallet_id: walletId,
    wallet_alias: walletAlias,
    session_id: trade.session_id ?? trade.sessionId ?? null,
    trade_uuid: tradeUuid,
    coin_mint: coinMint,
    txid,
    side,
    executed_at: executedAt,
    token_amount: trade.token_amount ?? trade.tokenAmount ?? null,
    sol_amount: trade.sol_amount ?? trade.solAmount ?? null,
    price_sol_per_token: trade.price_sol_per_token ?? trade.priceSolPerToken ?? null,
    price_usd_per_token: trade.price_usd_per_token ?? trade.priceUsdPerToken ?? null,
    slippage_pct: trade.slippage_pct ?? trade.slippagePct ?? null,
    price_impact_pct: trade.price_impact_pct ?? trade.priceImpactPct ?? null,
    program: trade.program ?? null,
    evaluation_payload: trade.evaluation_payload ?? trade.evaluationPayload ?? null,
    decision_payload: trade.decision_payload ?? trade.decisionPayload ?? null,
    fees_sol: trade.fees_sol ?? trade.feesSol ?? null,
    fees_usd: trade.fees_usd ?? trade.feesUsd ?? null,
    sol_usd_price: trade.sol_usd_price ?? trade.solUsdPrice ?? null,
    strategy_id: trade.strategy_id ?? trade.strategyId ?? null,
    strategy_name: trade.strategy_name ?? trade.strategyName ?? null,
    decision_label: trade.decision_label ?? trade.decisionLabel ?? null,
    decision_reason: trade.decision_reason ?? trade.decisionReason ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function computePnlSummary(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;

  let totalTokensBought = 0;
  let totalTokensSold = 0;
  let totalSolSpent = 0;
  let totalSolReceived = 0;
  let feesSol = 0;
  let feesUsd = 0;
  let avgCostSol = 0;
  let avgCostUsd = 0;
  let realizedSol = 0;
  let realizedUsd = 0;
  let firstTradeAt = null;
  let lastTradeAt = null;

  for (const trade of trades) {
    const executedAt = toNumber(trade.executed_at ?? trade.executedAt, null);
    const tokenAmount = toAbsNumber(trade.token_amount ?? trade.tokenAmount, 0);
    const solAmount = toNumber(trade.sol_amount ?? trade.solAmount, 0);
    const solUsdPrice = toNumber(trade.sol_usd_price ?? trade.solUsdPrice, 0);
    const tradeFeesSol = toNumber(trade.fees_sol ?? trade.feesSol, 0);
    const tradeFeesUsd = toNumber(trade.fees_usd ?? trade.feesUsd, 0);

    if (executedAt != null) {
      if (firstTradeAt == null || executedAt < firstTradeAt) firstTradeAt = executedAt;
      if (lastTradeAt == null || executedAt > lastTradeAt) lastTradeAt = executedAt;
    }

    if (trade.side === 'buy') {
      totalTokensBought += tokenAmount;
      totalSolSpent += solAmount;
      feesSol += tradeFeesSol;
      feesUsd += tradeFeesUsd;
      if (totalTokensBought > 0) {
        avgCostSol = Math.abs(totalSolSpent) / totalTokensBought;
        avgCostUsd = (Math.abs(totalSolSpent) * solUsdPrice) / totalTokensBought;
      }
    } else if (trade.side === 'sell') {
      totalTokensSold += tokenAmount;
      totalSolReceived += solAmount;
      feesSol += tradeFeesSol;
      feesUsd += tradeFeesUsd;
      realizedSol += solAmount - (tokenAmount * avgCostSol);
      realizedUsd += (solAmount - (tokenAmount * avgCostSol)) * solUsdPrice;
    }
  }

  return {
    total_tokens_bought: totalTokensBought,
    total_tokens_sold: totalTokensSold,
    total_sol_spent: totalSolSpent,
    total_sol_received: totalSolReceived,
    fees_sol: feesSol,
    fees_usd: feesUsd,
    avg_cost_sol: avgCostSol,
    avg_cost_usd: avgCostUsd,
    realized_sol: realizedSol,
    realized_usd: realizedUsd,
    first_trade_at: firstTradeAt,
    last_trade_at: lastTradeAt,
    last_updated_at: lastTradeAt ?? Date.now(),
  };
}

/**
 * Load open positions for a wallet id (closed_at = 0).
 *
 * @param {number} walletId
 * @returns {Array<object>}
 */
function loadOpenPositionsByWalletId(walletId) {
  if (!walletId) {
    throw new Error('[BootyBox] loadOpenPositionsByWalletId requires walletId');
  }
  return db
    .prepare('SELECT * FROM sc_positions WHERE wallet_id = ? AND closed_at = 0')
    .all(walletId);
}

/**
 * Fetch existing sc_trades txids for a wallet + mint.
 *
 * @param {number} walletId
 * @param {string} coinMint
 * @returns {string[]}
 */
function listScTradeTxidsByWalletMint(walletId, coinMint) {
  if (!walletId || !coinMint) {
    throw new Error('[BootyBox] listScTradeTxidsByWalletMint requires walletId + coinMint');
  }
  const rows = db
    .prepare('SELECT txid FROM sc_trades WHERE wallet_id = ? AND coin_mint = ?')
    .all(walletId, coinMint);
  return rows.map((row) => row.txid).filter(Boolean);
}

/**
 * Insert missing sc_trades rows. Skips any trades missing required fields.
 *
 * @param {Array<object>} trades
 * @returns {{ inserted: number, skipped: number }}
 */
function insertScTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  ensureTxidIndex();
  const now = Date.now();

  const stmt = db.prepare(
    `
    INSERT INTO sc_trades (
      wallet_id,
      wallet_alias,
      session_id,
      trade_uuid,
      coin_mint,
      txid,
      side,
      executed_at,
      token_amount,
      sol_amount,
      price_sol_per_token,
      price_usd_per_token,
      slippage_pct,
      price_impact_pct,
      program,
      evaluation_payload,
      decision_payload,
      fees_sol,
      fees_usd,
      sol_usd_price,
      strategy_id,
      strategy_name,
      decision_label,
      decision_reason,
      created_at,
      updated_at
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @session_id,
      @trade_uuid,
      @coin_mint,
      @txid,
      @side,
      @executed_at,
      @token_amount,
      @sol_amount,
      @price_sol_per_token,
      @price_usd_per_token,
      @slippage_pct,
      @price_impact_pct,
      @program,
      @evaluation_payload,
      @decision_payload,
      @fees_sol,
      @fees_usd,
      @sol_usd_price,
      @strategy_id,
      @strategy_name,
      @decision_label,
      @decision_reason,
      @created_at,
      @updated_at
    )
    ON CONFLICT(txid) DO NOTHING
  `
  );

  const tx = db.transaction((items) => {
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      const normalized = normalizeTradeInput(item, now);
      if (!normalized) {
        skipped += 1;
        continue;
      }
      const info = stmt.run(normalized);
      if (info && info.changes > 0) inserted += 1;
    }
    return { inserted, skipped };
  });

  return tx(trades);
}

/**
 * Update a position row to match a wallet snapshot.
 *
 * @param {object} args
 * @param {number} args.positionId
 * @param {number} args.currentTokenAmount
 * @param {number|null} [args.lastPriceUsd]
 * @param {number|null} [args.lastPriceSol]
 * @param {number} [args.updatedAt]
 * @returns {number} changes count
 */
function updatePositionSnapshot({
  positionId,
  currentTokenAmount,
  lastPriceUsd,
  lastPriceSol,
  updatedAt,
}) {
  if (!positionId) {
    throw new Error('[BootyBox] updatePositionSnapshot requires positionId');
  }

  const now = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now();

  const stmt = db.prepare(
    `
    UPDATE sc_positions
    SET
      current_token_amount = @current_token_amount,
      last_price_usd = COALESCE(@last_price_usd, last_price_usd),
      last_price_sol = COALESCE(@last_price_sol, last_price_sol),
      last_updated_at = @last_updated_at
    WHERE position_id = @position_id
  `
  );

  const info = stmt.run({
    position_id: positionId,
    current_token_amount: currentTokenAmount,
    last_price_usd: lastPriceUsd ?? null,
    last_price_sol: lastPriceSol ?? null,
    last_updated_at: now,
  });

  return info?.changes || 0;
}

/**
 * Close an open position run.
 *
 * @param {object} args
 * @param {number} args.positionId
 * @param {number} [args.closedAt]
 * @param {number} [args.updatedAt]
 * @returns {number} changes count
 */
function closePositionRun({ positionId, closedAt, updatedAt }) {
  if (!positionId) {
    throw new Error('[BootyBox] closePositionRun requires positionId');
  }
  const closeAt = Number.isFinite(Number(closedAt)) ? Number(closedAt) : Date.now();
  const now = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : closeAt;

  const stmt = db.prepare(
    `
    UPDATE sc_positions
    SET
      current_token_amount = 0,
      closed_at = @closed_at,
      last_updated_at = @last_updated_at
    WHERE position_id = @position_id
  `
  );

  const info = stmt.run({
    position_id: positionId,
    closed_at: closeAt,
    last_updated_at: now,
  });

  return info?.changes || 0;
}

/**
 * Rebuild sc_pnl and sc_pnl_positions for a wallet + mint from sc_trades.
 *
 * @param {object} args
 * @param {number} args.walletId
 * @param {string} args.coinMint
 * @returns {{ cleared: boolean, tradeCount: number, positionCount: number }}
 */
function rebuildScPnlForWalletMint({ walletId, coinMint }) {
  if (!walletId || !coinMint) {
    throw new Error('[BootyBox] rebuildScPnlForWalletMint requires walletId + coinMint');
  }

  const trades = db
    .prepare(
      `
      SELECT
        wallet_id,
        wallet_alias,
        coin_mint,
        trade_uuid,
        side,
        token_amount,
        sol_amount,
        fees_sol,
        fees_usd,
        sol_usd_price,
        executed_at
      FROM sc_trades
      WHERE wallet_id = ?
        AND coin_mint = ?
      ORDER BY executed_at ASC, id ASC
    `
    )
    .all(walletId, coinMint);

  const overall = computePnlSummary(trades);
  const walletAlias = pickFirstAlias(trades);

  const positions = new Map();
  for (const trade of trades) {
    const tradeUuid = trade.trade_uuid ?? null;
    if (!tradeUuid) continue;
    if (!positions.has(tradeUuid)) positions.set(tradeUuid, []);
    positions.get(tradeUuid).push(trade);
  }

  const stmtDeletePnl = db.prepare(
    'DELETE FROM sc_pnl WHERE wallet_id = ? AND coin_mint = ?'
  );
  const stmtDeletePositions = db.prepare(
    'DELETE FROM sc_pnl_positions WHERE wallet_id = ? AND coin_mint = ?'
  );

  const stmtInsertPnl = db.prepare(
    `
    INSERT INTO sc_pnl (
      wallet_id,
      wallet_alias,
      coin_mint,
      total_tokens_bought,
      total_tokens_sold,
      total_sol_spent,
      total_sol_received,
      fees_sol,
      fees_usd,
      avg_cost_sol,
      avg_cost_usd,
      realized_sol,
      realized_usd,
      first_trade_at,
      last_trade_at,
      last_updated_at
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @coin_mint,
      @total_tokens_bought,
      @total_tokens_sold,
      @total_sol_spent,
      @total_sol_received,
      @fees_sol,
      @fees_usd,
      @avg_cost_sol,
      @avg_cost_usd,
      @realized_sol,
      @realized_usd,
      @first_trade_at,
      @last_trade_at,
      @last_updated_at
    )
  `
  );

  const stmtInsertPosition = db.prepare(
    `
    INSERT INTO sc_pnl_positions (
      wallet_id,
      wallet_alias,
      coin_mint,
      trade_uuid,
      total_tokens_bought,
      total_tokens_sold,
      total_sol_spent,
      total_sol_received,
      fees_sol,
      fees_usd,
      avg_cost_sol,
      avg_cost_usd,
      realized_sol,
      realized_usd,
      first_trade_at,
      last_trade_at,
      last_updated_at
    ) VALUES (
      @wallet_id,
      @wallet_alias,
      @coin_mint,
      @trade_uuid,
      @total_tokens_bought,
      @total_tokens_sold,
      @total_sol_spent,
      @total_sol_received,
      @fees_sol,
      @fees_usd,
      @avg_cost_sol,
      @avg_cost_usd,
      @realized_sol,
      @realized_usd,
      @first_trade_at,
      @last_trade_at,
      @last_updated_at
    )
  `
  );

  const tx = db.transaction(() => {
    stmtDeletePnl.run(walletId, coinMint);
    stmtDeletePositions.run(walletId, coinMint);

    if (overall) {
      stmtInsertPnl.run({
        wallet_id: walletId,
        wallet_alias: walletAlias,
        coin_mint: coinMint,
        ...overall,
      });
    }

    for (const [tradeUuid, rows] of positions.entries()) {
      const summary = computePnlSummary(rows);
      if (!summary) continue;
      const alias = pickFirstAlias(rows) || walletAlias;
      stmtInsertPosition.run({
        wallet_id: walletId,
        wallet_alias: alias,
        coin_mint: coinMint,
        trade_uuid: tradeUuid,
        ...summary,
      });
    }
  });

  tx();

  return {
    cleared: !overall,
    tradeCount: trades.length,
    positionCount: positions.size,
  };
}

module.exports = {
  loadOpenPositionsByWalletId,
  listScTradeTxidsByWalletMint,
  insertScTrades,
  updatePositionSnapshot,
  closePositionRun,
  rebuildScPnlForWalletMint,
};
