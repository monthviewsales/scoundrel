'use strict';

const chalk = require('chalk');
const logger = require('../utils/logger');

/**
 * Placeholder MySQL schema helper to guard against accidental usage.
 */
async function ensureMysqlSchema() {
  const message = chalk.bgYellow.black(
    '[BootyBox] MySQL schema management is disabled. SQLite is now the only supported engine.'
  );
  logger.warn(message);
  const error = new Error(message);
  error.code = 'BOOTYBOX_MYSQL_SCHEMA_DISABLED';
  throw error;
}

module.exports = { ensureMysqlSchema };
