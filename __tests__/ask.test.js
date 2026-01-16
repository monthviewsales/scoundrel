const originalEnv = process.env.NODE_ENV;

jest.mock('../ai/warlordAI', () => {
  const mockRunTask = jest.fn();
  return { runTask: mockRunTask, _mock: { runTask: mockRunTask } };
});

const { _mock } = require('../ai/warlordAI');

describe.skip('ask processor (skipped: ask.js not yet wired)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('throws when question is missing', async () => {
    const ask = require('../lib/ask');
    await expect(ask({})).rejects.toThrow('[ask] question (string) is required');
  });

  test('formats response with bullets and actions', async () => {
    process.env.NODE_ENV = 'development';
    const ask = require('../lib/ask');

    _mock.runTask.mockResolvedValue({
      answer: 'Hello world',
      bullets: ['Tip 1', 'Tip 2'],
      actions: ['Action A']
    });

    const result = await ask({ question: 'hi?', profile: { id: 1 }, rows: ['r1', 'r2'] });

    expect(_mock.runTask).toHaveBeenCalledWith(expect.objectContaining({
      task: 'ask',
      payload: expect.objectContaining({
        question: 'hi?',
        profile: { id: 1 }
      })
    }));

    expect(result).toContain('Hello world');
    expect(result).toContain('• Tip 1');
    expect(result).toContain('• Tip 2');
    expect(result).toContain('Next actions:\n- Action A');
  });
});
