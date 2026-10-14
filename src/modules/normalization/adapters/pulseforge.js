'use strict';

const { CANONICAL_EVENT_TYPES, SEVERITIES, VENDORS } = require('../constants');
const { RECORD_ERROR_CODES } = require('../errors');
const { parseIsoUtc } = require('../time');
const {
  toFiniteNumber,
  isPlausibleVibrationMmS,
  isPlausibleTemperatureC,
  normalizeUnitRatio,
} = require('../units');
const {
  newIssues,
  resolveMachine,
  resolveLine,
  buildRecord,
} = require('../adapterSupport');

/**
 * PulseForge adapter.
 *
 * Sample shape:
 *   { vendor, plant_id, batch_generated_at, events: [ {
 *       event_id, machine_id, line_id, event_time (ISO-8601 Z),
 *       event_type, severity, vibration_mm_s, temperature_c,
 *       machine_state, sensor_health, vendor_confidence } ] }
 *
 * `event_time` MUST be ISO-8601 UTC. Any other shape (e.g. the malformed
 * "18-04-2026 08:28:20") is rejected as invalid_timestamp — never guessed.
 */

const EVENT_TYPE_MAP = Object.freeze({
  HIGH_VIBRATION: CANONICAL_EVENT_TYPES.VIBRATION,
  TEMP_SPIKE: CANONICAL_EVENT_TYPES.TEMPERATURE,
  SENSOR_HEALTH_DROP: CANONICAL_EVENT_TYPES.SENSOR_HEALTH,
  POWER_FLUCTUATION: CANONICAL_EVENT_TYPES.POWER,
  RECOVERY_SIGNAL: CANONICAL_EVENT_TYPES.RECOVERY,
});

const SEVERITIES_SET = new Set([
  SEVERITIES.LOW,
  SEVERITIES.MEDIUM,
  SEVERITIES.HIGH,
  SEVERITIES.CRITICAL,
]);

const VENDOR = VENDORS.PULSEFORGE;

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.pulseforge !== undefined) return payload.pulseforge;
  }
  return payload;
}

function normalizeRecord(raw, index, context) {
  const issues = newIssues();
  const result = { recordIndex: index, vendorEventId: null, raw, record: null, issues };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(RECORD_ERROR_CODES.NON_OBJECT_RECORD, 'Event is not an object');
    return result;
  }

  result.vendorEventId = raw.event_id != null ? String(raw.event_id) : null;

  const machine = resolveMachine(raw.machine_id, issues, context);
  result.machineId = machine ? machine.machine_id : null;
  const lineId = machine ? resolveLine(raw.line_id, machine, issues) : null;

  const occurredAt = parseIsoUtc(raw.event_time);
  if (!occurredAt) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_TIMESTAMP,
      `event_time "${raw.event_time}" is not ISO-8601 UTC`
    );
  }

  const canonicalEventType = EVENT_TYPE_MAP[raw.event_type];
  if (!canonicalEventType) {
    issues.add(
      RECORD_ERROR_CODES.UNSUPPORTED_EVENT_TYPE,
      `Unsupported event_type "${raw.event_type}"`
    );
  }

  if (!SEVERITIES_SET.has(raw.severity)) {
    issues.add(RECORD_ERROR_CODES.UNSUPPORTED_SEVERITY, `Unsupported severity "${raw.severity}"`);
  }

  const vibrationMmS = toFiniteNumber(raw.vibration_mm_s);
  if (vibrationMmS !== null && !isPlausibleVibrationMmS(vibrationMmS)) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_MEASUREMENT,
      `vibration_mm_s ${raw.vibration_mm_s} out of range`
    );
  }

  const temperatureC = toFiniteNumber(raw.temperature_c);
  if (temperatureC !== null && !isPlausibleTemperatureC(temperatureC)) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_MEASUREMENT,
      `temperature_c ${raw.temperature_c} out of range`
    );
  }

  let sensorHealth = null;
  if (raw.sensor_health !== null && raw.sensor_health !== undefined) {
    sensorHealth = normalizeUnitRatio(raw.sensor_health);
    if (sensorHealth === null) {
      issues.add(
        RECORD_ERROR_CODES.INVALID_SENSOR_HEALTH,
        `sensor_health ${raw.sensor_health} is not a [0,1] ratio`
      );
    }
  }

  let vendorConfidence = null;
  if (raw.vendor_confidence !== null && raw.vendor_confidence !== undefined) {
    vendorConfidence = normalizeUnitRatio(raw.vendor_confidence);
    if (vendorConfidence === null) {
      issues.add(
        RECORD_ERROR_CODES.INVALID_CONFIDENCE,
        `vendor_confidence ${raw.vendor_confidence} is not a [0,1] ratio`
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
    rawEventType: raw.event_type,
    severity: raw.severity,
    occurredAt,
    temperatureC,
    vibrationMmS,
    powerKw: null,
    machineState: raw.machine_state != null ? String(raw.machine_state) : null,
    sensorHealth,
    vendorConfidence,
    signalQuality: null,
    isActive: null,
    unitMetadata: { vibration: 'mm_s', temperature: 'celsius' },
    attributes: { vendor_plant_id: raw.plant_id ?? null },
    contentKey: null,
    warnings: issues.warnings.map((w) => w.code),
  });
  return result;
}

function normalize(payload, context) {
  const root = unwrap(payload);
  const list = root && Array.isArray(root.events) ? root.events : Array.isArray(root) ? root : null;
  if (!list) {
    return {
      vendor: VENDOR,
      items: [],
      batchError: 'PulseForge payload has no events array',
    };
  }
  const items = list.map((raw, index) => normalizeRecord(raw, index, context));
  return { vendor: VENDOR, items, batchError: null };
}

module.exports = { vendor: VENDOR, normalize };
