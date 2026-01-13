'use strict';

jest.mock('../../../db', () => ({
  init: jest.fn(),
  modules: {
    context: {
      db: {},
    },
  },
}));

jest.mock('../../../lib/bootyBoxInit', () => ({
  ensureBootyBoxInit: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({
    getTokenInformation: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('../../../db/src/services/evaluationService', () => ({
  buildEvaluation: jest.fn().mockResolvedValue({ evaluation: { warnings: [] }, warnings: [] }),
}));

const { loadStrategyDocs } = require('../../../lib/warchest/workers/sellOps/strategyDocs');
const { ensureTokenInfo } = require('../../../lib/services/tokenInfoService');
const { createSolanaTrackerDataClient } = require('../../../lib/solanaTrackerDataClient');
const { buildEvaluation } = require('../../../db/src/services/evaluationService');
const { runBuyOpsEvaluation } = require('../../../lib/warchest/workers/buyOps/evalWorker');

describe('buyOps evalWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses strategy freshness defaults and forces token refresh when overridden', async () => {
    const docs = loadStrategyDocs();
    const payload = {
      position: {
        walletId: 1,
        walletAlias: 'alpha',
        mint: 'MintAAA',
        tradeUuid: null,
      },
      target: {
        mint: 'MintAAA',
        status: 'watch',
      },
      walletStrategyRaw: 'flash',
      minScore: 50,
    };

    await runBuyOpsEvaluation(payload);

    expect(createSolanaTrackerDataClient).toHaveBeenCalled();
    expect(ensureTokenInfo).toHaveBeenCalledWith({
      mint: 'MintAAA',
      client: expect.any(Object),
      forceRefresh: true,
    });

    expect(buildEvaluation).toHaveBeenCalledTimes(1);
    const callArgs = buildEvaluation.mock.calls[0][0];
    expect(callArgs.freshness).toEqual(docs.flash.dataRequirements.freshnessMs);
    expect(callArgs.eventIntervals).toEqual(docs.flash.defaults.eventIntervals);
    expect(callArgs.position).toEqual(
      expect.objectContaining({
        expectedNotionalSol: docs.flash.entry.sizing.inputs.maxNotionalSol,
      }),
    );
  });
});
