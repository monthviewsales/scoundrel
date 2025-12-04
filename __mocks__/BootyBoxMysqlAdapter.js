'use strict';

module.exports = {
  engine: 'mysql',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  getCoinByMint: jest.fn(),
};
