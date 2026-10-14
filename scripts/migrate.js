'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getPool, closePool } = require('../src/db/pool');
const logger = require('../src/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const FILENAME_PATTERN = /^(\d+)_.+\.sql$/;
// Arbitrary but stable key so concurrent runners serialise on the same lock.
const ADVISORY_LOCK_KEY = 728481;

/**
 * Read and validate every migration file, sorted by numeric version.
 * Each file's checksum is computed so we can detect edits to applied files.
 */
function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => FILENAME_PATTERN.test(file))
    .map((file) => {
      const version = FILENAME_PATTERN.exec(file)[1];
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      return { version, file, sql, checksum };
    })
    .sort((a, b) => Number(a.version) - Number(b.version));
}

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function ensureMigrationsTable(client) {
  await client.query(MIGRATIONS_TABLE_SQL);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query(
    'SELECT version, checksum FROM schema_migrations'
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

/** Fail if an already-applied file's contents changed. */
function assertNoChecksumDrift(migrations, applied) {
  for (const migration of migrations) {
    const appliedChecksum = applied.get(migration.version);
    if (appliedChecksum && appliedChecksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.file} changed after it was applied. ` +
          'Do not modify applied migrations; add a new numbered migration instead.'
      );
    }
  }
}

async function applyPending(client, migrations, applied) {
  let count = 0;

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum]
      );
      await client.query('COMMIT');
      count += 1;
      logger.info({ migration: migration.file, version: migration.version }, 'Applied migration');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to apply migration ${migration.file}: ${err.message}`, {
        cause: err,
      });
    }
  }

  return count;
}

function printStatus(migrations, applied) {
  if (migrations.length === 0) {
    logger.info('No migration files found');
    return;
  }
  for (const migration of migrations) {
    const state = applied.has(migration.version) ? 'applied' : 'pending';
    logger.info({ version: migration.version, file: migration.file, state }, 'Migration status');
  }
}

/**
 * Connect, take an advisory lock (so multiple runners cannot clobber each
 * other), then either report status or apply pending migrations. The pool is
 * always closed before returning.
 */
async function run(command = 'up') {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const migrations = loadMigrations();
    const applied = await getAppliedMigrations(client);
    assertNoChecksumDrift(migrations, applied);

    if (command === 'status') {
      printStatus(migrations, applied);
      return { command, applied: [...applied.keys()] };
    }

    const appliedCount = await applyPending(client, migrations, applied);
    logger.info(
      { applied: appliedCount, total: migrations.length },
      'Migration run complete'
    );
    return { command, appliedCount, total: migrations.length };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch (err) {
      logger.warn({ err }, 'Failed to release migration advisory lock');
    }
    client.release();
    await closePool();
  }
}

async function main() {
  const command = process.argv[2] || 'up';
  if (!['up', 'status'].includes(command)) {
    logger.error({ command }, 'Unknown migration command');
    process.exitCode = 1;
    return;
  }
  try {
    await run(command);
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadMigrations,
  ensureMigrationsTable,
  getAppliedMigrations,
  assertNoChecksumDrift,
  applyPending,
  run,
};
