#!/usr/bin/env node
// index.js — Scoundrel CLI
require('./lib/env/safeDotenv').loadDotenv();
const logger = require('./lib/logger');
const chalk = require('chalk');
const React = require('react');
const { program } = require('commander');
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join, relative } = require('path');
const BootyBox = require('./db');
const { requestId } = require('./lib/id/issuer');
const util = require('util');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const walletsDomain = require('./lib/wallets');
const { runAutopsy } = require('./lib/cli/autopsy');
const { resolveAutopsyWallet } = require('./lib/cli/autopsyWalletResolver');
const {
    dossierBaseDir,
    loadLatestJson,
    normalizeTraderAlias,
} = require('./lib/persist/jsonArtifacts');
const warchestModule = require('./lib/cli/walletCli');
const warchestService = require('./lib/cli/warchest');
const { forkWorkerWithPayload } = require('./lib/warchest/workers/harness');
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

program.addHelpText('after', `\nEnvironment:\n  OPENAI_API_KEY              Required for OpenAI Responses\n  OPENAI_RESPONSES_MODEL      (default: gpt-4.1-mini)\n  xAI_API_KEY                 Required for Grok-backed DevScan summaries\n  DEVSCAN_RESPONSES_MODEL     (default: grok-4-1-fast-reasoning)\n  FEATURE_MINT_COUNT          (default: 8) Number of recent mints to summarize for technique features\n  SOLANATRACKER_API_KEY       Required for SolanaTracker Data API\n  DEVSCAN_API_KEY             Required for DevScan API access\n  NODE_ENV                    development|production (controls logging verbosity)\n`);
program.addHelpText('after', `\nDatabase env:\n  BOOTYBOX_SQLITE_PATH        Optional override for db/bootybox.db\n`);

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

        logger.warn('[scoundrel] research is deprecated; use "scoundrel dossier --harvest-only" instead.');
        logger.info(`[scoundrel] Research starting for wallet ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
        try {
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime, featureMintCount, runAnalysis: false });
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
    .option('--track-kol', 'If set, upsert this wallet into sc_wallets as a tracked KOL using --name as the alias')
    .option('-l, --limit <num>', 'Max trades to pull (default from HARVEST_LIMIT)')
    .option('-f, --feature-mint-count <num>', 'How many recent mints to summarize for technique features (default: FEATURE_MINT_COUNT or 8)')
    .option('--harvest-only', 'Harvest trades + chart and write artifacts but skip AI + DB upsert')
    .option('-r, --resend', 'Resend the latest merged file for this trader (-n) to AI without re-harvesting data', false)
    .addHelpText('after', `\nExamples:\n  $ scoundrel dossier &lt;WALLET&gt;\n  $ scoundrel dossier &lt;WALLET&gt; -n Gh0stee -l 500\n  $ scoundrel dossier &lt;WALLET&gt; --start 1735689600 --end 1738367999\n\nFlags:\n  -s, --start &lt;isoOrEpoch&gt;  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end &lt;isoOrEpoch&gt;    End time; ISO or epoch seconds\n  -n, --name &lt;traderName&gt;   Alias used as output filename under ./profiles/ (also enables an interactive KOL tracking prompt)\n  --track-kol               Non-interactive: upsert the wallet into sc_wallets as a tracked KOL (requires -n/--name)\n                             (if omitted but -n is provided, Scoundrel will ask [y/N] whether to track)\n  -l, --limit &lt;num&gt;         Max trades to pull (default: HARVEST_LIMIT or 500)\n  -f, --feature-mint-count &lt;num&gt;  Number of recent mints to summarize for features (default: 8)\n  --harvest-only            Harvest trades + chart and write artifacts but skip AI + DB upsert\n\nOutput:\n  • Writes schema-locked JSON to ./profiles/&lt;name&gt;.json using OpenAI Responses.\n  • Also writes raw samples to ./data/dossier/&lt;alias&gt;/raw/ (trades + chart) in development.\n  • Upserts result into sc_profiles for future local access.\n\nEnv:\n  OPENAI_API_KEY, OPENAI_RESPONSES_MODEL, SOLANATRACKER_API_KEY\n`)
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
        const defaultTraderName = process.env.TEST_TRADER ? String(process.env.TEST_TRADER).trim() : null;
        const limit = opts.limit ? Number(opts.limit) : undefined;
        const featureMintCount = opts.featureMintCount ? Number(opts.featureMintCount) : undefined;
        const harvestOnly = !!opts.harvestOnly;

        let traderName = cliTraderName || null;
        if (!cliTraderName && defaultTraderName) {
            const rl = readline.createInterface({ input, output });
            try {
                const modeLabel = harvestOnly ? 'harvest-only (no AI run)' : 'full dossier (AI + DB)';
                const answerRaw = await rl.question(
                    `[scoundrel] No --name provided. Use default trader alias "${defaultTraderName}" for wallet ${walletId} in ${modeLabel} mode? [y/N] `
                );
                const answer = (answerRaw || '').trim().toLowerCase();
                if (answer === 'y' || answer === 'yes') {
                    traderName = defaultTraderName;
                } else {
                    logger.info('[scoundrel] Continuing without default trader alias; artifacts will be tagged by wallet only.');
                }
            } finally {
                rl.close();
            }
        }

        const trackKol = !!opts.trackKol;

        // KOL tracking:
        // - If --track-kol is set, do it non-interactively (requires -n/--name).
        // - If a CLI name is provided without --track-kol, ask the user whether to track.
        if (trackKol) {
            if (!cliTraderName) {
                logger.error('[scoundrel] --track-kol requires -n/--name <traderName>');
                process.exit(1);
            }
            await walletsDomain.kol.ensureKolWallet({
                walletAddress: walletId,
                alias: cliTraderName,
            });
        } else if (cliTraderName) {
            const rl = readline.createInterface({ input, output });
            try {
                const answerRaw = await rl.question(
                    `[scoundrel] Track "${cliTraderName}" as a KOL wallet in sc_wallets? [y/N] `
                );
                const answer = (answerRaw || '').trim().toLowerCase();
                if (answer === 'y' || answer === 'yes') {
                    await walletsDomain.kol.ensureKolWallet({
                        walletAddress: walletId,
                        alias: cliTraderName,
                    });
                    logger.info(`[scoundrel] ✅ tracked KOL wallet: ${cliTraderName} (${shortenPubkey(walletId)})`);
                }
            } finally {
                rl.close();
            }
        }
        const alias = normalizeTraderAlias(traderName, walletId);

        // Disallow --resend with --harvest-only
        if (opts.resend && harvestOnly) {
            logger.error('[scoundrel] Cannot use --resend with --harvest-only; resend always runs AI.');
            process.exit(1);
        }

        logger.info(`[scoundrel] Dossier (simplified${harvestOnly ? ', harvest-only' : ''}) for ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
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
                const { analyzeWallet } = require('./ai/jobs/walletDossier');
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
            const runAnalysis = !harvestOnly;
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime, limit, featureMintCount, runAnalysis });

            // HARVEST-ONLY mode: skip AI and DB upsert, print summary and exit
            if (harvestOnly) {
                const count = (result && typeof result.count === 'number') ? result.count : 0;
                logger.info(`[scoundrel] ✅ harvested ${count} trades (harvest-only) for ${walletId}`);
                const baseDir = dossierBaseDir(alias);
                logger.info(`[scoundrel] Artifacts written under ${baseDir}`);
                process.exit(0);
            }

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
    .option('--trade-uuid <uuid>', 'Run autopsy by trade_uuid (loads trades from DB and enriches with SolanaTracker context)')
    .option('--wallet <aliasOrAddress>', 'Wallet alias or address (non-interactive)')
    .option('--mint <address>', 'Token mint to analyze (non-interactive)')
    .option('--no-tui', 'Disable the Ink TUI prompts (automation-friendly)')
    .addHelpText('after', `\nFlow:\n  • Default (interactive): choose a HUD wallet (or enter another address) and enter the token mint to analyze.\n  • DB mode (--trade-uuid): load all sc_trades rows for a trade_uuid and assemble the autopsy payload from DB + SolanaTracker context.\n\nOutput:\n  • Prints the AI narrative to the console.\n  • Persists the autopsy payload + response to the DB.\n\nExamples:\n  $ scoundrel autopsy\n  $ scoundrel autopsy --trade-uuid <TRADE_UUID>\n\nNotes:\n  • --trade-uuid is intended for analyzing a single position-run / campaign already recorded in sc_trades.\n`)
    .action(async (opts) => {
        try {
            const tradeUuid = opts && opts.tradeUuid ? String(opts.tradeUuid).trim() : '';
            const walletArg = opts && opts.wallet ? String(opts.wallet).trim() : '';
            const mintArg = opts && opts.mint ? String(opts.mint).trim() : '';
            const tuiDisabled = opts && opts.tui === false;

            if (tradeUuid) {
                const result = await runAutopsy({ tradeUuid });
                process.exitCode = result ? 0 : 0;
                return;
            }

            if (tuiDisabled) {
                if (!walletArg || !mintArg) {
                    logger.error('[autopsy] --no-tui requires --wallet and --mint');
                    process.exitCode = 1;
                    return;
                }

                const { walletLabel, walletAddress } = await resolveAutopsyWallet({
                    walletLabel: walletArg,
                    walletAddress: walletArg,
                });
                const result = await runAutopsy({ walletLabel, walletAddress, mint: mintArg });
                process.exitCode = result ? 0 : 0;
                return;
            }

            if (walletArg && mintArg) {
                const { walletLabel, walletAddress } = await resolveAutopsyWallet({
                    walletLabel: walletArg,
                    walletAddress: walletArg,
                });
                const result = await runAutopsy({ walletLabel, walletAddress, mint: mintArg });
                process.exitCode = result ? 0 : 0;
                return;
            }

            const { render } = await import('ink');
            const { loadAutopsyPrompt } = require('./lib/wallets/inkAutopsyPrompt');
            const { AutopsyPrompt } = await loadAutopsyPrompt();

            const { waitUntilExit } = render(
                React.createElement(AutopsyPrompt, {
                    defaultMint: mintArg,
                    onSubmit: async ({ walletLabel, walletAddress, mint }) => {
                        try {
                            const result = await runAutopsy({ walletLabel, walletAddress, mint });
                            process.exitCode = result ? 0 : 0;
                        } catch (err) {
                            logAutopsyError(err);
                            process.exitCode = 1;
                        }
                    },
                })
            );
            await waitUntilExit();
            return;
        } catch (err) {
            logAutopsyError(err);
            process.exitCode = 1;
            return;
        } finally {
            try { await BootyBox.close(); } catch (_) {}
        }
    });

program
    .command('devscan')
    .description('Fetch DevScan token/developer data, persist artifacts, and optionally summarize with AI')
    .option('--mint <address>', 'Token mint address to query')
    .option('--dev <wallet>', 'Developer wallet address to query')
    .option('--devtokens <wallet>', 'Developer wallet address to list tokens for')
    .option('--raw-only', 'Skip OpenAI analysis and only write raw artifacts')
    .addHelpText('after', `\nExamples:\n  $ scoundrel devscan --mint <MINT>\n  $ scoundrel devscan --dev <WALLET>\n  $ scoundrel devscan --devtokens <WALLET>\n  $ scoundrel devscan --mint <MINT> --dev <WALLET>\n\nNotes:\n  • Requires DEVSCAN_API_KEY in the environment.\n  • Uses xAI_API_KEY for AI summaries unless --raw-only is set.\n  • Writes JSON artifacts under ./data/devscan/.\n`)
    .action(async (opts) => {
        const mint = opts && opts.mint ? String(opts.mint).trim() : '';
        const developerWallet = opts && opts.dev ? String(opts.dev).trim() : '';
        const developerTokensWallet = opts && opts.devtokens ? String(opts.devtokens).trim() : '';
        const runAnalysis = !(opts && opts.rawOnly);

        if (!mint && !developerWallet && !developerTokensWallet) {
            logger.error('[scoundrel] devscan requires --mint, --dev, or --devtokens');
            process.exitCode = 1;
            return;
        }

        if (mint && !isBase58Mint(mint)) {
            logger.error('[scoundrel] devscan --mint must be a valid base58 address (32-44 chars)');
            process.exitCode = 1;
            return;
        }
        if (developerWallet && !isBase58Mint(developerWallet)) {
            logger.error('[scoundrel] devscan --dev must be a valid base58 address (32-44 chars)');
            process.exitCode = 1;
            return;
        }
        if (developerTokensWallet && !isBase58Mint(developerTokensWallet)) {
            logger.error('[scoundrel] devscan --devtokens must be a valid base58 address (32-44 chars)');
            process.exitCode = 1;
            return;
        }

        if (!process.env.DEVSCAN_API_KEY) {
            logger.error('[scoundrel] DEVSCAN_API_KEY is required for devscan');
            process.exitCode = 1;
            return;
        }
        if (runAnalysis && !process.env.xAI_API_KEY) {
            logger.error('[scoundrel] xAI_API_KEY is required for devscan AI summaries');
            process.exitCode = 1;
            return;
        }

        try {
            const workerPath = join(__dirname, 'lib', 'warchest', 'workers', 'devscanWorker.js');
            const { result } = await forkWorkerWithPayload(workerPath, {
                timeoutMs: 60000,
                payload: {
                    mint: mint || null,
                    developerWallet: developerWallet || null,
                    developerTokensWallet: developerTokensWallet || null,
                    runAnalysis,
                },
            });

            if (result && result.token) {
                if (result.token.artifactPath) {
                    logger.info(`[scoundrel] devscan token artifact: ${result.token.artifactPath}`);
                } else {
                    logger.info('[scoundrel] devscan token response captured (artifact save disabled).');
                }
            }
            if (result && result.developer) {
                if (result.developer.artifactPath) {
                    logger.info(`[scoundrel] devscan developer artifact: ${result.developer.artifactPath}`);
                } else {
                    logger.info('[scoundrel] devscan developer response captured (artifact save disabled).');
                }
            }
            if (result && result.developerTokens) {
                if (result.developerTokens.artifactPath) {
                    logger.info(`[scoundrel] devscan developer tokens artifact: ${result.developerTokens.artifactPath}`);
                } else {
                    logger.info('[scoundrel] devscan developer tokens response captured (artifact save disabled).');
                }
            }

            if (result && result.promptPath) {
                logger.info(`[scoundrel] devscan prompt artifact: ${result.promptPath}`);
            }
            if (result && result.responsePath) {
                logger.info(`[scoundrel] devscan response artifact: ${result.responsePath}`);
            }

            if (result && result.openAiResult && result.openAiResult.markdown) {
                logger.info('\n=== DevScan Summary ===\n');
                logger.info(result.openAiResult.markdown);
            }
        } catch (err) {
            let message = err?.message || '';
            if (!message && err) {
                try {
                    message = typeof err === 'string' ? err : JSON.stringify(err);
                } catch (_) {
                    message = String(err);
                }
            }
            logger.error(`[scoundrel] devscan failed: ${message || '(unknown error)'}`);
            if (err && err.devscanError) {
                logger.error(
                    `[scoundrel] devscan error: ${err.devscanError.code} - ${err.devscanError.message}`,
                );
            }
            if (err && err.body) {
                logger.error(`[scoundrel] devscan response: ${util.inspect(err.body, { depth: 4, breakLength: 120 })}`);
            }
            process.exitCode = 1;
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
    .option('--swap', 'Also interpret this transaction as a swap for a specific wallet/mint')
    .option('-s, --session', 'Interactive review session for this transaction (TUI)')
    .option('-w, --wallet <aliasOrAddress>', 'Wallet alias or address that initiated the swap (focus wallet)')
    .option('-m, --mint <mint>', 'SPL mint address for the swapped token')
    .addHelpText('after', `\nExamples:\n  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ --sig ANOTHER_SIG --sig THIRD_SIG
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ -s
  $ scoundrel tx 2xbbCaokF84M9YXnuWK86nfayJemC5RvH6xqXwgw9fgC1dVWML4xBjq8idb1oX9hg16qcFHK5H51u3YyCfjfheTQ --swap --wallet DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

Notes:
  • Uses SolanaTracker RPC via your configured API key.
  • Shows status, network fee, and per-account SOL balance changes.
  • With --swap, also computes token + SOL deltas for the given wallet/mint.
  • With -s/--session, runs an interactive review session after inspection.
`)
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

// --- swap command ---
program
    .command('swap')
    .argument('[mint]', 'Token mint address to swap')
    .description('Execute a token swap via the SolanaTracker swap API or manage swap configuration')
    .option(
        '-w, --wallet <aliasOrAddress>',
        'Wallet alias or address from the wallet registry (ignored when using -c/--config)'
    )
    .option('-b, --buy <amount>', "Spend <amount> SOL (number or '<percent>%') to buy the token")
    .option('-s, --sell <amount>', "Sell <amount> of the token (number, 'auto', or '<percent>%')")
    .option('--dry-run', 'Build and simulate the swap without broadcasting the transaction')
    .option('--detach', 'Return immediately after tx submission; confirmation/persistence runs in background')
    .option('-c, --config', 'Manage swap configuration instead of executing a swap')
    .addHelpText('after', `\nExamples:\n  # Execute swaps\n  $ scoundrel swap 36xsfxxxxxxxxx2rta5pump -w warlord -b 0.1\n  $ scoundrel swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s 50%\n  $ scoundrel swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s auto --detach\n\n  # Manage swap configuration\n  $ scoundrel swap --config\n`)
    .action(async (mint, cmdOrOpts) => {
        // Commander v14 may pass either (args..., options) or (args..., Command).
        // If the last parameter has an .opts() function, treat it as the Command instance;
        // otherwise assume it's already the plain options object.
        const hasOptsMethod = cmdOrOpts && typeof cmdOrOpts.opts === 'function';
        const opts = hasOptsMethod ? cmdOrOpts.opts() : (cmdOrOpts || {});

        // Config mode (-c/--config): launch the swap config TUI
        if (opts.config) {
            try {
                const { loadSwapConfigApp } = require('./lib/tui/swapConfigApp');
                const { render } = await import('ink');
                const { SwapConfigApp } = await loadSwapConfigApp();
                const { waitUntilExit } = render(
                    React.createElement(SwapConfigApp, { onComplete: () => {} })
                );
                await waitUntilExit();
                return;
            } catch (err) {
                logger.error('[scoundrel:swap-config] ❌ config UI failed:', err?.message || err);
                process.exitCode = 1;
                return;
            }
        }

        // Swap execution mode: enforce -b/--buy or -s/--sell semantics and delegate to ./lib/cli/swap
        if (!mint) {
            logger.error('[scoundrel] swap requires a mint when not using -c/--config.');
            process.exit(1);
        }

        const hasBuy = !!opts.buy;
        const hasSell = !!opts.sell;

        if (!hasBuy && !hasSell) {
            logger.error('[scoundrel] swap requires exactly one of -b/--buy or -s/--sell.');
            process.exit(1);
        }

        if (hasBuy && hasSell) {
            logger.error('[scoundrel] swap cannot use both -b/--buy and -s/--sell in the same command.');
            process.exit(1);
        }

        // Sell semantics: auto = 100%, bare -s = 100%, "<percent>%" = percent of token balance
        if (hasSell) {
            const raw = String(opts.sell).trim();
            if (!raw || raw.toLowerCase() === 'auto') {
                // Treat as 100% panic dump; CLI passes a normalized flag for trade implementation.
                opts.sell = '100%';
                opts._panic = true;
            } else if (raw.endsWith('%')) {
                // Percent-of-balance sell; leave as-is for downstream interpretation.
                opts.sell = raw;
            } else {
                // Numeric amount sell is allowed; leave as-is.
                opts.sell = raw;
            }
        }

        // Buy semantics: "<percent>%" = percent of SOL balance; numeric = SOL amount
        if (hasBuy) {
            const raw = String(opts.buy).trim();
            if (raw.endsWith('%')) {
                // Percent-of-SOL-balance buy; leave as-is for downstream interpretation.
                opts.buy = raw;
            } else {
                // Numeric amount buy is allowed; leave as-is.
                opts.buy = raw;
            }
        }

        try {
            const tradeCli = require('./lib/cli/swap');
            if (typeof tradeCli !== 'function') {
                logger.error('[scoundrel] ./lib/cli/swap must export a default function (module.exports = async (mint, opts) => { ... })');
                process.exit(1);
            }
            await tradeCli(mint, opts);
            process.exit(0);
        } catch (err) {
            const msg = err && err.message ? err.message : err;
            logger.error(`[scoundrel] ❌ swap failed: ${msg}`);
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
    .command('wallet')
    .description('Manage your Scoundrel wallet registry')
    .argument('[subcommand]', 'add|list|remove|set-color')
    .argument('[arg1]', 'First argument for subcommand (e.g., alias)')
    .argument('[arg2]', 'Second argument for subcommand (e.g., color)')
    .option('-s, --solo', 'Select a single wallet interactively (registry-only for now)')
    .addHelpText('after', `
Examples:
  $ scoundrel wallet add
  $ scoundrel wallet list
  $ scoundrel wallet remove sampleWallet
  $ scoundrel wallet set-color sampleWallet cyan
  $ scoundrel wallet -solo
`)
    .action(async (subcommand, arg1, arg2, cmd) => {
        const args = [];

        const opts = cmd.opts ? cmd.opts() : {};
        if (opts.solo) {
            // wallet CLI expects "-solo" or "--solo" in argv
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
            logger.error('[scoundrel] ❌ wallet command failed:', err?.message || err);
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
    .description('Run the warchest HUD follower or clean up legacy daemon artifacts')
    .argument('<action>', 'start|stop|restart|hud|status')
    .option(
        '--wallet <spec>',
        'Wallet spec alias:pubkey:color (repeatable, use multiple --wallet flags)',
        (value, previous) => {
            if (!previous) return [value];
            return previous.concat(value);
        }
    )
    .option('--hud', 'Render HUD output (for start/restart actions)')
    .option('--no-follow-hub', 'Disable following hub status/event files')
    .option('--hub-events <path>', 'Override hub event file path (default: data/warchest/tx-events.json)')
    .option('--hub-status <path>', 'Override hub status file path (default: data/warchest/status.json)')
    .addHelpText('after', `
Examples:
  # Start HUD follower (foreground) with hub event/status files
  $ scoundrel warchestd start --wallet sampleWallet:DDkFpJDsUbnPx43mgZZ8WRgrt9Hupjns5KAzYtf7E9ZR:orange

  # Start HUD follower with HUD rendering enabled
  $ scoundrel warchestd start --wallet sampleWallet:DDkF...:orange --hud

  # One-off HUD session with selector fallback
  $ scoundrel warchestd hud --wallet sampleWallet:DDkF...:orange

  # Clear legacy PID files
  $ scoundrel warchestd stop

  # Show hub/HUD health snapshot
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

            const followHub = opts.followHub !== false;
            const hubEventsPath = opts.hubEvents;
            const hubStatusPath = opts.hubStatus;

            if (action === 'start') {
                // Default to starting the daemon headless; enable HUD only when explicitly requested.
                const hud = !!opts.hud;
                await warchestService.start({ walletSpecs, hud, followHub, hubEventsPath, hubStatusPath });
            } else if (action === 'stop') {
                await warchestService.stop();
            } else if (action === 'restart') {
                // Default to restarting the daemon headless; enable HUD only when explicitly requested.
                const hud = !!opts.hud;
                await warchestService.restart({ walletSpecs, hud, followHub, hubEventsPath, hubStatusPath });
            } else if (action === 'hud') {
                // Dedicated HUD action: run the HUD in the foreground as a TUI viewer.
                warchestService.hud({ walletSpecs, followHub, hubEventsPath, hubStatusPath });
            } else if (action === 'status') {
                // Report daemon + health snapshot status without modifying state.
                await warchestService.status({ statusPath: hubStatusPath });
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
    .addHelpText('after', `\nChecks:\n  • Ensures OPENAI_API_KEY is present.\n  • Verifies presence of core files in ./lib and ./ai.\n  • Attempts a BootyBox SQLite init/ping and prints DB path.\n\nExample:\n  $ scoundrel test\n`)
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
            join(__dirname, 'ai', 'jobs', 'walletDossier.js'),
            join(__dirname, 'lib', 'cli', 'ask.js'),
        ];
        logger.info('\n[scoundrel] core files:');
        pathsToCheck.forEach(p => {
            const ok = existsSync(p);
            logger.info(`  ${relative(process.cwd(), p)}: ${ok ? 'present' : 'missing'}`);
        });

        // DB diagnostics
        const { BOOTYBOX_SQLITE_PATH = join(__dirname, 'db', 'bootybox.db') } = process.env;

        logger.info('\n[db] configuration:');
        logger.info(`  Engine   : sqlite`);
        logger.info(`  Path     : ${BOOTYBOX_SQLITE_PATH}`);

        try {
            if (typeof BootyBox.init === 'function') {
                await BootyBox.init();
            }
            if (typeof BootyBox.ping === 'function') {
                await BootyBox.ping();
            }
            logger.info('[db] ✅ sqlite reachable');
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

// Default/help handling is provided by commander
program.parseAsync(process.argv);
