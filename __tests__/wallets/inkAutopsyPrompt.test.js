'use strict';

const React = require('react');

jest.mock('ink', () => ({
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: jest.fn() }),
  useInput: () => {},
}));

jest.mock('ink-text-input', () => ({
  default: () => null,
}));

const { AutopsyPrompt } = require('../../lib/wallets/inkAutopsyPrompt');

describe('AutopsyPrompt', () => {
  test('exports a component', () => {
    expect(typeof AutopsyPrompt).toBe('function');
  });

  test('creates element with default props', () => {
    const element = React.createElement(AutopsyPrompt, { onSubmit: jest.fn() });
    expect(element).toBeTruthy();
  });
});
