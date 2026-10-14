'use strict';

require('dotenv').config();

const { z } = require('zod');

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off', '']);

/**
 * Coerce common string boolean representations into real booleans,
 * falling back to a default when the value is absent.
 */
function booleanFromEnv(defaultValue) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return value;
  }, z.boolean());
}

/**
 * Parse comma-separated "vendor:key" entries into a Map keyed by vendor.
 * Malformed or duplicate entries throw so a typo can never silently leave
 * ingestion authentication in an unexpected state.
 */
function parseApiKeys(raw) {
  const keys = new Map();
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error(
        `Invalid INGESTION_API_KEYS entry "${trimmed}": expected "vendor:key"`
      );
    }

    const vendor = trimmed.slice(0, separator).trim();
    const key = trimmed.slice(separator + 1).trim();

    if (!vendor || !key) {
      throw new Error(
        `Invalid INGESTION_API_KEYS entry "${trimmed}": empty vendor or key`
      );
    }
    if (keys.has(vendor)) {
      throw new Error(`Duplicate vendor "${vendor}" in INGESTION_API_KEYS`);
    }
    keys.set(vendor, key);
  }
  return keys;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('aurik-tech'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_PRETTY: booleanFromEnv(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(10000),
  DATABASE_SSL: booleanFromEnv(false),

  REQUEST_BODY_LIMIT: z.string().min(1).default('1mb'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10000),

  // Worker / job-queue tuning. Bounds are intentionally generous but finite so
  // a typo cannot produce a runaway poll loop or an unbounded lease.
  WORKER_ID: z.string().min(1).max(200).optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3600000).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(10),
  WORKER_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(10),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).max(86400000).default(60000),
  WORKER_BACKOFF_BASE_MS: z.coerce.number().int().min(1).max(3600000).default(1000),
  WORKER_BACKOFF_MAX_MS: z.coerce.number().int().min(1).max(86400000).default(60000),

  INGESTION_AUTH_REQUIRED: booleanFromEnv(false),
  // Comma-separated "vendor:key" entries. Never commit real keys.
  INGESTION_API_KEYS: z.string().default(''),

  // Normalization. Stale window is a documented ASSUMPTION (not from Aurik):
  // a machine whose latest evidence is older than this is reported 'stale'.
  NORMALIZATION_STALE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(60000)
    .max(2592000000)
    .default(86400000),
  // Directory containing the assessment asset CSVs.
  ASSETS_DIR: z
    .string()
    .min(1)
    .default('Aurik_Tech_Lead_Assessment_Assets/Aurik_Tech_Lead_Assessment_Assets'),
});

function formatIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate and shape the environment. Throws with a readable message listing
 * every problem so the process fails fast instead of booting misconfigured.
 */
function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${formatIssues(parsed.error)}`);
  }

  const value = parsed.data;

  const ingestionApiKeys = parseApiKeys(value.INGESTION_API_KEYS);
  if (value.INGESTION_AUTH_REQUIRED && ingestionApiKeys.size === 0) {
    throw new Error(
      'Invalid environment configuration: INGESTION_AUTH_REQUIRED is true but INGESTION_API_KEYS is empty'
    );
  }

  if (value.WORKER_BACKOFF_MAX_MS < value.WORKER_BACKOFF_BASE_MS) {
    throw new Error(
      'Invalid environment configuration: WORKER_BACKOFF_MAX_MS must be >= WORKER_BACKOFF_BASE_MS'
    );
  }

  return {
    env: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    serviceName: value.SERVICE_NAME,

    http: Object.freeze({
      host: value.HOST,
      port: value.PORT,
      bodyLimit: value.REQUEST_BODY_LIMIT,
    }),

    log: Object.freeze({
      level: value.LOG_LEVEL,
      pretty: value.LOG_PRETTY,
    }),

    db: Object.freeze({
      url: value.DATABASE_URL,
      poolMax: value.DATABASE_POOL_MAX,
      idleTimeoutMs: value.DATABASE_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      ssl: value.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    }),

    ingestion: Object.freeze({
      authRequired: value.INGESTION_AUTH_REQUIRED,
      apiKeys: ingestionApiKeys,
    }),

    worker: Object.freeze({
      id: value.WORKER_ID || null,
      pollIntervalMs: value.WORKER_POLL_INTERVAL_MS,
      batchSize: value.WORKER_BATCH_SIZE,
      recoveryBatchSize: value.WORKER_RECOVERY_BATCH_SIZE,
      maxAttempts: value.WORKER_MAX_ATTEMPTS,
      leaseMs: value.WORKER_LEASE_MS,
      backoffBaseMs: value.WORKER_BACKOFF_BASE_MS,
      backoffMaxMs: value.WORKER_BACKOFF_MAX_MS,
      shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    }),

    normalization: Object.freeze({
      staleWindowMs: value.NORMALIZATION_STALE_WINDOW_MS,
    }),

    assetsDir: value.ASSETS_DIR,

    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
  };
}

const config = loadConfig();
config.loadConfig = loadConfig;

module.exports = Object.freeze(config);
