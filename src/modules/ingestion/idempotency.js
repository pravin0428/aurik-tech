'use strict';

const crypto = require('crypto');
const AppError = require('../../errors/AppError');
const { ErrorCategory } = require('../../errors/AppError');

const IDEMPOTENCY_HEADER = 'idempotency-key';
// Deliberately conservative: URL-safe tokens only.
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Deterministic JSON serialisation with sorted object keys.
 *
 * Used ONLY to make payload hashing insensitive to key order. Arrays keep their
 * order (they are semantically ordered). Not a substitute for the idempotency
 * contract defined below — it is one input to it.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/** sha256 of the canonical payload representation (key-order insensitive). */
function hashPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * IDEMPOTENCY CONTRACT (provisional, documented before implementation):
 *
 *   1. A submission is identified by the pair (vendor, idempotency_key), which
 *      is a UNIQUE database constraint.
 *   2. The key comes from the `Idempotency-Key` header when present, otherwise
 *      from `submissionId` in the body. If neither exists -> 400.
 *   3. Replaying the SAME key with an EQUAL payload resolves to the existing
 *      submission (HTTP 200, no new submission, no duplicate job).
 *   4. Reusing the SAME key with a DIFFERENT payload is a deterministic client
 *      error -> HTTP 409 `IDEMPOTENCY_KEY_REUSED`. Nothing is written.
 *   5. Equality is judged by sha256 of the canonicalised payload. The hash is a
 *      comparison aid, not the contract itself.
 *
 * This is at-least-once ingestion with idempotent effects. It does NOT claim
 * exactly-once processing.
 */
function resolveIdempotencyKey(req, envelope) {
  const headerValue = req.headers[IDEMPOTENCY_HEADER];

  if (typeof headerValue === 'string' && headerValue.trim()) {
    const key = headerValue.trim();
    if (!KEY_PATTERN.test(key)) {
      throw AppError.validation('Idempotency-Key header contains unsupported characters');
    }
    return { key, source: 'header' };
  }

  if (envelope.submissionId) {
    if (!KEY_PATTERN.test(envelope.submissionId)) {
      throw AppError.validation('submissionId contains unsupported characters');
    }
    return { key: envelope.submissionId, source: 'body' };
  }

  throw new AppError(
    'An idempotency key is required: send an Idempotency-Key header or a submissionId in the body',
    {
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      category: ErrorCategory.VALIDATION,
      details: [{ path: 'Idempotency-Key', message: 'idempotency key is required' }],
    }
  );
}

module.exports = {
  stableStringify,
  hashPayload,
  resolveIdempotencyKey,
  KEY_PATTERN,
  IDEMPOTENCY_HEADER,
};
