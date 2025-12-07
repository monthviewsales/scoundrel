'use strict';

const sqliteAdapter = require('./BootyBoxSqliteAdapter');

const sharedHelpers = {
  init: jest.fn(),
  listWarchestWallets: jest.fn(),
  getWarchestWalletByAlias: jest.fn(),
  insertWarchestWallet: jest.fn(),
  deleteWarchestWallet: jest.fn(),
  getCoinByMint: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  recordWalletDossier: jest.fn(),
  recordDossierRun: jest.fn(),
  recordAutopsy: jest.fn(),
  recordWalletAnalysis: jest.fn(),
  applyScTradeEventToPositions: jest.fn(),
  recordScTradeEvent: jest.fn(),
  upsertProfileSnapshot: jest.fn(),
  persistWalletProfileArtifacts: jest.fn(),
  recordTune: jest.fn(),
  recordAsk: jest.fn(),
  recordJobRun: jest.fn(),
  close: jest.fn(),
};

Object.assign(sqliteAdapter, sharedHelpers);

module.exports = sqliteAdapter;
