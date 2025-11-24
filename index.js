#!/usr/bin/env node
// index.js — Scoundrel CLI
require("dotenv").config({ quiet: true });
const logger = require('./lib/logger');
const { program } = require('commander');
const { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } = require('fs');
const { join, relative } = require('path');
const BootyBox = require('./lib/packages/bootybox');
const { requestId } = require('./lib/id/issuer');
const chalk = require('chalk');
const util = require('util');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { getAllWallets } = require('./lib/warchest/walletRegistry');
const { runAutopsy } = require('./lib/autopsy');
const {
    dossierBaseDir,
    loadLatestJson,
    normalizeTraderAlias,
} = require('./lib/persist/jsonArtifacts');
const warchestModule = require('./commands/warchest');
const warchestRun = typeof warchestModule === 'function'
    ? warchestModule
    : warchestModule && typeof warchestModule.run === 'function'
        ? warchestModule.run
        : null;

function loadHarvest() {
    try {
        // Lazy-load to keep startup fast and allow running without Solana deps during setup
        return require('./lib/dossier').harvestWallet;
    } catch (e) {
        logger.error('[scoundrel] Missing ./lib/dossier. Create a stub that exports { harvestWallet }.');
        process.exit(1);
    }
}

function loadProcessor(name) {
    try {
        return require(`./lib/${name}`);
    } catch (e) {
        logger.error(`[scoundrel] Missing ./lib/${name}. Create it and export a function (module.exports = async (args) => { ... }) or a named export.`);
        process.exit(1);
    }
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
    .version('0.1.0');

program.addHelpText('after', `\nEnvironment:\n  OPENAI_API_KEY              Required for OpenAI Responses\n  OPENAI_RESPONSES_MODEL      (default: gpt-4.1-mini)\n  FEATURE_MINT_COUNT          (default: 8) Number of recent mints to summarize for technique features\n  SOLANATRACKER_API_KEY       Required for SolanaTracker Data API\n  NODE_ENV                    development|production (controls logging verbosity)\n`);
program.addHelpText('after', `\nDatabase env:\n  DB_ENGINE=mysql\n  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_POOL_LIMIT (default 30)\n`);

program
    .command('research')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades for a wallet, snapshot token states at trade time, and prep data for model analysis')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .option('-f, --feature-mint-count <num>', 'How many recent mints to summarize for technique features (default: FEATURE_MINT_COUNT or 8)')
    .addHelpText('after', `\nExamples:\n  $ scoundrel research <WALLET>\n  $ scoundrel research <WALLET> -n Gh0stee\n  $ scoundrel research <WALLET> --start 2025-01-01T00:00:00Z --end 2025-01-31T23:59:59Z\n\nFlags:\n  -s, --start <isoOrEpoch>  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end <isoOrEpoch>    End time; ISO or epoch seconds\n  -n, --name <traderName>   Optional alias to tag harvest artifacts\n  -f, --feature-mint-count <num>  Number of recent mints to summarize for features (default: 8)\n\nNotes:\n  • Writes small samples to ./data/ for inspection in development.\n  • Uses SOLANATRACKER_API_KEY from .env.\n  • The configured feature-mint count is written to the merged meta for traceability.\n`)
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
        const traderName = opts.name || process.env.TEST_TRADER || null;
        const featureMintCount = opts.featureMintCount ? Number(opts.featureMintCount) : undefined;

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
    .addHelpText('after', `\nExamples:\n  $ scoundrel dossier &lt;WALLET&gt;\n  $ scoundrel dossier &lt;WALLET&gt; -n Gh0stee -l 500\n  $ scoundrel dossier &lt;WALLET&gt; --start 1735689600 --end 1738367999\n\nFlags:\n  -s, --start &lt;isoOrEpoch&gt;  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end &lt;isoOrEpoch&gt;    End time; ISO or epoch seconds\n  -n, --name &lt;traderName&gt;   Alias used as output filename under ./profiles/\n  -l, --limit &lt;num&gt;         Max trades to pull (default: HARVEST_LIMIT or 500)\n  -f, --feature-mint-count &lt;num&gt;  Number of recent mints to summarize for features (default: 8)\n\nOutput:\n  • Writes schema-locked JSON to ./profiles/&lt;name&gt;.json using OpenAI Responses.\n  • Also writes raw samples to ./data/ (trades + chart) in development.\n  • Upserts result into sc_profiles for future local access.\n\nEnv:\n  OPENAI_API_KEY, OPENAI_RESPONSES_MODEL, SOLANATRACKER_API_KEY\n`)
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
        const traderName = opts.name || process.env.TEST_TRADER || null;
        const limit = opts.limit ? Number(opts.limit) : undefined;
        const featureMintCount = opts.featureMintCount ? Number(opts.featureMintCount) : undefined;
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
            const wallets = await getAllWallets();
            const options = wallets.map((w, idx) => `${idx + 1}) ${w.alias} (${shortenPubkey(w.pubkey)})`);
            options.push(`${wallets.length + 1}) Other (enter address)`);

            logger.info('Which wallet?');
            options.forEach((opt) => logger.info(opt));
            let choice = await rl.question('> ');
            let walletLabel;
            let walletAddress;

            const numeric = Number(choice);
            if (Number.isInteger(numeric) && numeric >= 1 && numeric <= wallets.length) {
                const selected = wallets[numeric - 1];
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
    .command('ask')
    .description('Ask a question about a trader using their saved profile (Responses API)')
    .option('-n, --name <traderName>', 'Trader alias used when saving the profile (optional, defaults to "default" if omitted)')
    .requiredOption('-q, --question <text>', 'Question to ask')
    .addHelpText('after', `\nExamples:\n  $ scoundrel ask -n Gh0stee -q "What patterns do you see?"\n  $ scoundrel ask -n Gh0stee -q "List common entry mistakes."\n\nFlags:\n  -n, --name <traderName>   Alias that matches ./profiles/<name>.json\n  -q, --question <text>     Natural language question\n\nNotes:\n  • Reads ./profiles/<name>.json as context.\n  • May also include recent enriched rows from ./data/ if available.\n`)
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
        let rows = [];
        const dataDir = join(process.cwd(), 'data');
        if (existsSync(dataDir)) {
            const candidates = readdirSync(dataDir).filter(f => f.endsWith('-enriched.json'));
            if (candidates.length) {
                try {
                    const last = join(dataDir, candidates.sort().pop());
                    rows = JSON.parse(readFileSync(last, 'utf8'));
                } catch (_) { }
            }
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
    .command('test')
    .description('Run a quick self-check (env + minimal OpenAI config presence)')
    .addHelpText('after', `\nChecks:\n  • Ensures OPENAI_API_KEY is present.\n  • Verifies presence of core files in ./lib and ./ai.\n  • Attempts a MySQL connection and prints DB config.\n\nExample:\n  $ scoundrel test\n`)
    .action(async () => {
    console.log('[test] starting test action');
    const hasKey = !!process.env.OPENAI_API_KEY;
    logger.info('[scoundrel] environment check:');
        logger.info(`  OPENAI_API_KEY: ${hasKey ? 'present' : 'MISSING'}`);
        logger.info('  Working directory:', process.cwd());
        logger.info('  Node version:', process.version);

        // Check presence of core modules in the new pipeline
        const pathsToCheck = [
            join(__dirname, 'lib', 'dossier.js'),
            join(__dirname, 'ai', 'client.js'),
            join(__dirname, 'ai', 'jobs', 'walletAnalysis.js'),
            join(__dirname, 'lib', 'ask.js'),
        ];
        logger.info('\n[scoundrel] core files:');
        pathsToCheck.forEach(p => {
            const ok = existsSync(p);
            logger.info(`  ${relative(process.cwd(), p)}: ${ok ? 'present' : 'missing'}`);
        });

        // DB diagnostics
        const {
            DB_ENGINE = 'mysql',
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
            await BootyBox.ping();
            logger.info('[db] ✅ connected');
        } catch (e) {
            logger.info('[db] ❌ connection failed:', e?.message || e);
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
