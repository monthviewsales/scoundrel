"use strict";

const mockGetTokenSnapshotNow = jest.fn();
const mockGetTokenPrice = jest.fn();
const mockGetTokenOverview = jest.fn();
const mockGetPriceRange = jest.fn();
const mockGetAthPrice = jest.fn();
const mockClose = jest.fn();

jest.mock("../../lib/solanaTrackerDataClient", () => ({
  createSolanaTrackerDataClient: jest.fn(() => ({
    getTokenSnapshotNow: mockGetTokenSnapshotNow,
    getTokenPrice: mockGetTokenPrice,
    getTokenOverview: mockGetTokenOverview,
    getPriceRange: mockGetPriceRange,
    getAthPrice: mockGetAthPrice,
    close: mockClose,
  })),
}));

const { listTools, callTool } = require("../../ai/tools");

beforeEach(() => {
  mockGetTokenSnapshotNow.mockReset();
  mockGetTokenPrice.mockReset();
  mockGetTokenOverview.mockReset();
  mockGetPriceRange.mockReset();
  mockGetAthPrice.mockReset();
  mockClose.mockReset();
});

describe("ai tools registry", () => {
  test("listTools exposes tool schemas", () => {
    const tools = listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("solanaTrackerData.getWalletTrades");
    expect(names).toContain("solanaTrackerData.getWalletChart");
    expect(names).toContain("solanaTrackerData.getPriceRange");
    expect(names).toContain("solanaTrackerData.getTokenOverview");
    expect(names).toContain("solanaTrackerData.getTokenPrice");
    expect(names).toContain("solanaTrackerData.getTokenSnapshotNow");
    expect(names).toContain("solanaTrackerData.getAthPrice");
    expect(names).toContain("grok.scoreProfile");
    expect(names).toContain("grok.searchMintReport");
    expect(names).toContain("walletChart.normalizeChartPoints");
    expect(names).toContain("tradeMints.isBase58Mint");
    expect(names).toContain("autopsy.extractPrice");
  });

  test("callTool runs a tool handler", async () => {
    const isMint = await callTool("tradeMints.isBase58Mint", {
      value: "So11111111111111111111111111111111111111112",
    });
    expect(isMint).toBe(true);
  });

  test("callTool passes mint options to getTokenSnapshotNow", async () => {
    mockGetTokenSnapshotNow.mockResolvedValue({ ok: true });

    await callTool("solanaTrackerData.getTokenSnapshotNow", {
      mint: "6R7UD3L7qLvbWXSmjGmYABrMau3PfcNvQDYytG5SBAGS",
    });

    expect(mockGetTokenSnapshotNow).toHaveBeenCalledWith({
      mint: "6R7UD3L7qLvbWXSmjGmYABrMau3PfcNvQDYytG5SBAGS",
    });
  });

  test("callTool supports tokenAddress for getTokenPrice", async () => {
    mockGetTokenPrice.mockResolvedValue({ ok: true });

    await callTool("solanaTrackerData.getTokenPrice", {
      tokenAddress: "So11111111111111111111111111111111111111112",
      includePriceChanges: true,
    });

    expect(mockGetTokenPrice).toHaveBeenCalledWith({
      tokenAddress: "So11111111111111111111111111111111111111112",
      includePriceChanges: true,
    });
  });

  test("callTool supports tokenAddress for getPriceRange", async () => {
    mockGetPriceRange.mockResolvedValue({ ok: true });

    await callTool("solanaTrackerData.getPriceRange", {
      tokenAddress: "So11111111111111111111111111111111111111112",
      timeFrom: 1700000000,
      timeTo: 1700003600,
    });

    expect(mockGetPriceRange).toHaveBeenCalledWith(
      "So11111111111111111111111111111111111111112",
      1700000000,
      1700003600,
    );
  });
});
