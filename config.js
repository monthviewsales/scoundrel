const fs = require('fs-extra');
const os = require('os');
const path = require("path");
const spawnSync = require("child_process").spawnSync;

// Application name for config directory
const APP_NAME = "summonTheWarlord";

// Default configuration values
// Note: walletSecretKey has been moved to macOS Keychain storage
const DEFAULT_CONFIG = {
  //  Welcome to summonTheWarlord, a CLI for simple fast trading on Solana.
  //  Its required that you use SolanaTracker.io as your RPC as they also provide required APIs.
  //  This is a free public endpoint and may have issues.
  //  You can get a free account at https://www.solanatracker.io/solana-rpc
  //  Replace the URL with the new one provided and keep '?advancedTx=true' after your API Key.
  rpcUrl: "https://rpc.solanatracker.io/public?advancedTx=true", 
  slippage: 10,               // Maximum acceptable slippage percentage (e.g., 10)
  priorityFee: "auto",        // Amount in SOL or "auto"
  priorityFeeLevel: "low",    // "min","low","medium","high","veryHigh","unsafeMax"
  txVersion: "v0",            // "v0" or "legacy"
  showQuoteDetails: false,      //  Outputs the JSON swap response to the console
  swapAPIKey: "jduck-d815-4c28-b85d-17e9fc3a21a8",             // API key for swap service (if required)
  DEBUG_MODE: false,          // Enable debug logging
  // walletSecretKey: "",       // Deprecated: now stored in macOS Keychain,
};

/**
 * Compute the path to the config file.
 * - On macOS: ~/Library/Application Support/summonTheWarlord/config.json
 * - Else:      $XDG_CONFIG_HOME/summonTheWarlord/config.json (or ~/.config/…)
 */
function getConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support", APP_NAME);
    return path.join(appSupport, "config.json");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfig, APP_NAME, "config.json");
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
  // Note: walletSecretKey is now stored securely in the macOS Keychain, not in this file
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