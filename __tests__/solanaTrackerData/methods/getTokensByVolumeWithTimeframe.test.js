'use strict';

const { createGetTokensByVolumeWithTimeframe } = require('../../../lib/solanaTrackerData/methods/getTokensByVolumeWithTimeframe');
const { createMockContext } = require('../../../test/helpers/dataClientTestUtils');

describe('getTokensByVolumeWithTimeframe', () => {
  test('calls sdk with timeframe', async () => {
    const ctx = createMockContext();
    ctx.client.getTokensByVolume = jest.fn().mockResolvedValue({ data: [] });
    const fn = createGetTokensByVolumeWithTimeframe(ctx);

    await fn({ timeframe: '6h' });

    expect(ctx.call).toHaveBeenCalledWith('getTokensByVolumeWithTimeframe', expect.any(Function));
    expect(ctx.client.getTokensByVolume).toHaveBeenCalledWith('6h');
  });

  test('rejects invalid timeframe', async () => {
    const fn = createGetTokensByVolumeWithTimeframe(createMockContext());
    await expect(fn({ timeframe: '99h' })).rejects.toThrow('timeframe must be one of');
  });
});
