jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  return {
    ...actual,
    ProxyAgent: jest.fn(() => ({ mocked: true })),
    setGlobalDispatcher: jest.fn(),
  };
});

describe('solanaTrackerRPCClient proxy logging', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.entries(originalEnv).forEach(([key, value]) => {
      process.env[key] = value;
    });
    delete globalThis.__scoundrelProxyDispatcher;
    delete globalThis.__scoundrelProxyWebSocket;
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('redacts proxy credentials in logs', () => {
    process.env.NODE_ENV = 'development';
    process.env.KIT_LOG_LEVEL = 'info';
    process.env.HTTP_PROXY = 'http://user:secret@proxy.example.com:8080/path?token=123';

    jest.resetModules();

    const infoMessages = [];

    jest.isolateModules(() => {
      jest.doMock('../lib/logger', () => ({
        child: () => ({
          info: (msg) => infoMessages.push(String(msg)),
          warn: () => {},
          debug: () => {},
          error: () => {},
        }),
      }));

      const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
      createSolanaTrackerRPCClient({ httpUrl: 'http://rpc.example.com', wsUrl: null });
    });

    const proxyLog = infoMessages.find((msg) => /proxy/i.test(msg));

    expect(proxyLog).toBeDefined();

    // Accept either scheme-present or host:port-only logging
    expect(proxyLog).toEqual(expect.stringMatching(/proxy\.example\.com:8080/));

    // Redaction expectations
    expect(proxyLog).not.toContain('user:secret');
    expect(proxyLog).not.toContain('user%3Asecret');
    expect(proxyLog).not.toContain('token=123');
  });
});

describe('solanaTrackerRPCClient retry handling', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.entries(originalEnv).forEach(([key, value]) => {
      process.env[key] = value;
    });
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('retries transient errors for read-only RPC calls', async () => {
    process.env.KIT_RPC_MAX_RETRIES = '1';
    const sendMock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ value: 1 });

    const warnMessages = [];
    let resultPromise;

    jest.isolateModules(() => {
      jest.doMock('@solana/kit', () => ({
        createSolanaRpc: jest.fn(() => ({
          getBalance: () => ({ send: sendMock }),
          sendTransaction: () => ({ send: jest.fn() }),
        })),
        createSolanaRpcSubscriptions: jest.fn(() => null),
      }));

      jest.doMock('../lib/logger', () => ({
        child: () => ({
          info: () => {},
          warn: (msg, meta) => warnMessages.push({ msg, meta }),
          debug: () => {},
          error: () => {},
        }),
      }));

      const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
      const { rpc } = createSolanaTrackerRPCClient({ httpUrl: 'http://rpc.example.com', wsUrl: null });
      resultPromise = rpc.getBalance('addr').send();
    });

    await resultPromise;
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(warnMessages.some((entry) => String(entry.msg).includes('rpc.send retry'))).toBe(true);
  });

  test('does not retry non-read RPC calls', async () => {
    process.env.KIT_RPC_MAX_RETRIES = '2';
    const sendTxMock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    let resultPromise;

    jest.isolateModules(() => {
      jest.doMock('@solana/kit', () => ({
        createSolanaRpc: jest.fn(() => ({
          sendTransaction: () => ({ send: sendTxMock }),
        })),
        createSolanaRpcSubscriptions: jest.fn(() => null),
      }));

      jest.doMock('../lib/logger', () => ({
        child: () => ({
          info: () => {},
          warn: () => {},
          debug: () => {},
          error: () => {},
        }),
      }));

      const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
      const { rpc } = createSolanaTrackerRPCClient({ httpUrl: 'http://rpc.example.com', wsUrl: null });
      resultPromise = rpc.sendTransaction('payload', { encoding: 'base64' }).send().catch(() => {});
    });

    await resultPromise;
    expect(sendTxMock).toHaveBeenCalledTimes(1);
  });
});
