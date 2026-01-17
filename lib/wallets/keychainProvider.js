'use strict';

const crypto = require('crypto');

let keytarModule = null;
let cachedMasterKey = null;

const DEFAULT_SERVICE = 'scoundrel';
const DEFAULT_ACCOUNT = 'wallet-master-key';

function loadKeytar() {
  if (keytarModule) return keytarModule;
  try {
    // eslint-disable-next-line global-require
    keytarModule = require('keytar');
  } catch (err) {
    throw new Error(
      `Keychain support requires the "keytar" package. Install it and retry. (${err?.message || err})`
    );
  }
  return keytarModule;
}

/**
 * Resolve the keychain service name used to store the master key.
 *
 * @returns {string}
 */
function getKeychainService() {
  return (process.env.SC_KEYCHAIN_SERVICE || DEFAULT_SERVICE).trim();
}

/**
 * Resolve the keychain account name used to store the master key.
 *
 * @returns {string}
 */
function getKeychainAccount() {
  return (process.env.SC_KEYCHAIN_ACCOUNT || DEFAULT_ACCOUNT).trim();
}

/**
 * Clear the cached master key (used in tests or when rotating keys).
 *
 * @returns {void}
 */
function clearMasterKeyCache() {
  cachedMasterKey = null;
}

/**
 * Return whether the master key is already cached in memory.
 *
 * @returns {boolean}
 */
function hasCachedMasterKey() {
  return !!cachedMasterKey;
}

/**
 * Load or create the keychain master key (32 bytes).
 *
 * @param {Object} [options]
 * @param {boolean} [options.allowCreate=true] When false, throw if missing.
 * @returns {Promise<Buffer>}
 */
async function getMasterKey(options = {}) {
  const { allowCreate = true } = options;
  if (cachedMasterKey) return cachedMasterKey;

  const keytar = loadKeytar();
  const service = getKeychainService();
  const account = getKeychainAccount();
  const stored = await keytar.getPassword(service, account);

  if (stored) {
    const decoded = Buffer.from(stored, 'base64');
    if (decoded.length === 32) {
      cachedMasterKey = decoded;
      return decoded;
    }
    if (!allowCreate) {
      throw new Error(
        `[keychain] Stored master key has invalid length (${decoded.length}).`
      );
    }
  }

  if (!allowCreate) {
    throw new Error('[keychain] Master key not found in Keychain.');
  }

  const next = crypto.randomBytes(32);
  await keytar.setPassword(service, account, next.toString('base64'));
  cachedMasterKey = next;
  return next;
}

/**
 * Preload the master key so later operations do not re-prompt the OS keychain.
 *
 * @returns {Promise<Buffer>}
 */
async function primeMasterKey() {
  return getMasterKey({ allowCreate: true });
}

module.exports = {
  getKeychainService,
  getKeychainAccount,
  getMasterKey,
  primeMasterKey,
  clearMasterKeyCache,
  hasCachedMasterKey,
};
