'use strict';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

maybe('withTransaction', () => {
  const { withTransaction } = require('../../src/db/tx');
  const { getPool, closePool } = require('../../src/db/pool');

  beforeAll(async () => {
    await getPool().query('CREATE TABLE IF NOT EXISTS _tx_test (id integer)');
  });

  afterAll(async () => {
    await getPool().query('DROP TABLE IF EXISTS _tx_test');
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE _tx_test');
  });

  test('commits changes on success', async () => {
    await withTransaction(async (client) => {
      await client.query('INSERT INTO _tx_test (id) VALUES ($1)', [1]);
    });

    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM _tx_test');
    expect(rows[0].n).toBe(1);
  });

  test('rolls back changes when the handler throws', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO _tx_test (id) VALUES ($1)', [2]);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM _tx_test');
    expect(rows[0].n).toBe(0);
  });

  test('releases the connection back to the pool after failure', async () => {
    const pool = getPool();
    const totalBefore = pool.totalCount;

    await withTransaction(async () => {
      throw new Error('expected failure');
    }).catch(() => {});

    // Idle count should reflect the released client; total should not grow.
    expect(pool.totalCount).toBe(totalBefore);
    expect(pool.idleCount).toBeGreaterThanOrEqual(1);
  });
});
