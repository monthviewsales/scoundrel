'use strict';

jest.mock('../../../packages/bootybox/src/adapters/mysql', () => ({
  engine: 'mysql',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  getCoinByMint: jest.fn(),
}));

jest.mock('../../../packages/bootybox/src/adapters/sqlite', () => ({
  engine: 'sqlite',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  getCoinByMint: jest.fn(),
}));

describe('BootyBox adapter selection (mysql)', () => {
  const loadBootyBox = () => {
    jest.resetModules();
    return require('../../../packages/bootybox');
  };

  afterEach(() => {
    delete process.env.DB_ENGINE;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('selects mysql adapter when DB_ENGINE=mysql', () => {
    process.env.DB_ENGINE = 'mysql';
    const BootyBox = loadBootyBox();
    const mysqlAdapter = require('../../../packages/bootybox/src/adapters/mysql');

    expect(BootyBox).toBe(mysqlAdapter);
    expect(BootyBox.engine).toBe('mysql');
  });

  test('exposes adapter helpers from the selected engine', async () => {
    process.env.DB_ENGINE = 'mysql';
    const BootyBox = loadBootyBox();
    const mysqlAdapter = require('../../../packages/bootybox/src/adapters/mysql');
    const payload = { mint: 'MintXYZ' };

    mysqlAdapter.addOrUpdateCoin.mockResolvedValueOnce('ok');

    await BootyBox.addOrUpdateCoin(payload);

    expect(mysqlAdapter.addOrUpdateCoin).toHaveBeenCalledWith(payload);
  });
});
