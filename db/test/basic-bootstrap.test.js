'use strict';

const fs = require('fs');
const { createIsolatedAdapter } = require('./helpers/sqliteTestUtils');

describe('BootyBox basic bootstrap', () => {
  let tmpDir = null;

  beforeAll(() => {
    ({ tmpDir } = createIsolatedAdapter());
  });

  afterAll(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('exposes init/close on the selected adapter', async () => {
    const BootyBox = require('../src');
    expect(typeof BootyBox.init).toBe('function');
    expect(typeof BootyBox.close).toBe('function');
  });
});
