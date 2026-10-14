'use strict';

const { getPool } = require('./pool');
const logger = require('../logger');

/**
 * Run `handler` inside a database transaction, always releasing the client.
 * Commits on success, rolls back on any thrown error, and re-throws so callers
 * can decide how to surface the failure.
 *
 * The handler receives the dedicated client and MUST use it for every query in
 * the transaction (e.g. `await client.query('...', [params])`).
 */
async function withTransaction(handler) {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Failed to roll back transaction');
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
