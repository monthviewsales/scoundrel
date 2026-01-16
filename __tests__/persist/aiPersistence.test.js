'use strict';

jest.mock('../../lib/bootyBoxInit', () => ({
  ensureBootyBoxInit: jest.fn().mockResolvedValue(),
}));

const {
  persistProfileSnapshot,
  persistCoinMetadata,
  persistWalletAnalysis,
  persistTradeAutopsy,
} = require('../../lib/persist/aiPersistence');

describe('aiPersistence', () => {
  test('persistProfileSnapshot validates inputs', async () => {
    await expect(persistProfileSnapshot({
      BootyBox: { init: jest.fn() },
      profileId: '',
      source: 'test',
    })).rejects.toThrow('[aiPersistence] persistProfileSnapshot requires profileId');
  });

  test('persistProfileSnapshot writes to BootyBox', async () => {
    const BootyBox = {
      init: jest.fn(),
      upsertProfileSnapshot: jest.fn().mockResolvedValue(),
    };

    await persistProfileSnapshot({
      BootyBox,
      profileId: 'profile-1',
      name: 'Test',
      wallet: null,
      source: 'dossier',
      profile: { ok: true },
      logger: { debug: jest.fn(), warn: jest.fn() },
    });

    expect(BootyBox.upsertProfileSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-1',
      source: 'dossier',
      profile: { ok: true },
    }));
  });

  test('persistCoinMetadata validates required fields', async () => {
    await expect(persistCoinMetadata({
      BootyBox: { init: jest.fn() },
      metadataId: null,
      mint: null,
      source: null,
      response: {},
    })).rejects.toThrow('[aiPersistence] persistCoinMetadata requires metadataId, mint, and source');
  });

  test('persistWalletAnalysis rethrows storage errors', async () => {
    const BootyBox = {
      init: jest.fn(),
      recordWalletAnalysis: jest.fn().mockRejectedValue(new Error('db down')),
    };

    await expect(persistWalletAnalysis({
      BootyBox,
      analysisRow: { analysisId: 'a1' },
      logger: { warn: jest.fn(), debug: jest.fn() },
    })).rejects.toThrow('db down');
  });

  test('persistTradeAutopsy rethrows storage errors', async () => {
    const BootyBox = {
      init: jest.fn(),
      recordTradeAutopsy: jest.fn().mockRejectedValue(new Error('db down')),
    };

    await expect(persistTradeAutopsy({
      BootyBox,
      autopsyRow: { autopsyId: 'a1' },
      logger: { warn: jest.fn(), debug: jest.fn() },
    })).rejects.toThrow('db down');
  });
});
