const originalEnv = process.env.NODE_ENV;

describe('log module', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalEnv;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('debug logs in development', () => {
    process.env.NODE_ENV = 'development';
    const consoleSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const log = require('../lib/log');
    log.debug('dev message');
    expect(consoleSpy).toHaveBeenCalledWith('dev message');
  });

  test('debug does not log outside development', () => {
    process.env.NODE_ENV = 'production';
    const consoleSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const log = require('../lib/log');
    log.debug('prod message');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('info logs in development only', () => {
    process.env.NODE_ENV = 'development';
    let consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let log = require('../lib/log');
    log.info('info message');
    expect(consoleSpy).toHaveBeenCalledWith('info message');

    jest.resetModules();
    jest.restoreAllMocks();
    process.env.NODE_ENV = 'test';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    log = require('../lib/log');
    log.info('should not log');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('warn and error always log', () => {
    process.env.NODE_ENV = 'production';
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = require('../lib/log');

    log.warn('warn message');
    log.error('error message');

    expect(consoleWarn).toHaveBeenCalledWith('warn message');
    expect(consoleError).toHaveBeenCalledWith('error message');
  });
});
