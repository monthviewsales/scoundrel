jest.mock('../ai/gptClient', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    __mock: { callResponses: mockCallResponses, parseResponsesJSON: mockParseResponsesJSON }
  };
});

describe('tuneStrategy job', () => {
  let runTuneStrategy;
  let mockClient;

  beforeEach(() => {
    jest.resetModules();
    mockClient = require('../ai/gptClient').__mock;
    ({ createTuneStrategyJob } = require('../ai/jobs/tuneStrategy'));
    ({ runTuneStrategy } = createTuneStrategyJob({
      callResponses: mockClient.callResponses,
      parseResponsesJSON: mockClient.parseResponsesJSON,
      log: {},
    }));
  });

  test('delegates to callResponses and parseResponsesJSON', async () => {
    const response = { answer: 'ok' };
    mockClient.callResponses.mockResolvedValue({ raw: true });
    mockClient.parseResponsesJSON.mockReturnValue(response);

    const result = await runTuneStrategy({
      strategy: { name: 'FLASH' },
      strategyMeta: { name: 'flash', path: '/tmp/flash.json' },
      profile: { id: 1 },
      history: [],
      question: 'What should I tweak?',
      model: 'gpt',
      temperature: 0.25,
    });

    expect(mockClient.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      schema: expect.any(Object),
      name: 'tune_strategy_v3',
      user: {
        strategy: { name: 'FLASH' },
        strategyMeta: { name: 'flash', path: '/tmp/flash.json' },
        profile: { id: 1 },
        history: [],
        question: 'What should I tweak?',
      },
      model: 'gpt',
      temperature: 0.25
    }));
    expect(result).toBe(response);
  });
});
