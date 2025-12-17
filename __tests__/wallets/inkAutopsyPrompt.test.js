'use strict';

const React = require('react');

jest.mock('ink', () => ({
  __esModule: true,
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: jest.fn() }),
  useInput: () => {},
}));

jest.mock('ink-text-input', () => ({
  __esModule: true,
  default: () => null,
}));

const { loadAutopsyPrompt } = require('../../lib/wallets/inkAutopsyPrompt');

describe('AutopsyPrompt', () => {
  test('loader resolves a component', async () => {
    const { AutopsyPrompt } = await loadAutopsyPrompt();
    expect(typeof AutopsyPrompt).toBe('function');
  });

  test('creates element with default props', async () => {
    const { AutopsyPrompt } = await loadAutopsyPrompt();
    const element = React.createElement(AutopsyPrompt, { onSubmit: jest.fn() });
    expect(element).toBeTruthy();
  });
});
