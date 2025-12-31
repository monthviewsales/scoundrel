'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const baseLogger = require('../../logger');

const DEFAULT_LOG_DIR = path.join(process.cwd(), 'data', 'logs', 'workers');

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
  const silentConsole = typeof opts.silentConsole === 'boolean'
    ? opts.silentConsole
    : isHudMode() || isInkMode();
  const format = loggerBase && loggerBase.format
    ? loggerBase.format
    : winston.format.combine(winston.format.timestamp(), winston.format.simple());

  fs.mkdirSync(logDir, { recursive: true });
  const filename = path.join(logDir, `${workerName}_%DATE%.log`);
  const transport = new winston.transports.DailyRotateFile({
    filename,
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',
    maxFiles: '7d',
    level,
    format,
  });

  if (!silentConsole && loggerBase && typeof loggerBase.child === 'function') {
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
