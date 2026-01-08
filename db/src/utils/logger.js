'use strict';

const rootLogger = require('../../../lib/logger');

const defaultScope = 'BootyBox';

/**
 * Create a BootyBox-scoped logger that inherits the app logger transports.
 *
 * @returns {import('winston').Logger}
 */
function createBootyboxLogger() {
  const child = rootLogger.child({ scope: defaultScope });
  if (process.env.BOOTYBOX_LOG_LEVEL) {
    child.level = process.env.BOOTYBOX_LOG_LEVEL;
  }
  return child;
}

const logger = createBootyboxLogger();

// Convenience helper mirroring the main app logger style.
logger.bootybox = function bootybox() {
  return createBootyboxLogger();
};

module.exports = logger;
