'use strict';

// Runs before the test framework and before any application module is required.
// Guarantees configuration dependencies exist so `src/config` can validate.

process.env.NODE_ENV = 'test';
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'aurik-tech';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';

// Small body limit keeps the oversized-payload test fast and deterministic.
process.env.REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '10kb';

// Integration tests only run when a dedicated test database is provided.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://aurik:aurik@localhost:5432/aurik_test';

// Ingestion auth is enabled for the whole suite so authentication behaviour is
// actually exercised rather than skipped.
process.env.INGESTION_AUTH_REQUIRED = 'true';
process.env.INGESTION_API_KEYS =
  'acme:test-key-acme,globex:test-key-globex';

// Worker settings: small, deterministic values. Backoff is fixed so retry
// timing assertions are stable (the worker injects a clock, but the config
// bounds still apply).
process.env.WORKER_POLL_INTERVAL_MS = process.env.WORKER_POLL_INTERVAL_MS || '20';
process.env.WORKER_BATCH_SIZE = process.env.WORKER_BATCH_SIZE || '10';
process.env.WORKER_RECOVERY_BATCH_SIZE = process.env.WORKER_RECOVERY_BATCH_SIZE || '10';
process.env.WORKER_MAX_ATTEMPTS = process.env.WORKER_MAX_ATTEMPTS || '3';
process.env.WORKER_LEASE_MS = process.env.WORKER_LEASE_MS || '5000';
process.env.WORKER_BACKOFF_BASE_MS = process.env.WORKER_BACKOFF_BASE_MS || '1000';
process.env.WORKER_BACKOFF_MAX_MS = process.env.WORKER_BACKOFF_MAX_MS || '60000';
