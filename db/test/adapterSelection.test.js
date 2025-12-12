'use strict';

const path = require('path');

describe('BootyBox adapter selection', () => {
  const bootboxPath = path.join(__dirname, '..');

  const loadBootyBox = () => {
    jest.resetModules();
    return require(bootboxPath);
  };

  afterEach(() => {
    delete process.env.DB_ENGINE;
    jest.resetModules();
  });

  test('loads SQLite when DB_ENGINE is unset', () => {
    const BootyBox = loadBootyBox();
    expect(BootyBox.engine).toBe('sqlite');
  });

  test('falls back to SQLite when DB_ENGINE is unsupported', () => {
    process.env.DB_ENGINE = 'postgres';
    const BootyBox = loadBootyBox();
    expect(BootyBox.engine).toBe('sqlite');
  });
});
