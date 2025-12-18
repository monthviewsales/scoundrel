'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const logger = require('../../utils/logger');
const { ensureSqliteSchema } = require('../sqliteSchema');

let defaultWalletPublicKey = null;

// Ensure DB directory exists to avoid failures in tests/runtime
const dbDir = path.join(__dirname, '../../../../','db');
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (e) {
  logger?.debug?.(`[BootyBox] mkdirSync failed: ${e.message}`);
}

const legacyDbPath = path.join(dbDir, 'db', 'bootybox.db');
const defaultDbPath = path.join(dbDir, 'bootybox.db');

let dbFile = process.env.BOOTYBOX_SQLITE_PATH || defaultDbPath;

if (!process.env.BOOTYBOX_SQLITE_PATH && !fs.existsSync(defaultDbPath) && fs.existsSync(legacyDbPath)) {
  try {
    fs.mkdirSync(path.dirname(defaultDbPath), { recursive: true });
    fs.renameSync(legacyDbPath, defaultDbPath);
    logger.warn?.(
      chalk.bgYellow.black(
        '[BootyBox] Detected legacy db/db/bootybox.db. Migrated to db/bootybox.db for native Scoundrel installs.'
      )
    );
  } catch (err) {
    logger.warn?.(`[BootyBox] Failed to migrate legacy SQLite file: ${err?.message || err}`);
  }
}

try {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
} catch (e) {
  logger?.debug?.(`[BootyBox] mkdirSync failed for ${path.dirname(dbFile)}: ${e.message}`);
}

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 3000');
db.pragma('foreign_keys = ON');

let dbClosed = false;
const pendingSwaps = new Map();
const tradeUuidMap = new Map();

const normalizeWalletField = (value) => {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'unknown') return null;
  return str;
};

function setDefaultWalletPublicKey(pubkey) {
  defaultWalletPublicKey = normalizeWalletField(pubkey);
}

function getDefaultWalletPublicKey() {
  return defaultWalletPublicKey;
}

ensureSqliteSchema(db, tradeUuidMap);

function saveInput(input) {
  if (process.env.SAVE_RAW !== 'true') return;
  try {
    const outDir = path.join(process.cwd(), 'data', 'bootybox');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `BootyBoxInput-${timestamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(input, null, 2), 'utf8');
    logger.info(`[BootyBox] Saved raw token info to ${outPath}`);
  } catch (err) {
    logger.warn(`[BootyBox] Failed to save raw token info: ${err?.message || err}`);
  }
}

function normalizeTradeUuidArgs(a, b) {
  // Back-compat: old callers used (mint, uuid) or (mint)
  if (b === undefined) return { walletId: null, mint: a };
  return { walletId: a, mint: b };
}

function tradeUuidCacheKey(walletId, mint) {
  return `${walletId || 'any'}:${mint}`;
}

function upsertPendingTradeUuid(walletId, mint, uuid) {
  if (!mint || !uuid) return;
  db.prepare(
    `
    INSERT INTO pending_trade_uuids (wallet_id, mint, trade_uuid, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet_id, mint) DO UPDATE SET
      trade_uuid = excluded.trade_uuid,
      created_at = excluded.created_at
  `
  ).run(walletId, mint, uuid, Date.now());
}


function deletePendingTradeUuid(walletId, mint) {
  if (!mint) return;
  db.prepare('DELETE FROM pending_trade_uuids WHERE wallet_id IS ? AND mint = ?').run(walletId, mint);
}

function cleanupPendingTradeUuids(options = {}) {
  const {
    maxAgeMs = 24 * 60 * 60 * 1000, // default: 24 hours
    nowMs = Date.now(),
    limit = 5000,
  } = options;

  // Guardrails
  const safeMaxAgeMs = Math.max(60 * 1000, Number(maxAgeMs) || 0); // at least 1 minute
  const cutoff = nowMs - safeMaxAgeMs;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 50000));

  // Delete in a bounded way to avoid long write locks.
  // Uses a subquery so we can apply a LIMIT.
  const res = db
    .prepare(
      `
      DELETE FROM pending_trade_uuids
      WHERE rowid IN (
        SELECT rowid FROM pending_trade_uuids
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `
    )
    .run(cutoff, safeLimit);

  return res.changes || 0;
}

function fetchTradeUuidFromStorage(walletId, mint) {
  if (!mint) return null;

  // Prefer an open position-run in sc_positions
  const positionRow = walletId
    ? db
        .prepare(
          'SELECT trade_uuid FROM sc_positions WHERE wallet_id = ? AND coin_mint = ? AND (closed_at IS NULL OR closed_at = 0) AND trade_uuid IS NOT NULL'
        )
        .get(walletId, mint)
    : db
        .prepare(
          'SELECT trade_uuid FROM sc_positions WHERE coin_mint = ? AND (closed_at IS NULL OR closed_at = 0) AND trade_uuid IS NOT NULL ORDER BY open_at DESC LIMIT 1'
        )
        .get(mint);

  if (positionRow?.trade_uuid) return positionRow.trade_uuid;

  const pendingRow = db
    .prepare('SELECT trade_uuid FROM pending_trade_uuids WHERE wallet_id IS ? AND mint = ?')
    .get(walletId, mint);

  return pendingRow?.trade_uuid || null;
}

function resolveTradeUuid(a, b) {
  const { walletId, mint } = normalizeTradeUuidArgs(a, b);
  if (!mint) return null;

  const key = tradeUuidCacheKey(walletId, mint);
  const cached = tradeUuidMap.get(key);
  if (cached) return cached;

  const uuid = fetchTradeUuidFromStorage(walletId, mint);
  if (uuid) tradeUuidMap.set(key, uuid);
  return uuid || null;
}

function setTradeUuid(a, b, c) {
  // New signature: (walletId, mint, uuid)
  // Back-compat: (mint, uuid)
  const walletId = c === undefined ? null : a;
  const mint = c === undefined ? a : b;
  const uuid = c === undefined ? b : c;

  if (!mint || !uuid) return;

  const key = tradeUuidCacheKey(walletId, mint);
  tradeUuidMap.set(key, uuid);

  const result = walletId
    ? db
        .prepare('UPDATE sc_positions SET trade_uuid = ? WHERE wallet_id = ? AND coin_mint = ? AND (closed_at IS NULL OR closed_at = 0)')
        .run(uuid, walletId, mint)
    : db
        .prepare('UPDATE sc_positions SET trade_uuid = ? WHERE coin_mint = ? AND (closed_at IS NULL OR closed_at = 0)')
        .run(uuid, mint);

  if (result.changes > 0) {
    deletePendingTradeUuid(walletId, mint);
  } else {
    upsertPendingTradeUuid(walletId, mint, uuid);
  }
}

function getTradeUuid(a, b) {
  return resolveTradeUuid(a, b);
}

function clearTradeUuid(a, b) {
  const { walletId, mint } = normalizeTradeUuidArgs(a, b);
  if (!mint) return;

  const key = tradeUuidCacheKey(walletId, mint);
  tradeUuidMap.delete(key);

  if (walletId) {
    db.prepare('UPDATE sc_positions SET trade_uuid = NULL WHERE wallet_id = ? AND coin_mint = ? AND (closed_at IS NULL OR closed_at = 0)').run(walletId, mint);
  } else {
    db.prepare('UPDATE sc_positions SET trade_uuid = NULL WHERE coin_mint = ? AND (closed_at IS NULL OR closed_at = 0)').run(mint);
  }

  deletePendingTradeUuid(walletId, mint);
}

function pingDb() {
  db.prepare('SELECT 1').get();
}

function closeDb() {
  if (dbClosed) return;
  db.close();
  dbClosed = true;
}

module.exports = {
  chalk,
  db,
  logger,
  pendingSwaps,
  tradeUuidMap,
  normalizeWalletField,
  saveInput,
  setDefaultWalletPublicKey,
  getDefaultWalletPublicKey,
  setTradeUuid,
  getTradeUuid,
  clearTradeUuid,
  resolveTradeUuid,
  upsertPendingTradeUuid,
  deletePendingTradeUuid,
  cleanupPendingTradeUuids,
  pingDb,
  closeDb,
};
