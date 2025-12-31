'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read and parse a JSON file from disk.
 * @param {string} filePath
 * @returns {any}
 */
function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Resolve absolute paths to strategy schemas.
 * @returns {{ flash: string, hybrid: string, campaign: string }}
 */
function getStrategySchemaPaths() {
  // This module lives under: lib/warchest/workers/sellOps
  // Strategies live at:       lib/analysis/schemas/*.json
  const base = path.resolve(__dirname, '..', '..', '..', 'analysis', 'schemas');
  return {
    flash: path.join(base, 'flashStrategy.v1.json'),
    hybrid: path.join(base, 'hybridStrategy.v1.json'),
    campaign: path.join(base, 'campaignStrategy.v1.json'),
  };
}

/**
 * Load strategy docs once per process.
 * @returns {{ flash: object, hybrid: object, campaign: object }}
 */
function loadStrategyDocs() {
  const p = getStrategySchemaPaths();
  return {
    flash: readJsonFile(p.flash),
    hybrid: readJsonFile(p.hybrid),
    campaign: readJsonFile(p.campaign),
  };
}

module.exports = {
  getStrategySchemaPaths,
  loadStrategyDocs,
  readJsonFile,
};
