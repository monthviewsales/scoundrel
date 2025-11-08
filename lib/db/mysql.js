'use strict';

/**
 * MySQL pool (mysql2/promise) with auto-connect + retry and small helper API.
 *
 * Env variables (from .env):
 *   DB_ENGINE=mysql
 *   DB_HOST
 *   DB_PORT
 *   DB_NAME
 *   DB_USER
 *   DB_PASSWORD
 *   DB_POOL_LIMIT (default: 30)
 */

const mysql = require('mysql2/promise');

const {
  DB_ENGINE = 'mysql',
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_POOL_LIMIT = '30',
} = process.env;

if (DB_ENGINE !== 'mysql') {
  throw new Error(
    `lib/db/mysql.js loaded with DB_ENGINE="${DB_ENGINE}". Expected "mysql".`
  );
}

if (!DB_NAME || !DB_USER) {
  throw new Error('DB_NAME and DB_USER must be set in environment.');
}

/** @type {import('mysql2/promise').Pool} */
let pool;

function createPool() {
  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(DB_POOL_LIMIT) || 30,
    queueLimit: 0,
    enableKeepAlive: true,
    // Keep dates as strings to avoid TZ/rounding surprises
    dateStrings: true,
    supportBigNumbers: true,
    // Named placeholders allow objects: db.query('SELECT :id', { id: 1 })
    namedPlaceholders: true,
  });
  return pool;
}

/**
 * Sleep for ms
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Initialize the pool with up to 3 retries and exponential backoff.
 * Exits the process if all retries fail.
 */
async function initializeWithRetry() {
  if (!pool) createPool();

  const maxRetries = 3; // per user request
  const baseDelay = 500; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const conn = await pool.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }

      if (process.env.NODE_ENV === 'development') {
        // Keep this quiet in production
        console.info(
          `[db] Connected to MySQL ${DB_HOST}:${DB_PORT}/${DB_NAME} (pool limit=${pool.poolMax || DB_POOL_LIMIT})`
        );
      }
      return; // success
    } catch (err) {
      const isLast = attempt === maxRetries;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.error(
        `[db] MySQL connection attempt ${attempt}/${maxRetries} failed: ${err && err.message ? err.message : err}`
      );
      if (isLast) {
        console.error('[db] Exhausted retries. Exiting process with code 1.');
        // Ensure pool is closed before exiting
        try { await pool.end(); } catch (e) { /* ignore */ }
        process.exit(1);
      }
      await sleep(delay);
    }
  }
}

/**
 * Execute a query using the shared pool.
 * Accepts positional params array or named placeholder object.
 * @template T
 * @param {string} sql
 * @param {any[]|Record<string, any>} [params]
 * @returns {Promise<{ rows: T[], fields: import('mysql2').FieldPacket[] }>} 
 */
async function query(sql, params) {
  if (!pool) createPool();
  const [rows, fields] = await pool.query(sql, params);
  return { rows, fields };
}

/**
 * Transaction helper. Provides a dedicated connection.
 * @template T
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function tx(fn) {
  if (!pool) createPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const res = await fn(conn);
    await conn.commit();
    return res;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Simple ping convenience.
 */
async function ping() {
  await query('SELECT 1');
  return true;
}

/** Return the underlying pool (use sparingly). */
function getPool() {
  if (!pool) createPool();
  return pool;
}

// Auto-initialize on module load with retry+backoff.
// This will exit the process if it cannot connect after retries.
void initializeWithRetry();

module.exports = {
  query,
  tx,
  ping,
  getPool,
};
