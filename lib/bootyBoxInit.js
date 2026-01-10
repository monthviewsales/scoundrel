'use strict';

const BootyBox = require('../db');

let initPromise;

/**
 * Ensure BootyBox is initialized once per process.
 * @returns {Promise<boolean>}
 */
async function ensureBootyBoxInit() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!BootyBox || typeof BootyBox.init !== 'function') {
      throw new Error('[bootyBoxInit] BootyBox.init is not available');
    }
    await BootyBox.init();
    return true;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

module.exports = {
  ensureBootyBoxInit,
};
