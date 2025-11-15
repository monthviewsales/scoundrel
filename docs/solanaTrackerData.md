# SolanaTracker Data API helpers

Scoundrel wraps the official `@solana-tracker/data-api` SDK in `lib/solanaTrackerDataClient.js`. The client binds every helper under `lib/solanaTrackerData/methods/` to a shared retry/logger context so we get deterministic logging and `DataApiError` handling.

```js
const { SolanaTrackerDataClient } = require('../lib/solanaTrackerDataClient');

const st = new SolanaTrackerDataClient({ apiKey: process.env.SOLANATRACKER_API_KEY });
const walletTrades = await st.getWalletTrades({ wallet: 'xxxxx', limit: 250 });
const chart = await st.getWalletChart('xxxxx');
const risk = await st.getTokenRiskScores('mint...');
```

## Covered endpoints

- **Tokens**: `getTokenInformation`, `getTokenByPoolAddress`, `getTokenHoldersTop100`, `getLatestTokens`, `getMultipleTokens`, `getTrendingTokens`, `getTokensByVolumeWithTimeframe`, `getTokenOverview`, `getTokenOhlcvData`, `getTokenPoolOhlcvData`, `getTokenSnapshotAt`, `getTokenSnapshotNow`.
- **Prices**: `getTokenPrice`, `getMultipleTokenPrices`.
- **Wallets**: `getWalletTokens`, `getBasicWalletInformation`, `getWalletTrades` (cursor pagination + optional start/end filtering), `getWalletChart`, `getWalletPnl`.
- **Leaders / events**: `getTopTradersForToken`, `getTokenEvents`.
- **Utility**: `searchTokens`, `getTokenRiskScores`, `healthCheck`.

Every helper has its own JSDoc + Jest test (`__tests__/solanaTrackerData/methods/*.test.js`). If you add a method, follow the same pattern.

## Risk API

`getTokenRiskScores(mint)` calls `/risk/:mint`, retries on rate limits, and returns a normalized object:

```json
{
  "token": "mint...",
  "score": 78.4,
  "rating": "medium",
  "factors": [
    { "name": "liquidity", "score": 0.42, "severity": "high" },
    { "name": "ownership", "score": 0.12, "severity": "medium" }
  ],
  "raw": { ...original payload... }
}
```

The `factors` array is built from whatever the upstream payload includes (`factors`, `riskFactors`, or `scores`). Downstream modules can rely on `name`, `score`, and `severity` always being present (null when unknown) without parsing nested structures.

## Search API

`searchTokens(filters)` maps directly to `/search`. We accept a plain object where:

- Arrays are converted to comma-separated lists (`['pumpfun', 'raydium'] → "pumpfun,raydium"`).
- Nested objects are JSON-stringified (useful for range filters).
- Nullish/empty values are ignored so we never send empty filters.
- At least one filter is required; otherwise we throw before hitting the API.

Example:

```js
await st.searchTokens({
  query: 'dog',
  pools: ['pumpfun', 'raydium'],
  filters: { minMcap: 100_000, maxAgeMinutes: 120 }
});
```

## Operational notes

- No datastream / WebSocket usage — only HTTPS endpoints are wired up.
- Retries use exponential backoff + `Retry-After` headers (when provided).
- `healthCheck()` is a lightweight readiness probe that hits `health.ping` (when exposed) or the `getTokenInfo(So111…)` fallback.

When in doubt, inspect the helper + test pair first. They serve as living documentation for arguments, defaults, and edge cases.
