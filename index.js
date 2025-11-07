#!/usr/bin/env node
// index.js — Scoundrel CLI
require('dotenv').config();
const { program } = require('commander');
const fs = require('fs');
const path = require('path');

function loadHarvest() {
    try {
        // Lazy-load to keep startup fast and allow running without Solana deps during setup
        return require('./lib/harvestwallet').harvestWallet;
    } catch (e) {
        console.error('[scoundrel] Missing ./lib/harvestWallet. Create a stub that exports { harvestWallet }.');
        process.exit(1);
    }
}

function loadProcessor(name) {
    try {
        return require(`./lib/${name}`);
    } catch (e) {
        console.error(`[scoundrel] Missing ./lib/${name}. Create it and export a function (module.exports = async (args) => { ... }) or a named export.`);
        process.exit(1);
    }
}

program
    .name('scoundrel')
    .description('Research & validation tooling for memecoin trading using SolanaTracker + OpenAI')
    .version('0.1.0');

program.addHelpText('after', `\nEnvironment:\n  OPENAI_API_KEY              Required for OpenAI Responses\n  OPENAI_RESPONSES_MODEL      (default: gpt-4.1-mini)\n  SOLANATRACKER_API_KEY       Required for SolanaTracker Data API\n  NODE_ENV                    development|production (controls logging verbosity)\n`);

program
    .command('research')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades for a wallet, snapshot token states at trade time, and prep data for model analysis')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .addHelpText('after', `\nExamples:\n  $ scoundrel research <WALLET>\n  $ scoundrel research <WALLET> -n Gh0stee\n  $ scoundrel research <WALLET> --start 2025-01-01T00:00:00Z --end 2025-01-31T23:59:59Z\n\nFlags:\n  -s, --start <isoOrEpoch>  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end <isoOrEpoch>    End time; ISO or epoch seconds\n  -n, --name <traderName>   Optional alias to tag harvest artifacts\n\nNotes:\n  • Writes small samples to ./data/ for inspection in development.\n  • Uses SOLANATRACKER_API_KEY from .env.\n`)
    .action(async (walletId, opts) => {
        const harvestWallet = loadHarvest();

        // Parse optional times
        const parseTs = (v) => {
            if (!v) return undefined;
            if (/^\d+$/.test(v)) return Number(v);
            const d = new Date(v);
            if (isNaN(d.getTime())) {
                console.error('[scoundrel] Invalid time:', v);
                process.exit(1);
            }
            return Math.floor(d.getTime() / 1000);
        };

        const startTime = parseTs(opts.start);
        const endTime = parseTs(opts.end);
        const traderName = opts.name || process.env.TEST_TRADER || null;

        console.log(`[scoundrel] Research starting for wallet ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
        try {
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime });
            const count = (result && typeof result.count === 'number') ? result.count : 0;
            console.log(`[scoundrel] ✅ harvested ${count} trades from ${walletId}`);
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ error during harvest:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('build-profile')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades + chart and build a schema-locked profile JSON via OpenAI Responses')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .option('-l, --limit <num>', 'Max trades to pull (default from HARVEST_LIMIT)')
    .addHelpText('after', `\nExamples:\n  $ scoundrel build-profile <WALLET>\n  $ scoundrel build-profile <WALLET> -n Gh0stee -l 500\n  $ scoundrel build-profile <WALLET> --start 1735689600 --end 1738367999\n\nFlags:\n  -s, --start <isoOrEpoch>  Start time; ISO (e.g., 2025-01-01T00:00:00Z) or epoch seconds\n  -e, --end <isoOrEpoch>    End time; ISO or epoch seconds\n  -n, --name <traderName>   Alias used as output filename under ./profiles/\n  -l, --limit <num>         Max trades to pull (default: HARVEST_LIMIT or 500)\n\nOutput:\n  • Writes schema-locked JSON to ./profiles/<name>.json using OpenAI Responses.\n  • Also writes raw samples to ./data/ (trades + chart) in development.\n\nEnv:\n  OPENAI_API_KEY, OPENAI_RESPONSES_MODEL, SOLANATRACKER_API_KEY\n`)
    .action(async (walletId, opts) => {
        const harvestWallet = loadHarvest();

        const parseTs = (v) => {
            if (!v) return undefined;
            if (/^\d+$/.test(v)) return Number(v);
            const d = new Date(v);
            if (isNaN(d.getTime())) {
                console.error('[scoundrel] Invalid time:', v);
                process.exit(1);
            }
            return Math.floor(d.getTime() / 1000);
        };

        const startTime = parseTs(opts.start);
        const endTime = parseTs(opts.end);
        const traderName = opts.name || process.env.TEST_TRADER || null;
        const limit = opts.limit ? Number(opts.limit) : undefined;

        console.log(`[scoundrel] Build-profile for ${walletId}${traderName ? ` (trader: ${traderName})` : ''}…`);
        try {
            const result = await harvestWallet({ wallet: walletId, traderName, startTime, endTime, limit });

            // Require the new Responses-based analysis
            if (!result || !result.openAiResult) {
                console.error('[scoundrel] No Responses output (openAiResult) returned by harvestWallet.');
                process.exit(1);
            }

            const dir = path.join(process.cwd(), 'profiles');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const fname = `${(traderName || walletId).replace(/[^a-z0-9_-]/gi, '_')}.json`;
            const outPath = path.join(dir, fname);
            fs.writeFileSync(outPath, JSON.stringify(result.openAiResult, null, 2));
            console.log(`[scoundrel] ✅ wrote profile (responses) to ${outPath}`);
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ build-profile failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('ask')
    .description('Ask a question about a trader using their saved profile (Responses API)')
    .requiredOption('-n, --name <traderName>', 'Trader alias used when saving the profile')
    .requiredOption('-q, --question <text>', 'Question to ask')
    .addHelpText('after', `\nExamples:\n  $ scoundrel ask -n Gh0stee -q "What patterns do you see?"\n  $ scoundrel ask -n Gh0stee -q "List common entry mistakes."\n\nFlags:\n  -n, --name <traderName>   Alias that matches ./profiles/<name>.json\n  -q, --question <text>     Natural language question\n\nNotes:\n  • Reads ./profiles/<name>.json as context.\n  • May also include recent enriched rows from ./data/ if available.\n`)
    .action(async (opts) => {
        const askProcessor = loadProcessor('ask');
        const profilePath = path.join(process.cwd(), 'profiles', `${opts.name.replace(/[^a-z0-9_-]/gi, '_')}.json`);
        if (!fs.existsSync(profilePath)) {
            console.error(`[scoundrel] profile not found: ${profilePath}`);
            process.exit(1);
        }
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

        // Optionally include recent enriched rows if present
        let rows = [];
        const dataDir = path.join(process.cwd(), 'data');
        if (fs.existsSync(dataDir)) {
            const candidates = fs.readdirSync(dataDir).filter(f => f.endsWith('-enriched.json'));
            if (candidates.length) {
                try {
                    const last = path.join(dataDir, candidates.sort().pop());
                    rows = JSON.parse(fs.readFileSync(last, 'utf8'));
                } catch (_) { }
            }
        }

        try {
            const runner = (typeof askProcessor === 'function') ? askProcessor : (askProcessor && askProcessor.ask);
            if (!runner) { console.error('[scoundrel] ./lib/ask must export a default function or { ask }'); process.exit(1); }
            const ans = await runner({ profile, question: opts.question, rows: rows.slice(0, 200) });
            console.log(ans);
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ ask failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('tune')
    .description('Get safe, incremental tuning recommendations based on a trader profile (Responses API)')
    .requiredOption('-n, --name <traderName>', 'Trader alias used when saving the profile')
    .addHelpText('after', `\nExamples:\n  $ scoundrel tune -n Gh0stee\n\nFlags:\n  -n, --name <traderName>   Alias that matches ./profiles/<name>.json\n\nNotes:\n  • Uses current settings from environment with sensible defaults.\n  • Returns concise advice plus optional structured changes.\n\nRelevant env (defaults in parentheses):\n  LIQUIDITY_FLOOR_USD (50000), SPREAD_CEILING_PCT (1.25), SLIPPAGE_PCT (0.8),\n  MAX_POSITION_PCT (0.35), TRAIL_STOP_TYPE (trailing), TRAIL_PCT (12),\n  TRAIL_ARM_AT_PROFIT_PCT (6), PRIORITY_FEE_SOL (0.00002)\n`)
    .action(async (opts) => {
        const tuneProcessor = loadProcessor('tune');
        const profilePath = path.join(process.cwd(), 'profiles', `${opts.name.replace(/[^a-z0-9_-]/gi, '_')}.json`);
        if (!fs.existsSync(profilePath)) {
            console.error(`[scoundrel] profile not found: ${profilePath}`);
            process.exit(1);
        }
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

        // Minimal current settings (could be read from your bot/env later)
        const currentSettings = {
            LIQUIDITY_FLOOR_USD: Number(process.env.LIQUIDITY_FLOOR_USD || 50000),
            SPREAD_CEILING_PCT: Number(process.env.SPREAD_CEILING_PCT || 1.25),
            SLIPPAGE_PCT: Number(process.env.SLIPPAGE_PCT || 0.8),
            MAX_POSITION_PCT: Number(process.env.MAX_POSITION_PCT || 0.35),
            TRAIL_STOP_TYPE: process.env.TRAIL_STOP_TYPE || 'trailing',
            TRAIL_PCT: Number(process.env.TRAIL_PCT || 12),
            TRAIL_ARM_AT_PROFIT_PCT: Number(process.env.TRAIL_ARM_AT_PROFIT_PCT || 6),
            PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.00002),
        };

        try {
            const runTune = (typeof tuneProcessor === 'function') ? tuneProcessor : (tuneProcessor && tuneProcessor.tune);
            if (!runTune) { console.error('[scoundrel] ./lib/tune must export a default function or { tune }'); process.exit(1); }
            const rec = await runTune({ profile, currentSettings });
            console.log(rec);
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ tune failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('test')
    .description('Run a quick self-check (env + minimal OpenAI config presence)')
    .addHelpText('after', `\nChecks:\n  • Ensures OPENAI_API_KEY is present.\n  • Verifies presence of core files in ./lib and ./ai.\n\nExample:\n  $ scoundrel test\n`)
    .action(async () => {
        const hasKey = !!process.env.OPENAI_API_KEY;
        console.log('[scoundrel] environment check:');
        console.log(`  OPENAI_API_KEY: ${hasKey ? 'present' : 'MISSING'}`);
        console.log('  Working directory:', process.cwd());
        console.log('  Node version:', process.version);

        // Check presence of core modules in the new pipeline
        const pathsToCheck = [
            path.join(__dirname, 'lib', 'harvestwallet.js'),
            path.join(__dirname, 'ai', 'client.js'),
            path.join(__dirname, 'ai', 'jobs', 'walletAnalysis.js'),
            path.join(__dirname, 'ai', 'schemas', 'walletAnalysis.v1.schema.json'),
            path.join(__dirname, 'lib', 'ask.js'),
            path.join(__dirname, 'lib', 'tune.js'),
        ];
        console.log('\n[scoundrel] core files:');
        pathsToCheck.forEach(p => {
            const ok = fs.existsSync(p);
            console.log(`  ${path.relative(process.cwd(), p)}: ${ok ? 'present' : 'missing'}`);
        });

        if (!hasKey) {
            console.log('\nTip: add OPENAI_API_KEY to your .env file.');
            process.exit(1);
        } else {
            console.log('\n[scoundrel] ✅ basic checks passed.');
            process.exit(0);
        }
    });

// Default/help handling is provided by commander
program.parseAsync(process.argv);