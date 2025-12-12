'use strict';

const BootyBox = require('../src');

describe('BootyBox basic bootstrap', () => {
  it('exposes init/close on the selected adapter', async () => {
    expect(typeof BootyBox.init).toBe('function');
    expect(typeof BootyBox.close).toBe('function');
  });
});
