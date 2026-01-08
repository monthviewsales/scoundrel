'use strict';

const fs = require('fs');
const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('BootyBox adapter selection', () => {
  let tmpDir = null;

  beforeAll(() => {
    ({ tmpDir } = createIsolatedAdapter());
  });

  afterAll(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  const loadBootyBox = () => {
    jest.resetModules();
    return require('..');
  };

  afterEach(() => {
    jest.resetModules();
  });

  test('loads SQLite adapter', () => {
    const BootyBox = loadBootyBox();
    expect(BootyBox.engine).toBe('sqlite');
  });
});
