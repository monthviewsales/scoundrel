'use strict';

jest.mock('../../lib/warchest/warlordAIClient', () => ({
  createWarlordAIClient: jest.fn(),
}));

const { createWarlordAIClient } = require('../../lib/warchest/warlordAIClient');
const { formatAskOutput, runWarlordAIAsk } = require('../../lib/cli/warlordai');

describe('warlordai CLI helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('formatAskOutput formats bullets and actions', () => {
    const text = formatAskOutput({
      answer: 'Hello',
      bullets: ['One', 'Two'],
      actions: ['Next step'],
    });
    expect(text).toContain('Hello');
    expect(text).toContain('• One');
    expect(text).toContain('Next actions:');
  });

  test('runWarlordAIAsk requires a question', async () => {
    await expect(runWarlordAIAsk({})).rejects.toThrow('[warlordai] question (string) is required');
  });

  test('runWarlordAIAsk sends ask payload and closes the client', async () => {
    const request = jest.fn().mockResolvedValue({
      sessionId: 'session-1',
      result: {
        answer: 'ok',
        bullets: ['b1'],
        actions: [],
      },
    });
    const close = jest.fn();
    createWarlordAIClient.mockReturnValue({ request, close });

    const result = await runWarlordAIAsk({ question: '  hi  ' });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'ask',
        payload: { question: 'hi' },
      }),
      expect.any(Object),
    );
    expect(close).toHaveBeenCalled();
    expect(result.sessionId).toBe('session-1');
    expect(result.text).toContain('ok');
  });
});
