const originalEnv = process.env.NODE_ENV;

jest.mock('../ai/client', () => {
  const mockCallResponses = jest.fn();
  const mockParseResponsesJSON = jest.fn();
  const mockLog = { debug: jest.fn() };
  return {
    callResponses: mockCallResponses,
    parseResponsesJSON: mockParseResponsesJSON,
    log: mockLog,
    __esModule: false,
    _mock: {
      callResponses: mockCallResponses,
      parseResponsesJSON: mockParseResponsesJSON,
      log: mockLog
    }
  };
});

const { _mock } = require('../ai/client');

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

    _mock.callResponses.mockResolvedValue({ raw: true });
    _mock.parseResponsesJSON.mockReturnValue({
      answer: 'Hello world',
      bullets: ['Tip 1', 'Tip 2'],
      actions: ['Action A']
    });

    const result = await ask({ question: 'hi?', profile: { id: 1 }, rows: ['r1', 'r2'] });

    expect(_mock.callResponses).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ask_v1',
      system: expect.stringContaining('Scoundrel'),
      user: expect.objectContaining({
        question: 'hi?',
        profile: { id: 1 }
      })
    }));

    expect(result).toContain('Hello world');
    expect(result).toContain('• Tip 1');
    expect(result).toContain('• Tip 2');
    expect(result).toContain('Next actions:\n- Action A');
    expect(_mock.log.debug).toHaveBeenCalled();
  });
});
