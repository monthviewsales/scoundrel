#!/usr/bin/env node
'use strict';

require('./lib/env/safeDotenv').loadDotenv();

const { Command } = require('commander');
const readline = require('readline');
const logger = require('./lib/logger');
const { runWarlordAIAsk } = require('./lib/cli/warlordai');
const { createWarlordAIClient } = require('./lib/warchest/warlordAIClient');
const { harvestWallet } = require('./lib/cli/dossier');
const { runAutopsy } = require('./lib/cli/autopsy');
const { normalizeMintList, runTargetScan } = require('./lib/targetScan');

function parseNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const num = parseNumber(value);
  if (num != null) return num;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function runInteractiveAsk({ session, rag, model, timeoutMs }, initialQuestion) {
  const client = createWarlordAIClient({ sessionId: session, logger });
  let activeSession = session || client.getSessionId();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => new Promise((resolve) => {
    rl.question('warlordai> ', resolve);
  });

  const handleExit = () => {
    try { rl.close(); } catch (_) {}
    try { client.close(); } catch (_) {}
  };

  process.on('SIGINT', () => {
    handleExit();
    process.exit(0);
  });

  logger.info('[warlordai] interactive mode: type "exit" to quit');
  if (activeSession) {
    logger.info(`[warlordai] session: ${activeSession}`);
  }

  let nextQuestion = initialQuestion || null;
  while (true) {
    const line = nextQuestion != null ? nextQuestion : await prompt();
    nextQuestion = null;
    const question = String(line || '').trim();
    if (!question) continue;
    if (['exit', 'quit', ':q'].includes(question.toLowerCase())) {
      break;
    }

    try {
      const result = await runWarlordAIAsk({
        question,
        rag,
        model,
        timeoutMs,
        client,
      });
      if (result.sessionId && !activeSession) {
        activeSession = result.sessionId;
        logger.info(`[warlordai] session: ${activeSession}`);
      }
      logger.info(result.text || '(no response)');
    } catch (err) {
      logger.error(`[warlordai] ask failed: ${err?.message || err}`);
    }
  }

  handleExit();
}

async function handleAsk(question, opts) {
  if (opts.interactive) {
    await runInteractiveAsk({
      session: opts.session,
      rag: opts.rag,
      model: opts.model,
      timeoutMs: parseNumber(opts.timeout),
    }, question);
    return;
  }

  const result = await runWarlordAIAsk({
    question,
    sessionId: opts.session,
    rag: opts.rag,
    model: opts.model,
    timeoutMs: parseNumber(opts.timeout),
  });

  if (result.sessionId) {
    logger.info(`[warlordai] session: ${result.sessionId}`);
  }
  logger.info(result.text || '(no response)');
}

async function handleDossier(opts) {
  if (!opts.wallet) {
    throw new Error('[warlordai] dossier requires --wallet');
  }
  const result = await harvestWallet({
    wallet: opts.wallet,
    traderName: opts.name || null,
    startTime: parseTimestamp(opts.start),
    endTime: parseTimestamp(opts.end),
    limit: parseNumber(opts.limit) || undefined,
    concurrency: parseNumber(opts.concurrency) || undefined,
    includeOutcomes: Boolean(opts.includeOutcomes),
    featureMintCount: parseNumber(opts.featureMintCount) || undefined,
    runAnalysis: !opts.rawOnly,
  });

  if (result && result.openAiResult && result.openAiResult.markdown) {
    logger.info(result.openAiResult.markdown);
  } else {
    logger.info('[warlordai] dossier complete');
  }
}

async function handleAutopsy(opts) {
  const isDbMode = Boolean(opts.tradeUuid);
  if (!isDbMode) {
    const missing = [];
    if (!opts.wallet) missing.push('--wallet');
    if (!opts.mint) missing.push('--mint');
    if (missing.length) {
      throw new Error(`[warlordai] autopsy missing required flag(s): ${missing.join(', ')} (use --trade-uuid or --wallet + --mint)`);
    }
  }
  await runAutopsy({
    tradeUuid: opts.tradeUuid || null,
    walletLabel: opts.walletLabel || null,
    walletAddress: opts.wallet || null,
    mint: opts.mint || null,
  });
}

async function handleTargetScan(opts) {
  const mints = normalizeMintList([opts.mint, opts.mints]);
  if (!mints.length) {
    throw new Error('[warlordai] targetscan requires --mint or --mints');
  }

  const sendVectorStore = Boolean(opts?.sendVectorStore);
  const result = await runTargetScan({
    mints,
    runAnalysis: !opts.rawOnly,
    concurrency: parseNumber(opts.concurrency) || undefined,
    manual: true,
    ...(sendVectorStore ? { sendVectorStore: true } : {}),
  });

  const results = Array.isArray(result?.results) ? result.results : [];
  const failures = results.filter((row) => row && row.error);
  logger.info(`[warlordai] targetscan complete: ${results.length - failures.length}/${results.length} succeeded`);
  results.forEach((row) => {
    if (!row || !row.mint) return;
    if (row.error) {
      logger.error(`[warlordai] targetscan ${row.mint} failed: ${row.error}`);
      return;
    }
    if (row.analysis && row.analysis.buyScore != null && row.analysis.rating) {
      logger.info(`[warlordai] targetscan ${row.mint} score=${row.analysis.buyScore} rating=${row.analysis.rating}`);
    }
  });
}

const program = new Command();
program
  .name('warlordai')
  .description('Unified WarlordAI CLI')
  .argument('[question]', 'Ask a question (default command)')
  .option('-s, --session <id>', 'Session id for follow-up memory')
  .option('--no-rag', 'Disable vector store retrieval')
  .option('-m, --model <name>', 'Override the OpenAI Responses model')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('-i, --interactive', 'Interactive ask mode')
  .action(async (question, opts) => {
    if (!question && !opts.interactive) {
      program.help();
      return;
    }
    try {
      await handleAsk(question, opts);
    } catch (err) {
      logger.error(`[warlordai] ask failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program
  .command('ask')
  .description('Ask a question (RAG + session memory)')
  .requiredOption('-q, --question <text>', 'Question to ask')
  .option('-s, --session <id>', 'Session id for follow-up memory')
  .option('--no-rag', 'Disable vector store retrieval')
  .option('-m, --model <name>', 'Override the OpenAI Responses model')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('-i, --interactive', 'Interactive ask mode')
  .action(async (opts) => {
    try {
      await handleAsk(opts.question, opts);
    } catch (err) {
      logger.error(`[warlordai] ask failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program
  .command('dossier')
  .description('Run a wallet dossier pipeline')
  .requiredOption('-w, --wallet <address>', 'Wallet address to analyze')
  .option('-n, --name <alias>', 'Trader alias/name')
  .option('--start <ts>', 'Start time (epoch ms or ISO)')
  .option('--end <ts>', 'End time (epoch ms or ISO)')
  .option('--limit <n>', 'Trade limit')
  .option('--concurrency <n>', 'Parallelism for wallet mint fetches')
  .option('--include-outcomes', 'Include outcome labels in analysis')
  .option('--feature-mint-count <n>', 'Override feature mint count')
  .option('--raw-only', 'Skip AI analysis and only write artifacts')
  .action(async (opts) => {
    try {
      await handleDossier(opts);
    } catch (err) {
      logger.error(`[warlordai] dossier failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program
  .command('autopsy')
  .description('Run a trade autopsy')
  .option('--trade-uuid <uuid>', 'Use a DB trade UUID')
  .option('-w, --wallet <address>', 'Wallet address (API mode)')
  .option('--wallet-label <label>', 'Wallet label (API mode)')
  .option('-m, --mint <address>', 'Token mint (API mode)')
  .action(async (opts) => {
    try {
      await handleAutopsy(opts);
    } catch (err) {
      logger.error(`[warlordai] autopsy failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program
  .command('targetscan')
  .description('Scan target mints and score buy opportunities')
  .option('--mint <address>', 'Single mint address to scan')
  .option('--mints <list>', 'Comma-delimited list of mints to scan')
  .option('--concurrency <n>', 'Parallel scans to run')
  .option('--raw-only', 'Skip AI scoring and only write artifacts')
  .option('--send-vector-store', 'Upload final artifacts to vector store')
  .action(async (opts) => {
    try {
      await handleTargetScan(opts);
    } catch (err) {
      logger.error(`[warlordai] targetscan failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(`[warlordai] fatal error: ${err?.message || err}`);
  process.exit(1);
});
