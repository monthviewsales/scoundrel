'use strict';

const fs = require('fs');
const path = require('path');

// Directories to skip during scan
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.idea',
  'coverage',
  'data',
  'profiles',
  'logs',
]);

const LOG_CALL_RE = /(logger\.(?:info|warn|error|debug|log)|console\.(?:log|info|warn|error|debug))/i;
const SENSITIVE_RE = /(private\s*key|secret\s*key|mnemonic|seed\s*phrase|passphrase)/i;

function walkFiles(startDir, files = []) {
  const entries = fs.readdirSync(startDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function findSensitiveLogs(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const hits = [];

  lines.forEach((line, idx) => {
    if (!LOG_CALL_RE.test(line)) return;
    if (SENSITIVE_RE.test(line)) {
      hits.push({ file: filePath, line: idx + 1, text: line.trim() });
    }
  });

  return hits;
}

describe('no sensitive key material is logged', () => {
  test('logger/console calls do not include private/secret key terms', () => {
    const root = path.join(__dirname, '..');
    const files = walkFiles(root);
    const findings = files.flatMap(findSensitiveLogs);

    const message = findings
      .map((f) => `${f.file}:${f.line} => ${f.text}`)
      .join('\n');

    expect(findings).toHaveLength(0);
  });
});
