'use strict';

/**
 * @typedef {Object} MetaTargets
 * @property {string|null} wallet
 * @property {string|null} walletLabel
 * @property {string|null} traderName
 * @property {string|null} traderAlias
 * @property {string|null} mint
 * @property {string|null} developerWallet
 * @property {string|null} developerTokensWallet
 * @property {string|null} tradeUuid
 */

/**
 * @typedef {Object} MetaWindow
 * @property {number|string|null} startTime
 * @property {number|string|null} endTime
 */

/**
 * @typedef {Object} MetaBlock
 * @property {string} createdAt
 * @property {string|null} fetchedAt
 * @property {string|null} command
 * @property {string|null} mode
 * @property {string|null} runId
 * @property {string|null} scoundrelVersion
 * @property {string|null} wallet
 * @property {string|null} walletLabel
 * @property {string|null} traderName
 * @property {string|null} traderAlias
 * @property {string|null} mint
 * @property {string|null} developerWallet
 * @property {string|null} developerTokensWallet
 * @property {string|null} tradeUuid
 * @property {number|string|null} startTime
 * @property {number|string|null} endTime
 * @property {number|null} featureMintCount
 * @property {MetaTargets} targets
 * @property {MetaWindow} window
 */

/**
 * Normalize a nullable value (trim empty strings).
 * @param {any} value
 * @returns {any|null}
 */
function toNullable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return value;
}

/**
 * Build a standard meta block for AI prompt artifacts.
 *
 * @param {Object} params
 * @param {string} [params.command]
 * @param {string} [params.runId]
 * @param {string} [params.mode]
 * @param {string} [params.scoundrelVersion]
 * @param {string} [params.createdAt]
 * @param {string} [params.fetchedAt]
 * @param {string} [params.wallet]
 * @param {string} [params.walletLabel]
 * @param {string} [params.traderName]
 * @param {string} [params.traderAlias]
 * @param {string} [params.mint]
 * @param {string} [params.developerWallet]
 * @param {string} [params.developerTokensWallet]
 * @param {string} [params.tradeUuid]
 * @param {number|string} [params.startTime]
 * @param {number|string} [params.endTime]
 * @param {number} [params.featureMintCount]
 * @returns {MetaBlock}
 */
function buildMetaBlock(params = {}) {
  const createdAt = params.createdAt || new Date().toISOString();
  const wallet = toNullable(params.wallet);
  const walletLabel = toNullable(params.walletLabel);
  const traderName = toNullable(params.traderName);
  const traderAlias = toNullable(params.traderAlias);
  const mint = toNullable(params.mint);
  const developerWallet = toNullable(params.developerWallet);
  const developerTokensWallet = toNullable(params.developerTokensWallet);
  const tradeUuid = toNullable(params.tradeUuid);
  const startTime = params.startTime ?? null;
  const endTime = params.endTime ?? null;

  return {
    createdAt,
    fetchedAt: toNullable(params.fetchedAt),
    command: toNullable(params.command),
    mode: toNullable(params.mode),
    runId: toNullable(params.runId),
    scoundrelVersion: toNullable(params.scoundrelVersion),
    wallet,
    walletLabel,
    traderName,
    traderAlias,
    mint,
    developerWallet,
    developerTokensWallet,
    tradeUuid,
    startTime,
    endTime,
    featureMintCount: params.featureMintCount ?? null,
    targets: {
      wallet,
      walletLabel,
      traderName,
      traderAlias,
      mint,
      developerWallet,
      developerTokensWallet,
      tradeUuid,
    },
    window: {
      startTime,
      endTime,
    },
  };
}

/**
 * Build a compact token summary.
 *
 * @param {any} tokenInfo
 * @returns {{ mint: string|null, symbol: string|null, name: string|null, decimals: number|null, socials: Object, creation: Object }}
 */
function buildTokenSummary(tokenInfo) {
  const token = tokenInfo && typeof tokenInfo === 'object'
    ? (tokenInfo.token && typeof tokenInfo.token === 'object' ? tokenInfo.token : tokenInfo)
    : null;

  const socials = {
    twitter: token?.strictSocials?.twitter || token?.twitter || null,
    website: token?.strictSocials?.website || token?.website || null,
    telegram: token?.strictSocials?.telegram || token?.telegram || null,
    discord: token?.strictSocials?.discord || token?.discord || null,
    tiktok: token?.strictSocials?.tiktok || token?.tiktok || null,
  };

  const creation = token?.creation && typeof token.creation === 'object'
    ? {
        creator: token.creation.creator || null,
        createdTx: token.creation.created_tx || null,
        createdTime: token.creation.created_time || null,
      }
    : { creator: null, createdTx: null, createdTime: null };

  return {
    mint: toNullable(token?.mint || tokenInfo?.mint),
    symbol: toNullable(token?.symbol || tokenInfo?.symbol),
    name: toNullable(token?.name || tokenInfo?.name),
    decimals: token?.decimals ?? tokenInfo?.decimals ?? null,
    socials,
    creation,
  };
}

/**
 * Pick the pool with the highest liquidity USD.
 *
 * @param {Array} pools
 * @returns {any|null}
 */
function pickPrimaryPool(pools) {
  if (!Array.isArray(pools) || !pools.length) return null;
  let best = null;
  let bestLiquidity = -Infinity;
  for (const pool of pools) {
    const liq = pool?.liquidity?.usd ?? pool?.liquidity?.quote ?? null;
    const liqNum = Number(liq);
    const score = Number.isFinite(liqNum) ? liqNum : -Infinity;
    if (score > bestLiquidity) {
      best = pool;
      bestLiquidity = score;
    }
  }
  return best || pools[0] || null;
}

/**
 * Build a compact pool summary.
 *
 * @param {any} pool
 * @returns {Object|null}
 */
function buildPoolSummary(pool) {
  if (!pool || typeof pool !== 'object') return null;
  return {
    poolId: pool.poolId || pool.id || null,
    market: pool.market || null,
    quoteToken: pool.quoteToken || null,
    decimals: pool.decimals ?? null,
    liquidityUsd: pool?.liquidity?.usd ?? null,
    liquidityQuote: pool?.liquidity?.quote ?? null,
    priceUsd: pool?.price?.usd ?? null,
    priceQuote: pool?.price?.quote ?? null,
    marketCapUsd: pool?.marketCap?.usd ?? null,
    marketCapQuote: pool?.marketCap?.quote ?? null,
    txns: pool?.txns || null,
    lpBurn: pool?.lpBurn ?? null,
    lastUpdated: pool?.lastUpdated ?? null,
    createdAt: pool?.createdAt ?? null,
    deployer: pool?.deployer ?? null,
  };
}

/**
 * Build a compact market overview from token info.
 *
 * @param {any} tokenInfo
 * @returns {{ holders: any, txns: any, events: any, risk: any, pool: any }}
 */
function buildMarketOverview(tokenInfo) {
  const pools = tokenInfo?.pools || [];
  const primaryPool = buildPoolSummary(pickPrimaryPool(pools));
  const risks = Array.isArray(tokenInfo?.risk?.risks) ? tokenInfo.risk.risks : [];
  const riskSummary = tokenInfo?.risk
    ? {
        score: tokenInfo.risk.score ?? null,
        top10: tokenInfo.risk.top10 ?? null,
        rugged: tokenInfo.risk.rugged ?? null,
        riskCount: risks.length,
        topRisks: risks.slice(0, 5).map((risk) => ({
          name: risk?.name || null,
          level: risk?.level || null,
          score: risk?.score ?? null,
        })),
      }
    : null;

  return {
    holders: tokenInfo?.holders ?? null,
    txns: tokenInfo?.txns ?? null,
    events: tokenInfo?.events ?? null,
    risk: riskSummary,
    pool: primaryPool,
  };
}

/**
 * Build a compact token snapshot summary.
 *
 * @param {any} snapshot
 * @returns {Object|null}
 */
function buildTokenSnapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const pools = snapshot.pools || snapshot?.token?.pools || snapshot?.raw?.info?.pools || [];
  const primaryPool = buildPoolSummary(pickPrimaryPool(pools));
  return {
    priceAt: snapshot.priceAt || null,
    pool: primaryPool,
  };
}

/**
 * @typedef {Object} CampaignContext
 * @property {{ label: string|null, address: string|null }} wallet
 * @property {{ mint: string|null, symbol: string|null, name: string|null, decimals: number|null, tokenInfo: any, socials?: any, creation?: any }} token
 * @property {Array} trades
 * @property {{ startTimestamp: number|string|null, endTimestamp: number|string|null }} window
 * @property {Object|null} metrics
 * @property {{ priceRange: any, tokenPnL: any, athPrice: any, ochlvWindow: any, overview?: any }} marketContext
 * @property {{ walletStats: any, regimeEvents: Array }} context
 * @property {string|null} tradeUuid
 */

/**
 * Build a standard campaign context for wallet+mint analysis payloads.
 *
 * @param {Object} params
 * @param {string} [params.walletLabel]
 * @param {string} [params.walletAddress]
 * @param {string} [params.mint]
 * @param {Object} [params.tokenInfo]
 * @param {Object} [params.tokenSummary]
 * @param {boolean} [params.includeTokenInfo]
 * @param {Array} [params.trades]
 * @param {number|string} [params.startTimestamp]
 * @param {number|string} [params.endTimestamp]
 * @param {Object} [params.metrics]
 * @param {any} [params.priceRange]
 * @param {any} [params.tokenPnL]
 * @param {any} [params.athPrice]
 * @param {any} [params.ochlvWindow]
 * @param {any} [params.marketOverview]
 * @param {any} [params.walletStats]
 * @param {Array} [params.regimeEvents]
 * @param {string} [params.tradeUuid]
 * @returns {CampaignContext}
 */
function buildCampaignContext(params = {}) {
  const tokenInfo = params.tokenInfo || null;
  const tokenSummary = params.tokenSummary || tokenInfo;
  const includeTokenInfo = params.includeTokenInfo !== false;
  const trades = Array.isArray(params.trades) ? params.trades : (params.trades ? [params.trades] : []);
  const regimeEvents = Array.isArray(params.regimeEvents) ? params.regimeEvents : (params.regimeEvents ? [params.regimeEvents] : []);

  return {
    wallet: {
      label: toNullable(params.walletLabel),
      address: toNullable(params.walletAddress),
    },
    token: {
      mint: toNullable(params.mint),
      symbol: tokenSummary ? tokenSummary.symbol : null,
      name: tokenSummary ? tokenSummary.name : null,
      decimals: tokenSummary ? tokenSummary.decimals : null,
      socials: tokenSummary?.socials || null,
      creation: tokenSummary?.creation || null,
      tokenInfo: includeTokenInfo ? tokenInfo : null,
    },
    trades,
    window: {
      startTimestamp: params.startTimestamp ?? null,
      endTimestamp: params.endTimestamp ?? null,
    },
    metrics: params.metrics || null,
    marketContext: {
      priceRange: params.priceRange || null,
      tokenPnL: params.tokenPnL || null,
      athPrice: params.athPrice || null,
      ochlvWindow: params.ochlvWindow || null,
      overview: params.marketOverview || null,
    },
    context: {
      walletStats: params.walletStats || null,
      regimeEvents,
    },
    tradeUuid: toNullable(params.tradeUuid),
  };
}

/**
 * Build per-mint campaigns for wallet dossier payloads.
 *
 * @param {Object} params
 * @param {string} [params.walletLabel]
 * @param {string} [params.walletAddress]
 * @param {Object} [params.mintTradesByMint]
 * @param {Array} [params.coinStats]
 * @param {Object} [params.tokenMetaByMint]
 * @returns {CampaignContext[]}
 */
function buildMintCampaigns(params = {}) {
  const walletLabel = params.walletLabel;
  const walletAddress = params.walletAddress;
  const tradesByMint = params.mintTradesByMint && typeof params.mintTradesByMint === 'object'
    ? params.mintTradesByMint
    : {};
  const statsList = Array.isArray(params.coinStats) ? params.coinStats : [];
  const statsByMint = new Map(statsList.map((row) => [row?.mint, row]));
  const tokenMetaByMint = params.tokenMetaByMint && typeof params.tokenMetaByMint === 'object'
    ? params.tokenMetaByMint
    : {};

  const mintSet = new Set([
    ...Object.keys(tradesByMint || {}),
    ...statsList.map((row) => row?.mint).filter(Boolean),
  ]);

  const campaigns = [];
  for (const mint of mintSet) {
    if (!mint) continue;
    const stats = statsByMint.get(mint) || null;
    const trades = Array.isArray(tradesByMint[mint]) ? tradesByMint[mint] : [];
    const meta = tokenMetaByMint[mint] || {};
    const tokenSummary = {
      mint,
      symbol: meta.symbol || stats?.symbol || null,
      name: meta.name || stats?.name || null,
      decimals: meta.decimals ?? null,
      socials: null,
      creation: null,
    };

    let startTimestamp = stats?.startTs ?? null;
    let endTimestamp = stats?.endTs ?? null;
    if ((startTimestamp == null || endTimestamp == null) && trades.length) {
      const tradeTimes = trades
        .map((t) => t?.time ?? t?.timestamp ?? t?.executed_at ?? null)
        .filter((t) => t != null)
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t));
      if (tradeTimes.length) {
        if (startTimestamp == null) startTimestamp = Math.min(...tradeTimes);
        if (endTimestamp == null) endTimestamp = Math.max(...tradeTimes);
      }
    }

    campaigns.push(buildCampaignContext({
      walletLabel,
      walletAddress,
      mint,
      tokenSummary,
      includeTokenInfo: false,
      trades,
      startTimestamp,
      endTimestamp,
      metrics: stats,
    }));
  }

  return campaigns;
}

/**
 * Build a final payload that appends the AI response below the prompt payload.
 *
 * @param {Object} params
 * @param {any} params.prompt
 * @param {any} params.response
 * @returns {Object}
 */
function buildFinalPayload({ prompt, response }) {
  const base = prompt && typeof prompt === 'object' && !Array.isArray(prompt)
    ? { ...prompt }
    : { prompt };
  return {
    ...base,
    response: response === undefined ? null : response,
  };
}

/**
 * Recursively prune null/undefined values and drop empty objects/arrays.
 * @param {any} value
 * @returns {any|undefined}
 */
function pruneNullish(value) {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const items = value
      .map((item) => pruneNullish(item))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }

  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const pruned = pruneNullish(item);
      if (pruned !== undefined) {
        next[key] = pruned;
      }
    }
    return Object.keys(next).length ? next : undefined;
  }

  return value;
}

/**
 * Prune empty/nullish fields from payloads before persistence.
 * @param {any} payload
 * @returns {any}
 */
function pruneNullishPayload(payload) {
  const pruned = pruneNullish(payload);
  return pruned === undefined ? {} : pruned;
}

module.exports = {
  buildMetaBlock,
  buildCampaignContext,
  buildMintCampaigns,
  buildTokenSummary,
  buildMarketOverview,
  buildTokenSnapshotSummary,
  buildFinalPayload,
  pruneNullishPayload,
};
