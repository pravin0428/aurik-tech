'use strict';

const { CANONICAL_EVENT_TYPES, SEVERITIES, VENDORS, severityRank } = require('../constants');
const { RECORD_ERROR_CODES } = require('../errors');
const { parseMaintaflowLocal } = require('../time');
const { toFiniteNumber } = require('../units');
const {
  newIssues,
  resolveMachine,
  resolveLine,
  buildRecord,
} = require('../adapterSupport');

/**
 * MaintaFlow adapter.
 *
 * Sample shape:
 *   { provider_name, factory_id, records: [ {
 *       record_id, machine_ref, line_ref ("LINE-A" or "C"), recorded_at,
 *       record_type, inspection_result, maintenance_status,
 *       days_since_last_service, technician_note, manual_confidence } ] }
 *
 * `recorded_at` is "YYYY/MM/DD HH:mm:ss" with NO timezone -> interpreted as UTC
 * (approved assumption). These are human/textual maintenance records, not
 * machine telemetry; they carry skip-level maintenance semantics used by the
 * reducer (defects, overdue, and documented resolution).
 */

const RECORD_TYPE_MAP = Object.freeze({
  inspection: CANONICAL_EVENT_TYPES.INSPECTION,
  maintenance_update: CANONICAL_EVENT_TYPES.MAINTENANCE,
  operator_note: CANONICAL_EVENT_TYPES.OPERATOR_NOTE,
  calibration: CANONICAL_EVENT_TYPES.CALIBRATION,
});

const VENDOR = VENDORS.MAINTAFLOW;

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.maintaflow !== undefined) return payload.maintaflow;
  }
  return payload;
}

function bump(current, candidate) {
  return severityRank(candidate) > severityRank(current) ? candidate : current;
}

function deriveSeverity(recordType, inspectionResult, maintenanceStatus) {
  let severity = SEVERITIES.NONE;

  if (recordType === 'inspection') {
    if (inspectionResult === 'major_defect_found') severity = bump(severity, SEVERITIES.HIGH);
    else if (inspectionResult === 'minor_defect_found') severity = bump(severity, SEVERITIES.MEDIUM);
    else if (inspectionResult === 'passed_with_observation')
      severity = bump(severity, SEVERITIES.LOW);
  }

  if (maintenanceStatus === 'overdue') severity = bump(severity, SEVERITIES.HIGH);
  else if (maintenanceStatus === 'due_soon') severity = bump(severity, SEVERITIES.MEDIUM);

  if (recordType === 'operator_note') severity = bump(severity, SEVERITIES.LOW);
  if (recordType === 'calibration') severity = bump(severity, SEVERITIES.LOW);

  // A completed maintenance update is a resolution signal, not a problem.
  if (recordType === 'maintenance_update' && maintenanceStatus === 'completed') {
    return SEVERITIES.NONE;
  }
  return severity;
}

function normalizeRecord(raw, index, context, batchFactoryId = null) {
  const issues = newIssues();
  const result = { recordIndex: index, vendorEventId: null, raw, record: null, issues };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.add(RECORD_ERROR_CODES.NON_OBJECT_RECORD, 'Record is not an object');
    return result;
  }

  result.vendorEventId = raw.record_id != null ? String(raw.record_id) : null;

  const machine = resolveMachine(raw.machine_ref, issues, context);
  result.machineId = machine ? machine.machine_id : null;
  const lineId = machine ? resolveLine(raw.line_ref, machine, issues) : null;

  const occurredAt = parseMaintaflowLocal(raw.recorded_at);
  if (!occurredAt) {
    issues.add(
      RECORD_ERROR_CODES.INVALID_TIMESTAMP,
      `recorded_at "${raw.recorded_at}" is not YYYY/MM/DD HH:mm:ss`
    );
  }

  const canonicalEventType = RECORD_TYPE_MAP[raw.record_type];
  if (!canonicalEventType) {
    issues.add(
      RECORD_ERROR_CODES.UNSUPPORTED_EVENT_TYPE,
      `Unsupported record_type "${raw.record_type}"`
    );
  }

  const inspectionResult = raw.inspection_result ?? null;
  const maintenanceStatus = raw.maintenance_status ?? null;
  const daysSince = toFiniteNumber(raw.days_since_last_service);
  const manualConfidence = raw.manual_confidence ?? null;
  const severity = canonicalEventType
    ? deriveSeverity(raw.record_type, inspectionResult, maintenanceStatus)
    : SEVERITIES.NONE;

  if (issues.hasErrors() || !machine) return result;

  const contentKey = [
    raw.record_type,
    inspectionResult ?? '',
    maintenanceStatus ?? '',
    daysSince ?? '',
    manualConfidence ?? '',
  ].join('|');

  result.record = buildRecord({
    vendor: VENDOR,
    vendorEventId: result.vendorEventId,
    machine,
    lineId,
    canonicalEventType,
    rawEventType: raw.record_type,
    severity,
    occurredAt,
    temperatureC: null,
    vibrationMmS: null,
    vibrationG: null,
    powerKw: null,
    machineState: null,
    sensorHealth: null,
    vendorConfidence: null,
    signalQuality: null,
    isActive: null,
    unitMetadata: null,
    attributes: {
      inspection_result: inspectionResult,
      maintenance_status: maintenanceStatus,
      days_since_last_service: daysSince,
      technician_note: raw.technician_note ?? null,
      manual_confidence: manualConfidence,
      // `factory_id` is a BATCH-level field on the MaintaFlow envelope, not a
      // per-record field; fall back to a record-level value if one appears.
      factory_id: batchFactoryId ?? raw.factory_id ?? null,
    },
    contentKey,
    warnings: issues.warnings.map((w) => w.code),
  });
  return result;
}

function normalize(payload, context) {
  const root = unwrap(payload);
  const list =
    root && Array.isArray(root.records) ? root.records : Array.isArray(root) ? root : null;
  if (!list) {
    return {
      vendor: VENDOR,
      items: [],
      batchError: 'MaintaFlow payload has no records array',
    };
  }
  const items = list.map((raw, index) =>
    normalizeRecord(raw, index, context, root && root.factory_id != null ? root.factory_id : null)
  );
  return { vendor: VENDOR, items, batchError: null };
}

module.exports = { vendor: VENDOR, normalize, deriveSeverity };
