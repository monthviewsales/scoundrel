const originalEnv = process.env.OPENAI_API_KEY;

jest.mock('../ai/warlordAI', () => {
  const mockRunTask = jest.fn();
  return {
    createWarlordAI: jest.fn(() => ({ runTask: mockRunTask })),
    __mock: { runTask: mockRunTask }
  };
});

describe('walletDossier job', () => {
  let analyzeWallet;
  let runTaskMock;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = '';
    jest.resetModules();
    runTaskMock = require('../ai/warlordAI').__mock.runTask;
    ({ analyzeWallet } = require('../ai/jobs/walletDossier'));
  });

  afterAll(() => {
    process.env.OPENAI_API_KEY = originalEnv;
  });

  test('throws when merged payload missing', async () => {
    await expect(analyzeWallet({})).rejects.toThrow('[walletDossier] missing merged payload');
  });

  test('delegates to warlordAI and returns payload', async () => {
    const merged = { foo: 'bar' };
    runTaskMock.mockResolvedValue({ version: 'dossier.freeform.v1', markdown: '# hi' });

    const res = await analyzeWallet({ merged, model: 'gpt-test' });

    const callArgs = runTaskMock.mock.calls[0][0];
    expect(callArgs.task).toBe('walletDossier');
    expect(callArgs.payload.merged).toEqual(merged);
    expect(callArgs.model).toBe('gpt-test');
    expect(res).toEqual({ version: 'dossier.freeform.v1', markdown: '# hi' });
  });

  test('wraps fallback output when parse fails', async () => {
    runTaskMock.mockRejectedValue({ response: '## raw markdown' });

    const res = await analyzeWallet({ merged: { ok: true } });

    expect(res).toEqual({ version: 'dossier.freeform.v1', markdown: '## raw markdown' });
  });
});
