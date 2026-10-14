'use strict';

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const { getPool, checkConnectivity, closePool } = require('./db/pool');

function installShutdown(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    const timer = setTimeout(() => {
      logger.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    timer.unref();

    try {
      await new Promise((resolve) => server.close(resolve));
      await closePool();
      clearTimeout(timer);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Start the HTTP API. Database connectivity is probed at startup for early
 * feedback, but a failure does not abort the process: `/ready` continues to
 * report the database as unavailable until it recovers.
 */
async function start() {
  getPool();

  try {
    await checkConnectivity();
    logger.info('Database connectivity verified at startup');
  } catch (err) {
    logger.error({ err }, 'Database connectivity check failed at startup; readiness will report not_ready');
  }

  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(config.http.port, config.http.host, resolve);
  });

  logger.info(
    { host: config.http.host, port: config.http.port },
    'API server listening'
  );

  installShutdown(server);
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    logger.error({ err }, 'Failed to start API server');
    process.exit(1);
  });
}

module.exports = { start };
