'use strict';

const rootLogger = require('../../../lib/logger');

const defaultScope = 'BootyBox';

const logger = rootLogger.child({ scope: defaultScope });

// Convenience helper mirroring the main app logger style.
logger.bootybox = function bootybox() {
  return rootLogger.child({ scope: defaultScope });
};

module.exports = logger;
