'use strict';

const { RECORD_ERROR_CODES, RecordIssues } = require('./errors');

/**
 * Shared helpers for vendor adapters. Keeps per-vendor code small and ensures
 * machine/line resolution and record assembly are IDENTICAL across vendors
 * (no divergent logic between adapters).
 */

function newIssues() {
  return new RecordIssues();
}

/**
 * Machine resolution against validated reference data. The vendor machine keys
 * already equal the canonical machine_id in the assets.
 */
function resolveMachine(machineRef, issues, context) {
  if (machineRef === null || machineRef === undefined || String(machineRef).trim() === '') {
    issues.add(RECORD_ERROR_CODES.MISSING_MACHINE, 'Record has no machine reference');
    return null;
  }
  const key = String(machineRef).trim();
  const machine = context.machines.get(key);
  if (!machine) {
    issues.add(RECORD_ERROR_CODES.UNKNOWN_MACHINE, `Unknown machine reference "${key}"`);
    return null;
  }
  return machine;
}

/** "A" / "c" / "LINE-A" -> "LINE-A". */
function normalizeLineId(lineRef) {
  const value = String(lineRef || '').trim();
  if (!value) return null;
  if (/^LINE-/i.test(value)) return value.toUpperCase();
  if (/^[A-Za-z]$/.test(value)) return `LINE-${value.toUpperCase()}`;
  return value.toUpperCase();
}

/**
 * Resolve a record's line. The machine's line is authoritative; a vendor line
 * that differs (e.g. "ZZ") is recorded as a warning and the machine's line wins.
 */
function resolveLine(lineRef, machine, issues) {
  const authoritative = machine.line_id;
  if (lineRef === null || lineRef === undefined || String(lineRef).trim() === '') {
    return authoritative;
  }
  const normalized = normalizeLineId(lineRef);
  if (normalized !== authoritative) {
    issues.add(
      RECORD_ERROR_CODES.UNKNOWN_LINE,
      `Vendor line "${lineRef}" does not match machine line "${authoritative}"; using machine line`
    );
  }
  return authoritative;
}

/** Assemble the canonical record persisted as a canonical_event. */
function buildRecord({
  vendor,
  vendorEventId,
  machine,
  lineId,
  canonicalEventType,
  rawEventType,
  severity,
  occurredAt,
  sourceIngestedAt = null,
  temperatureC = null,
  vibrationMmS = null,
  vibrationG = null,
  powerKw = null,
  machineState = null,
  sensorHealth = null,
  vendorConfidence = null,
  signalQuality = null,
  isActive = null,
  unitMetadata = null,
  attributes = {},
  contentKey = null,
  sourceVersion = null,
  warnings = [],
}) {
  return {
    vendor,
    vendorEventId: vendorEventId ?? null,
    machineRef: machine.machine_id,
    machine_id: machine.machine_id,
    plant_id: machine.plant_id,
    line_id: lineId,
    canonicalEventType,
    rawEventType,
    severity,
    occurredAt,
    sourceIngestedAt,
    temperatureC,
    vibrationMmS,
    vibrationG,
    powerKw,
    machineState,
    sensorHealth,
    vendorConfidence,
    signalQuality,
    isActive,
    unitMetadata,
    attributes,
    contentKey,
    sourceVersion,
    warnings,
  };
}

module.exports = {
  newIssues,
  resolveMachine,
  resolveLine,
  normalizeLineId,
  buildRecord,
};
