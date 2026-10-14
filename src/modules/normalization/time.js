'use strict';

/**
 * Deterministic timestamp parsing for the exact formats present in the
 * assessment assets. Every parser either returns a valid Date or null; callers
 * reject the record on null. No parser ever guesses a timezone silently:
 *
 *   * PulseForge `event_time`      -> ISO-8601 UTC  ("2026-04-18T07:59:12Z")
 *   * ThermexWatch `timestampMs`   -> epoch milliseconds (UTC)
 *   * MaintaFlow `recorded_at`     -> "YYYY/MM/DD HH:mm:ss", NO timezone.
 *                                     Interpreted as UTC (approved assumption).
 *   * malformed "18-04-2026 08:28:20" -> DD-MM-YYYY, treated as invalid for the
 *                                     vendor it appears under (PulseForge) so it
 *                                     is rejected rather than guessed.
 *
 * A permissive parser (`parseTimestampAny`) exists for tests/tools, but adapters
 * use the narrow, format-specific parsers so an unexpected shape is rejected.
 */

const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

function inRange(ms) {
  return Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS;
}

function fromParts(year, month, day, hour, minute, second) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Reject impossible calendar dates (e.g. month 13 or day 32 roll over).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return inRange(ms) ? date : null;
}

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const DD_MM_YYYY = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/;
const YYYY_MM_DD = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const EPOCH_MS = /^\d{10,13}$/;

/** ISO-8601 with an explicit Z (UTC). */
function parseIsoUtc(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_UTC.exec(value.trim());
  if (!m) return null;
  return fromParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}

/** Epoch milliseconds (number or numeric string), validated to a sane range. */
function parseEpochMs(value) {
  let numeric = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!EPOCH_MS.test(trimmed)) return null;
    numeric = Number(trimmed);
  }
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) return null;
  if (!inRange(numeric)) return null;
  return new Date(numeric);
}

/** "YYYY/MM/DD HH:mm:ss" with no timezone -> interpreted as UTC (assumption). */
function parseMaintaflowLocal(value) {
  if (typeof value !== 'string') return null;
  const m = YYYY_MM_DD.exec(value.trim());
  if (!m) return null;
  return fromParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}

/** "DD-MM-YYYY HH:mm:ss" (UTC). Kept for tools/tests; not used by adapters. */
function parseDdMmYyyy(value) {
  if (typeof value !== 'string') return null;
  const m = DD_MM_YYYY.exec(value.trim());
  if (!m) return null;
  return fromParts(+m[3], +m[2], +m[1], +m[4], +m[5], +m[6]);
}

/** Try every supported representation. Returns a Date or null. */
function parseTimestampAny(value) {
  return parseIsoUtc(value) || parseEpochMs(value) || parseMaintaflowLocal(value) || parseDdMmYyyy(value);
}

module.exports = {
  parseIsoUtc,
  parseEpochMs,
  parseMaintaflowLocal,
  parseDdMmYyyy,
  parseTimestampAny,
  inRange,
};
