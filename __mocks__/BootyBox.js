'use strict';

const mysqlAdapter = require('./BootyBoxMysqlAdapter');
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

Object.assign(mysqlAdapter, sharedHelpers);
Object.assign(sqliteAdapter, sharedHelpers);

function selectAdapter() {
  const engine = (process.env.DB_ENGINE || 'sqlite').toLowerCase();
  if (engine === 'mysql') {
    return mysqlAdapter;
  }
  if (engine === 'sqlite') {
    return sqliteAdapter;
  }

  // eslint-disable-next-line no-console
  console.warn(`[BootyBox] Unknown DB_ENGINE "${process.env.DB_ENGINE}", defaulting to sqlite`);
  return sqliteAdapter;
}

module.exports = selectAdapter();
