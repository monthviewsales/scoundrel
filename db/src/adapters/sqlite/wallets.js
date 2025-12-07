'use strict';

const {
  db,
  logger,
  normalizeWalletField,
  setDefaultWalletPublicKey,
  getDefaultWalletPublicKey,
} = require('./context');

const VALID_USAGE_TYPES = new Set(['funding', 'strategy', 'kol', 'deployer', 'other']);

function normalizeUsageType(value) {
  if (typeof value !== 'string') return 'other';
  const trimmed = value.trim().toLowerCase();
  return VALID_USAGE_TYPES.has(trimmed) ? trimmed : 'other';
}

function mapWalletRow(row) {
  if (!row) return null;
  return {
    walletId: row.walletId,
    alias: row.alias,
    pubkey: row.pubkey,
    usageType: row.usageType,
    isDefaultFunding: !!row.isDefaultFunding,
    autoAttachWarchest: !!row.autoAttachWarchest,
    strategyId: row.strategyId,
    color: row.color,
    hasPrivateKey: !!row.hasPrivateKey,
    keySource: row.keySource,
    keyRef: row.keyRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ensureKolWalletForProfile(wallet, traderName) {
  const pubkey = normalizeWalletField(wallet);
  if (!pubkey) return;

  const aliasFromName = traderName && typeof traderName === 'string' ? traderName.trim() : null;
  const alias = (aliasFromName && aliasFromName.slice(0, 64)) || pubkey;

  const existing = db
    .prepare('SELECT wallet_id, alias, usage_type FROM sc_wallets WHERE pubkey = ? LIMIT 1')
    .get(pubkey);

  if (existing) {
    const updates = [];
    const params = [];

    if (aliasFromName && (!existing.alias || existing.alias === existing.pubkey)) {
      updates.push('alias = ?');
      params.push(aliasFromName.slice(0, 64));
    }

    if (!existing.usage_type || existing.usage_type === 'other') {
      updates.push("usage_type = 'kol'");
    }

    if (!updates.length) return;

    params.push(Date.now(), existing.wallet_id);
    db.prepare(`UPDATE sc_wallets SET ${updates.join(', ')}, updated_at = ? WHERE wallet_id = ?`).run(
      ...params
    );
    return;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO sc_wallets (
       alias,
       pubkey,
       usage_type,
       is_default_funding,
       auto_attach_warchest,
       strategy_id,
       color,
       has_private_key,
       key_source,
       key_ref,
       created_at,
       updated_at
     ) VALUES (
       @alias,
       @pubkey,
       @usage_type,
       @is_default_funding,
       @auto_attach_warchest,
       @strategy_id,
       @color,
       @has_private_key,
       @key_source,
       @key_ref,
       @created_at,
       @updated_at
     )`
  ).run({
    alias,
    pubkey,
    usage_type: 'kol',
    is_default_funding: 0,
    auto_attach_warchest: 0,
    strategy_id: null,
    color: null,
    has_private_key: 0,
    key_source: 'none',
    key_ref: null,
    created_at: now,
    updated_at: now,
  });
}

function listWarchestWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function listWalletsByUsage(usageType) {
  let sql = `
    SELECT
      wallet_id            AS walletId,
      alias,
      pubkey,
      usage_type           AS usageType,
      is_default_funding   AS isDefaultFunding,
      auto_attach_warchest AS autoAttachWarchest,
      strategy_id          AS strategyId,
      color,
      has_private_key      AS hasPrivateKey,
      key_source           AS keySource,
      key_ref              AS keyRef,
      created_at           AS createdAt,
      updated_at           AS updatedAt
    FROM sc_wallets
  `;
  const params = [];

  if (usageType) {
    sql += ' WHERE usage_type = ?';
    params.push(usageType);
  }

  sql += ' ORDER BY alias ASC';

  const rows = db.prepare(sql).all(...params);
  return (rows || []).map(mapWalletRow);
}

function listAutoAttachedWarchestWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE auto_attach_warchest = 1
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function getWarchestWalletByAlias(alias) {
  if (!alias) return null;
  const row = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE alias = ?
       LIMIT 1`
    )
    .get(alias);
  return row ? mapWalletRow(row) : null;
}

function insertWarchestWallet(record) {
  if (!record || !record.alias || !record.pubkey) {
    throw new Error('insertWarchestWallet: alias and pubkey are required fields.');
  }
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO sc_wallets (
       alias,
       pubkey,
       usage_type,
       is_default_funding,
       auto_attach_warchest,
       strategy_id,
       color,
       has_private_key,
       key_source,
       key_ref,
       created_at,
       updated_at
     ) VALUES (
       @alias,
       @pubkey,
       @usage_type,
       @is_default_funding,
       @auto_attach_warchest,
       @strategy_id,
       @color,
       @has_private_key,
       @key_source,
       @key_ref,
       @created_at,
       @updated_at
     )`
  );
  stmt.run({
    alias: record.alias,
    pubkey: record.pubkey,
    usage_type: record.usageType || 'other',
    is_default_funding: record.isDefaultFunding ? 1 : 0,
    auto_attach_warchest: record.autoAttachWarchest ? 1 : 0,
    strategy_id: record.strategyId ?? null,
    color: record.color ?? null,
    has_private_key: record.hasPrivateKey ? 1 : 0,
    key_source: record.keySource || 'none',
    key_ref: record.keyRef ?? null,
    created_at: now,
    updated_at: now,
  });
  return getWarchestWalletByAlias(record.alias);
}

function updateWarchestWalletOptions(alias, updates = {}) {
  if (!alias) {
    throw new Error('updateWarchestWalletOptions: alias is required');
  }

  const setParts = [];
  const params = [];

  const hasProp = (prop) => Object.prototype.hasOwnProperty.call(updates, prop);

  if (hasProp('usageType')) {
    setParts.push('usage_type = ?');
    params.push(normalizeUsageType(updates.usageType));
  }

  if (hasProp('autoAttachWarchest')) {
    setParts.push('auto_attach_warchest = ?');
    params.push(updates.autoAttachWarchest ? 1 : 0);
  }

  if (hasProp('strategyId')) {
    const strategyId = updates.strategyId == null || updates.strategyId === ''
      ? null
      : String(updates.strategyId).trim().slice(0, 64);
    setParts.push('strategy_id = ?');
    params.push(strategyId);
  }

  if (hasProp('color')) {
    setParts.push('color = ?');
    params.push(updates.color ? String(updates.color).trim().slice(0, 32) : null);
  }

  if (hasProp('hasPrivateKey')) {
    setParts.push('has_private_key = ?');
    params.push(updates.hasPrivateKey ? 1 : 0);
  }

  if (hasProp('keySource')) {
    const keySource = updates.keySource ? String(updates.keySource).trim() : 'none';
    setParts.push('key_source = ?');
    params.push(keySource || 'none');
  }

  if (hasProp('keyRef')) {
    const keyRef = updates.keyRef == null || updates.keyRef === '' ? null : String(updates.keyRef).trim();
    setParts.push('key_ref = ?');
    params.push(keyRef);
  }

  if (hasProp('isDefaultFunding')) {
    setParts.push('is_default_funding = ?');
    params.push(updates.isDefaultFunding ? 1 : 0);
  }

  if (!setParts.length) {
    return getWarchestWalletByAlias(alias);
  }

  const setDefault = updates.isDefaultFunding === true;
  const now = Date.now();
  const tx = db.transaction(() => {
    if (setDefault) {
      db.prepare('UPDATE sc_wallets SET is_default_funding = 0 WHERE alias <> ?').run(alias);
    }

    const clauses = setParts.concat('updated_at = ?');
    const stmt = db.prepare(
      `UPDATE sc_wallets
         SET ${clauses.join(', ')}
       WHERE alias = ?`
    );
    stmt.run(...params, now, alias);
  });

  tx();
  return getWarchestWalletByAlias(alias);
}

function updateWarchestWalletColor(alias, color) {
  if (!alias) return false;
  const res = db
    .prepare('UPDATE sc_wallets SET color = ?, updated_at = ? WHERE alias = ?')
    .run(color, Date.now(), alias);
  return !!(res && res.changes);
}

function deleteWarchestWallet(alias) {
  if (!alias) return false;
  const res = db.prepare('DELETE FROM sc_wallets WHERE alias = ?').run(alias);
  return !!(res && res.changes);
}

function listFundingWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE usage_type = 'funding'
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function getDefaultFundingWallet() {
  const row = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE is_default_funding = 1
       LIMIT 1`
    )
    .get();
  return row ? mapWalletRow(row) : null;
}

function setDefaultFundingWallet(identifier) {
  if (!identifier) return null;

  const walletRow = db
    .prepare(
      `SELECT wallet_id, alias, pubkey
       FROM sc_wallets
       WHERE alias = ? OR pubkey = ?
       LIMIT 1`
    )
    .get(identifier, identifier);

  if (!walletRow) {
    return null;
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE sc_wallets SET is_default_funding = 0').run();
    db.prepare('UPDATE sc_wallets SET is_default_funding = 1, updated_at = ? WHERE wallet_id = ?').run(
      now,
      walletRow.wallet_id
    );
  });

  tx();
  return getWarchestWalletByAlias(walletRow.alias);
}

function listTrackedKolWallets() {
  const rows = db
    .prepare(
      `SELECT
         wallet_id            AS walletId,
         alias,
         pubkey,
         usage_type           AS usageType,
         is_default_funding   AS isDefaultFunding,
         auto_attach_warchest AS autoAttachWarchest,
         strategy_id          AS strategyId,
         color,
         has_private_key      AS hasPrivateKey,
         key_source           AS keySource,
         key_ref              AS keyRef,
         created_at           AS createdAt,
         updated_at           AS updatedAt
       FROM sc_wallets
       WHERE usage_type = 'kol'
       ORDER BY alias ASC`
    )
    .all();
  return (rows || []).map(mapWalletRow);
}

function upsertKolWalletFromDossier({ wallet, traderName, color }) {
  if (!wallet) {
    throw new Error('upsertKolWalletFromDossier: wallet is required');
  }
  const now = Date.now();

  const existing = db
    .prepare('SELECT wallet_id, alias, pubkey, color FROM sc_wallets WHERE pubkey = ? LIMIT 1')
    .get(wallet);

  const safeAliasFromWallet = () => {
    const str = String(wallet);
    if (str.length <= 8) return str;
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  };

  const alias = (traderName && String(traderName).trim()) || safeAliasFromWallet();

  if (existing) {
    const updates = [];
    const params = [];

    if (alias && existing.alias === existing.pubkey) {
      updates.push('alias = ?');
      params.push(alias.slice(0, 64));
    }

    if (color && !existing.color) {
      updates.push('color = ?');
      params.push(color);
    }

    if (!updates.length) return existing.wallet_id;

    params.push(now, existing.wallet_id);
    db.prepare(
      `UPDATE sc_wallets
         SET ${updates.join(', ')},
             updated_at = ?
       WHERE wallet_id = ?`
    ).run(...params);
    return existing.wallet_id;
  }

  const result = db.prepare(
    `INSERT INTO sc_wallets (
       alias,
       pubkey,
       usage_type,
       created_at,
       updated_at,
       color
     ) VALUES (?, ?, 'kol', ?, ?, ?)`
  ).run(alias.slice(0, 64), wallet, now, now, color || null);

  return result.lastInsertRowid;
}

module.exports = {
  deleteWarchestWallet,
  ensureKolWalletForProfile,
  getDefaultFundingWallet,
  getWarchestWalletByAlias,
  insertWarchestWallet,
  updateWarchestWalletOptions,
  listAutoAttachedWarchestWallets,
  listFundingWallets,
  listTrackedKolWallets,
  listWarchestWallets,
  listWalletsByUsage,
  mapWalletRow,
  setDefaultFundingWallet,
  updateWarchestWalletColor,
  upsertKolWalletFromDossier,
  setDefaultWalletPublicKey,
  getDefaultWalletPublicKey,
};
