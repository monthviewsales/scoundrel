'use strict';

const chalk = require('chalk');
const logger = require('./utils/logger');

/**
 * BootyBox entrypoint.
 * SQLite is the only supported engine.
 */
function loadBootyBox() {
  const requestedEngine = String(process.env.DB_ENGINE || 'sqlite').toLowerCase();
  if (requestedEngine !== 'sqlite') {
    const warning = chalk.bgYellow.black(
      `[BootyBox] DB_ENGINE=${requestedEngine} resolved to sqlite. SQLite is the only supported engine.`
    );
    logger.warn(warning);
  }
  return require('./adapters/sqlite');
}

module.exports = loadBootyBox();
