'use strict';

jest.mock('../ai/grokClient', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  const mockLog = { debug: jest.fn(), warn: jest.fn() };
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    log: mockLog,
    __mock: { callResponses: mockCallResponses, parseResponsesJSON: mockParseResponsesJSON, log: mockLog }
  };
});

describe('devscanAnalysis job', () => {
  let analyzeDevscan;
  let clientMock;

  beforeEach(() => {
    jest.resetModules();
    clientMock = require('../ai/grokClient').__mock;
    ({ analyzeDevscan } = require('../ai/jobs/devscanAnalysis'));
  });

  test('uses mint schema when mint is present', async () => {
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({
      version: 'devscan.mint.v1',
      markdown: '# ok',
      entity_type: 'mint',
      target: 'Mint1',
      mint: {
        address: 'Mint1',
        symbol: null,
        name: null,
        status: null,
        createdAt: null,
        priceUsd: null,
        marketCapUsd: null,
        migrated: null,
        creatorWallet: null,
        launchPlatform: null,
      },
      developer: null,
      x_mentions: {
        query: 'Mint1',
        last_60m: null,
        last_30m: null,
        last_5m: null,
        top_accounts: [],
        notes: '',
      },
      x_profiles: [],
      highlights: [],
      risk_flags: [],
      confidence: 0.5,
    });

    await analyzeDevscan({ payload: { meta: { mint: 'Mint1' } } });

    expect(clientMock.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      name: 'devscan_mint_v1',
      schema: expect.any(Object),
      tools: [{ type: 'x_search' }],
      tool_choice: 'auto',
    }));
  });

  test('uses mint schema when token payload includes mint address', async () => {
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({
      version: 'devscan.mint.v1',
      markdown: '# ok',
      entity_type: 'mint',
      target: 'MintToken',
      mint: {
        address: 'MintToken',
        symbol: null,
        name: null,
        status: null,
        createdAt: null,
        priceUsd: null,
        marketCapUsd: null,
        migrated: null,
        creatorWallet: null,
        launchPlatform: null,
      },
      developer: null,
      x_mentions: {
        query: 'MintToken',
        last_60m: null,
        last_30m: null,
        last_5m: null,
        top_accounts: [],
        notes: '',
      },
      x_profiles: [],
      highlights: [],
      risk_flags: [],
      confidence: 0.5,
    });

    const mint = 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump';
    await analyzeDevscan({
      payload: {
        token: {
          data: {
            mintAddress: mint,
            socials: { twitter: 'https://x.com/testtoken' },
          },
        },
      },
    });

    const callArgs = clientMock.callResponses.mock.calls[0][0];
    expect(callArgs.name).toBe('devscan_mint_v1');
    expect(callArgs.user.context.knownMints).toEqual([mint]);
    expect(callArgs.user.context.xHandles).toEqual(['testtoken']);
  });

  test('uses developer schema when no mint is present', async () => {
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({
      version: 'devscan.developer.v1',
      markdown: '# ok',
      entity_type: 'developer',
      target: 'Dev1',
      developer: {
        wallet: 'Dev1',
        name: null,
        rating: null,
        totalTokensCreated: null,
        migrationCount: null,
        feesCollected: null,
        x_handles: [],
      },
      tokens_summary: {
        total: 0,
        alive: 0,
        dead: 0,
        migrated: 0,
        top_market_caps: [],
        recent_mints: [],
      },
      x_profiles: [],
      x_mints_mentioned: [],
      highlights: [],
      risk_flags: [],
      confidence: 0.4,
    });

    await analyzeDevscan({ payload: { meta: { developerWallet: 'Dev1' } } });

    expect(clientMock.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      name: 'devscan_developer_v1',
      schema: expect.any(Object),
    }));
  });

  test('filters developer mint candidates to alive tokens', async () => {
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({
      version: 'devscan.developer.v1',
      markdown: '# ok',
      entity_type: 'developer',
      target: 'Dev1',
      developer: {
        wallet: 'Dev1',
        name: null,
        rating: null,
        totalTokensCreated: null,
        migrationCount: null,
        feesCollected: null,
        x_handles: [],
      },
      tokens_summary: {
        total: 0,
        alive: 0,
        dead: 0,
        migrated: 0,
        top_market_caps: [],
        recent_mints: [],
      },
      x_profiles: [],
      x_mints_mentioned: [],
      highlights: [],
      risk_flags: [],
      confidence: 0.4,
    });

    await analyzeDevscan({
      payload: {
        meta: { developerWallet: 'Dev1' },
        developer: {
          data: {
            tokens: [
              { mintAddress: 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', status: 'alive' },
              { mintAddress: '8invvEsamm2XeDi8gWHq2w8gN9s3RvMB1r6JKRskpump', status: 'dead' },
            ],
          },
        },
      },
    });

    const callArgs = clientMock.callResponses.mock.calls[0][0];
    expect(callArgs.user.context.knownMints).toEqual([
      'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump',
    ]);
  });

  test('builds fallback output when JSON parsing fails', async () => {
    clientMock.callResponses.mockResolvedValue('raw text');
    clientMock.parseResponsesJSON.mockImplementation(() => { throw new Error('bad json'); });

    const res = await analyzeDevscan({ payload: { meta: { mint: 'MintFallback' } } });

    expect(res.version).toBe('devscan.mint.v1');
    expect(res.entity_type).toBe('mint');
    expect(res.mint).toBeDefined();
    expect(res.x_mentions).toBeDefined();
    expect(Array.isArray(res.highlights)).toBe(true);
    expect(Array.isArray(res.risk_flags)).toBe(true);
  });
});
