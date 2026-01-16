"use strict";

const baseLogger = require("../../logger");
const {
  createSolanaTrackerDataClient,
} = require("../../solanaTrackerDataClient");
const { runPositionHealing } = require("../../services/positionHealingService");
const { resolveWalletSpecsWithRegistry } = require("../../wallets/resolver");
const { createWorkerHarness } = require("./harness");
const { createWorkerLogger } = require("./workerLogger");

let BootyBox = {};
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  BootyBox = require("../../../db");
} catch (err) {
  BootyBox = {};
}

const logger = createWorkerLogger({
  workerName: "positionHealing",
  scope: "positionHealing",
  baseLogger,
  includeCallsite: true,
});

async function ensureBootyBoxReady() {
  if (!BootyBox || typeof BootyBox.init !== "function") {
    throw new Error("BootyBox client unavailable; cannot heal positions.");
  }
  await BootyBox.init();
  return BootyBox;
}

function parseWalletSpecs(raw) {
  if (!Array.isArray(raw)) return [];
  const specs = [];

  for (const entry of raw) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const [alias, pubkey, color] = entry.split(":");
      if (!alias || !pubkey) continue;
      specs.push({ alias, pubkey, color: color || null });
      continue;
    }

    if (typeof entry === "object") {
      const alias = entry.alias || entry.walletAlias || entry.name || null;
      const pubkey = entry.pubkey || entry.wallet || entry.address || null;
      if (!alias || !pubkey) continue;
      specs.push({ alias, pubkey, color: entry.color || null });
    }
  }

  return specs;
}

async function resolveWallets(payload, bootyBox) {
  if (Array.isArray(payload?.wallets) && payload.wallets.length > 0) {
    const resolved = payload.wallets.filter(
      (wallet) => wallet && wallet.walletId != null && wallet.pubkey
    );
    if (resolved.length > 0) return resolved;
  }

  const specs = parseWalletSpecs(payload?.walletSpecs || payload?.wallets);
  if (!specs.length) return [];

  return resolveWalletSpecsWithRegistry(specs, bootyBox);
}

createWorkerHarness(
  async (payload = {}, tools = {}) => {
    const bootyBox = await ensureBootyBoxReady();
    const wallets = await resolveWallets(payload, bootyBox);
    if (!wallets.length) {
      throw new Error("positionHealing requires at least one wallet");
    }

    const dataEndpoint =
      payload?.dataEndpoint || process.env.WARCHEST_DATA_ENDPOINT || null;

    const dataClient = createSolanaTrackerDataClient({
      baseUrl: dataEndpoint || undefined,
      logger,
    });

    if (typeof tools.track === "function") {
      tools.track({ close: () => dataClient.close() });
    }

    return runPositionHealing({
      wallets,
      bootyBox,
      dataClient,
      logger,
      includeSol: payload?.includeSol === true,
      closeMissing: payload?.closeMissing !== false,
      dustEpsilon: payload?.dustEpsilon,
      onProgress:
        typeof tools.progress === "function"
          ? (event, details) => tools.progress(event, details)
          : null,
    });
  },
  {
    workerName: "positionHealing",
    logger,
    onClose: async () => {
      if (BootyBox && typeof BootyBox.close === "function") {
        await BootyBox.close();
      }
    },
  }
);
