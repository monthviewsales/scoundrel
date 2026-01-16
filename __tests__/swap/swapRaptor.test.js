'use strict';

const {
  _decimalToBaseUnits,
  _baseUnitsToDecimal,
  _getSwapQuote,
} = require('../../lib/swap/swapRaptor');

describe('swapRaptor helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('decimalToBaseUnits converts decimals to base units', () => {
    const amount = _decimalToBaseUnits('1.23', 6);
    expect(amount).toBe(1230000n);
  });

  test('decimalToBaseUnits rejects excessive precision', () => {
    expect(() => _decimalToBaseUnits('1.234', 2)).toThrow('amount has more precision than supported (2 decimals)');
  });

  test('baseUnitsToDecimal converts base units to decimal', () => {
    const amount = _baseUnitsToDecimal(1230000n, 6);
    expect(amount).toBe(1.23);
  });

  test('getSwapQuote requires baseUrl and apiKey', async () => {
    await expect(_getSwapQuote({
      baseUrl: '',
      apiKey: 'key',
      inputMint: 'A',
      outputMint: 'B',
      amount: 1,
      slippageBps: 50,
    })).rejects.toThrow('swapRaptor.getSwapQuote: missing baseUrl');
  });

  test('getSwapQuote parses successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn().mockResolvedValue(JSON.stringify({
        quote: { inAmount: '100', outAmount: '200' },
      })),
    });

    const result = await _getSwapQuote({
      baseUrl: 'https://raptor.example',
      apiKey: 'key',
      inputMint: 'A',
      outputMint: 'B',
      amount: 1,
      slippageBps: 50,
    });

    expect(result).toEqual(expect.objectContaining({ quote: expect.any(Object) }));
  });
});
