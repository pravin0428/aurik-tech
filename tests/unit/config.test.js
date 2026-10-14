'use strict';

const { loadConfig } = require('../../src/config');

describe('config.loadConfig', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  };

  test('applies documented defaults', () => {
    const config = loadConfig({ ...base });

    expect(config.env).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.http.port).toBe(3000);
    expect(config.http.bodyLimit).toBe('1mb');
    expect(config.db.poolMax).toBe(10);
    expect(config.db.ssl).toBe(false);
    expect(config.log.level).toBe('info');
  });

  test('coerces numeric and boolean strings', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      DATABASE_POOL_MAX: '25',
      DATABASE_SSL: 'true',
      LOG_PRETTY: 'yes',
    });

    expect(config.http.port).toBe(8080);
    expect(config.db.poolMax).toBe(25);
    expect(config.db.ssl).toEqual({ rejectUnauthorized: false });
    expect(config.log.pretty).toBe(true);
  });

  test('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  test('fails fast on an invalid enum value', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'banana' })).toThrow(
      /Invalid environment configuration/
    );
  });

  test('fails fast on a non-numeric port', () => {
    expect(() => loadConfig({ ...base, PORT: 'not-a-number' })).toThrow(
      /Invalid environment configuration/
    );
  });
});

describe('config.loadConfig ingestion auth', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  };

  test('defaults to authentication disabled', () => {
    const config = loadConfig({ ...base });

    expect(config.ingestion.authRequired).toBe(false);
    expect(config.ingestion.apiKeys.size).toBe(0);
  });

  test('parses comma-separated vendor:key entries', () => {
    const config = loadConfig({
      ...base,
      INGESTION_API_KEYS: 'acme:key-a, globex:key-b',
    });

    expect(config.ingestion.apiKeys.get('acme')).toBe('key-a');
    expect(config.ingestion.apiKeys.get('globex')).toBe('key-b');
    expect(config.ingestion.apiKeys.size).toBe(2);
  });

  test('fails fast when auth is required but no keys are configured', () => {
    expect(() =>
      loadConfig({ ...base, INGESTION_AUTH_REQUIRED: 'true' })
    ).toThrow(/INGESTION_API_KEYS is empty/);
  });

  test('accepts auth required when at least one key is configured', () => {
    const config = loadConfig({
      ...base,
      INGESTION_AUTH_REQUIRED: 'true',
      INGESTION_API_KEYS: 'acme:key-a',
    });

    expect(config.ingestion.authRequired).toBe(true);
  });

  test('fails fast on a malformed entry', () => {
    expect(() =>
      loadConfig({ ...base, INGESTION_API_KEYS: 'acme-no-separator' })
    ).toThrow(/expected "vendor:key"/);
  });

  test('fails fast on an empty key', () => {
    expect(() =>
      loadConfig({ ...base, INGESTION_API_KEYS: 'acme:' })
    ).toThrow(/expected "vendor:key"/);
  });

  test('fails fast on a duplicate vendor', () => {
    expect(() =>
      loadConfig({
        ...base,
        INGESTION_API_KEYS: 'acme:key-a,acme:key-b',
      })
    ).toThrow(/Duplicate vendor "acme"/);
  });
});

describe('config.loadConfig worker settings', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  };

  test('applies documented worker defaults', () => {
    const config = loadConfig({ ...base });

    expect(config.worker.pollIntervalMs).toBe(1000);
    expect(config.worker.batchSize).toBe(10);
    expect(config.worker.recoveryBatchSize).toBe(10);
    expect(config.worker.maxAttempts).toBe(5);
    expect(config.worker.leaseMs).toBe(60000);
    expect(config.worker.backoffBaseMs).toBe(1000);
    expect(config.worker.backoffMaxMs).toBe(60000);
    expect(config.worker.id).toBeNull();
    expect(config.worker.shutdownTimeoutMs).toBe(10000);
  });

  test('coerces and accepts overrides', () => {
    const config = loadConfig({
      ...base,
      WORKER_BATCH_SIZE: '25',
      WORKER_MAX_ATTEMPTS: '8',
      WORKER_LEASE_MS: '120000',
      WORKER_ID: 'worker-alpha',
    });

    expect(config.worker.batchSize).toBe(25);
    expect(config.worker.maxAttempts).toBe(8);
    expect(config.worker.leaseMs).toBe(120000);
    expect(config.worker.id).toBe('worker-alpha');
  });

  test('rejects a batch size of zero', () => {
    expect(() => loadConfig({ ...base, WORKER_BATCH_SIZE: '0' })).toThrow(
      /Invalid environment configuration/
    );
  });

  test('rejects a lease shorter than one second', () => {
    expect(() => loadConfig({ ...base, WORKER_LEASE_MS: '500' })).toThrow(
      /Invalid environment configuration/
    );
  });

  test('fails fast when backoff max is below backoff base', () => {
    expect(() =>
      loadConfig({ ...base, WORKER_BACKOFF_BASE_MS: '5000', WORKER_BACKOFF_MAX_MS: '1000' })
    ).toThrow(/WORKER_BACKOFF_MAX_MS must be >= WORKER_BACKOFF_BASE_MS/);
  });
});
