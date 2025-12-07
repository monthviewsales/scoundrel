'use strict';

const chalk = require('chalk');
const createSqliteAdapter = require('./adapters/sqlite');
const logger = require('./utils/logger');

/**
 * BootyBox
 * Shared persistence layer for VAULT77 apps (Scoundrel, BewareWF, etc.).
 * This class remains for compatibility but now initializes SQLite only.
 * MySQL support has ended and will emit warnings when requested.
 */
class BootyBox {
  /**
  * @param {Object} options
  * @param {'sqlite'} options.driver
  * @param {Object} [options.mysql]   - MySQL connection config (deprecated)
   * @param {Object} [options.sqlite]  - SQLite config (e.g. file path)
   * @param {Function} [options.logger] - Optional logger (console-like)
  */
  constructor(options = {}) {
    this.options = options;
    this.driver = 'sqlite';
    this.logger = options.logger || logger;

    this.sqlite = null;
  }

  /**
   * Initialize database connections and run migrations as needed.
   */
  async init() {
    const { options } = this;
    const warning = chalk.bgYellow.black(
      '[BootyBox] MySQL driver support has ended; initializing SQLite adapter only.'
    );
    this.logger.warn?.(warning);
    this.logger.info?.('[BootyBox] init start', { driver: 'sqlite' });

    this.sqlite = await createSqliteAdapter(options.sqlite || {}, this.logger);
    this.logger.info?.('[BootyBox] init complete');
  }

  /**
   * Close any open DB connections.
   */
  async close() {
    this.logger.info?.('[BootyBox] close start');

    if (this.sqlite && typeof this.sqlite.close === 'function') {
      await this.sqlite.close();
    }

    this.logger.info?.('[BootyBox] close complete');
  }
}

module.exports = BootyBox;
