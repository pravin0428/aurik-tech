'use strict';

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logger');

let pool;

/**
 * Lazily create a single shared PostgreSQL connection pool. Using one pool per
 * process avoids exhausting connections and gives us one place to tune limits.
 */
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      idleTimeoutMillis: config.db.idleTimeoutMs,
      connectionTimeoutMillis: config.db.connectionTimeoutMs,
      ssl: config.db.ssl,
      application_name: config.serviceName,
    });

    pool.on('error', (err) => {
      // Idle clients can emit errors (e.g. server restart); log and let the
      // pool discard the broken client rather than crashing the process.
      logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
    });
  }

  return pool;
}

/** Run a parameterized query against the shared pool. */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Connectivity probe used by readiness checks. Throws if the database cannot
 * be reached so callers can decide how to report the failure.
 */
async function checkConnectivity() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1 AS ok');
    return true;
  } finally {
    client.release();
  }
}

/** Close the pool. Safe to call multiple times. */
async function closePool() {
  if (!pool) return;
  const active = pool;
  pool = undefined;
  await active.end();
}

module.exports = {
  getPool,
  query,
  checkConnectivity,
  closePool,
};
