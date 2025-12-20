"use strict";

const React = require("react");
const { getChainState } = require("../solana/rpcMethods/internal/chainState");
const { getWalletState } = require("../solana/rpcMethods/internal/walletState");
const h = React.createElement;

const COLUMN_WIDTHS = {
  symbol: 7,
  stable: 7,
  balance: 14,
  delta: 11,
  usd: 11,
  price: 14,
  change: 10,
  upnl: 12,
  rpnl: 12,
};
function formatUsdCompact(value) {
  if (value == null || Number.isNaN(value)) return "-";
  const v = Number(value);
  if (!Number.isFinite(v)) return "-";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function formatUsdPrice(value) {
  if (value == null || Number.isNaN(value)) return "-";
  const v = Number(value);
  if (!Number.isFinite(v)) return "-";

  // Keep within a narrow column; prefer fixed for normal values, exponential for ultra-tiny.
  const abs = Math.abs(v);
  if (abs > 0 && abs < 1e-7) return `$${v.toExponential(2)}`;
  if (abs < 0.01) return `$${v.toFixed(10)}`.replace(/0+$/, "").replace(/\.$/, "");
  if (abs < 1) return `$${v.toFixed(6)}`.replace(/0+$/, "").replace(/\.$/, "");
  return `$${v.toFixed(4)}`.replace(/0+$/, "").replace(/\.$/, "");
}

function pickChangeSlice(changePct) {
  if (!changePct || typeof changePct !== 'object') return null;
  const order = ["5m", "15m", "30m", "1m"];
  for (const k of order) {
    const v = changePct[k];
    const n = Number(v);
    if (Number.isFinite(n)) return { key: k, value: n };
  }
  return null;
}

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

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (value) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(seconds)}s`;
  }
  return `${seconds}s`;
}

// Formats a fixed-width HH:MM:SS timestamp for Ink, to avoid layout jitter
function formatClockTime(value) {
  if (!value) return "";
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  // Fixed-width HH:MM:SS to avoid layout jitter in Ink.
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function rpcStatusText(rpcStats) {
  const parts = [];
  if (typeof rpcStats.lastSolMs === "number") parts.push(`SOL RPC: ${rpcStats.lastSolMs}ms`);
  if (typeof rpcStats.lastTokenMs === "number") parts.push(`Tokens RPC: ${rpcStats.lastTokenMs}ms`);
  if (typeof rpcStats.lastDataApiMs === "number") parts.push(`Data API: ${rpcStats.lastDataApiMs}ms`);
  return parts.length ? parts.join("  |  ") : "RPC: (no recent calls)";
}

function serviceStatusLines(now, service) {
  const wsSupervisor = service && service.wsSupervisor ? service.wsSupervisor : null;
  if (!wsSupervisor) return [];

  const restarts = Number.isFinite(wsSupervisor.restarts) ? wsSupervisor.restarts : 0;
  const inFlight = wsSupervisor.restartInFlight === true;
  const backoffMs = Number.isFinite(wsSupervisor.backoffMs) ? wsSupervisor.backoffMs : 0;

  const lastRestartAt = Number(wsSupervisor.lastRestartAt);
  const restartAge =
    Number.isFinite(lastRestartAt) && lastRestartAt > 0 ? Math.max(0, now - lastRestartAt) : null;
  const restartAgeText = restartAge != null ? formatDurationMs(restartAge) : "n/a";

  const reason = wsSupervisor.lastRestartReason ? String(wsSupervisor.lastRestartReason) : null;

  const lastError = wsSupervisor.lastError ? String(wsSupervisor.lastError) : null;
  const lastErrorAt = Number(wsSupervisor.lastErrorAt);
  const errorAge =
    Number.isFinite(lastErrorAt) && lastErrorAt > 0 ? Math.max(0, now - lastErrorAt) : null;
  const errorAgeText = errorAge != null ? formatDurationMs(errorAge) : null;

  const line1 = `WS Restarts: ${restarts}${inFlight ? " (restarting...)" : ""}  |  Backoff: ${backoffMs}ms`;
  const line2 = `Last WS restart: ${restartAgeText}${reason ? `  |  ${reason}` : ""}`;
  const line3 =
    lastError && errorAgeText
      ? `Last WS error: ${errorAgeText} ago  |  ${lastError}`
      : lastError
        ? `Last WS error: ${lastError}`
        : null;

  const lines = [line1, line2];
  if (line3) lines.push(line3);
  return lines;
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
 * Creates a component that renders service-level WS supervisor stats.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} ServiceStatus component
 */
function createServiceStatus(ink) {
  const { Box, Text } = ink;

  return function ServiceStatus({ service, now }) {
    const lines = serviceStatusLines(now, service);
    if (!lines.length) return null;

    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, { dimColor: true }, "Service:"),
      ...lines.map((line) => h(Text, { key: line, dimColor: true }, line))
    );
  };
}

/**
 * Creates a component that renders recent service alerts (errors/reconnects).
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} AlertsPanel component
 */
function createAlertsPanel(ink) {
  const { Box, Text } = ink;

  return function AlertsPanel({ alerts, maxItems = 5 }) {
    if (!Array.isArray(alerts) || alerts.length === 0) return null;
    const items = alerts.slice(0, maxItems);

    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, null, "Alerts:"),
      ...items.map((a) => {
        const level = a && a.level ? String(a.level) : "info";
        const color = level === "error" ? "red" : level === "warn" ? "yellow" : "blue";
        const ts = a && a.ts ? new Date(Number(a.ts)).toLocaleTimeString() : "";
        const msg = a && a.message ? String(a.message) : "";
        const line = ts ? `${ts} ${msg}` : msg;
        return h(Text, { key: `${a.ts || ""}-${msg}`, color }, line);
      })
    );
  };
}

/**
 * Creates a component that renders the current session ID and runtime.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} SessionStatus component
 */
function createSessionStatus(ink) {
  const { Box, Text } = ink;

  return function SessionStatus({ session, now }) {
    if (!session || !session.sessionId) {
      return h(Text, { dimColor: true }, "Session: (inactive)");
    }

    const startedAt = Number(session.startedAt);
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null;
    const durationText = durationMs != null ? formatDurationMs(durationMs) : "n/a";

    const lastRefreshAt = Number(session.lastRefreshAt);
    const refreshAgeMs = Number.isFinite(lastRefreshAt) ? Math.max(0, now - lastRefreshAt) : null;
    const refreshText = refreshAgeMs != null ? `${refreshAgeMs}ms ago` : "n/a";

    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, `Session: ${session.sessionId} (${durationText})`),
      h(Text, { dimColor: true }, `Last refresh ${refreshText}`)
    );
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
      ...items.map((event, idx) => {
        const summary = event && event.summary ? String(event.summary) : "";
        const tsValue = event && (event.ts || event.timestamp || event.observedAt) ? (event.ts || event.timestamp || event.observedAt) : null;
        const ts = formatClockTime(tsValue);
        const line = ts ? `${ts} ${summary}` : summary;
        const stableKey = event && (event.timestamp || event.ts) ? String(event.timestamp || event.ts) : `${line}-${idx}`;
        return h(Text, { key: stableKey }, line);
      })
    );
  };
}

/**
 * Creates a component that renders recent transactions with status emoji.
 *
 * @param {{Box: Function, Text: Function}} ink ink exports from the Ink package
 * @returns {Function} TransactionsPanel component
 */
function createTransactionsPanel(ink) {
  const { Box, Text } = ink;

  return function TransactionsPanel({ transactions, maxItems = 10 }) {
    if (!Array.isArray(transactions) || transactions.length === 0) return null;
    // Render newest-first (top of list). Prefer blockTime/observedAt for ordering.
    const ordered = [...transactions].sort((a, b) => {
      const atA = a && (a.blockTimeIso || a.observedAt) ? new Date(a.blockTimeIso || a.observedAt).getTime() : 0;
      const atB = b && (b.blockTimeIso || b.observedAt) ? new Date(b.blockTimeIso || b.observedAt).getTime() : 0;
      return atB - atA;
    });
    const items = ordered.slice(0, maxItems);

    function formatClockHHMM(value) {
      if (!value) return "";
      const dt = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(dt.getTime())) return "";
      const hh = String(dt.getHours()).padStart(2, "0");
      const mm = String(dt.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    function statusEmojiFor(tx) {
      if (tx && tx.statusEmoji) return String(tx.statusEmoji);
      const cat = tx && tx.statusCategory ? String(tx.statusCategory) : "";
      if (cat === "failed") return "🔴";
      if (cat === "confirmed") return "🟢";
      return "🟡";
    }

    function formatTokenDelta(side, tokens) {
      if (!Number.isFinite(tokens)) return null;
      const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
      const abs = Math.abs(tokens);
      const sign = side === "BUY" ? "+" : side === "SELL" ? "-" : tokens >= 0 ? "+" : "-";
      return `${sign}${nf.format(abs)}`;
    }

    function formatSolAbs(sol) {
      if (!Number.isFinite(sol)) return null;
      const abs = Math.abs(sol);
      // Trim trailing zeros.
      return abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    }

    function usdPerTokenFor(tx) {
      const fromQuote = tx && tx.txSummary && tx.txSummary.quote && tx.txSummary.quote.price && tx.txSummary.quote.price.usd;
      const q = Number(fromQuote);
      if (Number.isFinite(q)) return q;
      const fromCoin = tx && tx.coin && tx.coin.priceUsd;
      const c = Number(fromCoin);
      if (Number.isFinite(c)) return c;
      return null;
    }

    return h(
      Box,
      { flexDirection: "column", marginTop: 1 },
      h(Text, null, "Transactions:"),
      ...items.map((tx, idx) => {
        const emoji = statusEmojiFor(tx);
        const side = tx && tx.side ? String(tx.side).toUpperCase() : "TX";
        const sideLabel = side === "BUY" || side === "SELL" ? side : "TX";

        const mintFull = tx && tx.mint ? String(tx.mint) : "";
        const mintShort = mintFull ? shortenPubkey(mintFull) : "";

        const sym = tx && tx.coin && (tx.coin.symbol || tx.coin.name) ? String(tx.coin.symbol || tx.coin.name) : "";
        const ident = sym || mintShort || "-";

        const tokens = tx && tx.tokens != null ? Number(tx.tokens) : NaN;
        const sol = tx && tx.sol != null ? Number(tx.sol) : NaN;

        const tokenDelta = formatTokenDelta(sideLabel, tokens);
        const solAbs = formatSolAbs(sol);

        const arrow = sideLabel === "BUY" ? "←" : sideLabel === "SELL" ? "→" : "·";

        const ts = tx && (tx.blockTimeIso || tx.observedAt);
        const hhmm = formatClockHHMM(ts);

        const usdPerToken = usdPerTokenFor(tx);
        const usdPart = usdPerToken != null ? `  (${formatUsdPrice(usdPerToken)}/token)` : "";

        const tokenPart = tokenDelta ? tokenDelta.padStart(9, " ") : "";
        const solPart = solAbs != null ? `${solAbs} SOL` : "";

        const line = `${hhmm} ${sideLabel.padEnd(4, " ")} ${ident.padEnd(4, " ")} ${tokenPart}  ${arrow} ${solPart}${usdPart}`.trimEnd();
        const stableKey = (() => {
          if (!tx) return undefined;
          if (tx.txid) return String(tx.txid);

          // txid can be missing for synthetic/failed entries; avoid collisions on common mints (e.g. SOL).
          const mintKey = tx.mint ? String(tx.mint) : "";
          const slotKey = tx.slot != null ? String(tx.slot) : "";
          const timeKey = tx.blockTimeIso || tx.observedAt ? String(tx.blockTimeIso || tx.observedAt) : "";
          const errKey = tx.errMessage ? String(tx.errMessage).slice(0, 40) : "";
          const sideKey = side ? String(side) : "";
          const explorerKey = tx.explorerUrl ? String(tx.explorerUrl) : "";

          const composite = [sideKey, mintKey, slotKey, timeKey, explorerKey, errKey]
            .filter(Boolean)
            .join("|");

          // If we only have a mint (common case: SOL) and nothing else, keys will collide.
          // In that case, fall back to a per-render unique key for the visible slice.
          if (composite && composite === mintKey) {
            return `${mintKey}|${idx}`;
          }

          return composite || undefined;
        })();

        return h(
          Text,
          { key: stableKey || `${line}-${idx}` },
          `${emoji} ${line}`
        );
      })
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

  function UsdEstimate({ usdEstimate }) {
    const text = usdEstimate == null ? "-" : `$${fmtNum(usdEstimate, 2)}`;
    return h(
      Box,
      { width: COLUMN_WIDTHS.usd, justifyContent: "flex-end" },
      h(Text, null, text)
    );
  }

  function TokenRow({ token, isStable, pnl }) {
    const delta = formatDelta(token.sessionDelta, 2);
    const balanceLabel = isStable ? `$${fmtNum(token.balance, 2)}` : fmtNum(token.balance, 2);

    const priceLabel = token && token.priceUsd != null ? formatUsdPrice(token.priceUsd) : "-";
    const change = token && token.changePct ? pickChangeSlice(token.changePct) : null;
    const fmtPctShort = (n) => {
      if (!Number.isFinite(n)) return "-";
      const abs = Math.abs(n);
      const d = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
      const text = n > 0 ? `+${n.toFixed(d)}%` : `${n.toFixed(d)}%`;
      return text;
    };
    const changeLabel = change ? `${change.key} ${fmtPctShort(change.value)}` : "-";

    const uUsd = pnl && pnl.unrealized_usd != null ? Number(pnl.unrealized_usd) : null;
    const rUsd = pnl && pnl.realized_usd != null ? Number(pnl.realized_usd) : null;

    const uLabel = uUsd != null && Number.isFinite(uUsd) ? formatUsdCompact(uUsd) : "-";
    const rLabel = rUsd != null && Number.isFinite(rUsd) ? formatUsdCompact(rUsd) : "-";

    const uColor = uUsd > 0 ? "green" : uUsd < 0 ? "red" : undefined;
    const rColor = rUsd > 0 ? "green" : rUsd < 0 ? "red" : undefined;

    return h(
      Box,
      { flexDirection: "row" },
      h(
        Box,
        { width: COLUMN_WIDTHS.symbol },
        h(Text, { color: isStable ? "green" : undefined }, (token.symbol || "").slice(0, 7))
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.stable },
        h(Text, { dimColor: true }, shortenPubkey(token.mint || "") || "-")
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
      h(UsdEstimate, { usdEstimate: token.usdEstimate }),
      h(
        Box,
        { width: COLUMN_WIDTHS.price, justifyContent: "flex-end" },
        h(Text, { dimColor: true }, priceLabel)
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.change, justifyContent: "flex-end" },
        h(Text, { dimColor: true }, changeLabel)
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.upnl, justifyContent: "flex-end" },
        h(Text, { color: uColor }, uLabel)
      ),
      h(
        Box,
        { width: COLUMN_WIDTHS.rpnl, justifyContent: "flex-end" },
        h(Text, { color: rColor }, rLabel)
      )
    );
  }

  function TokenTable({ tokens, stableMints, pnlByMint = {}, tokenPage = 0, tokensPerPage = 10 }) {
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
          { width: COLUMN_WIDTHS.stable },
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
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.price, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "Price")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.change, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "Δ (5m)")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.upnl, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "uPnL")
        ),
        h(
          Box,
          { width: COLUMN_WIDTHS.rpnl, justifyContent: "flex-end" },
          h(Text, { dimColor: true }, "rPnL")
        )
      ),
      ...page.items.map((entry) => {
        const pnl = entry && entry.token && entry.token.mint ? pnlByMint[entry.token.mint] : null;
        return h(TokenRow, { key: `${entry.token.mint}-${entry.token.symbol}`, token: entry.token, isStable: entry.isStable, pnl });
      }),
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
        h(TokenTable, { tokens: wallet.tokens, stableMints, pnlByMint: wallet.pnlByMint || {}, tokenPage, tokensPerPage })
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
  const SessionStatus = createSessionStatus(ink);
  const RpcLatencyBar = createRpcLatencyBar(ink);
  const ServiceStatus = createServiceStatus(ink);
  const AlertsPanel = createAlertsPanel(ink);
  const TransactionsPanel = createTransactionsPanel(ink);
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
    const session = hudState.session || null;
    const service = hudState.service || null;
    const alerts = service && Array.isArray(service.alerts) ? service.alerts : [];
    const transactions = Array.isArray(hudState.transactions) ? hudState.transactions : [];
    const hudMaxTx = hudState.hudMaxTx || 10;

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

      // 1) Blockchain Client status
      h(ChainStatus, { chain, now }),
      h(SessionStatus, { session, now }),
      h(RpcLatencyBar, { rpcStats }),

      // 2) Transaction logs
      h(TransactionsPanel, { transactions, maxItems: hudMaxTx }),

      // 3) Wallet windows
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

      // 4) App status (bottom)
      h(
        Text,
        null,
        `Last redraw: ${new Date(now).toLocaleTimeString()}  |  Wallets: ${aliases.length}  |  Ctrl-C to exit`
      ),
      h(ServiceStatus, { service, now }),
      h(AlertsPanel, { alerts, maxItems: 4 })
    );
  }

  return WarchestApp;
}

module.exports = {
  createWarchestApp,
  createChainStatus,
  createRpcLatencyBar,
  createServiceStatus,
  createAlertsPanel,
  createTransactionsPanel,
  createSessionStatus,
  createWalletCard,
  createRecentActivityList,
};
