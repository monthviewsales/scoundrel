'use strict';

const React = require('react');

jest.mock('../../lib/swap/swapConfig', () => ({
  getConfigPath: jest.fn(() => '/tmp/swap-config.json'),
  loadConfig: jest.fn(() => Promise.resolve({
    slippage: 1.5,
    swapApiProvider: 'swapV3',
    rpcUrl: 'https://rpc.example',
  })),
  saveConfig: jest.fn(() => Promise.resolve()),
}));

const h = React.createElement;
let render;

describe('swap config app', () => {
  beforeAll(async () => {
    const inkTestingLibrary = await import('ink-testing-library');
    render = inkTestingLibrary.render;
  });

  test('renders view screen after loading config', async () => {
    const { loadSwapConfigApp } = require('../../lib/tui/swapConfigApp');
    const { SwapConfigApp } = await loadSwapConfigApp();

    const { lastFrame, unmount } = render(h(SwapConfigApp));
    await new Promise((resolve) => setImmediate(resolve));

    const frame = lastFrame();
    expect(frame).toContain('Swap config');
    expect(frame).toContain('Config file');
    expect(frame).toContain('Press e to edit');

    unmount();
  });
});
