'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  autopsyBaseDir,
  dossierBaseDir,
  formatRunId,
  getArtifactConfig,
  loadLatestJson,
  readJsonArtifact,
  removeArtifacts,
  sanitizeSegment,
  writeJsonArtifact,
} = require('../../lib/persist/jsonArtifacts');

describe('jsonArtifacts helpers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sanitizeSegment normalizes strings and fallbacks', () => {
    expect(sanitizeSegment('Foo Bar!')).toBe('foo-bar');
    expect(sanitizeSegment('___Alpha__Beta___')).toBe('___alpha__beta___');
    expect(sanitizeSegment('', 'fallback')).toBe('fallback');
  });

  test('write/read/load helpers manage JSON artifacts', () => {
    const mergedDir = path.join(tmpDir, 'merged');
    const first = writeJsonArtifact(tmpDir, ['merged'], 'merged-001.json', { a: 1 });
    const second = writeJsonArtifact(tmpDir, ['merged'], 'merged-002.json', { b: 2 });

    expect(readJsonArtifact(first)).toEqual({ a: 1 });
    const latest = loadLatestJson(tmpDir, ['merged'], 'merged-');
    expect(latest.path).toBe(second);
    expect(latest.data).toEqual({ b: 2 });

    removeArtifacts([first, second]);
    expect(fs.existsSync(mergedDir)).toBe(true);
  });

  test('base dir helpers include sanitized segments', () => {
    const dossierDir = dossierBaseDir('Trader One');
    const autopsyDir = autopsyBaseDir('Wallet:123', 'Mint*456');
    expect(dossierDir).toContain(path.join('data', 'dossier', 'trader-one'));
    expect(autopsyDir).toContain(path.join('data', 'autopsy', 'wallet-123', 'mint-456'));
  });

  test('getArtifactConfig reads env booleans', () => {
    const original = {
      SAVE_RAW: process.env.SAVE_RAW,
      SAVE_PARSED: process.env.SAVE_PARSED,
      SAVE_ENRICHED: process.env.SAVE_ENRICHED,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.SAVE_RAW = 'true';
    process.env.SAVE_PARSED = 'TRUE';
    process.env.SAVE_ENRICHED = 'false';
    process.env.NODE_ENV = 'production';

    const cfg = getArtifactConfig();
    expect(cfg).toMatchObject({ saveRaw: true, saveParsed: true, saveEnriched: false, env: 'production' });

    process.env.SAVE_RAW = original.SAVE_RAW;
    process.env.SAVE_PARSED = original.SAVE_PARSED;
    process.env.SAVE_ENRICHED = original.SAVE_ENRICHED;
    process.env.NODE_ENV = original.NODE_ENV;
  });

  test('formatRunId returns filesystem-friendly string', () => {
    const runId = formatRunId();
    expect(runId).toMatch(/^[0-9T-]+Z?$/);
    expect(runId.includes(':')).toBe(false);
  });
});

