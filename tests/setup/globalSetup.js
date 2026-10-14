'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Applied once before any test file runs. Ensures the database schema exists
 * for integration tests without each test file re-implementing migration logic.
 *
 * Does nothing when TEST_DATABASE_URL is absent (unit-only runs).
 */
module.exports = async function globalSetup() {
  if (!process.env.TEST_DATABASE_URL) return undefined;

  const repoRoot = path.join(__dirname, '..', '..');

  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'migrate.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      LOG_LEVEL: 'silent',
    },
    stdio: 'inherit',
  });

  return undefined;
};
