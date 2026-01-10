'use strict';

jest.mock('../../../ai/warlordAI', () => ({
  createWarlordAI: jest.fn(),
}));

const { createWarlordAI } = require('../../../ai/warlordAI');

describe('grok job helpers', () => {
  beforeEach(() => {
    createWarlordAI.mockReset();
  });

  test('runGrokMintSearchReport delegates to runTask with payload', async () => {
    const runTask = jest.fn().mockResolvedValue({ ok: true });
    createWarlordAI.mockReturnValue({ runTask });

    const client = { log: { debug: jest.fn() } };
    let createGrokMintSearchReport;
    jest.isolateModules(() => {
      ({ createGrokMintSearchReport } = require('../../../ai/jobs/grokMintSearchReport'));
    });

    const { runGrokMintSearchReport } = createGrokMintSearchReport(client);
    const result = await runGrokMintSearchReport({
      mint: 'mint123',
      symbol: 'SYM',
      aliases: ['alpha'],
      purpose: 'unit',
      model: 'grok-2',
    });

    expect(result).toEqual({ ok: true });
    expect(runTask).toHaveBeenCalledWith({
      task: 'grokMintSearchReport',
      payload: {
        mint: 'mint123',
        symbol: 'SYM',
        aliases: ['alpha'],
        purpose: 'unit',
      },
      model: 'grok-2',
    });
    expect(client.log.debug).toHaveBeenCalled();
  });

  test('runGrokProfileScore delegates to runTask with payload', async () => {
    const runTask = jest.fn().mockResolvedValue({ ok: true });
    createWarlordAI.mockReturnValue({ runTask });

    const client = { log: { debug: jest.fn() } };
    let createGrokProfileScore;
    jest.isolateModules(() => {
      ({ createGrokProfileScore } = require('../../../ai/jobs/grokProfileScore'));
    });

    const { runGrokProfileScore } = createGrokProfileScore(client);
    const result = await runGrokProfileScore({
      handle: 'trader',
      profileUrl: 'https://example.com',
      profile: { followers: 1 },
      purpose: 'unit',
      model: 'grok-2',
    });

    expect(result).toEqual({ ok: true });
    expect(runTask).toHaveBeenCalledWith({
      task: 'grokProfileScore',
      payload: {
        handle: 'trader',
        profileUrl: 'https://example.com',
        profile: { followers: 1 },
        purpose: 'unit',
      },
      model: 'grok-2',
    });
    expect(client.log.debug).toHaveBeenCalled();
  });
});
