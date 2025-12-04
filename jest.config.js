'use strict';

module.exports = {
  testEnvironment: 'node',
  collectCoverage: !!process.env.COVERAGE,
  collectCoverageFrom: [
    'lib/**/*.js',
    'commands/**/*.js',
    'ai/**/*.js',
    '!**/__tests__/**',
    '!packages/**',
    '!node_modules/**',
  ],
  coverageDirectory: 'artifacts/coverage',
  coverageReporters: ['text', 'lcov'],
  moduleNameMapper: {
    '^.*\/packages\/BootyBox$': '<rootDir>/__mocks__/BootyBox.js',
    '^.*\/packages\/BootyBox/src/adapters/mysql$': '<rootDir>/__mocks__/BootyBoxMysqlAdapter.js',
    '^.*\/packages\/BootyBox/src/adapters/sqlite$': '<rootDir>/__mocks__/BootyBoxSqliteAdapter.js',
  },
};
