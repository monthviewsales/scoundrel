'use strict';

const React = require('react');
const { EventEmitter } = require('node:events');

jest.mock('../../lib/warchest/events', () => ({
  createHubEventFollower: jest.fn(() => ({
    onEvent: jest.fn(),
    close: jest.fn(),
  })),
  DEFAULT_HUD_STATE_PATH: '/tmp/hud-state.json',
}));

const h = React.createElement;
let render;

describe('command TUI', () => {
  beforeAll(async () => {
    const inkModule = await import('ink');
    const inkRender = inkModule.render;

    class Stdout extends EventEmitter {
      constructor() {
        super();
        this.frames = [];
        this._lastFrame = undefined;
      }

      write(frame) {
        this.frames.push(frame);
        this._lastFrame = frame;
      }

      lastFrame() {
        return this._lastFrame;
      }

      get columns() {
        return 100;
      }
    }

    class Stderr extends EventEmitter {
      constructor() {
        super();
        this.frames = [];
        this._lastFrame = undefined;
      }

      write(frame) {
        this.frames.push(frame);
        this._lastFrame = frame;
      }

      lastFrame() {
        return this._lastFrame;
      }
    }

    class Stdin extends EventEmitter {
      constructor() {
        super();
        this.isTTY = true;
      }

      write(data) {
        this.emit('data', data);
      }

      read() {
        return null;
      }

      setEncoding() {}

      setRawMode() {}

      resume() {}

      pause() {}

      ref() {}

      unref() {}
    }

    render = (tree) => {
      const stdout = new Stdout();
      const stderr = new Stderr();
      const stdin = new Stdin();
      const instance = inkRender(tree, {
        stdout,
        stderr,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      return {
        rerender: instance.rerender,
        unmount: instance.unmount,
        cleanup: instance.cleanup,
        stdout,
        stderr,
        stdin,
        frames: stdout.frames,
        lastFrame: stdout.lastFrame.bind(stdout),
      };
    };
  });

  test('renders test command summary lines', async () => {
    const { loadCommandTuiApp } = require('../../lib/tui/commandTui');
    const { CommandTuiApp } = await loadCommandTuiApp();

    const run = jest.fn(async () => ({
      ok: true,
      env: {
        openaiKey: true,
        solanaTrackerKey: true,
        xaiKey: true,
        cwd: '/tmp',
        nodeVersion: 'v20.0.0',
      },
      coreFiles: [
        { path: 'lib/cli/dossier.js', present: true },
        { path: 'ai/gptClient.js', present: true },
        { path: 'ai/warlordAI.js', present: true },
        { path: 'ai/jobs/walletDossier.js', present: true },
        { path: 'lib/cli/ask.js', present: true },
      ],
      swapConfig: {
        path: '/tmp/swap-config.json',
        ok: true,
        override: false,
      },
      db: {
        path: '/tmp/bootybox.db',
        ok: true,
        error: null,
      },
      wallets: {
        count: 1,
        ok: true,
        error: null,
      },
    }));

    const { lastFrame, unmount } = render(
      h(CommandTuiApp, {
        command: 'test',
        options: {},
        run,
      })
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const frame = lastFrame();
    expect(frame).toContain('OPENAI_API_KEY');
    expect(frame).toContain('SOLANATRACKER_API_KEY');
    expect(frame).toContain('xAI_API_KEY');
    expect(frame).toContain('Core files:');
    expect(frame).toContain('Swap config:');
    expect(frame).toContain('BootyBox sqlite');
    expect(frame).toContain('Wallets in DB');

    unmount();
  });
});
