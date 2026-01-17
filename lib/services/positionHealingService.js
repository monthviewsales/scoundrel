'use strict';

const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');

const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'So11111111111111111111111111111111111111111',
]);

function toNumber(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveNumber(value) {
  const parsed = toNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

function normalizeWalletEntry(wallet) {
  if (!wallet || typeof wallet !== 'object') return null;
  const alias =
    wallet.alias ||
    wallet.walletAlias ||
    wallet.name ||
    wallet.wallet_alias ||
    null;
  const pubkey =
    wallet.pubkey ||
    wallet.wallet ||
    wallet.address ||
    wallet.walletAddress ||
    wallet.wallet_pubkey ||
    null;
  const walletId = wallet.walletId ?? wallet.wallet_id ?? null;
  if (!pubkey || walletId == null) return null;
  return {
    alias: alias ? String(alias) : null,
    pubkey: String(pubkey),
    walletId,
  };
}

function shouldSkipMint(mint, includeSol) {
  if (!mint) return true;
  if (includeSol) return false;
  return SOL_MINTS.has(mint);
}

function normalizeSnapshotTokens(snapshot, includeSol) {
  const map = new Map();
  const rows = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  for (const row of rows) {
    const mint = row?.address || row?.mint || row?.token || null;
    if (shouldSkipMint(mint, includeSol)) continue;

    const balance = toNumber(row?.balance);
    if (balance == null || balance <= 0) continue;

    const priceUsd = toPositiveNumber(row?.price?.usd ?? row?.price?.quote);
    const priceSol = toPositiveNumber(row?.price?.quote);
    const liquidityUsd = toPositiveNumber(row?.liquidity?.usd ?? row?.liquidity?.quote);
    const marketCapUsd = toPositiveNumber(row?.marketCap?.usd ?? row?.marketCap?.quote);
    const valueUsd = toPositiveNumber(row?.value ?? row?.valueUsd);

    const existing = map.get(mint);
    if (!existing) {
      map.set(mint, {
        mint,
        balance,
        priceUsd,
        priceSol,
        liquidityUsd,
        marketCapUsd,
        valueUsd,
        raw: row,
      });
      continue;
    }

    existing.balance += balance;
    existing.priceUsd = existing.priceUsd ?? priceUsd;
    existing.priceSol = existing.priceSol ?? priceSol;
    existing.liquidityUsd = existing.liquidityUsd ?? liquidityUsd;
    existing.marketCapUsd = existing.marketCapUsd ?? marketCapUsd;
    existing.valueUsd = existing.valueUsd ?? valueUsd;
  }

  return map;
}

function normalizeUserTrades(payload) {
  const raw = Array.isArray(payload?.trades)
    ? payload.trades
    : Array.isArray(payload)
      ? payload
      : [];

  const normalized = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const txid = row.tx || row.txid || row.signature || row.id || null;
    const sideRaw = String(row.type || row.side || '').toLowerCase();
    const side = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : null;
    const tokenAmount = toNumber(row.amount ?? row.tokenAmount ?? row.qty);
    const time = toNumber(
      row.time ??
        row.timestamp ??
        row.blockTime ??
        row.block_time ??
        row.ts
    );

    if (!txid || !side || tokenAmount == null || time == null) continue;

    const volumeUsd = toPositiveNumber(row.volume ?? row.volumeUsd ?? row.volume_usd);
    const volumeSol = toPositiveNumber(row.volumeSol ?? row.volume_sol);
    const priceUsd = toPositiveNumber(row.priceUsd ?? row.price_usd);
    const priceSol = volumeSol && tokenAmount ? volumeSol / Math.abs(tokenAmount) : null;
    const solUsdPrice =
      volumeUsd && volumeSol
        ? volumeUsd / volumeSol
        : priceUsd && priceSol
          ? priceUsd / priceSol
          : null;

    normalized.push({
      txid,
      side,
      tokenAmount: Math.abs(tokenAmount),
      time,
      volumeUsd,
      volumeSol,
      priceUsd,
      priceSol,
      solUsdPrice,
      program: row.program || null,
      raw: row,
    });
  }

  const deduped = new Map();
  for (const trade of normalized) {
    if (!deduped.has(trade.txid)) deduped.set(trade.txid, trade);
  }

  return Array.from(deduped.values()).sort((a, b) => a.time - b.time);
}

function resolveRunStartTime(trades, resetEpsilon) {
  if (!Array.isArray(trades) || trades.length === 0) return null;

  const epsilon = Number.isFinite(resetEpsilon) ? resetEpsilon : 1e-9;
  let balance = 0;
  let lastResetIndex = -1;

  for (let i = 0; i < trades.length; i += 1) {
    const trade = trades[i];
    if (trade.side === 'buy') {
      balance += trade.tokenAmount;
    } else if (trade.side === 'sell') {
      balance -= trade.tokenAmount;
    }

    if (balance <= epsilon) {
      balance = 0;
      lastResetIndex = i;
    }
  }

  if (lastResetIndex + 1 < trades.length) {
    return trades[lastResetIndex + 1].time;
  }

  return trades[0]?.time ?? null;
}

function needsPriceUpdate(position, snapshot) {
  if (!position || !snapshot) return false;
  const lastUsd = toPositiveNumber(position.last_price_usd ?? position.lastPriceUsd);
  const lastSol = toPositiveNumber(position.last_price_sol ?? position.lastPriceSol);
  const nextUsd = toPositiveNumber(snapshot.priceUsd);
  const nextSol = toPositiveNumber(snapshot.priceSol);

  return (nextUsd && !lastUsd) || (nextSol && !lastSol);
}

function buildTradeInsert(trade, wallet, mint, tradeUuid) {
  const solAmount = toNumber(trade.volumeSol);
  const tokenAmount = toNumber(trade.tokenAmount);
  const priceSolPerToken =
    solAmount != null && tokenAmount
      ? solAmount / Math.abs(tokenAmount)
      : trade.priceSol ?? null;

  return {
    walletId: wallet.walletId,
    walletAlias: wallet.alias,
    coinMint: mint,
    tradeUuid: tradeUuid || null,
    txid: trade.txid,
    side: trade.side,
    executedAt: trade.time,
    tokenAmount: tokenAmount != null ? Math.abs(tokenAmount) : null,
    solAmount: solAmount,
    priceSolPerToken,
    priceUsdPerToken: trade.priceUsd ?? null,
    solUsdPrice: trade.solUsdPrice ?? null,
    program: trade.program || null,
  };
}

/**
 * Heal sc_positions + sc_trades using SolanaTracker snapshots + trade history.
 *
 * @param {object} args
 * @param {Array<{walletId:number, alias:string, pubkey:string}>} args.wallets
 * @param {object} args.bootyBox
 * @param {object} [args.dataClient]
 * @param {object} [args.logger]
 * @param {boolean} [args.includeSol=false]
 * @param {boolean} [args.closeMissing=true]
 * @param {number} [args.dustEpsilon=0]
 * @param {(event:string, payload?:object) => void} [args.onProgress]
 * @returns {Promise<object>}
 */
async function runPositionHealing({
  wallets,
  bootyBox,
  dataClient: providedDataClient,
  logger,
  includeSol = false,
  closeMissing = true,
  dustEpsilon = 0,
  onProgress,
} = {}) {
  if (!bootyBox) throw new Error('runPositionHealing requires BootyBox');
  if (!Array.isArray(wallets) || wallets.length === 0) {
    return {
      wallets: 0,
      positions: { created: 0, updated: 0, closed: 0, matched: 0, priceFixed: 0 },
      trades: { requested: 0, missing: 0, inserted: 0, skipped: 0 },
      pnl: { rebuilt: 0 },
    };
  }

  const required = [
    'loadOpenPositionsByWalletId',
    'ensureOpenPositionRun',
    'updatePositionSnapshot',
    'closePositionRun',
    'listScTradeTxidsByWalletMint',
    'insertScTrades',
    'rebuildScPnlForWalletMint',
  ];
  const missing = required.filter((fn) => typeof bootyBox[fn] !== 'function');
  if (missing.length) {
    throw new Error(`runPositionHealing missing BootyBox helpers: ${missing.join(', ')}`);
  }

  const dataClient =
    providedDataClient || createSolanaTrackerDataClient({ logger });

  const summary = {
    wallets: 0,
    positions: { created: 0, updated: 0, closed: 0, matched: 0, priceFixed: 0 },
    trades: { requested: 0, missing: 0, inserted: 0, skipped: 0 },
    pnl: { rebuilt: 0 },
    warnings: [],
  };

  const resetEpsilon = Math.max(Number(dustEpsilon) || 0, 1e-9);

  for (const wallet of wallets) {
    const normalized = normalizeWalletEntry(wallet);
    if (!normalized) {
      summary.warnings.push('Skipping wallet with missing id/pubkey.');
      continue;
    }
    const { walletId, pubkey, alias } = normalized;
    summary.wallets += 1;

    onProgress?.('wallet:start', { walletId, alias, pubkey });

    let snapshot;
    try {
      snapshot = await dataClient.getBasicWalletInformation(pubkey);
    } catch (err) {
      const msg = err?.message || err;
      summary.warnings.push(`getBasicWalletInformation failed for ${alias}: ${msg}`);
      logger?.warn?.(`[positionHeal] getBasicWalletInformation failed for ${alias}: ${msg}`);
      continue;
    }

    const snapshotTokens = normalizeSnapshotTokens(snapshot, includeSol);

    let openPositions = [];
    try {
      openPositions = bootyBox.loadOpenPositionsByWalletId(walletId) || [];
    } catch (err) {
      const msg = err?.message || err;
      summary.warnings.push(`loadOpenPositionsByWalletId failed for ${alias}: ${msg}`);
      logger?.warn?.(`[positionHeal] loadOpenPositionsByWalletId failed for ${alias}: ${msg}`);
      continue;
    }

    const openByMint = new Map();
    for (const pos of openPositions) {
      const mint = pos?.coin_mint ?? pos?.coinMint;
      if (shouldSkipMint(mint, includeSol)) continue;

      if (!pos.trade_uuid) {
        try {
          const ensured = bootyBox.ensureOpenPositionRun({
            walletId,
            coinMint: mint,
            walletAlias: pos.wallet_alias || alias,
            source: pos.source || 'heal',
            currentTokenAmount: pos.current_token_amount ?? null,
            openAt: pos.open_at ?? null,
          });
          if (ensured?.position) {
            openByMint.set(mint, ensured.position);
            continue;
          }
        } catch (err) {
          const msg = err?.message || err;
          logger?.warn?.(`[positionHeal] ensureOpenPositionRun failed for ${alias} ${mint}: ${msg}`);
        }
      }

      openByMint.set(mint, pos);
    }

    const mintsNeedingTrades = new Set();
    const pendingCreates = new Map();
    const pendingUpdates = new Map();
    const pendingCloses = new Map();

    for (const [mint, snap] of snapshotTokens.entries()) {
      const pos = openByMint.get(mint);
      if (!pos) {
        pendingCreates.set(mint, snap);
        mintsNeedingTrades.add(mint);
        continue;
      }

      const dbAmount = toNumber(pos.current_token_amount) ?? 0;
      const diff = Math.abs(snap.balance - dbAmount);
      if (diff > dustEpsilon) {
        pendingUpdates.set(mint, { snapshot: snap, position: pos });
        mintsNeedingTrades.add(mint);
      } else if (needsPriceUpdate(pos, snap)) {
        pendingUpdates.set(mint, { snapshot: snap, position: pos, priceOnly: true });
      } else {
        summary.positions.matched += 1;
      }
    }

    for (const [mint, pos] of openByMint.entries()) {
      if (snapshotTokens.has(mint)) continue;
      if (closeMissing) {
        pendingCloses.set(mint, pos);
        mintsNeedingTrades.add(mint);
      }
    }

    for (const mint of mintsNeedingTrades) {
      summary.trades.requested += 1;
      const snap = snapshotTokens.get(mint) || null;
      const snapBalance = snap ? toNumber(snap.balance) : null;
      let openPos = openByMint.get(mint) || null;

      let trades;
      try {
        const resp = await dataClient.getUserTokenTrades(mint, pubkey);
        trades = normalizeUserTrades(resp);
      } catch (err) {
        const msg = err?.message || err;
        summary.warnings.push(`getUserTokenTrades failed for ${alias} ${mint}: ${msg}`);
        logger?.warn?.(`[positionHeal] getUserTokenTrades failed for ${alias} ${mint}: ${msg}`);
        continue;
      }

      const runStartTime = resolveRunStartTime(trades, resetEpsilon);

      if (!openPos && snapBalance != null && snapBalance > 0) {
        try {
          const ensured = bootyBox.ensureOpenPositionRun({
            walletId,
            coinMint: mint,
            walletAlias: alias,
            source: 'heal',
            currentTokenAmount: snapBalance,
            openAt: runStartTime ?? Date.now(),
          });
          openPos = ensured?.position || null;
          if (openPos) {
            openByMint.set(mint, openPos);
            pendingCreates.delete(mint);
            summary.positions.created += 1;
            if (snap) {
              const lastPriceUsd = toPositiveNumber(snap.priceUsd);
              const lastPriceSol = toPositiveNumber(snap.priceSol);
              if (lastPriceUsd || lastPriceSol) {
                bootyBox.updatePositionSnapshot({
                  positionId: openPos.position_id,
                  currentTokenAmount: snapBalance,
                  lastPriceUsd,
                  lastPriceSol,
                });
              }
            }
          }
        } catch (err) {
          const msg = err?.message || err;
          summary.warnings.push(`ensureOpenPositionRun failed for ${alias} ${mint}: ${msg}`);
          logger?.warn?.(`[positionHeal] ensureOpenPositionRun failed for ${alias} ${mint}: ${msg}`);
        }
      }

      const openAt = toNumber(openPos?.open_at ?? openPos?.openAt);
      const attachSince = runStartTime ?? openAt ?? null;

      let existingTxids = [];
      try {
        existingTxids = bootyBox.listScTradeTxidsByWalletMint(walletId, mint) || [];
      } catch (err) {
        const msg = err?.message || err;
        summary.warnings.push(`listScTradeTxidsByWalletMint failed for ${alias} ${mint}: ${msg}`);
        logger?.warn?.(`[positionHeal] listScTradeTxidsByWalletMint failed for ${alias} ${mint}: ${msg}`);
      }
      const existingSet = new Set(existingTxids);

      const missingTrades = [];
      for (const trade of trades) {
        if (existingSet.has(trade.txid)) continue;
        summary.trades.missing += 1;
        const attachTradeUuid =
          openPos && attachSince != null && trade.time >= attachSince
            ? openPos.trade_uuid
            : null;
        missingTrades.push(buildTradeInsert(trade, normalized, mint, attachTradeUuid));
      }

      if (missingTrades.length) {
        const inserted = bootyBox.insertScTrades(missingTrades);
        summary.trades.inserted += inserted.inserted;
        summary.trades.skipped += inserted.skipped;

        if (inserted.inserted > 0) {
          try {
            bootyBox.rebuildScPnlForWalletMint({ walletId, coinMint: mint });
            summary.pnl.rebuilt += 1;
          } catch (err) {
            const msg = err?.message || err;
            summary.warnings.push(`rebuildScPnlForWalletMint failed for ${alias} ${mint}: ${msg}`);
            logger?.warn?.(`[positionHeal] rebuildScPnlForWalletMint failed for ${alias} ${mint}: ${msg}`);
          }
        }
      }
    }

    for (const [mint, snap] of pendingCreates.entries()) {
      const balance = toNumber(snap.balance) ?? 0;
      if (!(balance > 0)) continue;
      try {
        const ensured = bootyBox.ensureOpenPositionRun({
          walletId,
          coinMint: mint,
          walletAlias: alias,
          source: 'heal',
          currentTokenAmount: balance,
          openAt: Date.now(),
        });
        if (ensured?.position) {
          openByMint.set(mint, ensured.position);
          summary.positions.created += 1;
          const lastPriceUsd = toPositiveNumber(snap.priceUsd);
          const lastPriceSol = toPositiveNumber(snap.priceSol);
          if (lastPriceUsd || lastPriceSol) {
            bootyBox.updatePositionSnapshot({
              positionId: ensured.position.position_id,
              currentTokenAmount: balance,
              lastPriceUsd,
              lastPriceSol,
            });
          }
        }
      } catch (err) {
        const msg = err?.message || err;
        summary.warnings.push(`ensureOpenPositionRun failed for ${alias} ${mint}: ${msg}`);
        logger?.warn?.(`[positionHeal] ensureOpenPositionRun failed for ${alias} ${mint}: ${msg}`);
      }
    }

    for (const [mint, entry] of pendingUpdates.entries()) {
      const snap = entry.snapshot;
      const pos = openByMint.get(mint) || entry.position;
      if (!pos) continue;
      const balance = toNumber(snap.balance) ?? toNumber(pos.current_token_amount) ?? 0;
      const lastPriceUsd = toPositiveNumber(snap.priceUsd);
      const lastPriceSol = toPositiveNumber(snap.priceSol);
      try {
        bootyBox.updatePositionSnapshot({
          positionId: pos.position_id,
          currentTokenAmount: balance,
          lastPriceUsd,
          lastPriceSol,
        });
        summary.positions.updated += entry.priceOnly ? 0 : 1;
        if (entry.priceOnly) summary.positions.priceFixed += 1;
      } catch (err) {
        const msg = err?.message || err;
        summary.warnings.push(`updatePositionSnapshot failed for ${alias} ${mint}: ${msg}`);
        logger?.warn?.(`[positionHeal] updatePositionSnapshot failed for ${alias} ${mint}: ${msg}`);
      }
    }

    if (closeMissing) {
      for (const [mint, pos] of pendingCloses.entries()) {
        try {
          bootyBox.closePositionRun({
            positionId: pos.position_id,
            closedAt: Date.now(),
          });
          summary.positions.closed += 1;
        } catch (err) {
          const msg = err?.message || err;
          summary.warnings.push(`closePositionRun failed for ${alias} ${mint}: ${msg}`);
          logger?.warn?.(`[positionHeal] closePositionRun failed for ${alias} ${mint}: ${msg}`);
        }
      }
    }

    onProgress?.('wallet:done', { walletId, alias, mints: snapshotTokens.size });
  }

  return summary;
}

module.exports = {
  runPositionHealing,
};
