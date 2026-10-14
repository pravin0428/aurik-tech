'use strict';

const os = require('os');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../logger');
const { getPool, checkConnectivity, closePool } = require('../db/pool');
const { createRegistry } = require('../modules/processing/registry');
const repository = require('../modules/processing/processing.repository');
const { createWorker } = require('../modules/processing/worker');
const normalizeSubmission = require('../modules/processing/handlers/normalizeSubmission');

/**
 * Default worker identity: unique per process so two workers (even on the same
 * host) never share a lease owner id. Overridable via WORKER_ID.
 */
function buildWorkerId() {
  const host = os.hostname();
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${config.serviceName}:${host}:${process.pid}:${nonce}`;
}

async function start() {
  const workerId = config.worker.id || buildWorkerId();

  logger.info({ workerId }, 'Worker starting');

  getPool();
  try {
    await checkConnectivity();
    logger.info('Worker: database connectivity verified');
  } catch (err) {
    logger.error({ err }, 'Worker: database connectivity check failed');
  }

  // The registry is where job-specific logic plugs in. Phase 5 registers the
  // normalize_submission handler, which runs the real normalization pipeline.
  const registry = createRegistry([normalizeSubmission]);
  logger.info({ handlers: registry.list() }, 'Worker: job handlers registered');

  const worker = createWorker({
    registry,
    repository,
    logger,
    settings: config.worker,
    workerId,
  });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, workerId }, 'Worker shutdown signal received');

    const timer = setTimeout(() => {
      logger.error('Worker shutdown timed out; forcing exit');
      process.exit(1);
    }, config.worker.shutdownTimeoutMs + 1000);
    timer.unref();

    try {
      await worker.stop();
      await closePool();
      clearTimeout(timer);
      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  worker.start();
}

if (require.main === module) {
  start().catch((err) => {
    logger.error({ err }, 'Failed to start worker');
    process.exit(1);
  });
}

module.exports = { start, buildWorkerId };
