const originalEnv = process.env.OPENAI_API_KEY;

jest.mock('../ai/gptClient', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  const mockLog = { debug: jest.fn() };
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    log: mockLog,
    __mock: { callResponses: mockCallResponses, parseResponsesJSON: mockParseResponsesJSON, log: mockLog }
  };
});

describe('walletAnalysis job', () => {
  let analyzeWallet;
  let clientMock;

  beforeEach(() => {
    jest.resetModules();
    clientMock = require('../ai/gptClient').__mock;
    ({ analyzeWallet } = require('../ai/jobs/walletAnalysis'));
  });

  afterAll(() => {
    process.env.OPENAI_API_KEY = originalEnv;
  });

  test('throws when merged payload missing', async () => {
    await expect(analyzeWallet({})).rejects.toThrow('[walletAnalysis] missing merged payload');
  });

  test('calls Responses with schema and returns parsed payload', async () => {
    const merged = { foo: 'bar' };
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({ version: 'dossier.freeform.v1', markdown: '# hi' });

    const res = await analyzeWallet({ merged, model: 'gpt-test' });

    expect(clientMock.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dossier_freeform_v1',
      schema: expect.objectContaining({
        required: expect.arrayContaining(['version', 'markdown', 'operator_summary'])
      }),
      user: { merged }
    }));
    expect(res).toEqual({ version: 'dossier.freeform.v1', markdown: '# hi' });
  });

  test('wraps fallback output when parse fails', async () => {
    clientMock.callResponses.mockResolvedValue('## raw markdown');
    clientMock.parseResponsesJSON.mockImplementation(() => { throw new Error('bad json'); });

    const res = await analyzeWallet({ merged: { ok: true } });

    expect(res).toEqual({ version: 'dossier.freeform.v1', markdown: '## raw markdown' });
  });
});
