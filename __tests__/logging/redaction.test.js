const { redactSecretsInText, redactSensitiveData } = require('../../lib/logging/redaction');

describe('redaction helpers', () => {
  test('redacts wallet private key namespaces in text', () => {
    const secretKey = '5'.repeat(88);
    const message = `Command already running for namespace wallet:${secretKey}`;

    const redacted = redactSecretsInText(message);

    expect(redacted).toContain('wallet:[REDACTED]');
    expect(redacted).not.toContain(secretKey);
  });

  test('preserves short wallet namespaces in text', () => {
    const message = 'Command already running for namespace wallet:alice';

    const redacted = redactSecretsInText(message);

    expect(redacted).toBe(message);
  });

  test('redacts walletPrivateKey fields in structured data', () => {
    const data = {
      walletPrivateKey: 'private-key-string',
      nested: {
        wallet: 'pubkey-string',
      },
    };

    expect(redactSensitiveData(data)).toEqual({
      walletPrivateKey: '[redacted]',
      nested: {
        wallet: 'pubkey-string',
      },
    });
  });
});
