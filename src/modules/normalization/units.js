'use strict';

/**
 * Unit handling. Conversions here are the only ones permitted:
 *   * Fahrenheit -> Celsius (exact, deterministic).
 *
 * ThermexWatch reports vibration in `g` (acceleration). It is preserved as
 * `vibration_g` and is NEVER converted to `vibration_mm_s` (velocity); that
 * conversion depends on frequency and would be an invented rule.
 */

function round(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** (F - 32) * 5/9, rounded to 3 dp. Non-numeric/absent input -> null. */
function fahrenheitToCelsius(fahrenheit) {
  if (fahrenheit === null || fahrenheit === undefined || fahrenheit === '') return null;
  const f = Number(fahrenheit);
  if (!Number.isFinite(f)) return null;
  return round(((f - 32) * 5) / 9, 3);
}

/**
 * Plausibility windows. Values outside these ranges are treated as invalid
 * measurements (e.g. the -999 sentinel in malformed.json) and the record is
 * rejected rather than stored or coerced.
 */
function isPlausibleTemperatureC(c) {
  return Number.isFinite(c) && c > -100 && c < 2000;
}

function isPlausibleVibrationMmS(v) {
  return Number.isFinite(v) && v >= 0 && v < 5000;
}

function isPlausibleVibrationG(v) {
  return Number.isFinite(v) && v >= 0 && v < 500;
}

function isPlausiblePowerKw(p) {
  return Number.isFinite(p) && p >= 0 && p < 1e7;
}

/** A [0,1] ratio, or null if absent/out of range/non-numeric. */
function normalizeUnitRatio(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return round(n, 4);
}

/** Keep only finite numbers, else null. */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const SIGNAL_QUALITIES = new Set(['GOOD', 'FAIR', 'POOR']);

function normalizeSignalQuality(value) {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return SIGNAL_QUALITIES.has(upper) ? upper : null;
}

module.exports = {
  round,
  fahrenheitToCelsius,
  isPlausibleTemperatureC,
  isPlausibleVibrationMmS,
  isPlausibleVibrationG,
  isPlausiblePowerKw,
  normalizeUnitRatio,
  toFiniteNumber,
  SIGNAL_QUALITIES,
  normalizeSignalQuality,
};
