'use strict';
// lib/cli/tuneStrategy.js (interactive strategy tuner)

require('../env/safeDotenv').loadDotenv();
const { readFileSync, readdirSync } = require('fs');
const { join, resolve, basename } = require('path');
const readline = require('readline');
const React = require('react');
const logger = require('../logger');
const { createCommandRun } = require('./aiRun');
const { runTuneStrategy } = require('../../ai/jobs/tuneStrategy');

const STRATEGY_DIR = join(__dirname, '..', 'analysis', 'schemas');
const DEFAULT_STRATEGY_NAME = 'flash';
const DEFAULT_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
const DEFAULT_TEMPERATURE = 0.2;
const MAX_HISTORY_MESSAGES = 12;

/**
 * Discover available strategy names from the schemas directory.
 * @returns {string[]}
 */
function listStrategyNames() {
  const entries = readdirSync(STRATEGY_DIR);
  return entries
    .map((name) => {
      const match = name.match(/^(.*)Strategy\.v1\.json$/);
      return match ? match[1].toLowerCase() : null;
    })
    .filter(Boolean)
    .sort();
}

/**
 * Select a strategy name using an Ink TUI.
 * @param {string[]} options
 * @returns {Promise<string>}
 */
async function selectStrategyName(options) {
  if (!options.length) throw new Error('[tune] No strategy schemas found.');
  const ink = await import('ink');
  const { render, Box, Text, useInput, useApp } = ink;

  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      fn(value);
    }

    function StrategySelector() {
      const [index, setIndex] = React.useState(0);
      const { exit } = useApp();

      useInput((_input, key) => {
        if (key.upArrow) {
          setIndex((prev) => (prev - 1 + options.length) % options.length);
        } else if (key.downArrow) {
          setIndex((prev) => (prev + 1) % options.length);
        } else if (key.return) {
          settle(resolve, options[index]);
          exit();
        } else if (key.escape) {
          settle(reject, new Error('[tune] Strategy selection cancelled.'));
          exit();
        }
      });

      return React.createElement(
        Box,
        { flexDirection: 'column', paddingBottom: 1 },
        React.createElement(Text, { bold: true }, 'Select a strategy to tune:'),
        React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          options.map((option, i) =>
            React.createElement(
              Text,
              { key: option, color: i === index ? 'cyan' : undefined },
              `${i === index ? '›' : ' '} ${option}`
            )
          )
        ),
        React.createElement(Text, { dimColor: true }, '↑/↓ to move, Enter to select, Esc to cancel')
      );
    }

    const app = render(React.createElement(StrategySelector));
    app.waitUntilExit()
      .then(() => {
        if (!settled) {
          settle(reject, new Error('[tune] Strategy selection cancelled.'));
        }
      })
      .catch((err) => {
        if (!settled) settle(reject, err);
      });
  });
}

/**
 * Resolve a strategy JSON path from a known name or explicit path.
 * @param {string} [strategyName]
 * @param {string} [strategyPath]
 * @returns {{ label: string, path: string, strategy: Object, meta: { name: string, path: string } }}
 */
function loadStrategy(strategyName, strategyPath) {
  let normalizedName = strategyName ? String(strategyName).toLowerCase() : null;
  const resolvedPath = strategyPath
    ? resolve(strategyPath)
    : join(__dirname, '..', 'analysis', 'schemas', `${(normalizedName || DEFAULT_STRATEGY_NAME)}Strategy.v1.json`);

  if (!normalizedName && strategyPath) {
    const fileName = basename(resolvedPath);
    const match = fileName.match(/^(.*)Strategy\.v1\.json$/);
    normalizedName = match ? match[1].toLowerCase() : DEFAULT_STRATEGY_NAME;
  }

  if (!normalizedName) normalizedName = DEFAULT_STRATEGY_NAME;

  const label = strategyPath ? resolvedPath : normalizedName;
  const raw = readFileSync(resolvedPath, 'utf8');
  const strategy = JSON.parse(raw);
  return { label, path: resolvedPath, strategy, meta: { name: normalizedName, path: resolvedPath } };
}

/**
 * Limit history size to a fixed number of messages (user + assistant pairs).
 * @param {Array<{ role: 'user'|'assistant', content: string }>} history
 * @returns {Array<{ role: 'user'|'assistant', content: string }>}
 */
function pruneHistory(history) {
  if (!Array.isArray(history)) return [];
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  return history.slice(history.length - MAX_HISTORY_MESSAGES);
}

/**
 * Render a response payload into a readable string.
 * @param {Object} out
 * @returns {string}
 */
function formatAnswer(out) {
  let result = out.answer || '';
  if (Array.isArray(out.bullets) && out.bullets.length) {
    result += '\n\n• ' + out.bullets.join('\n• ');
  }
  if (Array.isArray(out.actions) && out.actions.length) {
    result += '\n\nNext actions:\n- ' + out.actions.join('\n- ');
  }
  if (Array.isArray(out.questions) && out.questions.length) {
    result += '\n\nFollow-up questions:\n- ' + out.questions.join('\n- ');
  }
  if (Array.isArray(out.risks) && out.risks.length) {
    result += '\n\nRisks:\n- ' + out.risks.join('\n- ');
  }
  if (typeof out.rationale === 'string' && out.rationale.trim()) {
    result += `\n\nWhy: ${out.rationale.trim()}`;
  }
  return result.trim();
}

/**
 * Print JSON change suggestions when present.
 * @param {Object} out
 */
function printJsonSuggestions(out) {
  if (out.changes && typeof out.changes === 'object' && Object.keys(out.changes).length) {
    logger.info('\nProposed changes (JSON):\n' + JSON.stringify(out.changes, null, 2));
  }
  if (Array.isArray(out.patch) && out.patch.length) {
    logger.info('\nJSON Patch:\n' + JSON.stringify(out.patch, null, 2));
  }
}

/**
 * Start an interactive strategy tuning chat session.
 * @param {Object} args
 * @param {string} [args.strategyName]
 * @param {string} [args.strategyPath]
 * @param {Object|null} [args.profile]
 * @param {string} [args.model]
 * @param {number} [args.temperature]
 * @param {boolean} [args.showJson]
 * @returns {Promise<void>}
 */
module.exports = async function tuneStrategy({
  strategyName,
  strategyPath,
  profile = null,
  model = DEFAULT_MODEL,
  temperature = DEFAULT_TEMPERATURE,
  showJson = false,
}) {
  let resolvedName = strategyName;
  let resolvedPath = strategyPath;
  if (!resolvedName && !resolvedPath) {
    resolvedName = await selectStrategyName(listStrategyNames());
  }

  const { label, path: resolvedPathFinal, strategy, meta } = loadStrategy(resolvedName, resolvedPath);
  const { runId, artifacts } = createCommandRun({
    command: 'tune-strategy',
    segments: [label],
    logger,
  });

  logger.info(`[tune] Strategy loaded: ${resolvedPathFinal}`);
  logger.info(`[tune] Run: ${runId}`);
  logger.info('[tune] Ask questions about your strategy. Commands: :exit, :clear, :help');

  const history = [];
  let turnCount = 0;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  try {
    let active = true;
    while (active) {
      const raw = await ask('tune> ');
      const question = String(raw || '').trim();

      if (!question) continue;
      if (question === ':exit' || question === ':quit') {
        active = false;
        continue;
      }
      if (question === ':clear') {
        history.length = 0;
        logger.info('[tune] Cleared chat history.');
        continue;
      }
      if (question === ':help') {
        logger.info('Commands:\n  :exit  Quit the session\n  :clear Clear chat history\n  :help  Show this help');
        continue;
      }

      turnCount += 1;
      const historySnapshot = pruneHistory(history).map((entry) => ({ ...entry }));
      const payload = {
        strategy,
        strategyMeta: meta,
        profile,
        history: historySnapshot,
        question,
      };

      artifacts.write('prompt', `prompt-${turnCount}`, payload);

      const out = await runTuneStrategy({
        strategy,
        strategyMeta: meta,
        profile,
        history: historySnapshot,
        question,
        model,
        temperature,
      });

      artifacts.write('response', `response-${turnCount}`, out);

      const answer = formatAnswer(out);
      if (answer) logger.info(answer);
      if (showJson) printJsonSuggestions(out);

      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: answer || '' });
    }
  } finally {
    rl.close();
  }
};
