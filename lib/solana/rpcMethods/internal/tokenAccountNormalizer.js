'use strict';

function toNumber(value, decimals = 0) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const divisor = 10 ** (Number.isFinite(decimals) ? decimals : 0);
      return divisor > 0 ? parsed / divisor : parsed;
    }
  }
  return null;
}

function normalizeTokenAmount(info) {
  if (!info) {
    return {
      uiAmount: 0,
      amountRaw: null,
      decimals: 0,
    };
  }
  const decimals = Number(info.decimals ?? 0);
  const uiAmountSource = info.uiAmount ?? info.ui_amount;
  if (uiAmountSource != null) {
    const parsed = typeof uiAmountSource === 'string'
      ? Number(uiAmountSource)
      : Number(uiAmountSource);
    if (Number.isFinite(parsed)) {
      return {
        uiAmount: parsed,
        amountRaw: typeof info.amount === 'string' ? info.amount : null,
        decimals,
      };
    }
  }
  const derived = toNumber(info.amount, decimals);
  return {
    uiAmount: Number.isFinite(derived) ? derived : 0,
    amountRaw: typeof info.amount === 'string' ? info.amount : null,
    decimals,
  };
}

function normalizeTokenAccount(owner, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accountInfo = entry.account || {};
  const data = accountInfo.data || {};
  const parsed = data?.parsed?.info || data?.parsed || {};
  const tokenAmountInfo = parsed?.tokenAmount || parsed?.token_amount || {};
  const amount = normalizeTokenAmount(tokenAmountInfo);

  return {
    pubkey: entry.pubkey || parsed?.pubkey || null,
    mint: parsed?.mint || null,
    owner: parsed?.owner || owner || null,
    uiAmount: amount.uiAmount,
    amountRaw: amount.amountRaw,
    decimals: amount.decimals,
    raw: entry,
  };
}

module.exports = {
  normalizeTokenAccount,
};
