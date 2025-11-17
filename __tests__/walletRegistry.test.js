'use strict';

const mockInit = jest.fn().mockResolvedValue();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('../lib/db/BootyBox.mysql', () => ({
  init: mockInit,
  listWarchestWallets: mockList,
  getWarchestWalletByAlias: mockGet,
  insertWarchestWallet: mockInsert,
  updateWarchestWalletColor: mockUpdate,
  deleteWarchestWallet: mockDelete,
}));

describe('walletRegistry', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInit.mockClear();
    mockList.mockReset();
    mockGet.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockDelete.mockReset();
  });

  test('getAllWallets maps rows with boolean flags', async () => {
    mockList.mockResolvedValue([
      {
        walletId: 'w1',
        alias: 'alpha',
        pubkey: 'Pubkey111',
        color: null,
        hasPrivateKey: true,
        keySource: 'none',
        keyRef: null,
        createdAt: 'now',
        updatedAt: 'now',
      },
    ]);

    const { getAllWallets } = require('../lib/warchest/walletRegistry');
    const rows = await getAllWallets();

    expect(mockInit).toHaveBeenCalled();
    expect(mockList).toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      walletId: 'w1',
      alias: 'alpha',
      pubkey: 'Pubkey111',
      hasPrivateKey: true,
    });
  });

  test('getWalletByAlias returns null when not found', async () => {
    mockGet.mockResolvedValue(null);
    const { getWalletByAlias } = require('../lib/warchest/walletRegistry');
    const row = await getWalletByAlias('missing');

    expect(mockInit).toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith('missing');
    expect(row).toBeNull();
  });

  test('getWalletByAlias normalizes boolean flag', async () => {
    mockGet.mockResolvedValue({
      walletId: 'w2',
      alias: 'bravo',
      pubkey: 'Pubkey222',
      color: '#fff',
      hasPrivateKey: false,
      keySource: 'db_encrypted',
      keyRef: 'secret',
      createdAt: 'now',
      updatedAt: 'now',
    });

    const { getWalletByAlias } = require('../lib/warchest/walletRegistry');
    const row = await getWalletByAlias('bravo');

    expect(row).toMatchObject({
      walletId: 'w2',
      alias: 'bravo',
      hasPrivateKey: false,
      keySource: 'db_encrypted',
      keyRef: 'secret',
    });
  });
});
