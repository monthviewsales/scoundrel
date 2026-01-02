#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['.git', 'node_modules']);

/**
 * @param {string} dir
 * @param {string[]} files
 * @returns {string[]}
 */
function collectJsFiles(dir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectJsFiles(path.join(dir, entry.name), files);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

/**
 * @param {string} source
 * @returns {string}
 */
function stripShebang(source) {
  if (source.startsWith('#!')) {
    const newlineIndex = source.indexOf('\n');
    return newlineIndex === -1 ? '' : source.slice(newlineIndex + 1);
  }
  return source;
}

/**
 * @param {string} file
 * @returns {Error|null}
 */
function checkSyntax(file) {
  const source = stripShebang(fs.readFileSync(file, 'utf8'));
  try {
    new vm.Script(source, { filename: file });
    return null;
  } catch (error) {
    return error;
  }
}

const files = collectJsFiles(ROOT_DIR, []);
const failures = [];

for (const file of files) {
  const error = checkSyntax(file);
  if (error) {
    failures.push({ file, error });
  }
}

if (failures.length) {
  for (const failure of failures) {
    const message = failure.error && failure.error.message ? failure.error.message : String(failure.error);
    console.error(`[lint] ${failure.file}`);
    console.error(message);
  }
  process.exit(1);
}

console.log(`[lint] Checked ${files.length} JS files.`);
