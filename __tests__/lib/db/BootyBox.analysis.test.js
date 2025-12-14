'use strict';

jest.mock('../../../db/src/adapters/sqlite', () => ({
  engine: 'sqlite',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  getCoinByMint: jest.fn(),
}));

describe('BootyBox adapter selection', () => {
  const loadBootyBox = () => {
    jest.resetModules();
    return require('../../../db');
  };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('always resolves to sqlite adapter', () => {
    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');

    expect(BootyBox).toBe(sqliteAdapter);
    expect(BootyBox.engine).toBe('sqlite');
  });

  test('proxies helper calls to sqlite adapter', async () => {
    const BootyBox = loadBootyBox();
    const sqliteAdapter = require('../../../db/src/adapters/sqlite');
    const payload = { mint: 'MintXYZ' };

    sqliteAdapter.addOrUpdateCoin.mockResolvedValueOnce('ok');

    await BootyBox.addOrUpdateCoin(payload);

    expect(sqliteAdapter.addOrUpdateCoin).toHaveBeenCalledWith(payload);
  });
});
