'use strict';

const os = require('os');
const path = require('path');

if (!process.env.BOOTYBOX_SQLITE_PATH) {
  const filename = `bootybox-test-${process.pid}-${Date.now()}.db`;
  process.env.BOOTYBOX_SQLITE_PATH = path.join(os.tmpdir(), filename);
}

jest.mock('./lib/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn(),
    log: jest.fn(),
  };

  const child = jest.fn(() => logger);
  logger.child = child;
  logger.metrics = child;
  logger.worker = child;
  logger.swap = child;
  logger.solanaTrackerData = child;
  logger.bootybox = child;

  return logger;
});

jest.mock('./db/src/utils/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn(),
    log: jest.fn(),
  };

  const child = jest.fn(() => logger);
  logger.child = child;
  logger.metrics = child;
  logger.worker = child;
  logger.swap = child;
  logger.solanaTrackerData = child;
  logger.bootybox = child;

  return logger;
});
