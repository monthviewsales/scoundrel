'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const baseLogger = require('../../logger');

const DEFAULT_LOG_DIR = path.join(process.cwd(), 'data', 'logs', 'workers');
const CALLSITE_ENV = process.env.SC_WORKER_LOG_CALLSITE === '1' || process.env.SC_LOG_CALLSITE === '1';

function isHudMode() {
  if (process.env.SC_HUD_MODE === '1') return true;
  if (process.env.WARCHEST_HUD === '1') return true;
  return Array.isArray(process.argv) && process.argv.includes('--hud');
}

function isInkMode() {
  if (process.env.SC_INK_MODE === '1') return true;
  return Array.isArray(process.argv) && process.argv.includes('--ink');
}

function normalizeWorkerName(workerName) {
  const raw = typeof workerName === 'string' ? workerName.trim() : '';
  return raw ? raw.replace(/[\\/\s]+/g, '-').replace(/[^\w.-]/g, '') : 'worker';
}

function stripScopePrefix(message, scope) {
  if (!scope || typeof message !== 'string') return message;
  const prefix = `[${scope}]`;
  if (!message.startsWith(prefix)) return message;
  let next = message.slice(prefix.length);
  if (next.startsWith(' ')) next = next.slice(1);
  return next;
}

function resolveCallsite() {
  const err = new Error();
  Error.captureStackTrace(err, resolveCallsite);
  const stack = typeof err.stack === 'string' ? err.stack.split('\n') : [];
  for (let i = 1; i < stack.length; i += 1) {
    const line = stack[i].trim();
    const match = line.match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const fn = match[1] || '';
    const filePath = match[2] || '';
    const normalized = filePath.replace(/\\/g, '/');
    if (
      normalized.includes('/node_modules/')
      || normalized.includes('/winston/')
      || normalized.includes('/workerLogger.js')
      || normalized.includes('/logger.js')
      || normalized.includes('node:internal')
    ) {
      continue;
    }
    const rel = path.relative(process.cwd(), filePath);
    const location = rel && !rel.startsWith('..') ? rel : filePath;
    const label = fn ? `${fn} ${location}:${match[3]}` : `${location}:${match[3]}`;
    return label;
  }
  return '';
}

function buildWorkerFormat({ baseFormat, scope, includeCallsite, workerName }) {
  const stripFormat = winston.format((info) => {
    if (info && typeof info.message === 'string') {
      info.message = stripScopePrefix(info.message, scope);
    }
    return info;
  });

  const prefixFormat = winston.format((info) => {
    if (!info || typeof info.message !== 'string') return info;
    const name = workerName || scope;
    const pid = process.pid;
    const requestId = process.env.SC_WORKER_REQUEST_ID;
    const parts = [];
    if (name && (!scope || scope !== name)) parts.push(name);
    if (pid) parts.push(`pid=${pid}`);
    if (requestId) parts.push(`req=${requestId}`);
    if (!parts.length) return info;
    info.message = `[${parts.join(' ')}] ${info.message}`;
    return info;
  });

  const callsiteFormat = winston.format((info) => {
    if (!includeCallsite || !info || typeof info.message !== 'string') return info;
    const callsite = resolveCallsite();
    if (callsite) {
      info.message = `${info.message} (at ${callsite})`;
    }
    return info;
  });

  return winston.format.combine(stripFormat(), prefixFormat(), callsiteFormat(), baseFormat);
}

/**
 * Resolve the log directory for worker logs.
 *
 * @param {string} [logDir]
 * @returns {string}
 */
function resolveWorkerLogDir(logDir) {
  return logDir || DEFAULT_LOG_DIR;
}

/**
 * Create a worker-scoped logger that writes to a dedicated log file.
 *
 * @param {Object} [options]
 * @param {string} [options.workerName] - Worker name used for log filenames.
 * @param {string} [options.scope] - Logger scope (defaults to workerName).
 * @param {string} [options.logDir] - Directory for worker log files.
 * @param {boolean} [options.silentConsole] - When true, do not attach a console transport.
 * @param {string} [options.level] - Override log level.
 * @param {boolean} [options.includeCallsite] - Append callsite info to worker log messages.
 * @param {import('../../logger')} [options.baseLogger] - Injected base logger (for tests).
 * @returns {import('winston').Logger}
 */
function createWorkerLogger(options) {
  const opts = options || {};
  const workerName = normalizeWorkerName(opts.workerName);
  const scope = opts.scope || workerName;
  const logDir = resolveWorkerLogDir(opts.logDir);
  const loggerBase = opts.baseLogger || baseLogger;
  const level = opts.level || loggerBase.level || process.env.LOG_LEVEL || 'info';
  const includeCallsite = typeof opts.includeCallsite === 'boolean' ? opts.includeCallsite : CALLSITE_ENV;
  const silentConsole = typeof opts.silentConsole === 'boolean'
    ? opts.silentConsole
    : isHudMode() || isInkMode();
  const baseFormat = loggerBase && loggerBase.format
    ? loggerBase.format
    : winston.format.combine(winston.format.timestamp(), winston.format.simple());
  const format = buildWorkerFormat({ baseFormat, scope, includeCallsite, workerName });

  fs.mkdirSync(logDir, { recursive: true });
  const filename = path.join(logDir, `${workerName}_%DATE%.log`);
  const useBaseLogger = !silentConsole && loggerBase && typeof loggerBase.child === 'function';
  const transport = new winston.transports.DailyRotateFile({
    filename,
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',
    maxFiles: '7d',
    level,
    format: useBaseLogger ? format : undefined,
  });

  if (useBaseLogger) {
    const scoped = loggerBase.child({ scope });
    if (typeof scoped.add === 'function') {
      const alreadyAdded = Array.isArray(scoped.transports)
        && scoped.transports.some((item) => item && item.filename === filename);
      if (!alreadyAdded) scoped.add(transport);
    }
    return scoped;
  }

  return winston.createLogger({
    level,
    format,
    defaultMeta: scope ? { scope } : {},
    transports: [transport],
  });
}

module.exports = {
  createWorkerLogger,
  resolveWorkerLogDir,
};
