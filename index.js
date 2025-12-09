#!/usr/bin/env node
// index.js — Scoundrel CLI
require("dotenv").config({ quiet: true });
const logger = require('./lib/logger');
const chalk = require('chalk');
const { program } = require('commander');
const {
    getConfigPath: getSwapConfigPath,
    loadConfig: loadSwapConfig,
    saveConfig: saveSwapConfig,
    editConfig: editSwapConfig,
} = require('./lib/swap/swapConfig');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, relative } = require('path');
const BootyBox = require('./db');
const { requestId } = require('./lib/id/issuer');
const util = require('util');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const walletsDomain = require('./lib/wallets');
const { runAutopsy } = require('./lib/cli/autopsy');
const {
    dossierBaseDir,
    loadLatestJson,
    normalizeTraderAlias,
} = require('./lib/persist/jsonArtifacts');
const warchestModule = require('./lib/cli/warchestCli');
const warchestService = require('./lib/cli/warchest');
const warchestRun = typeof warchestModule === 'function'
    ? warchestModule
    : warchestModule && typeof warchestModule.run === 'function'
        ? warchestModule.run
        : null;

function loadHarvest() {
    try {
        // Lazy-load to keep startup fast and allow running without Solana deps during setup
        return require('./lib/cli/dossier').harvestWallet;
    } catch (e) {
        logger.error(`[scoundrel: dossier] ${e}`);
        process.exit(1);
    }
}

function loadProcessor(name) {
    try {
        return require(`./lib/cli/${name}`);
    } catch (e) {
        logger.error(`[scoundrel] Missing ./lib/${name}. Create it and export a function (module.exports = async (args) => { ... }) or a named export.`);
        process.exit(1);
    }
}

function resolveVersion() {
    try {
        const lockPath = join(__dirname, 'package-lock.json');
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (lock && lock.version) return lock.version;
    } catch (_) {}
    try {
        // Fallback to package.json if lock parsing fails.
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const pkg = require('./package.json');
        if (pkg && pkg.version) return pkg.version;
    } catch (_) {}
    return '0.0.0';
}

function shortenPubkey(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}


async function persistProfileSnapshot({ wallet, traderName, profile, source }) {
    if (!wallet || !profile) return;
    try {
        await BootyBox.init();
        const profileIdRaw = await requestId({ prefix: 'profile' });
        const profileId = String(profileIdRaw).slice(-26);
        await BootyBox.upsertProfileSnapshot({
            profileId,
            name: traderName || wallet,
            wallet,
            profile,
            source,
        });
        if (process.env.NODE_ENV === 'development') {
            logger.info(`[scoundrel] upserted profile in DB as ${profileId}`);
        }
    } catch (dbErr) {
        logger.warn('[scoundrel] warning: failed to upsert profile to DB:', dbErr?.message || dbErr);
    }
}

function isBase58Mint(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s.length < 32 || s.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function logAutopsyError(err) {
    const message = err?.message || err;
    logger.error('[scoundrel] ❌ autopsy failed:', message);

    if (err?.response) {
        const { status, statusText, data } = err.response;
        const statusLine = [status, statusText].filter(Boolean).join(' ');
        if (statusLine) {
            logger.error('[scoundrel] HTTP response:', statusLine);
        }
        if (data) {
            logger.error('[scoundrel] Response body:', util.inspect(data, { depth: 4, breakLength: 120 }));
        }
    }

    if (err?.cause) {
        logger.error('[scoundrel] cause:', err.cause?.message || err.cause);
    }

    if (err?.stack) {
        logger.error(err.stack);
    }
}

program
    .name('scoundrel')
    .description('Research & validation tooling for memecoin trading using SolanaTracker + OpenAI')
    .version(resolveVersion());

program.addHelpText('after', `\nEnvironment:\n  OPENAI_API_KEY              Required for OpenAI Responses\n  OPENAI_RESPONSES_MODEL      (default: gpt-4.1-mini)\n  FEATURE_MINT_COUNT          (default: 8) Number of recent mints to summarize for technique features\n  SOLANATRACKER_API_KEY       Required for SolanaTracker Data API\n  NODE_ENV                    development|production (controls logging verbosity)\n`);
program.addHelpText('after', `\nDatabase env:\n  BOOTYBOX_SQLITE_PATH        Optional override for db/bootybox.db\n  DB_ENGINE                  Optional legacy flag (sqlite only)\n`);

program
    .command('research')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades for a wallet, snapshot token states at trade time, and prep data for model analysis')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .option('-f, --feature-mint-count <num>', 'How many recent mints to summarize for technique features (default: FEATURE_MINT_COUNT or 8)')
    .addHelpText('after', `\nExamples:\n  $ scoundrel research <WALLET>\n  $ scoundrel research <WALLET> -n Gh0stee\n  $ scoundrel research <WALLET> --start 2025-01-01T00:00:00Z --end 2025-01-31T23:59:59Z\n\nFlags:\n  -s, --start <isoOrEpoch>  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end <isoOrEpoch>    End time; ISO or epoch seconds\n  -n, --name <traderName>   Optional alias to tag harvest artifacts\n  -f, --feature-mint-count <num>  Number of recent mints to summarize for features (default: 8)\n\nNotes:\n  • Writes small samples to ./data/dossier/<alias>/raw/ for inspection in development.\n  • Uses SOLANATRACKER_API_KEY from .env.\n  • The configured feature-mint count is written to the merged meta for traceability.\n`)
    .action(async (walletId, opts) => {
        const harvestWallet = loadHarvest();

        // Parse optional times
        const parseTs = (v) => {
            if (!v) return undefined;
            if (/^\d+$/.test(v)) return Number(v);
            const d = new Date(v);
            if (isNaN(d.getTime())) {
                logger.error('[scoundrel] Invalid time:', v);
                process.exit(1);
            }
            return Math.floor(d.getTime() / 1000);
        };

        const startTime = parseTs(opts.start);
        const endTime = parseTs(opts.end);
        const cliTraderName = opts.name ? String(opts.name).trim() : null;
        const traderName = cliTraderName || process.env.TEST_TRADER || null;
        const featureMintCount = opts.featureMintCount ? Number(opts.featureMintCount) : undefined;

        if (cliTraderName) {
            await walletsDomain.kol.ensureKolWallet({
                walletAddress: walletId,
                alias: cliTraderName,
            });
        }

        logger.info(`[scoundrel] Research starting for wallet ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
        try {
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime, featureMintCount });
            const count = (result && typeof result.count === 'number') ? result.count : 0;
            logger.info(`[scoundrel] ✅ harvested ${count} trades from ${walletId}`);
            process.exit(0);
        } catch (err) {
            logger.error('[scoundrel] ❌ error during harvest:', err?.message || err);
            process.exit(1);
        }
    });



// --- dossier command ---
program
    .command('dossier')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades + chart and build a schema-locked profile JSON via a single OpenAI Responses call')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .option('-l, --limit <num>', 'Max trades to pull (default from HARVEST_LIMIT)')
    .option('-f, --feature-mint-count <num>', 'How many recent mints to summarize for technique features (default: FEATURE_MINT_COUNT or 8)')
    .option('-r, --resend', 'Resend the latest merged file for this trader (-n) to AI without re-harvesting data', false)
    .addHelpText('after', `\nExamples:\n  $ scoundrel dossier &lt;WALLET&gt;\n  $ scoundrel dossier &lt;WALLET&gt; -n Gh0stee -l 500\n  $ scoundrel dossier &lt;WALLET&gt; --start 1735689600 --end 1738367999\n\nFlags:\n  -s, --start &lt;isoOrEpoch&gt;  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end &lt;isoOrEpoch&gt;    End time; ISO or epoch seconds\n  -n, --name &lt;traderName&gt;   Alias used as output filename under ./profiles/\n  -l, --limit &lt;num&gt;         Max trades to pull (default: HARVEST_LIMIT or 500)\n  -f, --feature-mint-count &lt;num&gt;  Number of recent mints to summarize for features (default: 8)\n\nOutput:\n  • Writes schema-locked JSON to ./profiles/&lt;name&gt;.json using OpenAI Responses.\n  • Also writes raw samples to ./data/dossier/&lt;alias&gt;/raw/ (trades + chart) in development.\n  • Upserts result into sc_profiles for future local access.\n\nEnv:\n  OPENAI_API_KEY, OPENAI_RESPONSES_MODEL, SOLANATRACKER_API_KEY\n`)
    .action(async (walletId, opts) => {
        const harvestWallet = loadHarvest();

        const parseTs = (v) => {
            if (!v) return undefined;
            if (/^\d+$/.test(v)) return Number(v);
            const d = new Date(v);
            if (isNaN(d.getTime())) {
                logger.error('[scoundrel] Invalid time:', v);
                process.exit(1);
            }
            return Math.floor(d.getTime() / 1000);
        };

        const startTime = parseTs(opts.start);
        const endTime = parseTs(opts.end);
        const cliTraderName = opts.name ? String(opts.name).trim() : null;
        const traderName = cliTraderName || process.env.TEST_TRADER || null;
        const limit = opts.limit ? Number(opts.limit) : undefined;
        const featureMintCount = opts.featureMintCount ? Number(opts.featureMintCount) : undefined;

        if (cliTraderName) {
            await walletsDomain.kol.ensureKolWallet({
                walletAddress: walletId,
                alias: cliTraderName,
            });
        }
        const alias = normalizeTraderAlias(traderName, walletId);

        logger.info(`[scoundrel] Dossier (simplified) for ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
        try {
            // ----- RESEND MODE: reuse latest merged payload and skip harvesting -----
            if (opts.resend) {
                const baseDir = dossierBaseDir(alias);
                const latest = loadLatestJson(baseDir, ['merged'], 'merged-');
                if (!latest || latest.data == null) {
                    logger.error(`[scoundrel] No merged files found for "${alias}" in ${baseDir}. Run without --resend first.`);
                    process.exit(1);
                }
                const latestPath = latest.path;
                logger.info(`[scoundrel] Reusing merged payload: ${latestPath}`);
                const merged = latest.data;
                const { analyzeWallet } = require('./ai/jobs/walletAnalysis');
                const aiOut = await analyzeWallet({ merged });
                const openAiResult = aiOut && aiOut.version ? aiOut : { version: 'dossier.freeform.v1', markdown: String(aiOut || '') };

                // Write profile JSON under ./profiles
                const dir = join(process.cwd(), 'profiles');
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                const fname = `${alias}.json`;
                const outPath = join(dir, fname);
                writeFileSync(outPath, JSON.stringify(openAiResult, null, 2));
                logger.info(`[scoundrel] ✅ wrote profile to ${outPath}`);

                // Persist to DB (sc_profiles), mirroring the normal path
                await persistProfileSnapshot({
                    wallet: walletId,
                    traderName,
                    profile: openAiResult,
                    source: 'dossier-resend',
                });

                // Print brief console output if markdown present
                if (openAiResult && openAiResult.markdown) {
                    logger.info('\n=== Dossier (resend) ===\n');
                    logger.info(openAiResult.markdown);
                }

                logger.info(`[scoundrel] ✅ dossier (resend) complete for ${walletId}`);
                process.exit(0);
            }
            // ----- END RESEND MODE -----

            // Single-pass: SolanaTracker fetches + merge + one OpenAI Responses call handled by harvestWallet
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime, limit, featureMintCount });

            // Expect Responses output from harvest step
            if (!result || !result.openAiResult) {
                logger.error('[scoundrel] No Responses output (openAiResult) returned by harvestWallet.');
                process.exit(1);
            }

            // Write profile JSON under ./profiles
            const dir = join(process.cwd(), 'profiles');
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const fname = `${alias}.json`;
            const outPath = join(dir, fname);
            writeFileSync(outPath, JSON.stringify(result.openAiResult, null, 2));
            logger.info(`[scoundrel] ✅ wrote profile to ${outPath}`);

            // Persist to DB (sc_profiles), mirroring the previous build-profile upsert
            await persistProfileSnapshot({
                wallet: walletId,
                traderName,
                profile: result.openAiResult,
                source: 'dossier',
            });

            // Normal send: print the dossier to console (same as --resend), then exit
            if (result.openAiResult && result.openAiResult.markdown) {
                logger.info('\n=== Dossier ===\n');
                logger.info(result.openAiResult.markdown);
            } else {
                logger.info('[scoundrel] (no markdown field in openAiResult)');
            }
            process.exit(0);
        } catch (err) {
            logger.error('[scoundrel] ❌ dossier failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('autopsy')
    .description('Interactive trade autopsy for a wallet + mint campaign (SolanaTracker + OpenAI)')
    .addHelpText('after', `\nFlow:\n  • Choose a HUD wallet or enter another address.\n  • Enter the token mint to analyze.\n  • Saves autopsy JSON to ./profiles/autopsy-<wallet>-<symbol>-<ts>.json and prints the AI narrative.\n\nExample:\n  $ scoundrel autopsy\n`)
    .action(async () => {
        const rl = readline.createInterface({ input, output });
        try {
            const walletRows = await walletsDomain.registry.getAllWallets();
            const options = walletRows.map((w, idx) => `${idx + 1}) ${w.alias} (${shortenPubkey(w.pubkey)})`);
            options.push(`${walletRows.length + 1}) Other (enter address)`);

            logger.info('Which wallet?');
            options.forEach((opt) => logger.info(opt));
            let choice = await rl.question('> ');
            let walletLabel;
            let walletAddress;

            const numeric = Number(choice);
            if (Number.isInteger(numeric) && numeric >= 1 && numeric <= walletRows.length) {
                const selected = walletRows[numeric - 1];
                walletLabel = selected.alias;
                walletAddress = selected.pubkey;
            } else {
                if (!walletAddress) {
                    walletAddress = choice && choice.trim() ? choice.trim() : null;
                }
                if (!walletAddress) {
                    walletAddress = await rl.question('Enter wallet address:\n> ');
                }
                walletLabel = 'other';
            }

            let mint = await rl.question('Enter mint to trace:\n> ');
            mint = mint.trim();
            if (!mint) {
                throw new Error('mint is required');
            }
            if (!isBase58Mint(mint)) {
                logger.warn('[scoundrel] mint does not look like base58; continuing anyway');
            }

            const result = await runAutopsy({ walletLabel, walletAddress, mint });
            if (!result) {
                process.exit(0);
            }
            process.exit(0);
        } catch (err) {
            logAutopsyError(err);
            process.exit(1);
        } finally {
            rl.close();
            try { await BootyBox.close(); } catch (_) {}
        }
    });


program
    .command('tx')
    .argument('<signature>', 'Solana transaction signature to inspect')
    .description('Inspect a Solana transaction via SolanaTracker (status, fees, SOL balance changes)')
    .option('--sig <signature>', 'Additional transaction signature to inspect (may be repeated)', (value, previous) => {
        if (!previous) return [value];
        return previous.concat(value);
    })
    .option('-s, --swap', 'Also interpret this transaction as a swap for a specific wallet/mint')
    .option('-w, --wallet <aliasOrAddress>', 'Wallet alias or address that initiated the swap (focus wallet)')
    .option('-m, --mint <mint>', 'SPL mint address for the swapped token')
    .addHelpText('after', `\nExamples:\n  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ\n  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ --sig ANOTHER_SIG --sig THIRD_SIG\n  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ -s --wallet DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\n\nNotes:\n  • Uses SolanaTracker RPC via your configured API key.\n  • Shows status, network fee, and per-account SOL balance changes.\n  • With -s/--swap, also computes token + SOL deltas for the given wallet/mint.\n`)
    .action(async (signature, cmd) => {
        const txProcessor = loadProcessor('tx');

        const runner = (typeof txProcessor === 'function')
            ? txProcessor
            : (txProcessor && txProcessor.run);

        if (!runner) {
            logger.error('[scoundrel] ./lib/tx must export a default function or { run }');
            process.exit(1);
        }

        try {
            await runner({ signature, cmd });
            process.exit(0);
        } catch (err) {
            const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : err;
            logger.error('[scoundrel] ❌ tx command failed:', msg);
            process.exit(1);
        }
    });

// --- swap:config command ---
const swapConfigCmd = program
    .command('swap:config')
    .description('Manage Scoundrel swap configuration (RPC, swap API key, slippage, etc.)')
    .addHelpText('after', `
Examples:
  $ scoundrel swap:config view
  $ scoundrel swap:config edit
  $ scoundrel swap:config set rpcUrl https://your-solanatracker-rpc-url?advancedTx=true
  $ scoundrel swap:config set swapAPIKey YOUR_API_KEY
`);

swapConfigCmd
    .command('view')
    .description('Show current swap config')
    .action(async () => {
        try {
            const configPath = getSwapConfigPath();
            const cfg = await loadSwapConfig();

            // Redact API key to avoid screen-share leaks
            const redacted = { ...cfg };
            if (redacted.swapAPIKey && typeof redacted.swapAPIKey === 'string') {
                const tail = redacted.swapAPIKey.slice(-4);
                redacted.swapAPIKey = `************${tail}`;
            }

            logger.info(`[scoundrel:swap-config] Config file: ${configPath}`);
            logger.info(JSON.stringify(redacted, null, 2));
        } catch (err) {
            logger.error('[scoundrel:swap-config] ❌ failed to load config:', err?.message || err);
            process.exitCode = 1;
        }
    });

swapConfigCmd
    .command('edit')
    .description('Edit swap config in your $EDITOR')
    .action(async () => {
        try {
            await editSwapConfig();
        } catch (err) {
            logger.error('[scoundrel:swap-config] ❌ failed to edit config:', err?.message || err);
            process.exitCode = 1;
        }
    });

swapConfigCmd
    .command('set <key> <value>')
    .description('Set a single swap config key')
    .action(async (key, value) => {
        try {
            const configPath = getSwapConfigPath();
            const cfg = await loadSwapConfig();
            const numeric = Number(value);
            const castValue = Number.isNaN(numeric) ? value : numeric;

            cfg[key] = castValue;
            await saveSwapConfig(cfg);

            logger.info(`[scoundrel:swap-config] ✅ Updated ${key} → ${castValue} in ${configPath}`);
        } catch (err) {
            logger.error('[scoundrel:swap-config] ❌ failed to update config:', err?.message || err);
            process.exitCode = 1;
        }
    });

// --- trade command ---
program
    .command('trade')
    .argument('<mint>', 'Token mint address to trade')
    .description('Execute a token trade via the SolanaTracker swap API')
    .requiredOption('-w, --wallet <aliasOrAddress>', 'Wallet alias or address from the warchest registry')
    .option('-b, --buy <amount>', "Spend <amount> SOL (number or '<percent>%') to buy the token")
    .option('-s, --sell <amount>', "Sell <amount> of the token (number, 'auto', or '<percent>%')")
    .option('--slippage <percent>', 'Override default slippage percent for this trade')
    .option('--priority-fee <microlamports>', 'Override default priority fee in microlamports (or use "auto")')
    .option('--jito', 'Use Jito-style priority fee routing when supported')
    .option('--dry-run', 'Build and simulate the swap without broadcasting the transaction')
    .addHelpText('after', `\nExamples:\n  $ scoundrel trade 36xsfxxxxxxxxx2rta5pump -w warlord -b 0.1\n  $ scoundrel trade 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s 50%\n  $ scoundrel trade 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s auto --slippage 3 --priority-fee auto\n`)
    .action(async (mint, opts) => {
        try {
            const tradeCli = require('./lib/cli/trade');
            if (typeof tradeCli !== 'function') {
                logger.error('[scoundrel] ./lib/cli/trade must export a default function (module.exports = async (mint, opts) => { ... })');
                process.exit(1);
            }
            await tradeCli(mint, opts);
            process.exit(0);
        } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.error(`[scoundrel] ❌ trade failed: ${msg}`);
            if (err && err.stack && logger.debug) {
                logger.debug(err.stack);
            }
            process.exit(1);
        }
    });

program
    .command('ask')
    .description('Ask a question about a trader using their saved profile (Responses API)')
    .option('-n, --name <traderName>', 'Trader alias used when saving the profile (optional, defaults to "default" if omitted)')
    .requiredOption('-q, --question <text>', 'Question to ask')
    .addHelpText('after', `\nExamples:\n  $ scoundrel ask -n Gh0stee -q "What patterns do you see?"\n  $ scoundrel ask -n Gh0stee -q "List common entry mistakes."\n\nFlags:\n  -n, --name <traderName>   Alias that matches ./profiles/<name>.json\n  -q, --question <text>     Natural language question\n\nNotes:\n  • Reads ./profiles/<name>.json as context.\n  • May also include the latest dossier snapshot from ./data/dossier/<alias>/enriched/ when SAVE_ENRICHED is enabled.\n`)
    .action(async (opts) => {
        const askProcessor = loadProcessor('ask');
        const alias = opts.name ? opts.name.replace(/[^a-z0-9_-]/gi, '_') : 'default';
        const profilePath = join(process.cwd(), 'profiles', `${alias}.json`);
        if (!existsSync(profilePath)) {
            logger.error(`[scoundrel] profile not found: ${profilePath}`);
            process.exit(1);
        }
        const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

        // Optionally include recent enriched rows if present
        const artifactAlias = normalizeTraderAlias(opts.name || alias, opts.name || alias || 'default');
        let rows = [];
        const latestEnriched = loadLatestJson(dossierBaseDir(artifactAlias), ['enriched'], 'techniqueFeatures-');
        if (latestEnriched && latestEnriched.data) {
            const payload = latestEnriched.data;
            // Prefer the condensed coins array; otherwise wrap the payload so ask() still receives rows[]
            const arrayPayload = Array.isArray(payload?.coins)
                ? payload.coins
                : Array.isArray(payload)
                    ? payload
                    : payload
                        ? [payload]
                        : [];
            rows = arrayPayload;
        }

        try {
            const runner = (typeof askProcessor === 'function') ? askProcessor : (askProcessor && askProcessor.ask);
            if (!runner) { logger.error('[scoundrel] ./lib/ask must export a default function or { ask }'); process.exit(1); }
            const ans = await runner({ profile, question: opts.question, rows: rows.slice(0, 200) });
            logger.info(ans);
            process.exit(0);
        } catch (err) {
            logger.error('[scoundrel] ❌ ask failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('addcoin')
    .argument('<mint>', 'Token mint address to add to the Scoundrel DB')
    .description('Fetch token metadata via SolanaTracker SDK and persist it through tokenInfoService')
    .option('-f, --force', 'Force refresh from API and skip cached DB metadata', false)
    .addHelpText('after', `
Examples:
  $ scoundrel addcoin <MINT>
  $ scoundrel addcoin 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump

Notes:
  • Uses the SolanaTracker Data API SDK to fetch token metadata for the given mint.
  • Delegates persistence to lib/tokenInfoService.js (e.g., addOrUpdateCoin).
`)
    .action(async (mint, opts, cmd) => {
        const forceRefresh = !!opts.force;
        const addcoinProcessor = loadProcessor('addcoin');

        const runner = (typeof addcoinProcessor === 'function')
            ? addcoinProcessor
            : (addcoinProcessor && addcoinProcessor.run);

        if (!runner) {
            logger.error('[scoundrel] ./lib/addcoin must export a default function or { run }');
            process.exit(1);
        }

        try {
            const opts = (cmd && typeof cmd.opts === 'function') ? cmd.opts() : {};
            const forceRefresh = !!opts.force;
            logger.debug('[scoundrel] addcoin CLI opts', opts);
            logger.debug('[scoundrel] addcoin CLI forceRefresh computed', { forceRefresh });
            await runner({ mint, forceRefresh });
            logger.info(`[scoundrel] ✅ addcoin completed for mint ${mint}`);
            process.exit(0);
        } catch (err) {
            logger.error('[scoundrel] ❌ addcoin failed:', err?.message || err);
            process.exit(1);
        }
    });
    
program
    .command('warchest')
    .description('Manage your Scoundrel warchest wallet registry')
    .argument('[subcommand]', 'add|list|remove|set-color')
    .argument('[arg1]', 'First argument for subcommand (e.g., alias)')
    .argument('[arg2]', 'Second argument for subcommand (e.g., color)')
    .option('-s, --solo', 'Select a single wallet interactively (registry-only for now)')
    .addHelpText('after', `
Examples:
  $ scoundrel warchest add
  $ scoundrel warchest list
  $ scoundrel warchest remove warlord
  $ scoundrel warchest set-color warlord cyan
  $ scoundrel warchest -solo
`)
    .action(async (subcommand, arg1, arg2, cmd) => {
        const args = [];

        const opts = cmd.opts ? cmd.opts() : {};
        if (opts.solo) {
            // warchest CLI expects "-solo" or "--solo" in argv
            args.push('-solo');
        }

        if (subcommand) args.push(subcommand);
        if (arg1) args.push(arg1);
        if (arg2) args.push(arg2);

        try {
            if (!warchestRun) {
                throw new Error('warchest command module does not export a runnable function');
            }
            await warchestRun(args);
        } catch (err) {
            logger.error('[scoundrel] ❌ warchest command failed:', err?.message || err);
            process.exitCode = 1;
        } finally {
            try {
                await BootyBox.close();
            } catch (e) {
                if (process.env.NODE_ENV === 'development') {
                    logger.warn('[scoundrel] warning: failed to close DB pool:', e?.message || e);
                }
            }
            // Ensure the CLI returns control to the shell after warchest completes
            process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
        }
    });

program
    .command('warchestd')
    .description('Control the warchest daemon (start, stop, restart, or run a HUD session)')
    .argument('<action>', 'start|stop|restart|hud|status')
    .option(
        '--wallet <spec>',
        'Wallet spec alias:pubkey:color (repeatable, use multiple --wallet flags)',
        (value, previous) => {
            if (!previous) return [value];
            return previous.concat(value);
        }
    )
    .option('--hud', 'Start daemon with HUD enabled (for start/restart actions)')
    .addHelpText('after', `
Examples:
  # Start warchest daemon in the background
  $ scoundrel warchestd start --wallet warlord:DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR:orange

  # Start daemon with HUD enabled in the foreground (dev mode)
  $ scoundrel warchestd start --wallet warlord:DDkF...:orange --hud

  # One-off HUD session (no PID management)
  $ scoundrel warchestd hud --wallet warlord:DDkF...:orange

  # Stop background daemon
  $ scoundrel warchestd stop

  # Restart daemon with new wallet args
  $ scoundrel warchestd restart --wallet warlord:DDkF...:orange

  # Show daemon health and latest status snapshot
  $ scoundrel warchestd status
`)
    .action(async (action, opts) => {
        // In Commander v9+, the second argument here is the options object, not the Command instance.
        // We defined --wallet as a repeatable option, so opts.wallet will be:
        //   - undefined (if not provided)
        //   - a string (if provided once)
        //   - an array of strings (if provided multiple times)
        const rawWallet = opts && Object.prototype.hasOwnProperty.call(opts, 'wallet')
            ? opts.wallet
            : undefined;

        let walletSpecs = [];
        if (Array.isArray(rawWallet)) {
            walletSpecs = rawWallet;
        } else if (typeof rawWallet === 'string') {
            walletSpecs = [rawWallet];
        }

        // walletSpecs may be empty here. The warchest service will attempt to resolve
        // wallets from configuration (autoAttachWarchest/default funding) when none
        // are provided explicitly.

        try {
            if (!warchestService) {
                throw new Error('warchest service module is not available');
            }

            if (action === 'start') {
                // Default to starting the daemon headless; enable HUD only when explicitly requested.
                const hud = !!opts.hud;
                await warchestService.start({ walletSpecs, hud });
            } else if (action === 'stop') {
                await warchestService.stop();
            } else if (action === 'restart') {
                // Default to restarting the daemon headless; enable HUD only when explicitly requested.
                const hud = !!opts.hud;
                await warchestService.restart({ walletSpecs, hud });
            } else if (action === 'hud') {
                // Dedicated HUD action: run the HUD in the foreground as a TUI viewer.
                warchestService.hud({ walletSpecs });
            } else if (action === 'status') {
                // Report daemon + health snapshot status without modifying state.
                await warchestService.status();
            } else {
                logger.error(`[scoundrel] Unknown warchestd action: ${action}`);
                process.exitCode = 1;
            }
        } catch (err) {
            logger.error('[scoundrel] ❌ warchestd command failed:', err?.message || err);
            process.exitCode = 1;
        }
    });

program
    .command('test')
    .description('Run a quick self-check (env + minimal OpenAI config presence)')
    .addHelpText('after', `\nChecks:\n  • Ensures OPENAI_API_KEY is present.\n  • Verifies presence of core files in ./lib and ./ai.\n  • Attempts a MySQL connection and prints DB config.\n\nExample:\n  $ scoundrel test\n`)
    .action(async () => {
    console.log('[test] starting test action');
    const hasKey = !!process.env.OPENAI_API_KEY;
        logger.info('[scoundrel] environment check:');
        logger.info(`  OPENAI_API_KEY: ${hasKey ? 'present' : 'MISSING'}`);
        logger.info(`  Working directory: ${process.cwd()}`);
        logger.info(`  Node version: ${process.version}`);

        // Check presence of core modules in the new pipeline
        const pathsToCheck = [
            join(__dirname, 'lib', 'cli', 'dossier.js'),
            join(__dirname, 'ai', 'client.js'),
            join(__dirname, 'ai', 'jobs', 'walletAnalysis.js'),
            join(__dirname, 'lib', 'cli', 'ask.js'),
        ];
        logger.info('\n[scoundrel] core files:');
        pathsToCheck.forEach(p => {
            const ok = existsSync(p);
            logger.info(`  ${relative(process.cwd(), p)}: ${ok ? 'present' : 'missing'}`);
        });

        // DB diagnostics
        const {
            DB_ENGINE = 'sqlite',
            DB_HOST = 'localhost',
            DB_PORT = '3306',
            DB_NAME = '(unset)',
            DB_USER = '(unset)',
            DB_POOL_LIMIT = '30',
        } = process.env;

        logger.info('\n[db] configuration:');
        logger.info(`  Engine   : ${DB_ENGINE}`);
        logger.info(`  Host     : ${DB_HOST}:${DB_PORT}`);
        logger.info(`  Database : ${DB_NAME}`);
        logger.info(`  User     : ${DB_USER}`);
        logger.info(`  Pool     : ${DB_POOL_LIMIT}`);

        try {
            if (typeof BootyBox.init === 'function') {
                await BootyBox.init();
            }
            await BootyBox.ping();
            logger.info('[db] ✅ connected');
        } catch (e) {
            const msg = e && e.message ? e.message : e;
            logger.info(`[db] ❌ connection failed: ${msg}`);
            if (e && e.stack) {
                logger.debug && logger.debug(e.stack);
            }
        }

        if (!hasKey) {
            logger.info('\nTip: add OPENAI_API_KEY to your .env file.');
            process.exit(1);
        } else {
            logger.info('\n[scoundrel] ✅ basic checks passed.');
            process.exit(0);
        }
    });

// Ensure the warchest daemon is running for most commands.
program.hook('preAction', async (thisCommand, actionCommand) => {
    const name = actionCommand && typeof actionCommand.name === 'function'
        ? actionCommand.name()
        : undefined;

    // Avoid recursion / conflicts for the service management command itself.
    if (name === 'warchestd') {
        return;
    }

    if (!warchestService || typeof warchestService.ensureDaemonRunning !== 'function') {
        return;
    }

    try {
        await warchestService.ensureDaemonRunning();
    } catch (err) {
        const msg = err && err.message ? err.message : err;
        logger.warn(`[scoundrel] Failed to ensure warchest daemon is running: ${msg}`);
    }
});

// Default/help handling is provided by commander
program.parseAsync(process.argv);
