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

    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    jest.isolateModules(() => {
      const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
      createSolanaTrackerRPCClient({ httpUrl: 'http://rpc.example.com', wsUrl: null });
    });

    const allCalls = [
      ...infoSpy.mock.calls,
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...debugSpy.mock.calls,
    ];

    const allMessages = allCalls
      .map((args) => (args && args.length ? String(args[0]) : ''))
      .filter(Boolean);

    const proxyLog = allMessages.find((msg) => /proxy/i.test(msg));

    expect(proxyLog).toBeDefined();

    // Accept either scheme-present or host:port-only logging
    expect(proxyLog).toEqual(expect.stringMatching(/proxy\.example\.com:8080/));

    // Redaction expectations
    expect(proxyLog).not.toContain('user:secret');
    expect(proxyLog).not.toContain('user%3Asecret');
    expect(proxyLog).not.toContain('token=123');
  });
});
