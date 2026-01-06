'use strict';

const { listTools, callTool } = require('../../ai/tools');

describe('ai tools registry', () => {
  test('listTools exposes tool schemas', () => {
    const tools = listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('solanaTrackerData.getWalletTrades');
    expect(names).toContain('solanaTrackerData.getWalletChart');
    expect(names).toContain('solanaTrackerData.getPriceRange');
    expect(names).toContain('solanaTrackerData.getTokenOverview');
    expect(names).toContain('solanaTrackerData.getTokenPrice');
    expect(names).toContain('solanaTrackerData.getTokenSnapshotNow');
    expect(names).toContain('solanaTrackerData.getTokenRiskScores');
    expect(names).toContain('solanaTrackerData.getAthPrice');
    expect(names).toContain('walletChart.normalizeChartPoints');
    expect(names).toContain('tradeMints.isBase58Mint');
    expect(names).toContain('autopsy.extractPrice');
  });

  test('callTool runs a tool handler', async () => {
    const isMint = await callTool('tradeMints.isBase58Mint', {
      value: 'So11111111111111111111111111111111111111112',
    });
    expect(isMint).toBe(true);
  });
});
