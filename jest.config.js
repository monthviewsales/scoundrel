'use strict';

module.exports = {
  testEnvironment: 'node',
  collectCoverage: !!process.env.COVERAGE,
  collectCoverageFrom: [
    'lib/**/*.js',
    'commands/**/*.js',
    'ai/**/*.js',
    'db/**/*.js',
    '!**/__tests__/**',
    '!db/test/**',
    '!node_modules/**',
  ],
  coverageDirectory: 'artifacts/coverage',
  coverageReporters: ['text', 'lcov'],
};
