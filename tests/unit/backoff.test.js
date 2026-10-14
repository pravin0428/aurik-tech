'use strict';

const { computeBackoffMs, nextAvailableAt } = require('../../src/modules/processing/backoff');

describe('computeBackoffMs', () => {
  const backoff = { baseMs: 1000, maxMs: 60000 };

  test('is base for the first attempt', () => {
    expect(computeBackoffMs(1, backoff)).toBe(1000);
  });

  test('doubles for each subsequent attempt', () => {
    expect(computeBackoffMs(2, backoff)).toBe(2000);
    expect(computeBackoffMs(3, backoff)).toBe(4000);
    expect(computeBackoffMs(4, backoff)).toBe(8000);
  });

  test('is capped at maxMs', () => {
    expect(computeBackoffMs(10, backoff)).toBe(60000);
  });

  test('treats invalid attempts as the first attempt', () => {
    expect(computeBackoffMs(0, backoff)).toBe(1000);
    expect(computeBackoffMs(-5, backoff)).toBe(1000);
    expect(computeBackoffMs(undefined, backoff)).toBe(1000);
    expect(computeBackoffMs(Number.NaN, backoff)).toBe(1000);
  });

  test('respects a small cap', () => {
    expect(computeBackoffMs(5, { baseMs: 1000, maxMs: 3000 })).toBe(3000);
  });
});

describe('nextAvailableAt', () => {
  test('adds the backoff delay to the supplied clock time', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = nextAvailableAt(now, 2, { baseMs: 1000, maxMs: 60000 });

    expect(result.toISOString()).toBe('2026-01-01T00:00:02.000Z');
  });
});
