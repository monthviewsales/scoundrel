'use strict';

const path = require('path');

describe('BootyBox adapter selection', () => {
  const bootboxPath = path.join(__dirname, '..');

  const loadBootyBox = () => {
    jest.resetModules();
    return require(bootboxPath);
  };

  afterEach(() => {
    jest.resetModules();
  });

  test('loads SQLite adapter', () => {
    const BootyBox = loadBootyBox();
    expect(BootyBox.engine).toBe('sqlite');
  });
});
