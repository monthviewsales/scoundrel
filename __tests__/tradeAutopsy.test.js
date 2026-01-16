const originalApiKey = process.env.OPENAI_API_KEY;

jest.mock('../ai/warlordAI', () => {
  const mockRunTask = jest.fn();
  return {
    createWarlordAI: jest.fn(() => ({ runTask: mockRunTask })),
    __mock: { runTask: mockRunTask },
  };
});

describe('tradeAutopsy job', () => {
  let analyzeTradeAutopsy;
  let runTaskMock;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = '';
    jest.resetModules();
    runTaskMock = require('../ai/warlordAI').__mock.runTask;
    ({ analyzeTradeAutopsy } = require('../ai/jobs/tradeAutopsy'));
  });

  afterAll(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
  });

  test('throws when payload missing', async () => {
    await expect(analyzeTradeAutopsy({})).rejects.toThrow('[tradeAutopsy] missing payload');
  });

  test('delegates to warlordAI and returns payload', async () => {
    const payload = { wallet: { address: 'abc' } };
    const response = { grade: 'A', summary: 'ok', entryAnalysis: 'e', exitAnalysis: 'x', riskManagement: 'r', profitability: 'p', lessons: [], tags: [] };
    runTaskMock.mockResolvedValue(response);

    const res = await analyzeTradeAutopsy({ payload, model: 'gpt-test' });

    expect(runTaskMock).toHaveBeenCalledWith({
      task: 'tradeAutopsy',
      payload,
      model: 'gpt-test',
    });
    expect(res.grade).toBe('A');
  });
});
