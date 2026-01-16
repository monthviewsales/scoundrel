'use strict';

const mockFs = {
  pathExists: jest.fn(),
  ensureDir: jest.fn(),
  writeJson: jest.fn(),
  chmod: jest.fn(),
  readJson: jest.fn(),
};
const mockSpawnSync = jest.fn();

jest.mock('fs-extra', () => mockFs);
jest.mock('child_process', () => ({
  spawnSync: (...args) => mockSpawnSync(...args),
}));

describe('swapConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SWAP_CONFIG_JSON;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('loads config from SWAP_CONFIG_JSON override', async () => {
    process.env.SWAP_CONFIG_JSON = JSON.stringify({
      swapApiKey: 'api-key',
      slippage: 5,
    });

    const { loadConfig } = require('../../lib/swap/swapConfig');
    const config = await loadConfig();

    expect(config.swapApiKey).toBe('api-key');
    expect(config.slippage).toBe(5);
    expect(config.swapApiProvider).toBe('swapV3');
    expect(mockFs.pathExists).not.toHaveBeenCalled();
  });

  test('migrates legacy swapAPIKey and writes updated config', async () => {
    process.env.SWAP_CONFIG_JSON = '{invalid-json';
    mockFs.pathExists.mockResolvedValue(true);
    mockFs.readJson.mockResolvedValue({
      swapAPIKey: 'legacy-key',
    });

    const { loadConfig } = require('../../lib/swap/swapConfig');
    const config = await loadConfig();

    expect(config.swapApiKey).toBe('legacy-key');
    expect(config.swapAPIKey).toBeUndefined();
    expect(config.swapDiscountKey).toBe('legacy-key');
    expect(mockFs.writeJson).toHaveBeenCalled();
    expect(mockFs.chmod).toHaveBeenCalledWith(expect.any(String), 0o600);
  });

  test('saveConfig removes legacy swapAPIKey and sets permissions', async () => {
    const { saveConfig } = require('../../lib/swap/swapConfig');

    const cfg = {
      rpcUrl: 'http://example',
      swapAPIKey: 'legacy-key',
    };

    await saveConfig(cfg);

    const [, payload] = mockFs.writeJson.mock.calls[0];
    expect(payload.swapAPIKey).toBeUndefined();
    expect(payload.swapDiscountKey).toBe('legacy-key');
    expect(mockFs.ensureDir).toHaveBeenCalled();
    expect(mockFs.chmod).toHaveBeenCalledWith(expect.any(String), 0o600);
  });

  test('editConfig opens config in editor', () => {
    process.env.EDITOR = 'nano';
    const { editConfig, getConfigPath } = require('../../lib/swap/swapConfig');

    editConfig();
    expect(mockSpawnSync).toHaveBeenCalledWith('nano', [getConfigPath()], { stdio: 'inherit' });
  });
});
