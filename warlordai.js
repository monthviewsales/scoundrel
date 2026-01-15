#!/usr/bin/env node
'use strict';

require('./lib/env/safeDotenv').loadDotenv();

const { Command } = require('commander');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const React = require('react');
const readline = require('readline');
const util = require('util');
const logger = require('./lib/logger');
const { runWarlordAIAsk } = require('./lib/cli/warlordai');
const { createWarlordAIClient } = require('./lib/warchest/warlordAIClient');
const { harvestWallet } = require('./lib/cli/dossier');
const { runAutopsy } = require('./lib/cli/autopsy');
const { forkWorkerWithPayload } = require('./lib/warchest/workers/harness');
const { normalizeMintList, runTargetScan } = require('./lib/targetScan');
const {
  assertValidMintAddress,
  assertValidWalletAddress,
} = require('./lib/solana/addressValidation');

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
  const walletAddress = assertValidWalletAddress(opts.wallet);
  const result = await harvestWallet({
    wallet: walletAddress,
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
  const walletAddress = opts.wallet ? assertValidWalletAddress(opts.wallet) : null;
  const mintAddress = opts.mint ? assertValidMintAddress(opts.mint) : null;
  await runAutopsy({
    tradeUuid: opts.tradeUuid || null,
    walletLabel: opts.walletLabel || null,
    walletAddress,
    mint: mintAddress,
  });
}

async function handleSwap(mint, cmdOrOpts) {
  const hasOptsMethod = cmdOrOpts && typeof cmdOrOpts.opts === 'function';
  const opts = hasOptsMethod ? cmdOrOpts.opts() : cmdOrOpts || {};

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
      const msg = err?.message || err;
      throw new Error(`[warlordai:swap-config] ❌ config UI failed: ${msg}`);
    }
  }

  if (!mint) {
    throw new Error('[warlordai] swap requires a mint when not using -c/--config.');
  }
  const normalizedMint = assertValidMintAddress(mint);

  const hasBuy = !!opts.buy;
  const hasSell = !!opts.sell;

  if (!hasBuy && !hasSell) {
    throw new Error('[warlordai] swap requires exactly one of -b/--buy or -s/--sell.');
  }

  if (hasBuy && hasSell) {
    throw new Error('[warlordai] swap cannot use both -b/--buy and -s/--sell in the same command.');
  }

  if (hasSell) {
    const raw = String(opts.sell).trim();
    if (!raw || raw.toLowerCase() === 'auto') {
      opts.sell = '100%';
      opts._panic = true;
    } else if (raw.endsWith('%')) {
      opts.sell = raw;
    } else {
      opts.sell = raw;
    }
  }

  if (hasBuy) {
    const raw = String(opts.buy).trim();
    if (raw.endsWith('%')) {
      opts.buy = raw;
    } else {
      opts.buy = raw;
    }
  }

  const tradeCli = require('./lib/cli/swap');
  if (typeof tradeCli !== 'function') {
    throw new Error(
      '[warlordai] ./lib/cli/swap must export a default function (module.exports = async (mint, opts) => { ... })'
    );
  }
  await tradeCli(normalizedMint, opts);
}

async function handleDevscan(opts) {
  const mint = opts && opts.mint ? String(opts.mint).trim() : '';
  const developerWallet = opts && opts.dev ? String(opts.dev).trim() : '';
  const developerTokensWallet =
    opts && opts.devtokens ? String(opts.devtokens).trim() : '';
  let runAnalysis = !(opts && opts.rawOnly);

  if (mint && !developerWallet && !developerTokensWallet) {
    runAnalysis = false;
  }

  if (!mint && !developerWallet && !developerTokensWallet) {
    throw new Error('[warlordai] devscan requires --mint, --dev, or --devtokens');
  }

  const validatedMint = mint ? assertValidMintAddress(mint) : '';
  const validatedDevWallet = developerWallet ? assertValidWalletAddress(developerWallet) : '';
  const validatedDevTokensWallet = developerTokensWallet
    ? assertValidWalletAddress(developerTokensWallet)
    : '';

  if (!process.env.DEVSCAN_API_KEY) {
    throw new Error('[warlordai] DEVSCAN_API_KEY is required for devscan');
  }
  if (runAnalysis && !process.env.xAI_API_KEY) {
    throw new Error(
      '[warlordai] xAI_API_KEY is required for devscan AI summaries'
    );
  }

  const workerPath = join(
    __dirname,
    'lib',
    'warchest',
    'workers',
    'devscanWorker.js'
  );
  const { result } = await forkWorkerWithPayload(workerPath, {
    timeoutMs: 120000,
    payload: {
      mint: validatedMint || null,
      developerWallet: validatedDevWallet || null,
      developerTokensWallet: validatedDevTokensWallet || null,
      runAnalysis,
    },
  });

  if (result && result.token) {
    if (result.token.artifactPath) {
      logger.info(
        `[warlordai] devscan token artifact: ${result.token.artifactPath}`
      );
    } else {
      logger.info(
        '[warlordai] devscan token response captured (artifact save disabled).'
      );
    }
  }
  if (result && result.developer) {
    if (result.developer.artifactPath) {
      logger.info(
        `[warlordai] devscan developer artifact: ${result.developer.artifactPath}`
      );
    } else {
      logger.info(
        '[warlordai] devscan developer response captured (artifact save disabled).'
      );
    }
  }
  if (result && result.developerTokens) {
    if (result.developerTokens.artifactPath) {
      logger.info(
        `[warlordai] devscan developer tokens artifact: ${result.developerTokens.artifactPath}`
      );
    } else {
      logger.info(
        '[warlordai] devscan developer tokens response captured (artifact save disabled).'
      );
    }
  }

  if (result && result.promptPath) {
    logger.info(`[warlordai] devscan prompt artifact: ${result.promptPath}`);
  }
  if (result && result.responsePath) {
    logger.info(`[warlordai] devscan response artifact: ${result.responsePath}`);
  }

  if (result && result.openAiResult && result.openAiResult.markdown) {
    logger.info('\n=== DevScan Summary ===\n');
    logger.info(result.openAiResult.markdown);
  }
}

async function handleTuneStrategy(opts) {
  let profile = null;

  if (opts.name) {
    const alias = opts.name.replace(/[^a-z0-9_-]/gi, '_');
    const profilePath = join(process.cwd(), 'profiles', `${alias}.json`);
    if (!existsSync(profilePath)) {
      throw new Error(`[warlordai] profile not found: ${profilePath}`);
    }
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  }

  const tuneProcessor = require('./lib/cli/tuneStrategy');
  const runner =
    typeof tuneProcessor === 'function'
      ? tuneProcessor
      : tuneProcessor && tuneProcessor.run;
  if (!runner) {
    throw new Error(
      '[warlordai] ./lib/cli/tuneStrategy must export a default function or { run }'
    );
  }
  await runner({
    strategyName: opts.strategy,
    strategyPath: opts.strategyPath || null,
    profile,
    showJson: Boolean(opts.showJson),
  });
}

async function handleTargetScan(opts) {
  const mints = normalizeMintList([opts.mint, opts.mints]);
  if (!mints.length) {
    throw new Error('[warlordai] targetscan requires --mint or --mints');
  }
  const validatedMints = mints.map((mint) => assertValidMintAddress(mint));

  const sendVectorStore = Boolean(opts?.sendVectorStore);
  const result = await runTargetScan({
    mints: validatedMints,
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
  .command('devscan')
  .description(
    'Fetch DevScan token/developer data, persist artifacts, and optionally summarize with AI'
  )
  .option('--mint <address>', 'Token mint address to query')
  .option('--dev <wallet>', 'Developer wallet address to query')
  .option('--devtokens <wallet>', 'Developer wallet address to list tokens for')
  .option('--raw-only', 'Skip OpenAI analysis and only write raw artifacts')
  .addHelpText(
    'after',
    '\nExamples:\n  $ warlordai devscan --mint <MINT>\n  $ warlordai devscan --dev <WALLET>\n  $ warlordai devscan --devtokens <WALLET>\n  $ warlordai devscan --mint <MINT> --dev <WALLET>\n\nNotes:\n  • Requires DEVSCAN_API_KEY in the environment.\n  • Uses xAI_API_KEY for AI summaries unless --raw-only is set.\n  • Writes JSON artifacts under ./data/devscan/.\n'
  )
  .action(async (opts) => {
    try {
      await handleDevscan(opts);
    } catch (err) {
      let message = err?.message || '';
      if (!message && err) {
        try {
          message = typeof err === 'string' ? err : JSON.stringify(err);
        } catch (_) {
          message = String(err);
        }
      }
      logger.error(
        `[warlordai] devscan failed: ${message || '(unknown error)'}`
      );
      if (err && err.devscanError) {
        logger.error(
          `[warlordai] devscan error: ${err.devscanError.code} - ${err.devscanError.message}`
        );
      }
      if (err && err.body) {
        logger.error(
          `[warlordai] devscan response: ${util.inspect(err.body, {
            depth: 4,
            breakLength: 120,
          })}`
        );
      }
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
  .addHelpText(
    'after',
    '\nNotes:\n  • Manual runs emit a HUD event with symbol, buyScore, and summary.\n'
  )
  .action(async (opts) => {
    try {
      await handleTargetScan(opts);
    } catch (err) {
      logger.error(`[warlordai] targetscan failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program
  .command('swap')
  .argument('[mint]', 'Token mint address to swap')
  .description(
    'Execute a token swap via the SolanaTracker swap API or manage swap configuration'
  )
  .option(
    '-w, --wallet <aliasOrAddress>',
    'Wallet alias or address from the wallet registry (ignored when using -c/--config)'
  )
  .option(
    '-b, --buy <amount>',
    "Spend <amount> SOL (number or '<percent>%') to buy the token"
  )
  .option(
    '-s, --sell <amount>',
    "Sell <amount> of the token (number, 'auto', or '<percent>%')"
  )
  .option(
    '--dry-run',
    'Build and simulate the swap without broadcasting the transaction'
  )
  .option(
    '--detach',
    'Return immediately after tx submission; confirmation/persistence runs in background'
  )
  .option(
    '-c, --config',
    'Manage swap configuration instead of executing a swap'
  )
  .addHelpText(
    'after',
    '\nExamples:\n  # Execute swaps\n  $ warlordai swap 36xsfxxxxxxxxx2rta5pump -w warlord -b 0.1\n  $ warlordai swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s 50%\n  $ warlordai swap 36xsf1xquajvto11slgf6hmqkqp2ieibh7v2rta5pump -w warlord -s auto --detach\n\n  # Manage swap configuration\n  $ warlordai swap --config\n'
  )
  .action(async (mint, cmdOrOpts) => {
    try {
      await handleSwap(mint, cmdOrOpts);
    } catch (err) {
      const msg = err?.message || err;
      logger.error(`[warlordai] ❌ swap failed: ${msg}`);
      process.exitCode = 1;
    }
  });

program
  .command('tune-strategy')
  .alias('tune')
  .description(
    'Interactive strategy tuner for memecoin sell/buy settings (OpenAI)'
  )
  .option('-s, --strategy <name>', 'Strategy name (flash, hybrid, campaign)')
  .option('-p, --strategy-path <path>', 'Custom path to a strategy JSON file')
  .option(
    '-n, --name <traderName>',
    'Optional trader profile alias (loads ./profiles/<name>.json)'
  )
  .option('--show-json', 'Print proposed JSON changes/patches', false)
  .addHelpText(
    'after',
    '\nExamples:\n  $ warlordai tune-strategy --strategy flash\n  $ warlordai tune -s hybrid\n  $ warlordai tune --strategy-path ./lib/analysis/schemas/campaignStrategy.v1.json\n  $ warlordai tune -n Gh0stee\n\nNotes:\n  • If no strategy is specified, a selector will prompt you to choose one.\n  • Reads strategy JSON from ./lib/analysis/schemas by name unless --strategy-path is provided.\n  • Optional profile context is loaded from ./profiles/<name>.json.\n  • Suggestions are advisory only; you manually edit strategy files.\n'
  )
  .action(async (opts) => {
    try {
      await handleTuneStrategy(opts);
    } catch (err) {
      logger.error(`[warlordai] ❌ tune-strategy failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(`[warlordai] fatal error: ${err?.message || err}`);
  process.exit(1);
});
