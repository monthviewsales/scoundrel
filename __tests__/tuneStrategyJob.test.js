jest.mock('../ai/warlordAI', () => {
  const mockRunTask = jest.fn();
  return {
    createWarlordAI: jest.fn(() => ({ runTask: mockRunTask })),
    __mock: { runTask: mockRunTask }
  };
});

describe('tuneStrategy job', () => {
  let runTuneStrategy;
  let runTaskMock;

  beforeEach(() => {
    jest.resetModules();
    runTaskMock = require('../ai/warlordAI').__mock.runTask;
    ({ createTuneStrategyJob } = require('../ai/jobs/tuneStrategy'));
    ({ runTuneStrategy } = createTuneStrategyJob({
      callResponses: jest.fn(),
      parseResponsesJSON: jest.fn(),
      log: {},
    }));
  });

  test('delegates to warlordAI runTask', async () => {
    const response = { answer: 'ok' };
    runTaskMock.mockResolvedValue(response);

    const result = await runTuneStrategy({
      strategy: { name: 'FLASH' },
      strategyMeta: { name: 'flash', path: '/tmp/flash.json' },
      profile: { id: 1 },
      history: [],
      question: 'What should I tweak?',
      model: 'gpt',
      temperature: 0.25,
    });

    expect(runTaskMock).toHaveBeenCalledWith({
      task: 'tuneStrategy',
      payload: {
        strategy: { name: 'FLASH' },
        strategyMeta: { name: 'flash', path: '/tmp/flash.json' },
        profile: { id: 1 },
        history: [],
        question: 'What should I tweak?',
      },
      model: 'gpt',
      temperature: 0.25,
    });
    expect(result).toBe(response);
  });
});
