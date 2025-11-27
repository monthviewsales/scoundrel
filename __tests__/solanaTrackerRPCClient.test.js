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
    process.env.HTTP_PROXY = 'http://user:secret@proxy.example.com:8080/path?token=123';

    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    jest.isolateModules(() => {
      const { createSolanaTrackerRPCClient } = require('../lib/solanaTrackerRPCClient');
      createSolanaTrackerRPCClient({ httpUrl: 'http://rpc.example.com', wsUrl: null });
    });

    const proxyLog = infoSpy.mock.calls.find(([msg]) => msg.includes('http using proxy'))?.[0];
    expect(proxyLog).toBeDefined();
    expect(proxyLog).toContain('http://proxy.example.com:8080');
    expect(proxyLog).not.toContain('user:secret');
    expect(proxyLog).not.toContain('user%3Asecret');
    expect(proxyLog).not.toContain('token=123');
  });
});
