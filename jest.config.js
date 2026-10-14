'use strict';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.js',
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: ['src/**/*.js', 'scripts/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  testTimeout: 20000,
};
