'use strict';

const { CANONICAL_EVENT_TYPES, SEVERITIES, VENDORS } = require('../constants');
const { RECORD_ERROR_CODES } = require('../errors');
const { parseEpochMs } = require('../time');
const {
  toFiniteNumber,
  isPlausibleVibrationG,
  isPlausibleTemperatureC,
  isPlausiblePowerKw,
  fahrenheitToCelsius,
  normalizeSignalQuality,
} = require('../units');
const {
  newIssues,
  resolveMachine,
  resolveLine,
  buildRecord,
} = require('../adapterSupport');

/**
 * ThermexWatch adapter.
 *
 * Sample shape:
 *   { source, site_code, response_time_epoch_ms, readings: [ {
 *       readingId, assetCode, productionLine ("A"), timestampMs (epoch ms),
 *       alertCode, level (1..5), vibration_g, temperature_f, power_kw,
 *       is_active, signal_quality } ] }
 *
 * Units: temperature is Fahrenheit -> converted to Celsius. Vibration is in g
 * and is PRESERVED as vibration_g (never converted to mm/s). Severity comes from
 * `level` (1 nominal .. 5 critical); `is_active` and `signal_quality` are kept.
 */

const ALERT_TYPE_MAP = Object.freeze({
  VIB_WARN: CANONICAL_EVENT_TYPES.VIBRATION,
  TEMP_WARN: CANONICAL_EVENT_TYPES.TEMPERATURE,
  TEMP_CRIT: CANONICAL_EVENT_TYPES.TEMPERATURE,
  POWER_DROP: CANONICAL_EVENT_TYPES.POWER,
  OK: CANONICAL_EVENT_TYPES.OK,
});

const LEVEL_SEVERITY = Object.freeze({
  1: SEVERITIES.NONE,
  2: SEVERITIES.LOW,
  3: SEVERITIES.MEDIUM,
  4: SEVERITIES.HIGH,
  5: SEVERITIES.CRITICAL,
});

const VENDOR = VENDORS.THERMEXWATCH;

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.thermexwatch !== undefined) return payload.thermexwatch;
  }
  return payload;
}

function normalizeRecord(raw, index, context) {
  const issues = newIssues();
  const result = { recordIndex: index, vendorEventId: null, raw, record: null, issues };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(RECORD_ERROR_CODES.NON_OBJECT_RECORD, 'Reading is not an object');
    return result;
  }

  result.vendorEventId = raw.readingId != null ? String(raw.readingId) : null;

  const machine = resolveMachine(raw.assetCode, issues, context);
  result.machineId = machine ? machine.machine_id : null;
  const lineId = machine ? resolveLine(raw.productionLine, machine, issues) : null;

  const occurredAt = parseEpochMs(raw.timestampMs);
  if (!occurredAt) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_TIMESTAMP,
      `timestampMs "${raw.timestampMs}" is not a valid epoch-ms value`
    );
  }

  const canonicalEventType = ALERT_TYPE_MAP[raw.alertCode];
  if (!canonicalEventType) {
    issues.add(
      RECORD_ERROR_CODES.UNSUPPORTED_EVENT_TYPE,
      `Unsupported alertCode "${raw.alertCode}"`
    );
  }

  const level = Number(raw.level);
  const severity = Number.isInteger(level) && LEVEL_SEVERITY[level] ? LEVEL_SEVERITY[level] : null;
  if (!severity) {
    issues.add(RECORD_ERROR_CODES.UNSUPPORTED_SEVERITY, `Unsupported level "${raw.level}"`);
  }

  const vibrationG = toFiniteNumber(raw.vibration_g);
  if (vibrationG !== null && !isPlausibleVibrationG(vibrationG)) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_MEASUREMENT,
      `vibration_g ${raw.vibration_g} out of range`
    );
  }

  let temperatureC = null;
  if (raw.temperature_f !== null && raw.temperature_f !== undefined && raw.temperature_f !== '') {
    const celsius = fahrenheitToCelsius(raw.temperature_f);
    if (celsius === null || !isPlausibleTemperatureC(celsius)) {
      issues.add(
        RECORD_ERROR_CODES.INVALID_MEASUREMENT,
        `temperature_f ${raw.temperature_f} out of range`
      );
    } else {
      temperatureC = celsius;
    }
  }

  const powerKw = toFiniteNumber(raw.power_kw);
  if (powerKw !== null && !isPlausiblePowerKw(powerKw)) {
    issues.add(RECORD_ERROR_CODES.INVALID_MEASUREMENT, `power_kw ${raw.power_kw} out of range`);
  }

  let signalQuality = null;
  if (raw.signal_quality !== null && raw.signal_quality !== undefined) {
    signalQuality = normalizeSignalQuality(raw.signal_quality);
    if (signalQuality === null) {
      issues.add(
        RECORD_ERROR_CODES.INVALID_SIGNAL_QUALITY,
        `signal_quality "${raw.signal_quality}" is not GOOD/FAIR/POOR`
      );
    }
  }

  if (issues.hasErrors() || !machine) return result;

  result.record = buildRecord({
    vendor: VENDOR,
    vendorEventId: result.vendorEventId,
    machine,
    lineId,
    canonicalEventType,
    rawEventType: raw.alertCode,
    severity,
    occurredAt,
    temperatureC,
    vibrationMmS: null,
    vibrationG,
    powerKw,
    machineState: null,
    sensorHealth: null,
    vendorConfidence: null,
    signalQuality,
    isActive: typeof raw.is_active === 'boolean' ? raw.is_active : null,
    unitMetadata: { vibration: 'g', temperature: 'celsius_from_fahrenheit', level },
    attributes: { site_code: raw.site_code ?? null },
    contentKey: null,
    warnings: issues.warnings.map((w) => w.code),
  });
  return result;
}

function normalize(payload, context) {
  const root = unwrap(payload);
  const list =
    root && Array.isArray(root.readings) ? root.readings : Array.isArray(root) ? root : null;
  if (!list) {
    return {
      vendor: VENDOR,
      items: [],
      batchError: 'ThermexWatch payload has no readings array',
    };
  }
  const items = list.map((raw, index) => normalizeRecord(raw, index, context));
  return { vendor: VENDOR, items, batchError: null };
}

module.exports = { vendor: VENDOR, normalize };
