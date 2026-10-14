'use strict';

const {
  CANONICAL_EVENT_TYPES,
  CONDITION_CATEGORIES,
  SEVERITIES,
  severityRank,
  DERIVED_STATUS,
  NEEDS_ATTENTION_BY_STATUS,
  ATTENTION_LEVELS,
  REASON_CODES,
  REASON_CODE_RANK,
  reasonCodeForCategory,
  VENDOR_TIEBREAK,
} = require('./constants');

/**
 * Deterministic machine operational-state reducer (pure; no DB, no clock).
 *
 * Given all canonical events for one machine (and any open/closed work orders),
 * it derives the machine's operational status. It is order-independent: events
 * are sorted by their OWN timestamps, never by processing order.
 *
 * KEY RULES (documented in docs/DESIGN_NOTES.md):
 *   * Active-condition model. Each signal category (vibration, temperature,
 *     power, sensor_health) has an "active" severity = the severity of its most
 *     recent event.
 *   * Recovery never erases a critical. A generic recovery/OK signal can clear
 *     warnings but NOT a still-active critical condition. A critical is only
 *     cleared by (a) a later same-category event below critical, or (b) a later
 *     documented maintenance resolution (a completed maintenance record or a
 *     work order closed with post_maintenance_check = 'passed').
 *   * Missing or stale evidence is never reported as healthy: a machine with no
 *     events is 'unknown'; a machine whose latest event is older than the stale
 *     window is 'stale'.
 *   * Deterministic tie-break for equal timestamps: higher severity, then a
 *     fixed vendor precedence, then vendor event id, then record index.
 */

function pick(obj, camel, snake) {
  if (obj == null) return undefined;
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Normalize a canonical_events DB row OR a normalized record to one shape. */
function normalizeEvent(raw) {
  const occurredAt = toDate(pick(raw, 'occurredAt', 'occurred_at'));
  const attributes = pick(raw, 'attributes', 'attributes') || {};
  return {
    id: pick(raw, 'id', 'id') || null,
    vendor: pick(raw, 'vendor', 'vendor') || null,
    vendorEventId: pick(raw, 'vendorEventId', 'vendor_event_id') || null,
    sourceSubmissionId:
      pick(raw, 'sourceSubmissionId', 'source_submission_id') || null,
    sourceRecordIndex: pick(raw, 'sourceRecordIndex', 'source_record_index'),
    type: pick(raw, 'canonicalEventType', 'canonical_event_type'),
    rawEventType: pick(raw, 'rawEventType', 'raw_event_type') || null,
    severity: pick(raw, 'severity', 'severity') || SEVERITIES.NONE,
    occurredAt,
    machineState: pick(raw, 'machineState', 'machine_state') || null,
    sensorHealth:
      pick(raw, 'sensorHealth', 'sensor_health') === null
        ? null
        : Number(pick(raw, 'sensorHealth', 'sensor_health')),
    vendorConfidence:
      pick(raw, 'vendorConfidence', 'vendor_confidence') === null
        ? null
        : Number(pick(raw, 'vendorConfidence', 'vendor_confidence')),
    signalQuality: pick(raw, 'signalQuality', 'signal_quality') || null,
    isActive: pick(raw, 'isActive', 'is_active'),
    attributes,
  };
}

function compareEventsDesc(a, b) {
  const ta = a.occurredAt ? a.occurredAt.getTime() : -Infinity;
  const tb = b.occurredAt ? b.occurredAt.getTime() : -Infinity;
  if (ta !== tb) return tb - ta;
  const sa = severityRank(a.severity);
  const sb = severityRank(b.severity);
  if (sa !== sb) return sb - sa;
  const va = VENDOR_TIEBREAK[a.vendor] ?? -1;
  const vb = VENDOR_TIEBREAK[b.vendor] ?? -1;
  if (va !== vb) return vb - va;
  const ea = a.vendorEventId || '';
  const eb = b.vendorEventId || '';
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ra = Number.isFinite(a.sourceRecordIndex) ? a.sourceRecordIndex : -1;
  const rb = Number.isFinite(b.sourceRecordIndex) ? b.sourceRecordIndex : -1;
  return ra - rb;
}

function maxDate(...dates) {
  const valid = dates.filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

const MAINTENANCE_DEFECT_RESULTS = new Set([
  'major_defect_found',
  'minor_defect_found',
  'passed_with_observation',
]);

function deriveMachineState({
  now,
  staleWindowMs,
  machine,
  events = [],
  workOrders = [],
  processingStatusHint = null,
}) {
  const machineId = machine.machine_id || machine.machineId;
  const plantId = machine.plant_id || machine.plantId;
  const lineId = machine.line_id || machine.lineId;

  const normalized = events.map(normalizeEvent).filter((e) => e.occurredAt);
  const sorted = [...normalized].sort(compareEventsDesc);

  const base = {
    machine_id: machineId,
    plant_id: plantId,
    line_id: lineId,
    derived_status: DERIVED_STATUS.UNKNOWN,
    attention_level: ATTENTION_LEVELS.NONE,
    needs_attention: true,
    reason_codes: [],
    latest_relevant_event_time: null,
    latest_relevant_event_id: null,
    source_event_refs: [],
    processing_status: processingStatusHint || 'unknown',
    last_processed_at: now,
    source_max_event_time: null,
  };

  if (sorted.length === 0) {
    // No evidence is never "healthy".
    return { ...base, reason_codes: [] };
  }

  const latest = sorted[0];
  const latestMs = latest.occurredAt.getTime();
  const stale =
    Number.isFinite(staleWindowMs) &&
    latestMs < now.getTime() - staleWindowMs;

  // Documented resolution timestamps.
  const recoveryAt = maxDate(
    ...sorted
      .filter(
        (e) =>
          e.type === CANONICAL_EVENT_TYPES.RECOVERY ||
          e.type === CANONICAL_EVENT_TYPES.OK
      )
      .map((e) => e.occurredAt)
  );

  const maintenanceResolvedAt = maxDate(
    ...sorted
      .filter(
        (e) =>
          e.type === CANONICAL_EVENT_TYPES.MAINTENANCE &&
          e.attributes &&
          e.attributes.maintenance_status === 'completed'
      )
      .map((e) => e.occurredAt),
    ...workOrders
      .filter(
        (wo) =>
          (wo.status === 'closed') &&
          (wo.post_maintenance_check === 'passed' ||
            wo.postMaintenanceCheck === 'passed')
      )
      .map((wo) => toDate(wo.closed_at || wo.closedAt))
  );

  const reasons = new Set();

  const isResolvedAfter = (time) => {
    const t = time ? time.getTime() : null;
    if (t === null) return false;
    if (maintenanceResolvedAt && maintenanceResolvedAt.getTime() > t) return true;
    if (recoveryAt && recoveryAt.getTime() > t) return true;
    return false;
  };

  // --- Active condition categories -----------------------------------------
  let hasActiveCritical = false;
  let hasActiveHigh = false;
  let hasActiveMedium = false;
  let hasActiveLow = false;

  const categoryLatest = {};
  for (const category of CONDITION_CATEGORIES) {
    const ev = sorted.find((e) => e.type === category);
    if (!ev) continue;
    categoryLatest[category] = ev;
    const rank = severityRank(ev.severity);
    if (rank < severityRank(SEVERITIES.MEDIUM)) continue; // only medium+ is "active"

    const critical = ev.severity === SEVERITIES.CRITICAL;
    // Recovery clears warnings; maintenance resolution clears anything before it
    // (including critical). Recovery never clears a critical.
    const clearedByMaintenance =
      maintenanceResolvedAt && maintenanceResolvedAt.getTime() > ev.occurredAt.getTime();
    const clearedByRecovery =
      !critical && recoveryAt && recoveryAt.getTime() > ev.occurredAt.getTime();

    if (clearedByMaintenance || clearedByRecovery) continue;

    const code = reasonCodeForCategory(category, ev.severity);
    if (code) reasons.add(code);
    if (critical) hasActiveCritical = true;
    else if (ev.severity === SEVERITIES.HIGH) hasActiveHigh = true;
    else if (ev.severity === SEVERITIES.MEDIUM) hasActiveMedium = true;
    else hasActiveLow = true;
  }

  // --- Maintenance semantics -------------------------------------------------
  const latestInspection = sorted.find(
    (e) =>
      e.type === CANONICAL_EVENT_TYPES.INSPECTION &&
      e.attributes &&
      MAINTENANCE_DEFECT_RESULTS.has(e.attributes.inspection_result)
  );
  if (latestInspection && !isResolvedAfter(latestInspection.occurredAt)) {
    const result = latestInspection.attributes.inspection_result;
    if (result === 'major_defect_found') {
      reasons.add(REASON_CODES.MAINTENANCE_DEFECT_MAJOR);
      hasActiveHigh = true;
    } else {
      reasons.add(REASON_CODES.MAINTENANCE_DEFECT_MINOR);
      hasActiveLow = true;
    }
  }

  const latestMaintenanceStatus = sorted.find(
    (e) =>
      e.attributes &&
      typeof e.attributes.maintenance_status === 'string' &&
      e.attributes.maintenance_status !== 'unknown' &&
      e.attributes.maintenance_status !== 'completed'
  );
  if (
    latestMaintenanceStatus &&
    !isResolvedAfter(latestMaintenanceStatus.occurredAt)
  ) {
    const status = latestMaintenanceStatus.attributes.maintenance_status;
    if (status === 'overdue') {
      reasons.add(REASON_CODES.MAINTENANCE_OVERDUE);
      hasActiveMedium = true;
    } else if (status === 'due_soon') {
      reasons.add(REASON_CODES.MAINTENANCE_DUE_SOON);
    }
  }

  const hasOpenWorkOrder = workOrders.some(
    (wo) => (wo.status || wo.status) === 'open'
  );
  if (hasOpenWorkOrder) {
    reasons.add(REASON_CODES.OPEN_WORK_ORDER);
    if (!hasActiveHigh && !hasActiveCritical) hasActiveMedium = true;
  }

  // --- Low confidence --------------------------------------------------------
  const conf = latest.vendorConfidence;
  const health = latest.sensorHealth;
  if (
    (Number.isFinite(conf) && conf < 0.5) ||
    (Number.isFinite(health) && health < 0.5)
  ) {
    reasons.add(REASON_CODES.LOW_SENSOR_CONFIDENCE);
  }

  // --- Recovery (only meaningful after a real condition) --------------------
  const hasPriorCondition = sorted.some(
    (e) =>
      CONDITION_CATEGORIES.includes(e.type) &&
      severityRank(e.severity) >= severityRank(SEVERITIES.MEDIUM)
  );
  const recoveryPresent = Boolean(recoveryAt) && hasPriorCondition;
  if (recoveryPresent) reasons.add(REASON_CODES.RECOVERY_SIGNAL);

  // --- Staleness -------------------------------------------------------------
  if (stale) reasons.add(REASON_CODES.STALE_DATA);

  // --- Attention level -------------------------------------------------------
  let attention;
  if (hasActiveCritical) attention = ATTENTION_LEVELS.CRITICAL;
  else if (hasActiveHigh) attention = ATTENTION_LEVELS.HIGH;
  else if (hasActiveMedium) attention = ATTENTION_LEVELS.MEDIUM;
  else if (hasActiveLow) attention = ATTENTION_LEVELS.LOW;
  else attention = ATTENTION_LEVELS.NONE;

  // --- Derived status --------------------------------------------------------
  let derived;
  if (hasActiveCritical) derived = DERIVED_STATUS.CRITICAL;
  else if (hasActiveHigh || hasActiveMedium) derived = DERIVED_STATUS.WARNING;
  else if (stale) derived = DERIVED_STATUS.STALE;
  else if (recoveryPresent) derived = DERIVED_STATUS.RECOVERING;
  else derived = DERIVED_STATUS.OK;

  const reasonCodes = [...reasons].sort(
    (a, b) => (REASON_CODE_RANK[a] ?? 999) - (REASON_CODE_RANK[b] ?? 999)
  );

  const sourceEventRefs = sorted.slice(0, 10).map((e) => ({
    canonicalEventId: e.id,
    vendor: e.vendor,
    vendorEventId: e.vendorEventId,
    submissionId: e.sourceSubmissionId,
    recordIndex: e.sourceRecordIndex,
  }));

  return {
    machine_id: machineId,
    plant_id: plantId,
    line_id: lineId,
    derived_status: derived,
    attention_level: attention,
    needs_attention: NEEDS_ATTENTION_BY_STATUS[derived],
    reason_codes: reasonCodes,
    latest_relevant_event_time: latest.occurredAt,
    latest_relevant_event_id: latest.id,
    source_event_refs: sourceEventRefs,
    processing_status: processingStatusHint || 'processed',
    last_processed_at: now,
    source_max_event_time: latest.occurredAt,
  };
}

module.exports = { deriveMachineState, normalizeEvent, compareEventsDesc };
