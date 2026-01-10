'use strict';

jest.mock('../../../ai/warlordAI', () => ({
  createWarlordAI: jest.fn(),
}));

const { createWarlordAI } = require('../../../ai/warlordAI');

describe('targetScan AI job', () => {
  beforeEach(() => {
    createWarlordAI.mockReset();
  });

  test('throws when payload missing', async () => {
    const runTask = jest.fn();
    createWarlordAI.mockReturnValue({ runTask });

    const client = { log: { debug: jest.fn() } };
    let createTargetScanAnalysis;
    jest.isolateModules(() => {
      ({ createTargetScanAnalysis } = require('../../../ai/jobs/targetScan'));
    });

    const { analyzeTargetScan } = createTargetScanAnalysis(client);
    await expect(analyzeTargetScan({})).rejects.toThrow('missing payload');
  });

  test('returns fallback when task fails', async () => {
    const runTask = jest.fn().mockRejectedValue(new Error('boom'));
    createWarlordAI.mockReturnValue({ runTask });

    const client = { log: { debug: jest.fn() } };
    let createTargetScanAnalysis;
    jest.isolateModules(() => {
      ({ createTargetScanAnalysis } = require('../../../ai/jobs/targetScan'));
    });

    const { analyzeTargetScan } = createTargetScanAnalysis(client);
    const payload = {
      meta: { mint: 'Mint111' },
      token: { summary: { symbol: 'SYM', name: 'Token' } },
    };

    const result = await analyzeTargetScan({ payload, model: 'gpt-5.2', purpose: 'unit' });

    expect(result.rating).toBe('avoid');
    expect(result.mint).toBe('Mint111');
    expect(result.symbol).toBe('SYM');
    expect(result.name).toBe('Token');
    expect(client.log.debug).toHaveBeenCalled();
  });

  test('returns model output when task succeeds', async () => {
    const runTask = jest.fn().mockResolvedValue({ rating: 'buy', summary: 'ok' });
    createWarlordAI.mockReturnValue({ runTask });

    const client = { log: { debug: jest.fn() } };
    let createTargetScanAnalysis;
    jest.isolateModules(() => {
      ({ createTargetScanAnalysis } = require('../../../ai/jobs/targetScan'));
    });

    const { analyzeTargetScan } = createTargetScanAnalysis(client);
    const payload = { meta: { mint: 'Mint111' } };

    const result = await analyzeTargetScan({ payload, model: 'gpt-5.2' });

    expect(result).toEqual({ rating: 'buy', summary: 'ok' });
    expect(runTask).toHaveBeenCalledWith({
      task: 'targetScan',
      payload: { payload, purpose: undefined },
      model: 'gpt-5.2',
    });
  });
});
