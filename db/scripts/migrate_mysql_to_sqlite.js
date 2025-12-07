#!/usr/bin/env node
'use strict';

/**
 * Migrates data from MySQL into a BootyBox SQLite database.
 *
 * Usage:
 *   MYSQL_HOST=localhost MYSQL_USER=user MYSQL_PASSWORD=pass MYSQL_DB=db \
 *   BOOTYBOX_SQLITE_PATH=./db/bootybox.db \
 *   EXPORT_CSV_DIR=./exports \   # optional: write per-table CSV snapshots
 *   node scripts/migrate_mysql_to_sqlite.js
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const { ensureSqliteSchema } = require('../src/adapters/sqliteSchema');

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || process.env.MYSQL_DATABASE || '',
  port: Number(process.env.MYSQL_PORT || 3306),
};

const SQLITE_PATH = process.env.BOOTYBOX_SQLITE_PATH || path.join(__dirname, '..', 'db', 'bootybox.db');
const EXPORT_DIR = process.env.EXPORT_CSV_DIR || '';

const TABLES_IN_ORDER = [
  'coins',
  'pools',
  'events',
  'risk',
  'indicators',
  'chart_data',
  'pnl',
  'positions',
  'pending_trade_uuids',
  'buys',
  'sells',
  'trades',
  'sc_wallets',
  'sc_trades',
  'sc_positions',
  'sc_wallet_analyses',
  'sc_trade_autopsies',
  'sc_asks',
  'sc_tunes',
  'sc_job_runs',
  'sc_wallet_profiles',
  'sc_wallet_profile_versions',
  'sc_wallet_profile_index',
  'sessions',
  'evaluations',
  'markets',
];

function log(msg, extra) {
  const time = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${time}] ${msg}`, extra || '');
}

function ensureExportDir(dir) {
  if (!dir) return null;
  const full = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

async function main() {
  const exportDir = ensureExportDir(EXPORT_DIR);
  if (!MYSQL_CONFIG.database) {
    throw new Error('MYSQL_DB (or MYSQL_DATABASE) is required');
  }

  log(`Connecting to MySQL ${MYSQL_CONFIG.user}@${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database}`);
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);

  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const sqlite = new Database(SQLITE_PATH);
  ensureSqliteSchema(sqlite, new Map());

  for (const table of TABLES_IN_ORDER) {
    const [rows] = await mysqlConn.query(`SELECT * FROM ${table}`);
    log(`Fetched ${rows.length} rows from ${table}`);

    if (exportDir && rows.length) {
      const csv = toCsv(rows);
      const outPath = path.join(exportDir, `${table}.csv`);
      fs.writeFileSync(outPath, csv, 'utf8');
      log(`Wrote CSV snapshot: ${outPath}`);
    }

    if (!rows.length) continue;

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(',');
    const insert = sqlite.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
    );

    const tx = sqlite.transaction((batch) => {
      for (const row of batch) {
        const params = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
          if (v instanceof Date) return v.getTime();
          return v;
        });
        insert.run(params);
      }
    });

    tx(rows);
    log(`Inserted ${rows.length} rows into SQLite table ${table}`);
  }

  await mysqlConn.end();
  sqlite.close();
  log('Migration complete');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
