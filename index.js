#!/usr/bin/env node
// index.js — Scoundrel CLI
require('dotenv').config();
const { program } = require('commander');

function loadHarvest() {
  try {
    // Lazy-load to keep startup fast and allow running without Solana deps during setup
    return require('./lib/harvestWallet').harvestWallet;
  } catch (e) {
    console.error('[scoundrel] Missing ./lib/harvestWallet. Create a stub that exports { harvestWallet }.');
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

    console.log(`[scoundrel] Research starting for wallet ${walletId}…`);
    try {
      const result = await harvestWallet({ wallet: walletId, startTime, endTime });
      const count = (result && typeof result.count === 'number') ? result.count : 0;
      console.log(`[scoundrel] ✅ harvested ${count} trades from ${walletId}`);
      process.exit(0);
    } catch (err) {
      console.error('[scoundrel] ❌ error during harvest:', err?.message || err);
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Run a quick self-check (env + minimal OpenAI config presence)')
  .action(async () => {
    // Basic env + config checks; avoid hard dependency on OpenAI client here
    const hasKey = !!process.env.OPENAI_API_KEY;
    console.log('[scoundrel] environment check:');
    console.log(`  OPENAI_API_KEY: ${hasKey ? 'present' : 'MISSING'}`);
    console.log('  Working directory:', process.cwd());
    console.log('  Node version:', process.version);

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
