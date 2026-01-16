'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMintCampaigns,
  pruneNullishPayload,
} = require('../lib/analysis/payloadBuilders');
const {
  isBase58Mint,
  isStableMint,
  isSolToStableSwap,
  pickNonSolMint,
} = require('../lib/analysis/tradeMints');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function get(obj, p) {
  return p.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function extractMintFromTrade(trade) {
  const fromAddr = get(trade, 'from.address');
  const toAddr = get(trade, 'to.address');
  if (fromAddr || toAddr) {
    const chosen = pickNonSolMint(fromAddr, toAddr);
    if (chosen && typeof chosen === 'string' && chosen.length > 20) return chosen;
  }

  const candidates = [
    trade.mint,
    trade.mintAddress,
    trade.tokenMint,
    trade.token_mint_address,
    trade.tokenAddress,
    trade.baseTokenAddress,
    trade.address,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.length > 20) return c;

  const nested = [
    get(trade, 'token.mint'),
    get(trade, 'token.address'),
    get(trade, 'base.mint'),
    get(trade, 'quote.mint'),
    get(trade, 'pool.mint'),
  ];
  for (const c of nested) if (typeof c === 'string' && c.length > 20) return c;

  const baseMint = get(trade, 'base.mint') || get(trade, 'baseTokenAddress') || get(trade, 'baseMint');
  const quoteMint = get(trade, 'quote.mint') || get(trade, 'quoteTokenAddress') || get(trade, 'quoteMint');
  const chosen = pickNonSolMint(baseMint, quoteMint);
  if (chosen && typeof chosen === 'string' && chosen.length > 20) return chosen;

  if (trade && typeof trade.mint === 'string' && trade.mint.toLowerCase() === 'mint') return null;

  return null;
}

function buildTokenMetaByMint(trades) {
  const out = {};
  if (!Array.isArray(trades)) return out;

  for (const trade of trades) {
    if (isSolToStableSwap(trade)) continue;
    const mint = extractMintFromTrade(trade);
    if (!mint) continue;
    if (!isBase58Mint(mint)) continue;
    if (isStableMint(mint)) continue;

    const from = trade && trade.from;
    const to = trade && trade.to;
    const token =
      (from && from.address === mint ? from.token : null) ||
      (to && to.address === mint ? to.token : null) ||
      null;

    if (!token || typeof token !== 'object') continue;
    const existing = out[mint] || {};
    out[mint] = {
      symbol: existing.symbol || token.symbol || null,
      name: existing.name || token.name || null,
      decimals: existing.decimals ?? token.decimals ?? null,
    };
  }

  return out;
}

function buildMintTradesByMint(rawDir, entries) {
  const mintTradesByMint = {};
  for (const entry of entries) {
    if (!entry || !entry.mint || !entry.file) continue;
    const data = readJson(path.join(rawDir, entry.file.replace(/^raw[\\/]/, '')));
    const trades = Array.isArray(data?.trades)
      ? data.trades
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
    mintTradesByMint[entry.mint] = trades.slice(0, 50);
  }
  return mintTradesByMint;
}

describe('payload builders (dossier)', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'payload-builders', 'dossier');
  const rawDir = path.join(fixtureDir, 'raw');
  const expected = readJson(path.join(fixtureDir, 'expected-prompt.json'));
  const manifest = readJson(path.join(fixtureDir, 'manifest.json'));

  it('builds per-mint campaigns that match the expected prompt output', () => {
    const trades = readJson(path.join(rawDir, manifest.tradesFile.replace(/^raw[\\/]/, '')));
    const tokenMetaByMint = buildTokenMetaByMint(trades);

    const mintTradesByMint = buildMintTradesByMint(rawDir, manifest.mintTrades);
    const campaigns = buildMintCampaigns({
      walletLabel: expected.meta.traderName || expected.meta.traderAlias,
      walletAddress: expected.meta.wallet,
      mintTradesByMint,
      coinStats: expected.coins,
      tokenMetaByMint,
    });

    const pruned = pruneNullishPayload({ campaigns }).campaigns || [];
    const builtByMint = new Map(pruned.map((c) => [c?.token?.mint, c]));

    expect(pruned.length).toBe(expected.campaigns.length);
    for (const expectedCampaign of expected.campaigns) {
      const mint = expectedCampaign?.token?.mint;
      expect(builtByMint.has(mint)).toBe(true);
      expect(builtByMint.get(mint)).toEqual(expectedCampaign);
    }
  });
});
