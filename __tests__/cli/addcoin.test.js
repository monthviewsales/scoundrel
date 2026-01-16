'use strict';

jest.mock('../../lib/solanaTrackerDataClient', () => ({
  createSolanaTrackerDataClient: jest.fn(),
}));

jest.mock('../../lib/services/tokenInfoService', () => ({
  ensureTokenInfo: jest.fn(),
}));

const { createSolanaTrackerDataClient } = require('../../lib/solanaTrackerDataClient');
const tokenInfoService = require('../../lib/services/tokenInfoService');

describe('addcoin CLI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws when mint is missing', async () => {
    const { run } = require('../../lib/cli/addcoin');
    await expect(run({})).rejects.toThrow('mint is required');
  });

  test('calls ensureTokenInfo with client and forceRefresh', async () => {
    const client = { id: 'client' };
    createSolanaTrackerDataClient.mockResolvedValue(client);
    tokenInfoService.ensureTokenInfo.mockResolvedValue({ mint: 'Mint111' });

    const { run } = require('../../lib/cli/addcoin');
    await run({ mint: 'So11111111111111111111111111111111111111112', forceRefresh: true });

    expect(createSolanaTrackerDataClient).toHaveBeenCalled();
    expect(tokenInfoService.ensureTokenInfo).toHaveBeenCalledWith({
      mint: 'So11111111111111111111111111111111111111112',
      client,
      forceRefresh: true,
    });
  });

  test('returns early when token info is empty', async () => {
    const client = { id: 'client' };
    createSolanaTrackerDataClient.mockResolvedValue(client);
    tokenInfoService.ensureTokenInfo.mockResolvedValue(null);

    const { run } = require('../../lib/cli/addcoin');
    await run({ mint: 'Mint111111111111111111111111111111111111111' });

    expect(tokenInfoService.ensureTokenInfo).toHaveBeenCalled();
  });
});
