jest.mock('../ai/gptClient', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  const mockLog = { debug: jest.fn() };
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    log: mockLog,
    __mock: { callResponses: mockCallResponses, parseResponsesJSON: mockParseResponsesJSON, log: mockLog },
  };
});

describe('tradeAutopsy job', () => {
  let analyzeTradeAutopsy;
  let clientMock;

  beforeEach(() => {
    jest.resetModules();
    clientMock = require('../ai/gptClient').__mock;
    ({ analyzeTradeAutopsy } = require('../ai/jobs/tradeAutopsy'));
  });

  test('throws when payload missing', async () => {
    await expect(analyzeTradeAutopsy({})).rejects.toThrow('[tradeAutopsy] missing payload');
  });

  test('calls Responses with schema and returns parsed payload', async () => {
    const payload = { wallet: { address: 'abc' } };
    clientMock.callResponses.mockResolvedValue({ ok: true });
    clientMock.parseResponsesJSON.mockReturnValue({ grade: 'A', summary: 'ok', entryAnalysis: 'e', exitAnalysis: 'x', riskManagement: 'r', profitability: 'p', lessons: [], tags: [] });

    const res = await analyzeTradeAutopsy({ payload, model: 'gpt-test' });

    expect(clientMock.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      name: 'trade_autopsy_v2_3',
      schema: expect.objectContaining({ required: expect.arrayContaining(['grade', 'summary']) }),
      user: { campaign: payload },
    }));
    expect(res.grade).toBe('A');
  });
});
