/**
 * addcoin
 *
 * This module backs the `scoundrel addcoin <mint>` CLI command.
 * It is intentionally very thin:
 *   - Validates the provided mint.
 *   - Obtains a SolanaTracker Data API client from lib/solanaTrackerDataClient.js.
 *   - Delegates all token lookup + persistence to tokenInfoService.ensureTokenInfo().
 */

const logger = require('../logger');
const { createSolanaTrackerDataClient } = require('../solanaTrackerDataClient');
const tokenInfoService = require('../services/tokenInfoService');
const path = require('path');
const {
  formatRunId,
  getArtifactConfig,
  sanitizeSegment,
  writeJsonArtifact,
} = require('../persist/jsonArtifacts');
const { assertValidMintAddress } = require('../solana/addressValidation');

const { saveRaw: SAVE_RAW } = getArtifactConfig();
const ARTIFACT_BASE_DIR = path.join(process.cwd(), 'data');

/**
 * Entry point used by index.js via loadProcessor('addcoin').
 *
 * @param {{ mint: string }} params
 * @returns {Promise<object|null>}
 */
async function run(params) {
    const mint = (params && params.mint ? String(params.mint) : '').trim();
    const forceRefresh = !!(params && params.forceRefresh);

    logger.debug('[scoundrel:addcoin] run() received params', params);
    logger.debug('[scoundrel:addcoin] resolved forceRefresh flag', { forceRefresh });

    if (!mint) {
        logger.error('[scoundrel:addcoin] mint is required');
        throw new Error('mint is required');
    }

    assertValidMintAddress(mint);

    logger.info(`[scoundrel:addcoin] ensuring token info for mint ${mint}…`);

    try {
        // Data client uses env vars internally (SOLANATRACKER_API_KEY, SOLANATRACKER_DATA_BASE_URL)
        const client = await createSolanaTrackerDataClient();

        // Delegate to tokenInfoService to handle cache + DB persistence
        logger.debug('[scoundrel:addcoin] calling ensureTokenInfo with', { mint, forceRefresh });
        const info = await tokenInfoService.ensureTokenInfo({ mint, client, forceRefresh });

        if (!info) {
            logger.warn(`[scoundrel:addcoin] no token info was returned for mint ${mint}`);
            return null;
        }

/*         // Optional: Save raw JSON response if SAVE_RAW=true
        if (SAVE_RAW) {
            try {
                const outPath = writeJsonArtifact(
                    ARTIFACT_BASE_DIR,
                    ['addcoin'],
                    `${sanitizeSegment(mint, 'mint')}-${formatRunId()}.json`,
                    info,
                );
                logger.info(`[scoundrel:addcoin] Saved raw token info to ${outPath}`);
            } catch (err) {
                logger.warn('[scoundrel:addcoin] Failed to save raw token info:', err?.message || err);
            }
        } */

        logger.info(`[scoundrel:addcoin] ✅ token info ensured for mint ${mint}`);
        return info;
    } catch (err) {
        const msg = err && (err.message || err.stack || String(err));
        logger.error(`[scoundrel:addcoin] ❌ ensureTokenInfo failed: ${msg}`);
        throw err;
    }
}

module.exports = {
    run,
};
