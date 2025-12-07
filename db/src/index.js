'use strict';

const chalk = require('chalk');
const logger = require('./utils/logger');

/**
 * BootyBox entrypoint.
 * SQLite is the only supported engine; MySQL support has ended.
 */
function loadBootyBox() {
  const requestedEngine = String(process.env.DB_ENGINE || 'sqlite').toLowerCase();
  if (requestedEngine !== 'sqlite') {
    const warning = chalk.bgYellow.black(
      `[BootyBox] DB_ENGINE=${requestedEngine} resolved to sqlite. MySQL support has ended; running with SQLite only.`
    );
    logger.warn(warning);
  }
  return require('./adapters/sqlite');
}

module.exports = loadBootyBox();
