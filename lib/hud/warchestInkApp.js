"use strict";

const React = require("react");
const { getChainState } = require("../solana/rpcMethods/internal/chainState");
const { getWalletState } = require("../solana/rpcMethods/internal/walletState");
const h = React.createElement;

const COLUMN_WIDTHS = {
  symbol: 7,
  mint: 17,
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
  if (!chain || chain.slot == null) return { chainLine: "Chain: slot N/A (WS idle)", wsStatus: "WS: idle" };

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

  return { chainLine, wsStatus };
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

  function TokenRow({ token, isStable }) {
    const usdText =
      token.usdEstimate == null ? "-" : `$${fmtNum(token.usdEstimate, 2)}`;
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
      h(
        Box,
        { width: COLUMN_WIDTHS.usd, justifyContent: "flex-end" },
        h(Text, null, usdText)
      )
    );
  }

  function TokenTable({ tokens, stableMints }) {
    if (!tokens || tokens.length === 0) {
      return h(Text, null, "(no tokens yet)");
    }

    const stableSet = stableMints || new Set();
    const stableTokens = [];
    const otherTokens = [];

    for (const token of tokens) {
      if (token.mint && stableSet.has(token.mint)) {
        stableTokens.push(token);
      } else {
        otherTokens.push(token);
      }
    }

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
      stableTokens.length > 0
        ? h(
            Box,
            {
              flexDirection: "column",
              marginTop: 1,
              marginBottom: otherTokens.length ? 1 : 0,
            },
            h(Text, { color: "green" }, "Stablecoins"),
            ...stableTokens.map((token) =>
              h(TokenRow, {
                key: `${token.mint}-${token.symbol}`,
                token,
                isStable: true,
              })
            )
          )
        : null,
      otherTokens.length > 0
        ? h(
            Box,
            { flexDirection: "column" },
            stableTokens.length > 0
              ? h(
                  Text,
                  { dimColor: true },
                  "─".repeat(
                    COLUMN_WIDTHS.symbol +
                      COLUMN_WIDTHS.mint +
                      COLUMN_WIDTHS.balance +
                      COLUMN_WIDTHS.delta +
                      COLUMN_WIDTHS.usd
                  )
                )
              : null,
            ...otherTokens.map((token) =>
              h(TokenRow, {
                key: `${token.mint}-${token.symbol}`,
                token,
                isStable: false,
              })
            )
          )
        : null
    );
  }

  function RecentActivity({ events }) {
    if (!events || events.length === 0) return null;

    const maxEvents = Math.min(events.length, 5);
    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, null, "Recent activity:"),
      ...events.slice(0, maxEvents).map((event) =>
        h(Text, { key: event.timestamp || event.summary }, event.summary || "")
      )
    );
  }

  function WalletCard({ wallet, stableMints, lastSolPriceUsd }) {
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
        h(TokenTable, { tokens: wallet.tokens, stableMints })
      ),
      h(RecentActivity, { events: wallet.recentEvents })
    );
  }

  /**
   * Ink-powered HUD for warchest wallet state.
   *
   * @param {{
   *   state: Record<string, import("../warchest/client").WalletState>,
   *   lastSolPriceUsd: number|null,
   *   rpcStats: {lastSolMs: number|null, lastTokenMs: number|null, lastDataApiMs: number|null},
   *   stableMints: Set<string>
   * }} props
   * @returns {React.ReactElement}
   */
  function WarchestApp({ state, lastSolPriceUsd, rpcStats, stableMints }) {
    const aliases = Object.keys(state || {}).sort();
    const now = Date.now();
    const chain = getChainState();
    const { chainLine, wsStatus } = chainStatusText(now, chain);
    const stableSet = stableMints || new Set();

    if (aliases.length === 0) {
      return h(Text, null, "No wallets configured for HUD worker.");
    }

    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, chainLine),
      h(Text, null, `${wsStatus}  |  ${rpcStatusText(rpcStats)}`),
      h(Newline, null),
      ...aliases.map((alias) =>
        h(
          Box,
          { key: alias, marginBottom: 1 },
          h(WalletCard, {
            wallet: state[alias],
            stableMints: stableSet,
            lastSolPriceUsd,
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

module.exports = { createWarchestApp };
