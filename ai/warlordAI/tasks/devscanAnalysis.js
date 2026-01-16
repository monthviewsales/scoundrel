"use strict";

const devscanMintSchema = require("../../schemas/devscan.mint.v1.schema.json");
const devscanDeveloperSchema = require("../../schemas/devscan.developer.v1.schema.json");
const { isBase58Mint } = require("../../../lib/analysis/tradeMints");

const SYSTEM = [
  'You receive a JSON object named "payload" containing DevScan API responses plus a "context" object with hints.',
  "Use ONLY the provided payload/context. Do not invent data.",
  "Voice: degen, crisp, operator-facing. Similar to dossier: short punchy sentences, clear headings.",
  "If data is missing, say it plainly and set JSON fields to null/empty as required.",
  "Solana mint pattern: base58 32–44 chars (no 0, O, I, l). Use this to detect mint addresses.",
  "You have access to the x_search tool for X (Twitter) search. Use it when asked for X signals.",
  "Mint mode: when payload.meta.mint or payload.token is present, analyze the mint and return x_mentions counts for last 60m, 30m, 5m.",
  "Developer mode: analyze dev + token history and scan X handles; list mints they are tweeting about (only alive mints).",
  "If x_search cannot provide time-windowed counts, set counts to null and explain in notes.",
  "DevScan developer rating is a raw 0–100 score (not a percentage). A value like 0.991 is sub-1/100, NOT 99%.",
  "Return Markdown + the required JSON fields per schema. Do NOT print JSON inside markdown.",
].join(" ");

function extractHandlesFromValue(value) {
  if (!value) return [];
  const text = String(value);
  const match = text.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
  return match && match[1] ? [match[1]] : [];
}

function extractXHandles(payload) {
  const handles = new Set();
  const devTwitter = payload?.developer?.data?.developer?.social?.twitter;
  const devTwArray = Array.isArray(devTwitter)
    ? devTwitter
    : devTwitter
    ? [devTwitter]
    : [];
  devTwArray.forEach((val) =>
    extractHandlesFromValue(val).forEach((h) => handles.add(h))
  );

  const tokenTwitter = payload?.token?.data?.socials?.twitter;
  extractHandlesFromValue(tokenTwitter).forEach((h) => handles.add(h));

  const devInfoTwitter = payload?.token?.data?.developerInfo?.social?.twitter;
  extractHandlesFromValue(devInfoTwitter).forEach((h) => handles.add(h));

  return Array.from(handles);
}

function extractMintCandidates(payload) {
  const mints = new Set();
  const metaMint = payload?.meta?.mint;
  if (metaMint && isBase58Mint(metaMint)) mints.add(metaMint);

  const tokenMint = payload?.token?.data?.mintAddress;
  if (tokenMint && isBase58Mint(tokenMint)) mints.add(tokenMint);

  const devTokens = payload?.developerTokens?.data?.tokens;
  if (Array.isArray(devTokens)) {
    devTokens.forEach((t) => {
      if (t && isBase58Mint(t.mintAddress)) mints.add(t.mintAddress);
    });
  }

  const devTokensAlt = payload?.developer?.data?.tokens;
  if (Array.isArray(devTokensAlt)) {
    devTokensAlt.forEach((t) => {
      const status =
        typeof t?.status === "string" ? t.status.toLowerCase() : null;
      if (status && status !== "alive") return;
      if (t && isBase58Mint(t.mintAddress)) mints.add(t.mintAddress);
    });
  }

  return Array.from(mints).slice(0, 25);
}

/**
 * Resolve the DevScan schema/config for the payload shape.
 * @param {{ payload?: Object }} params
 * @returns {{ schema: Object, name: string, version: string }}
 */
function resolve({ payload }) {
  const hasMint = Boolean(
    payload?.meta?.mint || payload?.token?.data?.mintAddress
  );
  return hasMint
    ? {
        schema: devscanMintSchema,
        name: "devscan_mint_v1",
        version: "devscan.mint.v1",
      }
    : {
        schema: devscanDeveloperSchema,
        name: "devscan_developer_v1",
        version: "devscan.developer.v1",
      };
}

/**
 * Build the user payload for DevScan analysis.
 * @param {{ payload: Object, purpose?: string }} params
 * @returns {{ payload: Object, context: Object, purpose: string }}
 */
function buildUser(params) {
  const payload = params?.payload;
  return {
    payload,
    context: {
      knownMints: extractMintCandidates(payload),
      xHandles: extractXHandles(payload),
    },
    purpose:
      params?.purpose ||
      "Summarize the DevScan data for quick operator review.",
  };
}

module.exports = {
  resolve,
  buildUser,
  system: SYSTEM,
  provider: "grok",
  temperature: 0.3,
  tools: [{ type: "x_search" }],
  tool_choice: "auto",
};
