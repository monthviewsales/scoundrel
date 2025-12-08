#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const path = require('path');
const readline = require('readline');
const { version: pkgVersion } = require('./package.json');
const logger = require('./lib/log');
const BootyBox = require('./db');
const WalletManagerV2 = require('./lib/WalletManagerV2');
const { loadDossier } = require('./lib/dossier');
const { ensureTxInsight } = require('./lib/services/txInsightService');
const { writeSwapSummary } = require('./lib/trades');
const { resolveVersion } = require('./lib/version');
const { listWallets, selectWallet } = require('./lib/cli/walletSelector');
const { createAskCommand } = require('./lib/cli/ask');
const { createTuneCommand } = require('./lib/cli/tuneStrategy');
const { createDossierCommand } = require('./lib/cli/dossier');
const { createAutopsyCommand } = require('./lib/cli/autopsy');
const { createTxCommand } = require('./lib/cli/tx');
const { createTxInspectorCommand } = require('./scripts/txInspectorCli');
const { createWarchestHudCommand } = require('./scripts/warchestHudWorker');
const WalletRegistry = require('./lib/warchest/walletRegistry');
const pkg = require('./package.json');

const DEFAULT_CONCURRENCY = Number(process.env.FEATURE_MINT_COUNT || 8);

function handleGlobalError(err) {
    try {
        logger.error(err.message || err);
    } catch (loggingErr) {
        console.error('logger.error failed:', loggingErr);
    }

    try {
        logger.error('[global] Fatal error, exiting.');
    } catch (_) {}

    try {
        process.exit(1);
    } catch (_) {}

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
        const harvestWallet = loadDossier();

        const parseTs = (v) => {
            if (!v) return undefined;
            if (/^\d+$/.test(v)) return Number(v);
            return Date.parse(v);
        };

... (rest of file) ...
