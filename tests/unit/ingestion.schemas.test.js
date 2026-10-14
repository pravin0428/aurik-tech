'use strict';

const {
  vendorParamSchema,
  idempotencyKeySchema,
  ingestionEnvelopeSchema,
  submissionIdParamSchema,
} = require('../../src/modules/ingestion/ingestion.schemas');

describe('vendorParamSchema', () => {
  test('accepts a simple identifier', () => {
    expect(vendorParamSchema.parse('acme-corp')).toBe('acme-corp');
  });

  test('rejects an empty value', () => {
    expect(() => vendorParamSchema.parse('')).toThrow();
  });

  test('rejects values containing spaces', () => {
    expect(() => vendorParamSchema.parse('bad vendor')).toThrow();
  });

  test('rejects an over-long value', () => {
    expect(() => vendorParamSchema.parse('a'.repeat(65))).toThrow();
  });
});

describe('idempotencyKeySchema', () => {
  test('accepts allowed characters', () => {
    expect(idempotencyKeySchema.parse('abc-123:def.ghi')).toBe(
      'abc-123:def.ghi'
    );
  });

  test('rejects characters outside the allow-list', () => {
    expect(() => idempotencyKeySchema.parse('has space')).toThrow();
  });
});

describe('ingestionEnvelopeSchema', () => {
  test('requires a payload', () => {
    expect(() => ingestionEnvelopeSchema.parse({})).toThrow();
  });

  test('accepts an object payload', () => {
    const value = ingestionEnvelopeSchema.parse({ payload: { a: 1 } });
    expect(value.payload).toEqual({ a: 1 });
  });

  test('accepts an array payload', () => {
    const value = ingestionEnvelopeSchema.parse({ payload: [1, 2, 3] });
    expect(value.payload).toEqual([1, 2, 3]);
  });

  test('accepts optional submissionId and source', () => {
    const value = ingestionEnvelopeSchema.parse({
      submissionId: 'sub-1',
      source: { system: 'scada' },
      payload: { a: 1 },
    });
    expect(value.submissionId).toBe('sub-1');
    expect(value.source).toEqual({ system: 'scada' });
  });

  test('rejects unknown top-level keys', () => {
    expect(() =>
      ingestionEnvelopeSchema.parse({ payload: {}, unexpected: true })
    ).toThrow();
  });
});

describe('submissionIdParamSchema', () => {
  test('accepts a UUID', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(submissionIdParamSchema.parse(uuid)).toBe(uuid);
  });

  test('rejects a non-UUID', () => {
    expect(() => submissionIdParamSchema.parse('not-a-uuid')).toThrow();
  });
});
