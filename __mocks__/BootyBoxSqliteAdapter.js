'use strict';

module.exports = {
  engine: 'sqlite',
  init: jest.fn(),
  addOrUpdateCoin: jest.fn(),
  getCoinByMint: jest.fn(),
};
