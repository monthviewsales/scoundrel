'use strict';

module.exports = {
  registry: require('./walletRegistry'),
  selection: require('./walletSelection'),
  management: require('./walletManagement'),
  kol: require('./kolManager'),
  state: require('./state'),
  scanner: require('./WalletScanner'),
  resolver: require('./resolver'),
  getWalletForSwap: require('./getWalletForSwap'),
  options: require('./optionsManager'),
};
