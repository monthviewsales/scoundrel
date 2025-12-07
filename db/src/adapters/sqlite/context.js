'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const logger = require('../../utils/logger');
const { ensureSqliteSchema } = require('../sqliteSchema');

let defaultWalletPublicKey = null;

// Ensure DB directory exists to avoid failures in tests/runtime
const dbDir = path.join(__dirname, '../../../db');
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (e) {
  logger?.debug?.(`[BootyBox] mkdirSync failed: ${e.message}`);
}

const dbFile =
  process.env.BOOTYBOX_SQLITE_PATH || path.join(dbDir, 'bootybox.db');
try {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
} catch (e) {
  logger?.debug?.(`[BootyBox] mkdirSync failed for ${path.dirname(dbFile)}: ${e.message}`);
}

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 3000');

let dbClosed = false;
const pendingSwaps = new Set();
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

function upsertPendingTradeUuid(mint, uuid) {
  db.prepare(
    `
    INSERT INTO pending_trade_uuids (mint, trade_uuid, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      trade_uuid = excluded.trade_uuid,
      created_at = excluded.created_at
  `
  ).run(mint, uuid, Date.now());
}

function deletePendingTradeUuid(mint) {
  db.prepare('DELETE FROM pending_trade_uuids WHERE mint = ?').run(mint);
}

function fetchTradeUuidFromStorage(mint) {
  if (!mint) return null;
  const positionRow = db
    .prepare('SELECT trade_uuid FROM positions WHERE coin_mint = ? AND trade_uuid IS NOT NULL')
    .get(mint);
  if (positionRow?.trade_uuid) return positionRow.trade_uuid;
  const pendingRow = db
    .prepare('SELECT trade_uuid FROM pending_trade_uuids WHERE mint = ?')
    .get(mint);
  return pendingRow?.trade_uuid || null;
}

function resolveTradeUuid(mint) {
  if (!mint) return null;
  const cached = tradeUuidMap.get(mint);
  if (cached) return cached;
  const uuid = fetchTradeUuidFromStorage(mint);
  if (uuid) tradeUuidMap.set(mint, uuid);
  return uuid || null;
}

function setTradeUuid(mint, uuid) {
  if (!mint || !uuid) return;
  tradeUuidMap.set(mint, uuid);
  const result = db
    .prepare('UPDATE positions SET trade_uuid = ? WHERE coin_mint = ?')
    .run(uuid, mint);
  if (result.changes > 0) {
    deletePendingTradeUuid(mint);
  } else {
    upsertPendingTradeUuid(mint, uuid);
  }
}

function getTradeUuid(mint) {
  return resolveTradeUuid(mint);
}

function clearTradeUuid(mint) {
  tradeUuidMap.delete(mint);
  db.prepare('UPDATE positions SET trade_uuid = NULL WHERE coin_mint = ?').run(mint);
  deletePendingTradeUuid(mint);
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
  pingDb,
  closeDb,
};
