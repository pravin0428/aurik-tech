'use strict';

const {
  parseIsoUtc,
  parseEpochMs,
  parseMaintaflowLocal,
  parseDdMmYyyy,
  parseTimestampAny,
} = require('../../src/modules/normalization/time');

describe('timestamp parsing', () => {
  test('parses ISO-8601 UTC (PulseForge)', () => {
    const d = parseIsoUtc('2026-04-18T07:59:12Z');
    expect(d.toISOString()).toBe('2026-04-18T07:59:12.000Z');
  });

  test('rejects non-ISO shapes for the ISO parser', () => {
    expect(parseIsoUtc('18-04-2026 08:28:20')).toBeNull();
    expect(parseIsoUtc('2026/04/18 08:14:05')).toBeNull();
    expect(parseIsoUtc(null)).toBeNull();
    expect(parseIsoUtc(1776499152000)).toBeNull();
  });

  test('parses epoch milliseconds (ThermexWatch) and matches the ISO instant', () => {
    const d = parseEpochMs(1776499152000);
    expect(d.toISOString()).toBe('2026-04-18T07:59:12.000Z');
    expect(parseEpochMs('1776499152000').toISOString()).toBe('2026-04-18T07:59:12.000Z');
  });

  test('rejects implausible / malformed epoch values', () => {
    expect(parseEpochMs('bad-ts')).toBeNull();
    expect(parseEpochMs(1)).toBeNull();
    expect(parseEpochMs(99_999_999_999_999)).toBeNull();
  });

  test('parses MaintaFlow "YYYY/MM/DD HH:mm:ss" as UTC (approved assumption)', () => {
    const d = parseMaintaflowLocal('2026/04/18 08:14:05');
    expect(d.toISOString()).toBe('2026-04-18T08:14:05.000Z');
    expect(d.getUTCHours()).toBe(8);
  });

  test('rejects invalid calendar dates', () => {
    expect(parseMaintaflowLocal('2026/13/40 08:14:05')).toBeNull();
  });

  test('parseDdMmYyyy only accepts the DD-MM-YYYY shape', () => {
    expect(parseDdMmYyyy('18-04-2026 08:28:20').toISOString()).toBe(
      '2026-04-18T08:28:20.000Z'
    );
  });

  test('parseTimestampAny tries every supported shape', () => {
    expect(parseTimestampAny('2026-04-18T07:59:12Z')).not.toBeNull();
    expect(parseTimestampAny(1776499152000)).not.toBeNull();
    expect(parseTimestampAny('2026/04/18 08:14:05')).not.toBeNull();
    expect(parseTimestampAny('nope')).toBeNull();
  });
});
