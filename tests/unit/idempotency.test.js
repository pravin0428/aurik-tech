'use strict';

const {
  stableStringify,
  hashPayload,
  resolveIdempotencyKey,
} = require('../../src/modules/ingestion/idempotency');
const AppError = require('../../src/errors/AppError');

describe('stableStringify', () => {
  test('is insensitive to object key order', () => {
    const a = { b: 1, a: { d: 4, c: 3 } };
    const b = { a: { c: 3, d: 4 }, b: 1 };

    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  test('preserves array order (arrays are semantically ordered)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  test('handles null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('x')).toBe('"x"');
  });
});

describe('hashPayload', () => {
  test('produces identical hashes for reordered keys', () => {
    const a = { temperature: 20, machineId: 'm1' };
    const b = { machineId: 'm1', temperature: 20 };

    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  test('produces differing hashes for different payloads', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  test('produces a stable sha256 hex digest', () => {
    expect(hashPayload({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('resolveIdempotencyKey', () => {
  const envelope = { payload: { a: 1 } };

  test('prefers the Idempotency-Key header', () => {
    const result = resolveIdempotencyKey(
      { headers: { 'idempotency-key': 'from-header' } },
      { ...envelope, submissionId: 'from-body' }
    );

    expect(result).toEqual({ key: 'from-header', source: 'header' });
  });

  test('falls back to the body submissionId', () => {
    const result = resolveIdempotencyKey({ headers: {} }, {
      ...envelope,
      submissionId: 'from-body',
    });

    expect(result).toEqual({ key: 'from-body', source: 'body' });
  });

  test('rejects a header key with unsupported characters', () => {
    expect(() =>
      resolveIdempotencyKey(
        { headers: { 'idempotency-key': 'bad key!' } },
        envelope
      )
    ).toThrow(AppError);
  });

  test('throws IDEMPOTENCY_KEY_REQUIRED when neither source is present', () => {
    try {
      resolveIdempotencyKey({ headers: {} }, envelope);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(err.statusCode).toBe(400);
    }
  });
});
