'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('logger modules', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('loads the real app logger and exposes scoped helpers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoundrel-logs-'));
    process.env.LOG_ROOT_DIR = tmpDir;
    process.env.SC_REDACT_STDIO = '0';
    process.env.SC_HUD_CAPTURE_CONSOLE = '0';

    jest.unmock('../../lib/logger');
    const logger = require('../../lib/logger');

    expect(logger).toBeTruthy();
    expect(typeof logger.child).toBe('function');
    expect(typeof logger.metrics).toBe('function');
    expect(typeof logger.worker).toBe('function');

    const metrics = logger.metrics();
    expect(metrics).toBeTruthy();
  });

  test('bootybox logger honors BOOTYBOX_LOG_LEVEL', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoundrel-logs-'));
    process.env.LOG_ROOT_DIR = tmpDir;
    process.env.BOOTYBOX_LOG_LEVEL = 'debug';
    process.env.SC_REDACT_STDIO = '0';
    process.env.SC_HUD_CAPTURE_CONSOLE = '0';

    jest.unmock('../../lib/logger');
    jest.unmock('../../db/src/utils/logger');
    const logger = require('../../db/src/utils/logger');

    expect(logger).toBeTruthy();
    expect(logger.level).toBe('debug');
    expect(typeof logger.bootybox).toBe('function');
    const child = logger.bootybox();
    expect(child).toBeTruthy();
  });
});
