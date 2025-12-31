'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load .env safely, skipping non-regular files (e.g., FIFOs).
 *
 * @param {Object} [options]
 * @param {string} [options.path] - Optional override for the .env path.
 * @returns {boolean} True when dotenv was loaded, false otherwise.
 */
function loadDotenv(options = {}) {
  // const envPath = options.path || process.env.DOTENV_CONFIG_PATH || path.join(process.cwd(), '.env');
  const envPath = path.join(process.cwd(), '.env');
  // console.log(`[safeDotenv] Loading .env from ${envPath}`);

  try {
    const stat = fs.statSync(envPath);
    if (!stat.isFile()) return false;
  } catch (_) {
    return false;
  }

  try {
    // eslint-disable-next-line global-require
    require('dotenv').config({ quiet: true, path: envPath });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  loadDotenv,
};
