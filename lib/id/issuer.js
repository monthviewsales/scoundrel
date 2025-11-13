'use strict';

/**
 * Universal ID Issuer — Event-driven & direct-access compatible.
 *
 * Features:
 *  - Emits `id:issued` when responding to `id:request`.
 *  - Provides direct helper `getNewId(prefix)`.
 *  - Provides Promise-based `requestId({ prefix, meta, timeoutMs })` that uses the event bus.
 *
 * Event contracts:
 *  - `process.emit('id:request', { prefix?, correlationId?, meta? })`
 *  - `process.on('id:issued', ({ id, prefix?, correlationId, issuedAt, meta? }) => {})`
 */

const { ulid } = require('ulid');
const { EventEmitter } = require('events');

// Use the global process as event bus.
const bus = process;

// Prevent duplicate listener registration (in dev reloads, etc.)
const INIT_FLAG = Symbol.for('scoundrel.id.issuer.initialized');
if (!bus[INIT_FLAG]) {
  bus[INIT_FLAG] = true;

  bus.on('id:request', (payload = {}) => {
    try {
      const { prefix, correlationId = ulid(), meta } = payload;
      const idCore = ulid();
      const id = prefix ? `${prefix}_${idCore}` : idCore;
      const issuedAt = new Date().toISOString();

      bus.emit('id:issued', {
        id,
        prefix,
        correlationId,
        issuedAt,
        meta,
      });

      if (process.env.NODE_ENV === 'development') {
        console.debug(`[id] issued ${id}`);
      }
    } catch (err) {
      console.error('[id] Error issuing ID:', err);
    }
  });
}

/**
 * Generate a new ULID directly.
 * @param {string} [prefix]
 * @returns {string}
 */
function getNewId(prefix) {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Request a new ID through the event bus and wait for its response.
 * @param {{ prefix?: string, meta?: any, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
async function requestId(options = {}) {
  const { prefix, meta, timeoutMs = 1000 } = options;
  const correlationId = ulid();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      bus.removeListener('id:issued', onIssued);
      reject(new Error('Timeout waiting for id:issued'));
    }, timeoutMs);

    function onIssued(msg) {
      if (msg && msg.correlationId === correlationId) {
        clearTimeout(timeout);
        bus.removeListener('id:issued', onIssued);
        resolve(msg.id);
      }
    }

    bus.on('id:issued', onIssued);
    bus.emit('id:request', { prefix, correlationId, meta });
  });
}

module.exports = {
  getNewId,
  requestId,
};
