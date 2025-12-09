'use strict';

module.exports = {
  registry: require('./registry'),
  selection: require('./walletSelection'),
  management: require('./walletManagement'),
  kol: require('./kolManager'),
  state: require('./state'),
  scanner: require('./scanner'),
  resolver: require('./resolver'),
  getWalletForSwap: require('./getWalletForSwap'),
  options: require('./optionsManager'),
};
