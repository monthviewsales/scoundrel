jest.mock('../ai/client', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    __mock: { callResponses: mockCallResponses, parseResponsesJSON: mockParseResponsesJSON }
  };
});

describe('tuneStrategy job', () => {
  let run;
  let mockClient;

  beforeEach(() => {
    jest.resetModules();
    mockClient = require('../ai/client').__mock;
    ({ run } = require('../ai/jobs/tuneStrategy'));
  });

  test('delegates to callResponses and parseResponsesJSON', async () => {
    const response = { answer: 'ok' };
    mockClient.callResponses.mockResolvedValue({ raw: true });
    mockClient.parseResponsesJSON.mockReturnValue(response);

    const result = await run({ profile: { id: 1 }, currentSettings: { risk: 'low' }, model: 'gpt', temperature: 0.25 });

    expect(mockClient.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      schema: expect.any(Object),
      name: 'tune_strategy_v1',
      user: { profile: { id: 1 }, currentSettings: { risk: 'low' } },
      model: 'gpt',
      temperature: 0.25
    }));
    expect(result).toBe(response);
  });
});
