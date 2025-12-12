"use strict";

const React = require("react");
let render;
let ink;

const {
  createChainStatus,
  createRpcLatencyBar,
  createWalletCard,
  createRecentActivityList,
} = require("../../lib/hud/warchestInkApp");

const h = React.createElement;

describe("warchest Ink components", () => {
  beforeAll(async () => {
    const inkTestingLibrary = await import("ink-testing-library");
    const inkModule = await import("ink");
    render = inkTestingLibrary.render;
    ink = inkModule;
  });

  test("ChainStatus highlights stale websocket age", () => {
    const ChainStatus = createChainStatus(ink);
    const now = Date.now();
    const chain = { slot: 10, root: 8, lastSlotAt: now - 5000 };

    const { lastFrame } = render(h(ChainStatus, { chain, now }));

    expect(lastFrame()).toContain("slot 10");
    expect(lastFrame()).toContain("WS: stale");
  });

  test("RpcLatencyBar shows recent RPC timings", () => {
    const RpcLatencyBar = createRpcLatencyBar(ink);
    const rpcStats = { lastSolMs: 11, lastTokenMs: 25, lastDataApiMs: 9 };

    const { lastFrame } = render(h(RpcLatencyBar, { rpcStats }));

    expect(lastFrame()).toContain("SOL RPC: 11ms");
    expect(lastFrame()).toContain("Tokens RPC: 25ms");
    expect(lastFrame()).toContain("Data API: 9ms");
  });

  test("WalletCard renders stable tokens with USD estimates and pagination notice", () => {
    const RecentActivityList = createRecentActivityList(ink);
    const WalletCard = createWalletCard(ink, RecentActivityList);
    const wallet = {
      alias: "Demo",
      pubkey: "ABCDEFGH1234567890",
      solBalance: 3,
      solSessionDelta: 0.5,
      tokens: [
        { mint: "stable", symbol: "USDC", balance: 12.5, usdEstimate: 12.5, sessionDelta: 0.1 },
        { mint: "other", symbol: "ABC", balance: 3.1234, usdEstimate: 1.23, sessionDelta: -0.25 },
      ],
      recentEvents: [],
    };
    const stableMints = new Set(["stable"]);

    const { lastFrame } = render(
      h(WalletCard, {
        wallet,
        stableMints,
        lastSolPriceUsd: 100,
        tokensPerPage: 1,
        tokenPage: 0,
      })
    );

    expect(lastFrame()).toContain("Stable");
    expect(lastFrame()).toContain("$12.50");
    expect(lastFrame()).toContain("Showing 1-1 of 2");
  });

  test("RecentActivityList caps the number of displayed entries", () => {
    const RecentActivityList = createRecentActivityList(ink);
    const events = [
      { timestamp: 1, summary: "First" },
      { timestamp: 2, summary: "Second" },
      { timestamp: 3, summary: "Third" },
    ];

    const { lastFrame } = render(h(RecentActivityList, { events, maxItems: 2 }));

    expect(lastFrame()).toContain("First");
    expect(lastFrame()).toContain("Second");
    expect(lastFrame()).not.toContain("Third");
  });
});
