'use strict';

const { createSendTransaction } = require('../../../lib/solana/rpcMethods/sendTransaction');

describe('createSendTransaction', () => {
  test('requires rpc.sendTransaction', () => {
    expect(() => createSendTransaction({})).toThrow('sendTransaction: rpc client does not provide sendTransaction');
  });

  test('rejects empty wire transactions', async () => {
    const rpc = {
      sendTransaction: jest.fn(),
    };
    const sendTransaction = createSendTransaction(rpc);

    await expect(sendTransaction('')).rejects.toThrow('wireTxn must be a non-empty string');
  });

  test('sends with default base64 encoding', async () => {
    const send = jest.fn().mockResolvedValue('txid-123');
    const rpc = {
      sendTransaction: jest.fn(() => ({ send })),
    };

    const sendTransaction = createSendTransaction(rpc);
    const result = await sendTransaction('wire');

    expect(result).toBe('txid-123');
    expect(rpc.sendTransaction).toHaveBeenCalledWith('wire', { encoding: 'base64' });
    expect(send).toHaveBeenCalled();
  });

  test('merges explicit options into send payload', async () => {
    const send = jest.fn().mockResolvedValue('txid-456');
    const rpc = {
      sendTransaction: jest.fn(() => ({ send })),
    };

    const sendTransaction = createSendTransaction(rpc);
    const result = await sendTransaction('wire', {
      encoding: 'base58',
      skipPreflight: true,
      maxRetries: 2,
    });

    expect(result).toBe('txid-456');
    expect(rpc.sendTransaction).toHaveBeenCalledWith('wire', {
      encoding: 'base58',
      skipPreflight: true,
      maxRetries: 2,
    });
  });

  test('throws when rpc returns a non-string result', async () => {
    const send = jest.fn().mockResolvedValue(null);
    const rpc = {
      sendTransaction: jest.fn(() => ({ send })),
    };

    const sendTransaction = createSendTransaction(rpc);
    await expect(sendTransaction('wire')).rejects.toThrow('unexpected result');
  });
});
