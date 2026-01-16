'use strict';

jest.mock('../ai/warlordAI', () => {
  const mockRunTask = jest.fn();
  return {
    createWarlordAI: jest.fn(() => ({ runTask: mockRunTask })),
    __mock: { runTask: mockRunTask },
  };
});

describe('devscanAnalysis job', () => {
  let analyzeDevscan;
  let runTaskMock;
  const originalXaiKey = process.env.xAI_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.xAI_API_KEY = originalXaiKey || 'test-xai-key';
    runTaskMock = require('../ai/warlordAI').__mock.runTask;
    ({ analyzeDevscan } = require('../ai/jobs/devscanAnalysis'));
  });

  afterAll(() => {
    process.env.xAI_API_KEY = originalXaiKey;
  });

  test('delegates to warlordAI and returns output', async () => {
    const payload = { meta: { mint: 'Mint1' } };
    const response = { version: 'devscan.mint.v1', markdown: '# ok' };
    runTaskMock.mockResolvedValue(response);

    const res = await analyzeDevscan({ payload, model: 'grok-test' });

    const callArgs = runTaskMock.mock.calls[0][0];
    expect(callArgs.task).toBe('devscanAnalysis');
    expect(callArgs.payload.payload).toEqual(payload);
    expect(callArgs.model).toBe('grok-test');
    expect(res).toBe(response);
  });

  test('builds fallback output when task throws', async () => {
    runTaskMock.mockRejectedValue({ response: 'raw text' });

    const res = await analyzeDevscan({ payload: { meta: { mint: 'MintFallback' } } });

    expect(res.version).toBe('devscan.mint.v1');
    expect(res.entity_type).toBe('mint');
    expect(res.mint.address).toBe('MintFallback');
    expect(res.markdown).toBe('raw text');
  });

  test('wraps response when markdown is missing', async () => {
    runTaskMock.mockResolvedValue({ version: 'devscan.developer.v1' });

    const res = await analyzeDevscan({ payload: { meta: { developerWallet: 'Dev1' } } });

    expect(res.version).toBe('devscan.developer.v1');
    expect(res.entity_type).toBe('developer');
    expect(res.markdown).toContain('devscan.developer.v1');
  });
});

describe('devscanAnalysis task helpers', () => {
  const devscanTask = require('../ai/warlordAI/tasks/devscanAnalysis');

  test('resolves mint config when payload includes a mint', () => {
    const result = devscanTask.resolve({ payload: { meta: { mint: 'Mint1' } } });
    expect(result.name).toBe('devscan_mint_v1');
    expect(result.version).toBe('devscan.mint.v1');
  });

  test('buildUser collects mint candidates and x handles', () => {
    const mint = 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump';
    const user = devscanTask.buildUser({
      payload: {
        token: {
          data: {
            mintAddress: mint,
            socials: { twitter: 'https://x.com/testtoken' },
          },
        },
      },
    });

    expect(user.context.knownMints).toEqual([mint]);
    expect(user.context.xHandles).toEqual(['testtoken']);
  });

  test('filters developer mint candidates to alive tokens', () => {
    const user = devscanTask.buildUser({
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

    expect(user.context.knownMints).toEqual([
      'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump',
    ]);
  });
});
