'use strict';
// lib/cli/tuneStrategy.js (interactive strategy tuner)

require('../env/safeDotenv').loadDotenv();
const { readFileSync, readdirSync } = require('fs');
const { join, resolve, basename } = require('path');
const React = require('react');
const logger = require('../logger');
const { createCommandRun } = require('./aiRun');
const { runTuneStrategy } = require('../../ai/jobs/tuneStrategy');

const STRATEGY_DIR = join(__dirname, '..', 'analysis', 'schemas');
const DEFAULT_STRATEGY_NAME = 'flash';
const DEFAULT_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4.1-mini';
const DEFAULT_TEMPERATURE = 0.2;
const MAX_HISTORY_MESSAGES = 12;
const MAX_DISPLAY_ENTRIES = 8;
const TURN_EMOJI_DIVIDER = '🤘👀🍻💰💎🚀🤘👀🍻💰💎🚀🤘👀🍻💰💎🚀';

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
    let selection = null;
    let cancelled = false;

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
          selection = options[index];
          exit();
        } else if (key.escape) {
          cancelled = true;
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
        if (settled) return;
        if (cancelled || !selection) {
          settle(reject, new Error('[tune] Strategy selection cancelled.'));
          return;
        }
        settle(resolve, selection);
      })
      .catch((err) => {
        if (!settled) settle(reject, err);
      });
  });
}

async function loadInkForTune() {
  // Ink + ink-text-input are ESM (and may use top-level await), so they must be loaded via dynamic import.
  const ink = await import('ink');
  const inkTextInputMod = await import('ink-text-input');
  const TextInput = inkTextInputMod?.default || inkTextInputMod;
  return { ink, TextInput };
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
 * Render JSON change suggestions when present.
 * @param {Object} out
 * @returns {string}
 */
function formatJsonSuggestions(out) {
  let result = '';
  if (out.changes) {
    if (typeof out.changes === 'string') {
      try {
        const parsed = JSON.parse(out.changes);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
          result += `\n\nProposed changes (JSON):\n${JSON.stringify(parsed, null, 2)}`;
        }
      } catch (_) {
        result += `\n\nProposed changes (JSON):\n${out.changes}`;
      }
    } else if (typeof out.changes === 'object' && Object.keys(out.changes).length) {
      result += `\n\nProposed changes (JSON):\n${JSON.stringify(out.changes, null, 2)}`;
    }
  }
  if (Array.isArray(out.patch) && out.patch.length) {
    result += `\n\nJSON Patch:\n${JSON.stringify(out.patch, null, 2)}`;
  }
  return result.trim();
}

/**
 * Start the Ink-based strategy tuning chat session.
 * @param {Object} params
 * @param {Object} params.strategy
 * @param {Object} params.strategyMeta
 * @param {Object|null} params.profile
 * @param {string} params.model
 * @param {number} params.temperature
 * @param {boolean} params.showJson
 * @param {Object} params.artifacts
 * @returns {Promise<void>}
 */
async function runTuneInkSession({
  strategy,
  strategyMeta,
  profile,
  model,
  temperature,
  showJson,
  artifacts,
}) {
  const { ink, TextInput } = await loadInkForTune();
  const { render, Box, Text, useInput, useApp } = ink;

  return new Promise((resolve, reject) => {
    function TuneChat() {
      const { exit } = useApp();
      const [entries, setEntries] = React.useState([]);
      const [status, setStatus] = React.useState('');
      const [input, setInput] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const historyRef = React.useRef([]);
      const turnRef = React.useRef(0);

      useInput((_input, key) => {
        if (key.escape || (key.ctrl && _input === 'c')) {
          exit();
        }
      });

      function appendEntry(role, text) {
        setEntries((prev) => {
          const next = [...prev, { role, text }];
          return next.length > MAX_DISPLAY_ENTRIES ? next.slice(-MAX_DISPLAY_ENTRIES) : next;
        });
      }

      async function handleSubmit(raw) {
        const question = String(raw || '').trim();
        if (!question || busy) return;

        if (question === ':exit' || question === ':quit') {
          exit();
          return;
        }
        if (question === ':clear') {
          historyRef.current = [];
          setEntries([]);
          setStatus('Cleared chat history.');
          setInput('');
          return;
        }
        if (question === ':help') {
          setStatus('Commands: :exit, :clear, :help');
          setInput('');
          return;
        }

        appendEntry('user', question);
        setInput('');
        setBusy(true);
        setStatus('Thinking...');

        const historySnapshot = pruneHistory(historyRef.current).map((entry) => ({ ...entry }));
        const payload = {
          strategy,
          strategyMeta,
          profile,
          history: historySnapshot,
          question,
        };

        turnRef.current += 1;
        artifacts.write('prompt', `prompt-${turnRef.current}`, payload);

        try {
          const out = await runTuneStrategy({
            strategy,
            strategyMeta,
            profile,
            history: historySnapshot,
            question,
            model,
            temperature,
          });

          artifacts.write('response', `response-${turnRef.current}`, out);

          let answer = formatAnswer(out);
          if (showJson) {
            const extra = formatJsonSuggestions(out);
            if (extra) {
              answer = `${answer}\n${extra}`.trim();
            }
          }

          appendEntry('assistant', answer || '(no response)');
          historyRef.current.push({ role: 'user', content: question });
          historyRef.current.push({ role: 'assistant', content: answer || '' });
          setStatus('');
        } catch (err) {
          setStatus(`Error: ${err?.message || err}`);
        } finally {
          setBusy(false);
        }
      }

      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, { bold: true }, 'Strategy Tuner'),
        React.createElement(Text, { dimColor: true }, 'Commands: :exit, :clear, :help'),
        status ? React.createElement(Text, { color: 'yellow' }, status) : null,
        React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          entries.map((entry, idx) =>
            entry.role === 'assistant'
              ? React.createElement(
                Box,
                { key: `${entry.role}-${idx}`, flexDirection: 'column' },
                React.createElement(
                  Text,
                  null,
                  `Scoundrel: ${entry.text}`
                ),
                React.createElement(Text, null, ''),
                React.createElement(Text, null, TURN_EMOJI_DIVIDER),
                React.createElement(Text, null, '')
              )
              : React.createElement(
                Text,
                { key: `${entry.role}-${idx}` },
                `You: ${entry.text}`
              )
          )
        ),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, null, 'tune> '),
          React.createElement(TextInput, {
            value: input,
            onChange: setInput,
            onSubmit: handleSubmit,
            focus: true,
            showCursor: true,
            placeholder: busy ? 'Waiting...' : 'Ask about your strategy',
          })
        )
      );
    }

    try {
      const app = render(React.createElement(TuneChat));
      app.waitUntilExit().then(resolve).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
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
 * @param {Function} [args.runSession] Optional session runner override (tests).
 * @returns {Promise<void>}
 */
module.exports = async function tuneStrategy({
  strategyName,
  strategyPath,
  profile = null,
  model = DEFAULT_MODEL,
  temperature = DEFAULT_TEMPERATURE,
  showJson = false,
  runSession,
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

  const sessionRunner = runSession || runTuneInkSession;
  if (sessionRunner === runTuneInkSession) {
    const isTty = !!process.stdout.isTTY && !!process.stdin.isTTY;
    if (!isTty) {
      throw new Error('[tune] interactive mode requires a TTY (stdin/stdout)');
    }
  }
  await sessionRunner({
    strategy,
    strategyMeta: meta,
    profile,
    model,
    temperature,
    showJson,
    artifacts,
  });
};
