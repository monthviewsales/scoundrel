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

  test('returns null when wallet missing and private key not required', () => {
    expect(getPrivateKeyForWallet(null, { requirePrivateKey: false })).toBeNull();
  });

  test('errors when wallet missing and private key required', () => {
    expect(() => getPrivateKeyForWallet(null)).toThrow('wallet is required');
  });

  test('errors when has_private_key is false and key required', () => {
    expect(() =>
      getPrivateKeyForWallet({ alias: 'alpha', has_private_key: 0 })
    ).toThrow('does not have an attached private key');
  });

  test('resolves env-sourced keys', () => {
    process.env.WALLET_SECRET = 'super-secret';
    const secret = getPrivateKeyForWallet({
      alias: 'alpha',
      has_private_key: 1,
      key_source: 'env',
      key_ref: 'WALLET_SECRET',
    });
    expect(secret).toBe('super-secret');
  });

  test('errors when env key_ref is missing', () => {
    expect(() =>
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'env',
      })
    ).toThrow('key_source=env but key_ref is NULL');
  });

  test('errors when env var is not set', () => {
    expect(() =>
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'env',
        key_ref: 'MISSING_ENV',
      })
    ).toThrow('Environment variable "MISSING_ENV"');
  });

  test('blocks plaintext_dev in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'plaintext_dev',
        key_ref: 'plaintext-secret',
      })
    ).toThrow('plaintext_dev, which is not allowed in production');
  });

  test('allows plaintext_dev outside production', () => {
    process.env.NODE_ENV = 'development';
    const secret = getPrivateKeyForWallet({
      alias: 'alpha',
      has_private_key: 1,
      key_source: 'plaintext_dev',
      key_ref: 'plaintext-secret',
    });
    expect(secret).toBe('plaintext-secret');
  });

  test('errors on unsupported key source when required', () => {
    expect(() =>
      getPrivateKeyForWallet({
        alias: 'alpha',
        has_private_key: 1,
        key_source: 'vault',
      })
    ).toThrow('unsupported key_source');
  });
});
