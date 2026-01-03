const fs = require('fs-extra');
const os = require('os');
const path = require("path");
const spawnSync = require("child_process").spawnSync;

// Application name for config directory
const APP_NAME = "com.VAULT77.scoundrel";

// Default configuration values
// Note: walletSecretKey has been moved to macOS Keychain storage
const DEFAULT_CONFIG = {
  //  Scoundrel swap configuration.
  //  It is required that you use SolanaTracker.io as your RPC because they also provide the swap APIs.
  //  The default is a free public endpoint and may have issues under heavy load.
  //  You can get a free account at https://www.solanatracker.io/solana-rpc
  //  Replace the URL with the one provided for your account and keep '?advancedTx=true' after your API key.
  rpcUrl: "https://rpc.solanatracker.io/public?advancedTx=true", 
  swapApiProvider: "swapV3",  // swapV3 (default) or raptor
  swapApiBaseUrl: "https://swap-v2.solanatracker.io/swap",
  swapApiKey: "",              // API key for SolanaTracker swap service; MUST be set in your config.json
  slippage: 10,               // Maximum acceptable slippage percentage (e.g., 10)
  priorityFee: "auto",        // Amount in SOL or "auto"
  priorityFeeLevel: "low",    // "min","low","medium","high","veryHigh","unsafeMax"
  txVersion: "v0",            // "v0" or "legacy"
  showQuoteDetails: false,      //  Outputs the JSON swap response to the console
  useJito: false,             // Enable Jito bundle routing
  jitoTip: 0.0001,            // Tip amount in SOL when Jito is enabled
  DEBUG_MODE: true,          // Enable debug logging
  preflight: false,           // Simulate transactions before sending
  maxPriceImpact: null,       // Abort when price impact exceeds this percent (null disables)
  inkMode: true,             // Suppress worker console output for Ink UI
  explorerBaseUrl: "https://solscan.io/tx", // Base URL for transaction explorer links
};

/**
 * Compute the path to the config file.
 * - On macOS: ~/Library/Application Support/com.VAULT77.scoundrel/config.json
 * - Else:     $XDG_CONFIG_HOME/com.VAULT77.scoundrel/config.json (or ~/.config/…)
 */
function getConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support", APP_NAME);
    return path.join(appSupport, "swapConfig.json");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfig, APP_NAME, "swapConfig.json");
}

/**
 * Load the config, writing defaults if the file didn't exist.
 * Also merges in any new keys from DEFAULT_CONFIG.
 */
async function loadConfig() {
  const configPath = getConfigPath();

  // If missing, write out defaults
  if (!await fs.pathExists(configPath)) {
    await fs.ensureDir(path.dirname(configPath), { mode: 0o700 });
    await fs.writeJson(configPath, DEFAULT_CONFIG, { spaces: 2 });
    await fs.chmod(configPath, 0o600);
    return { ...DEFAULT_CONFIG };
  }

  // Read existing, merge missing defaults
  const cfg = await fs.readJson(configPath);
  let updated = false;
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!(key in cfg)) {
      cfg[key] = value;
      updated = true;
    }
  }
  if (cfg.swapApiKey === undefined && cfg.swapAPIKey !== undefined) {
    cfg.swapApiKey = cfg.swapAPIKey;
    updated = true;
  }
  if (cfg.swapAPIKey !== undefined) {
    delete cfg.swapAPIKey;
    updated = true;
  }
  if (cfg.swapApiBaseUrl === undefined && cfg.swapApiUrl !== undefined) {
    cfg.swapApiBaseUrl = cfg.swapApiUrl;
    updated = true;
  }
  if (updated) {
    await fs.writeJson(configPath, cfg, { spaces: 2 });
    await fs.chmod(configPath, 0o600);
  }
  return cfg;
}

/**
 * Save the given config object back to disk (with secure perms).
 */
async function saveConfig(cfg) {
  const configPath = getConfigPath();
  await fs.ensureDir(path.dirname(configPath), { mode: 0o700 });
  // Note: walletSecretKey is not in this file
  await fs.writeJson(configPath, cfg, { spaces: 2 });
  await fs.chmod(configPath, 0o600);
}

/**
 * Open the config file in the user's $EDITOR.
 */
function editConfig() {
  const configPath = getConfigPath();
  const editor = process.env.EDITOR || "vim";
  spawnSync(editor, [configPath], { stdio: "inherit" });
}

module.exports = {
  loadConfig,
  saveConfig,
  editConfig,
  getConfigPath,
};
