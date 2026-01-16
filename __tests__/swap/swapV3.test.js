'use strict';

const { _buildSwapTx } = require('../../lib/swap/swapV3');

describe('swapV3 buildSwapTx', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('rejects missing baseUrl', async () => {
    await expect(_buildSwapTx({
      apiKey: 'key',
      from: 'A',
      to: 'B',
      fromAmount: 1,
      payer: 'payer',
      slippagePercent: 1,
    })).rejects.toThrow('swapV3.buildSwapTx: missing baseUrl');
  });

  test('rejects missing apiKey', async () => {
    await expect(_buildSwapTx({
      baseUrl: 'https://swap.example',
      from: 'A',
      to: 'B',
      fromAmount: 1,
      payer: 'payer',
      slippagePercent: 1,
    })).rejects.toThrow('swapV3.buildSwapTx: missing apiKey');
  });

  test('builds swap tx from a successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn().mockResolvedValue(JSON.stringify({
        txn: 'wire-tx',
        rate: { priceImpactPercent: 0.5 },
      })),
    });

    const result = await _buildSwapTx({
      baseUrl: 'https://swap.example',
      apiKey: 'key',
      from: 'So11111111111111111111111111111111111111112',
      to: 'Mint111',
      fromAmount: 1.25,
      payer: 'payer',
      slippagePercent: 1,
      priorityFeeLevel: 'low',
      txVersion: 'v0',
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ txn: 'wire-tx' }));
  });

  test('throws on response without txn', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn().mockResolvedValue(JSON.stringify({})),
    });

    await expect(_buildSwapTx({
      baseUrl: 'https://swap.example/swap',
      apiKey: 'key',
      from: 'A',
      to: 'B',
      fromAmount: 1,
      payer: 'payer',
      slippagePercent: 1,
    })).rejects.toThrow('swapV3.buildSwapTx: missing `txn` in response');
  });
});
