'use strict';

jest.mock('../packages/bootybox', () => ({
  init: jest.fn(),
  getCoinByMint: jest.fn(),
  addOrUpdateCoin: jest.fn(),
}));

jest.mock('../lib/log', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const BootyBox = require('../packages/bootybox');

const loadService = () => {
  let service;
  jest.isolateModules(() => {
    service = require('../lib/services/tokenInfoService');
  });
  return service;
};

describe('tokenInfoService.ensureTokenInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DB_ENGINE;
  });

  test('returns cached coin when BootyBox is ready', async () => {
    BootyBox.init.mockResolvedValue();
    BootyBox.getCoinByMint.mockResolvedValue({ mint: 'MintA', symbol: 'AAA' });
    const client = { getTokenInformation: jest.fn() };

    const { ensureTokenInfo } = loadService();
    const result = await ensureTokenInfo({ mint: 'MintA', client });

    expect(BootyBox.init).toHaveBeenCalledTimes(1);
    expect(client.getTokenInformation).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ symbol: 'AAA' }));
  });

  test('skips DB cache when BootyBox init fails', async () => {
    BootyBox.init.mockRejectedValue(new Error('pool failed'));
    const client = {
      getTokenInformation: jest.fn().mockResolvedValue({ symbol: 'BBB', name: 'B Coin' }),
    };

    const { ensureTokenInfo } = loadService();
    const result = await ensureTokenInfo({ mint: 'MintB', client });

    expect(client.getTokenInformation).toHaveBeenCalledWith('MintB');
    expect(BootyBox.addOrUpdateCoin).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ symbol: 'BBB' }));
  });

  test('persists fetched info when DB is ready', async () => {
    BootyBox.init.mockResolvedValue();
    BootyBox.getCoinByMint.mockResolvedValue(null);
    const client = {
      getTokenInformation: jest.fn().mockResolvedValue({ symbol: 'CCC', decimals: 9 }),
    };

    const { ensureTokenInfo } = loadService();
    await ensureTokenInfo({ mint: 'MintC', client });

    expect(client.getTokenInformation).toHaveBeenCalledWith('MintC');
    expect(BootyBox.addOrUpdateCoin).toHaveBeenCalledWith(
      expect.objectContaining({ mint: 'MintC', symbol: 'CCC' }),
    );
  });
});
