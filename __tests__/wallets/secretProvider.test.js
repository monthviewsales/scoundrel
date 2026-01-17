'use strict';

const { hasUsablePrivateKey, getPrivateKeyForWallet } = require('../../lib/wallets/secretProvider');

describe('wallet secretProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('normalizes has_private_key flags', () => {
    expect(hasUsablePrivateKey({ has_private_key: 1 })).toBe(true);
    expect(hasUsablePrivateKey({ has_private_key: '1' })).toBe(true);
    expect(hasUsablePrivateKey({ hasPrivateKey: true })).toBe(true);
    expect(hasUsablePrivateKey({ has_private_key: 0 })).toBe(false);
    expect(hasUsablePrivateKey({ has_private_key: '0' })).toBe(false);
    expect(hasUsablePrivateKey({ hasPrivateKey: false })).toBe(false);
  });

  test('returns null when wallet missing and private key not required', async () => {
    await expect(getPrivateKeyForWallet(null, { requirePrivateKey: false })).resolves.toBeNull();
  });

  test('errors when wallet missing and private key required', async () => {
    await expect(getPrivateKeyForWallet(null)).rejects.toThrow('wallet is required');
  });

  test('errors when has_private_key is false and key required', async () => {
    await expect(
      getPrivateKeyForWallet({ alias: 'alpha', has_private_key: 0 })
    ).rejects.toThrow('does not have an attached private key');
  });

  test('resolves env-sourced keys', async () => {
    process.env.WALLET_SECRET = 'super-secret';
    const secret = await getPrivateKeyForWallet({
      alias: 'alpha',
      has_private_key: 1,
      key_source: 'env',
      key_ref: 'WALLET_SECRET',
    });
    expect(secret).toBe('super-secret');
  });

  test('errors when env key_ref is missing', async () => {
    await expect(
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'env',
      })
    ).rejects.toThrow('key_source=env but key_ref is NULL');
  });

  test('errors when env var is not set', async () => {
    await expect(
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'env',
        key_ref: 'MISSING_ENV',
      })
    ).rejects.toThrow('Environment variable "MISSING_ENV"');
  });

  test('blocks plaintext_dev in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'plaintext_dev',
        key_ref: 'plaintext-secret',
      })
    ).rejects.toThrow('plaintext_dev, which is not allowed in production');
  });

  test('allows plaintext_dev outside production', async () => {
    process.env.NODE_ENV = 'development';
    const secret = await getPrivateKeyForWallet({
      alias: 'alpha',
      has_private_key: 1,
      key_source: 'plaintext_dev',
      key_ref: 'plaintext-secret',
    });
    expect(secret).toBe('plaintext-secret');
  });

  test('errors on unsupported key source when required', async () => {
    await expect(
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'vault',
      })
    ).rejects.toThrow('unsupported key_source');
  });
});
