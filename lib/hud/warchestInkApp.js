"use strict";

const React = require("react");
const { getChainState } = require("../solana/rpcMethods/internal/chainState");
const { getWalletState } = require("../solana/rpcMethods/internal/walletState");
const h = React.createElement;

const COLUMN_WIDTHS = {
  symbol: 7,
  mint: 17,
  stable: 9,
  balance: 14,
  delta: 14,
  usd: 12,
};

function colorizer(color) {
  if (!color) return undefined;
  switch (color) {
    case "green":
    case "cyan":
    case "magenta":
    case "yellow":
    case "blue":
    case "red":
      return color;
    default:
      return undefined;
  }
}

function shortenPubkey(pubkey) {
  if (!pubkey || pubkey.length <= 8) return pubkey || "";
  return `${pubkey.slice(0, 3)}...${pubkey.slice(-5)}`;
}

function fmtNum(value, decimals = 3) {
  if (value == null || Number.isNaN(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDelta(value, decimals) {
  if (value == null || Number.isNaN(value)) return { text: "-", color: undefined };
  const rounded = fmtNum(value, decimals);
  if (value > 0) return { text: `+${rounded}`, color: "green" };
  if (value < 0) return { text: rounded, color: "red" };
  return { text: rounded, color: undefined };
}

function rpcStatusText(rpcStats) {
  const parts = [];
  if (typeof rpcStats.lastSolMs === "number") parts.push(`SOL RPC: ${rpcStats.lastSolMs}ms`);
  if (typeof rpcStats.lastTokenMs === "number") parts.push(`Tokens RPC: ${rpcStats.lastTokenMs}ms`);
  if (typeof rpcStats.lastDataApiMs === "number") parts.push(`Data API: ${rpcStats.lastDataApiMs}ms`);
  return parts.length ? parts.join("  |  ") : "RPC: (no recent calls)";
}

function chainStatusText(now, chain) {
  if (!chain || chain.slot == null)
    return { chainLine: "Chain: slot N/A (WS idle)", wsStatus: "WS: idle", wsColor: "yellow" };

  const ageMs = chain.lastSlotAt ? now - chain.lastSlotAt : null;
  const ageStr = ageMs != null ? `${Math.round(ageMs)}ms ago` : "just now";
  const rootStr = chain.root != null ? `root ${chain.root}` : "root N/A";
  const chainLine = `Chain: slot ${chain.slot} (${rootStr}), last update ${ageStr}`;

  const wsStatus = (() => {
    if (!chain || chain.slot == null || !chain.lastSlotAt) return "WS: idle";
    const elapsed = now - chain.lastSlotAt;
    if (elapsed < 2000) return `WS: OK (${elapsed}ms)`;
    if (elapsed < 10000) return `WS: stale (${elapsed}ms)`;
    return `WS: lagging (${elapsed}ms)`;
  })();

  const wsColor = (() => {
    if (!chain || chain.slot == null || !chain.lastSlotAt) return "yellow";
    const elapsed = now - chain.lastSlotAt;
    if (elapsed < 2000) return "green";
    if (elapsed < 10000) return "yellow";
    return "red";
  })();

  return { chainLine, wsStatus, wsColor };
}

function paginateTokens(tokens, tokenPage, tokensPerPage) {
  if (!tokens || tokens.length === 0)
    return { items: [], start: 0, end: 0, total: 0, hasMore: false };

  const pageIndex = Math.max(0, Number.isFinite(tokenPage) ? tokenPage : 0);
  const size = Math.max(1, tokensPerPage || tokens.length);
  const start = pageIndex * size;
  const end = Math.min(tokens.length, start + size);

  return {
    items: tokens.slice(start, end),
    start: start + 1,
    end,
    total: tokens.length,
    hasMore: end < tokens.length,
  };
}

/**
 * Creates a component that renders chain/WS status with staleness highlighting.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} ChainStatus component
 */
function createChainStatus(ink) {
  const { Box, Text } = ink;

  return function ChainStatus({ chain, now }) {
    const { chainLine, wsStatus, wsColor } = chainStatusText(now, chain);

    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, chainLine),
      h(Text, null, h(Text, { color: wsColor }, wsStatus))
    );
  };
}

/**
 * Creates a component that renders recent RPC latency information.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} RpcLatencyBar component
 */
function createRpcLatencyBar(ink) {
  const { Box, Text } = ink;

  return function RpcLatencyBar({ rpcStats }) {
    return h(Box, { flexDirection: "row" }, h(Text, null, rpcStatusText(rpcStats)));
  };
}

/**
 * Creates a component that renders recent wallet activity summaries.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} RecentActivityList component
 */
function createRecentActivityList(ink) {
  const { Box, Text } = ink;

  return function RecentActivityList({ events, maxItems = 5 }) {
    if (!events || events.length === 0) return null;

    const items = events.slice(0, maxItems);
    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, null, "Recent activity:"),
      ...items.map((event) =>
        h(Text, { key: event.timestamp || event.summary }, event.summary || "")
      )
    );
  };
}

/**
 * Creates a component that renders wallet balances, tokens, and activity.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @param {Function} RecentActivityList component factory output for recent events
 * @returns {Function} WalletCard component
 */
function createWalletCard(ink, RecentActivityList) {
  const { Box, Text } = ink;

  function StableIndicator({ isStable }) {
    if (!isStable) return h(Box, { width: COLUMN_WIDTHS.stable }, h(Text, { dimColor: true }, "-"));
    return h(
      Box,
      { width: COLUMN_WIDTHS.stable },
      h(Text, { color: "green" }, "Stable")
    );
  }

  function UsdEstimate({ usdEstimate, isStable }) {
    const text = usdEstimate == null ? "-" : `$${fmtNum(usdEstimate, 2)}`;
    return h(
      Box,
      { width: COLUMN_WIDTHS.usd, justifyContent: "flex-end" },
      h(Text, { color: isStable ? "green" : undefined }, text)
    );
  }

  function TokenRow({ token, isStable }) {
    const delta = formatDelta(token.sessionDelta, 2);
    const balanceLabel = isStable ? `$${fmtNum(token.balance, 2)}` : fmtNum(token.balance, 2);

    return h(
      Box,
      { flexDirection: "row" },
      h(
        Box,
        { width: COLUMN_WIDTHS.symbol },
        h(Text, { color: isStable ? "green" : undefined }, (token.symbol || "").slice(0, 6))
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.mint },
        h(Text, { color: isStable ? "green" : undefined }, shortenPubkey(token.mint || "").slice(0, 15))
      ),
      h(StableIndicator, { isStable }),
      h(
        Box,
        { width: COLUMN_WIDTHS.balance, justifyContent: "flex-end" },
        h(Text, { color: isStable ? "green" : undefined }, balanceLabel)
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.delta, justifyContent: "flex-end" },
        h(Text, { color: delta.color }, delta.text)
      ),
      h(UsdEstimate, { usdEstimate: token.usdEstimate, isStable })
    );
  }

  function TokenTable({ tokens, stableMints, tokenPage = 0, tokensPerPage = 10 }) {
    if (!tokens || tokens.length === 0) {
      return h(Text, null, "(no tokens yet)");
    }

    const stableSet = stableMints || new Set();
    const annotatedTokens = tokens.map((token) => ({
      token,
      isStable: Boolean(token.mint && stableSet.has(token.mint)),
    }));

    const orderedTokens = [
      ...annotatedTokens.filter((item) => item.isStable),
      ...annotatedTokens.filter((item) => !item.isStable),
    ];

    const page = paginateTokens(orderedTokens, tokenPage, tokenPerPageForDisplay(tokensPerPage, orderedTokens.length));

    return h(
      Box,
      { flexDirection: "column" },
      h(
        Box,
        { flexDirection: "row" },
        h(
          Box,
          { width: COLUMN_WIDTHS.symbol },
          h(Text, { dimColor: true }, "Sym")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.mint },
          h(Text, { dimColor: true }, "Mint")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.stable },
          h(Text, { dimColor: true }, "Type")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.balance, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "Balance")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.delta, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "Δ Session")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.usd, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "Est. USD")
        )
      ),
      ...page.items.map((entry) =>
        h(TokenRow, { key: `${entry.token.mint}-${entry.token.symbol}`, token: entry.token, isStable: entry.isStable })
      ),
      page.hasMore
        ? h(
            Text,
            { dimColor: true, marginTop: 1 },
            `Showing ${page.start}-${page.end} of ${page.total}`
          )
        : null
    );
  }

  function tokenPerPageForDisplay(requested, total) {
    if (!requested || !Number.isFinite(requested) || requested <= 0) return Math.min(10, total);
    return requested;
  }

  return function WalletCard({ wallet, stableMints, lastSolPriceUsd, tokenPage = 0, tokensPerPage = 10 }) {
    const aliasColor = colorizer(wallet.color);
    const shortPk = shortenPubkey(wallet.pubkey);

    let effectiveSolBalance = wallet.solBalance;
    const wsWallet = getWalletState(wallet.pubkey);
    if (wsWallet && typeof wsWallet.solLamports === "number" && Number.isFinite(wsWallet.solLamports)) {
      effectiveSolBalance = wsWallet.solLamports / 1_000_000_000;
    }

    let sessionDelta = wallet.solSessionDelta;
    if (wallet.startSolBalance != null && effectiveSolBalance != null && Number.isFinite(effectiveSolBalance)) {
      sessionDelta = effectiveSolBalance - wallet.startSolBalance;
    }

    const solDelta = formatDelta(sessionDelta, 3);
    const solPriceText =
      typeof lastSolPriceUsd === "number" && Number.isFinite(lastSolPriceUsd)
        ? ` @ $${fmtNum(lastSolPriceUsd, 2)}`
        : "";

    return h(
      Box,
      { flexDirection: "column", borderStyle: "round", paddingX: 1, paddingY: 0 },
      h(
        Text,
        null,
        h(Text, { color: aliasColor }, wallet.alias),
        ` (${shortPk})   SOL: ${fmtNum(effectiveSolBalance, 3)}`,
        sessionDelta !== 0 ? h(Text, { color: solDelta.color }, ` (${solDelta.text})`) : null,
        solPriceText
      ),
      h(
        Box,
        { marginTop: 1, flexDirection: "column" },
        h(TokenTable, { tokens: wallet.tokens, stableMints, tokenPage, tokensPerPage })
      ),
      h(RecentActivityList, { events: wallet.recentEvents })
    );
  };
}

/**
 * Factory that binds Ink components to the HUD React tree.
 *
 * @param {{Box: Function, Text: Function, Newline?: Function}} ink ink exports from the Ink package
 * @returns {Function} ready-to-render Warchest React component
 */
function createWarchestApp(ink) {
  if (!ink || typeof ink !== "object") {
    throw new Error("createWarchestApp requires the Ink module exports");
  }

  const { Box, Text } = ink;
  const Newline = ink.Newline || (() => null);
  const ChainStatus = createChainStatus(ink);
  const RpcLatencyBar = createRpcLatencyBar(ink);
  const RecentActivityList = createRecentActivityList(ink);
  const WalletCard = createWalletCard(ink, RecentActivityList);

  /**
   * Ink-powered HUD for warchest wallet state.
 *
 * @param {{
 *   hudStore: { getSnapshot: Function, subscribe: Function },
 *   stableMints: Set<string>,
 *   tokenPage?: number,
 *   tokensPerPage?: number,
 * }} props
 * @returns {React.ReactElement}
 */
  function WarchestApp({ hudStore, stableMints, tokenPage = 0, tokensPerPage = 10 }) {
    const [hudState, setHudState] = React.useState(() =>
      hudStore && typeof hudStore.getSnapshot === "function"
        ? hudStore.getSnapshot()
        : { state: {}, lastSolPriceUsd: null, rpcStats: {} }
    );

    React.useEffect(() => {
      if (!hudStore || typeof hudStore.subscribe !== "function") return undefined;

      const unsubscribe = hudStore.subscribe((next) => {
        setHudState(next);
      });

      return unsubscribe;
    }, [hudStore]);

    const state = hudState.state || {};
    const lastSolPriceUsd = hudState.lastSolPriceUsd ?? null;
    const rpcStats = hudState.rpcStats || {};

    const aliases = Object.keys(state).sort();
    const now = Date.now();
    const chain = getChainState();
    const stableSet = stableMints || new Set();

    if (aliases.length === 0) {
      return h(Text, null, "No wallets configured for HUD worker.");
    }

    return h(
      Box,
      { flexDirection: "column" },
      h(ChainStatus, { chain, now }),
      h(RpcLatencyBar, { rpcStats }),
      h(Newline, null),
      ...aliases.map((alias) =>
        h(
          Box,
          { key: alias, marginBottom: 1 },
          h(WalletCard, {
            wallet: state[alias],
            stableMints: stableSet,
            lastSolPriceUsd,
            tokenPage,
            tokensPerPage,
          })
        )
      ),
      h(
        Text,
        null,
        `Last redraw: ${new Date(now).toLocaleTimeString()}  |  Wallets: ${aliases.length}  |  Ctrl-C to exit`
      )
    );
  }

  return WarchestApp;
}

module.exports = {
  createWarchestApp,
  createChainStatus,
  createRpcLatencyBar,
  createWalletCard,
  createRecentActivityList,
};
