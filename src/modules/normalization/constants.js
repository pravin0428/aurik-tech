'use strict';

/**
 * Canonical vocabulary shared by adapters, the persistence layer, and the
 * operational view. Every value here is either taken directly from the
 * assessment assets or is an approved design decision (see
 * docs/ASSUMPTIONS_REGISTER.md). Nothing vendor-specific belongs here.
 */

/** Vendor slugs (case-insensitive key derived from the ingestion path). */
const VENDORS = Object.freeze({
  PULSEFORGE: 'pulseforge',
  THERMEXWATCH: 'thermexwatch',
  MAINTAFLOW: 'maintaflow',
});

function normalizeVendorKey(vendor) {
  return String(vendor || '').trim().toLowerCase();
}

/** Canonical event types (mirrors the CHECK on canonical_events). */
const CANONICAL_EVENT_TYPES = Object.freeze({
  VIBRATION: 'vibration',
  TEMPERATURE: 'temperature',
  POWER: 'power',
  SENSOR_HEALTH: 'sensor_health',
  RECOVERY: 'recovery',
  OK: 'ok',
  INSPECTION: 'inspection',
  MAINTENANCE: 'maintenance',
  OPERATOR_NOTE: 'operator_note',
  CALIBRATION: 'calibration',
});

/** Signal categories that participate in the active-condition reducer. */
const CONDITION_CATEGORIES = Object.freeze([
  CANONICAL_EVENT_TYPES.VIBRATION,
  CANONICAL_EVENT_TYPES.TEMPERATURE,
  CANONICAL_EVENT_TYPES.POWER,
  CANONICAL_EVENT_TYPES.SENSOR_HEALTH,
]);

/** Severity scale (lower is calmer). */
const SEVERITIES = Object.freeze({
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SEVERITY_RANK = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? -1;
}

/** Derived machine statuses (mirrors the CHECK on machine_state). */
const DERIVED_STATUS = Object.freeze({
  OK: 'ok',
  WARNING: 'warning',
  CRITICAL: 'critical',
  RECOVERING: 'recovering',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

const NEEDS_ATTENTION_BY_STATUS = Object.freeze({
  ok: false,
  recovering: false,
  warning: true,
  critical: true,
  stale: true,
  unknown: true,
});

/** Attention levels (mirrors the CHECK on machine_state). */
const ATTENTION_LEVELS = Object.freeze({
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/**
 * Stable reason-code catalog. Condition codes are generated as
 * `<category>_<level>` where level maps critical->critical, high->high,
 * medium/low->attention. Codes are emitted in a fixed order so responses are
 * deterministic regardless of event arrival order.
 */
const CATEGORY_REASON_PREFIX = Object.freeze({
  vibration: 'vibration',
  temperature: 'temperature',
  power: 'power',
  sensor_health: 'sensor_health',
});

function reasonCodeForCategory(category, severity) {
  const prefix = CATEGORY_REASON_PREFIX[category];
  if (!prefix) return null;
  if (severity === SEVERITIES.CRITICAL) return `${prefix}_critical`;
  if (severity === SEVERITIES.HIGH) return `${prefix}_high`;
  return `${prefix}_attention`;
}

const REASON_CODES = Object.freeze({
  MAINTENANCE_DEFECT_MAJOR: 'maintenance_defect_major',
  MAINTENANCE_DEFECT_MINOR: 'maintenance_defect_minor',
  MAINTENANCE_OVERDUE: 'maintenance_overdue',
  MAINTENANCE_DUE_SOON: 'maintenance_due_soon',
  OPEN_WORK_ORDER: 'open_work_order',
  LOW_SENSOR_CONFIDENCE: 'low_sensor_confidence',
  RECOVERY_SIGNAL: 'recovery_signal',
  STALE_DATA: 'stale_data',
});

const REASON_CODE_ORDER = Object.freeze([
  'vibration_critical',
  'temperature_critical',
  'power_critical',
  'sensor_health_critical',
  'vibration_high',
  'temperature_high',
  'power_high',
  'sensor_health_high',
  'vibration_attention',
  'temperature_attention',
  'power_attention',
  'sensor_health_attention',
  'maintenance_defect_major',
  'maintenance_defect_minor',
  'maintenance_overdue',
  'maintenance_due_soon',
  'open_work_order',
  'low_sensor_confidence',
  'recovery_signal',
  'stale_data',
]);

const REASON_CODE_RANK = Object.freeze(
  REASON_CODE_ORDER.reduce((acc, code, index) => {
    acc[code] = index;
    return acc;
  }, {})
);

/** Deterministic tie-break precedence for equal timestamps (higher = preferred). */
const VENDOR_TIEBREAK = Object.freeze({
  maintaflow: 2,
  thermexwatch: 1,
  pulseforge: 0,
});

module.exports = {
  VENDORS,
  normalizeVendorKey,
  CANONICAL_EVENT_TYPES,
  CONDITION_CATEGORIES,
  SEVERITIES,
  SEVERITY_RANK,
  severityRank,
  DERIVED_STATUS,
  NEEDS_ATTENTION_BY_STATUS,
  ATTENTION_LEVELS,
  REASON_CODES,
  REASON_CODE_ORDER,
  REASON_CODE_RANK,
  reasonCodeForCategory,
  CATEGORY_REASON_PREFIX,
  VENDOR_TIEBREAK,
};
