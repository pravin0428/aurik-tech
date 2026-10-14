'use strict';

/**
 * Record-level normalization error codes. These are stable, machine-readable
 * reasons recorded in `normalization_failures` for every rejected or warned
 * source record. Invalid values are NEVER silently coerced: a record either
 * produces a canonical event, or it is rejected with one or more of these codes.
 *
 * severity 'error'   -> the record is rejected (no canonical event written)
 * severity 'warning' -> the record is accepted but a field was unusable; the
 *                       warning is stored with the event and in the ledger
 */
const RECORD_ERROR_CODES = Object.freeze({
  UNSUPPORTED_VENDOR: 'unsupported_vendor',
  UNSUPPORTED_EVENT_TYPE: 'unsupported_event_type',
  UNSUPPORTED_SEVERITY: 'unsupported_severity',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
  MISSING_MACHINE: 'missing_machine',
  UNKNOWN_MACHINE: 'unknown_machine',
  UNKNOWN_LINE: 'unknown_line',
  INVALID_TIMESTAMP: 'invalid_timestamp',
  INVALID_MEASUREMENT: 'invalid_measurement',
  INVALID_CONFIDENCE: 'invalid_confidence',
  INVALID_SENSOR_HEALTH: 'invalid_sensor_health',
  INVALID_SIGNAL_QUALITY: 'invalid_signal_quality',
  NON_OBJECT_RECORD: 'non_object_record',
});

const WARNING_CODES = new Set([
  RECORD_ERROR_CODES.UNKNOWN_LINE,
  RECORD_ERROR_CODES.INVALID_CONFIDENCE,
  RECORD_ERROR_CODES.INVALID_SENSOR_HEALTH,
  RECORD_ERROR_CODES.INVALID_SIGNAL_QUALITY,
]);

function severityForCode(code) {
  return WARNING_CODES.has(code) ? 'warning' : 'error';
}

/**
 * Accumulates per-record issues during normalization. A record with any 'error'
 * issue is rejected; warnings are attached to the accepted event.
 */
class RecordIssues {
  constructor() {
    this.issues = [];
  }

  add(code, message, raw) {
    this.issues.push({
      code,
      message: message || code,
      severity: severityForCode(code),
      raw,
    });
    return this;
  }

  get errors() {
    return this.issues.filter((issue) => issue.severity === 'error');
  }

  get warnings() {
    return this.issues.filter((issue) => issue.severity === 'warning');
  }

  hasErrors() {
    return this.errors.length > 0;
  }
}

module.exports = {
  RECORD_ERROR_CODES,
  WARNING_CODES,
  severityForCode,
  RecordIssues,
};
