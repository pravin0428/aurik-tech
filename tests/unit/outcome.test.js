'use strict';

const {
  OUTCOME,
  PermanentJobError,
  permanentError,
  classifyThrown,
  normalizeHandlerResult,
  sanitizeErrorMessage,
} = require('../../src/modules/processing/outcome');

describe('normalizeHandlerResult', () => {
  test('accepts each valid outcome', () => {
    expect(normalizeHandlerResult({ outcome: OUTCOME.SUCCEEDED })).toEqual({
      outcome: OUTCOME.SUCCEEDED,
    });
    expect(normalizeHandlerResult({ outcome: OUTCOME.RETRY })).toEqual({
      outcome: OUTCOME.RETRY,
    });
    expect(normalizeHandlerResult({ outcome: OUTCOME.PERMANENT })).toEqual({
      outcome: OUTCOME.PERMANENT,
    });
    expect(
      normalizeHandlerResult({ outcome: OUTCOME.BLOCKED, reason: 'nope' })
    ).toEqual({ outcome: OUTCOME.BLOCKED, reason: 'nope' });
  });

  test('a blocked outcome without a reason is a permanent contract violation', () => {
    const result = normalizeHandlerResult({ outcome: OUTCOME.BLOCKED });
    expect(result.outcome).toBe(OUTCOME.PERMANENT);
    expect(result.category).toBe('handler_contract');
  });

  test('an unknown or missing outcome is a permanent contract violation', () => {
    expect(normalizeHandlerResult(undefined).outcome).toBe(OUTCOME.PERMANENT);
    expect(normalizeHandlerResult({ outcome: 'nonsense' }).outcome).toBe(
      OUTCOME.PERMANENT
    );
    expect(normalizeHandlerResult({ outcome: 'nonsense' }).category).toBe(
      'handler_contract'
    );
  });
});

describe('classifyThrown', () => {
  test('defaults unexpected errors to retry', () => {
    const result = classifyThrown(new Error('boom'));
    expect(result.outcome).toBe(OUTCOME.RETRY);
    expect(result.category).toBe('transient');
  });

  test('treats PermanentJobError as permanent', () => {
    const result = classifyThrown(permanentError('bad payload'));
    expect(result.outcome).toBe(OUTCOME.PERMANENT);
    expect(result.category).toBe('permanent');
  });

  test('treats validation-category errors as permanent', () => {
    const err = new Error('invalid');
    err.category = 'validation';
    expect(classifyThrown(err).outcome).toBe(OUTCOME.PERMANENT);
  });

  test('treats not_found-category errors as permanent', () => {
    const err = new Error('missing');
    err.category = 'not_found';
    expect(classifyThrown(err).outcome).toBe(OUTCOME.PERMANENT);
  });

  test('honours an explicit permanent flag', () => {
    const err = new Error('x');
    err.permanent = true;
    expect(classifyThrown(err).outcome).toBe(OUTCOME.PERMANENT);
  });
});

describe('PermanentJobError', () => {
  test('is an Error with the permanent flag and a category', () => {
    const err = new PermanentJobError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.permanent).toBe(true);
    expect(err.category).toBe('permanent');
  });
});

describe('sanitizeErrorMessage', () => {
  test('extracts the message from an Error', () => {
    expect(sanitizeErrorMessage(new Error('boom'))).toBe('boom');
  });

  test('accepts a plain string', () => {
    expect(sanitizeErrorMessage('plain')).toBe('plain');
  });

  test('handles null/undefined', () => {
    expect(sanitizeErrorMessage(null)).toBe('Unknown error');
    expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
  });

  test('caps very long messages and does not include a stack', () => {
    const long = 'x'.repeat(5000);
    const result = sanitizeErrorMessage(new Error(long));
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.endsWith('...')).toBe(true);
  });
});
