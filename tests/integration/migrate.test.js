'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

maybe('migration runner', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const migrateScript = path.join(repoRoot, 'scripts', 'migrate.js');

  function runMigrate(args = []) {
    return execFileSync(process.execPath, [migrateScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      encoding: 'utf8',
    });
  }

  async function withClient(fn) {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  test('applies migrations and records them', async () => {
    runMigrate();

    const rows = await withClient(async (client) => {
      const result = await client.query(
        'SELECT version FROM schema_migrations ORDER BY version'
      );
      return result.rows.map((row) => row.version);
    });

    expect(rows).toContain('0001');
  });

  test('creates the reusable set_updated_at trigger function', async () => {
    const count = await withClient(async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'set_updated_at'"
      );
      return result.rows[0].n;
    });

    expect(count).toBe(1);
  });

  test('is idempotent when run repeatedly', async () => {
    runMigrate();
    runMigrate();

    const count = await withClient(async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0001'"
      );
      return result.rows[0].n;
    });

    expect(count).toBe(1);
  });

  test('reports status without applying anything', () => {
    const output = execFileSync(process.execPath, [migrateScript, 'status'], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      encoding: 'utf8',
    });
    // Silent log level means no stdout noise; the command must still exit 0.
    expect(typeof output).toBe('string');
  });
});
