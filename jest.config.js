'use strict';

module.exports = {
  testEnvironment: 'node',
  collectCoverage: !!process.env.COVERAGE,
  collectCoverageFrom: [
    'lib/**/*.js',
    'ai/**/*.js',
    'db/**/*.js',
    '!**/__tests__/**',
    '!db/test/**',
    '!node_modules/**',
  ],
  testPathIgnorePatterns: ['/__tests__/fixtures/'],
  coverageDirectory: 'artifacts/coverage',
  coverageReporters: ['text', 'lcov'],
};
