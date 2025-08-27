#!/usr/bin/env node
// index.js — Scoundrel CLI
require('dotenv').config();
const { program } = require('commander');
const fs = require('fs');
const path = require('path');

function loadHarvest() {
    try {
        // Lazy-load to keep startup fast and allow running without Solana deps during setup
        return require('./lib/harvestWallet').harvestWallet;
    } catch (e) {
        console.error('[scoundrel] Missing ./lib/harvestWallet. Create a stub that exports { harvestWallet }.');
        process.exit(1);
    }
}

function loadAI() {
    try {
        return require('./lib/openAiClient');
    } catch (e) {
        console.error('[scoundrel] Missing ./lib/openAiClient. Create it with exported methods.');
        process.exit(1);
    }
}

program
    .name('scoundrel')
    .description('Research & validation tooling for memecoin trading using SolanaTracker + OpenAI')
    .version('0.1.0');

program
    .command('research')
    .argument('<walletId>', 'Solana wallet address to analyze')
    .description('Harvest trades for a wallet, snapshot token states at trade time, and prep data for model analysis')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
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
    .description('Harvest + enrich trades, then build/save a TraderProfile JSON for this trader')
    .option('-s, --start <isoOrEpoch>', 'Start time (ISO or epoch seconds)')
    .option('-e, --end <isoOrEpoch>', 'End time (ISO or epoch seconds)')
    .option('-n, --name <traderName>', 'Trader alias for this wallet (e.g., Cupsey, Ansem)')
    .option('-l, --limit <num>', 'Max trades to pull (default from HARVEST_LIMIT)')
    .action(async (walletId, opts) => {
        const harvestWallet = loadHarvest();
        const { buildProfile } = loadAI();

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
            const enriched = result?.enriched || [];
            if (!enriched.length) {
                console.warn('[scoundrel] No enriched rows available from harvest; cannot build profile.');
                process.exit(1);
            }

            const profile = await buildProfile({ traderName: traderName || walletId, wallet: walletId, rows: enriched });
            const dir = path.join(process.cwd(), 'profiles');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const fname = `${(traderName || walletId).replace(/[^a-z0-9_-]/gi, '_')}.json`;
            const outPath = path.join(dir, fname);
            fs.writeFileSync(outPath, JSON.stringify(profile, null, 2));
            console.log(`[scoundrel] ✅ wrote profile to ${outPath}`);
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ build-profile failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('ask')
    .description('Ask a question about a trader’s historical choices using their saved profile')
    .requiredOption('-n, --name <traderName>', 'Trader alias used when saving the profile')
    .requiredOption('-q, --question <text>', 'Question to ask')
    .action(async (opts) => {
        const { answerTraderQuestion } = loadAI();
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
            const ans = await answerTraderQuestion({ profile, question: opts.question, rows: rows.slice(0, 200) });
            console.log(JSON.stringify(ans, null, 2));
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ ask failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('tune')
    .description('Get tuning recommendations for your bot based on a trader’s profile')
    .requiredOption('-n, --name <traderName>', 'Trader alias used when saving the profile')
    .action(async (opts) => {
        const { recommendTuning } = loadAI();
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
            const rec = await recommendTuning({ profile, currentSettings });
            console.log(JSON.stringify(rec, null, 2));
            process.exit(0);
        } catch (err) {
            console.error('[scoundrel] ❌ tune failed:', err?.message || err);
            process.exit(1);
        }
    });

program
    .command('test')
    .description('Run a quick self-check (env + minimal OpenAI config presence)')
    .action(async () => {
        const hasKey = !!process.env.OPENAI_API_KEY;
        console.log('[scoundrel] environment check:');
        console.log(`  OPENAI_API_KEY: ${hasKey ? 'present' : 'MISSING'}`);
        console.log('  Working directory:', process.cwd());
        console.log('  Node version:', process.version);

        // Schema presence (optional)
        const schemasDir = path.join(__dirname, 'lib', 'schemas');
        const schemaFiles = [
            'traderProfile.schema.json',
            'traderQA.schema.json',
            'tuningRecommendation.request.schema.json',
            'tuningRecommendation.result.schema.json',
        ];
        const schemaReport = schemaFiles.map(f => ({ f, exists: fs.existsSync(path.join(schemasDir, f)) }));
        console.log('\n[scoundrel] schemas:');
        schemaReport.forEach(s => console.log(`  ${s.f}: ${s.exists ? 'present' : 'missing'}`));

        // OpenAI client methods (optional)
        let methods = {};
        try { methods = loadAI(); } catch (_) { }
        const needed = ['analyzeBatch', 'buildProfile', 'answerTraderQuestion', 'recommendTuning'];
        console.log('\n[scoundrel] openAiClient methods:');
        needed.forEach(n => console.log(`  ${n}: ${methods && typeof methods[n] === 'function' ? 'ok' : 'missing'}`));

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