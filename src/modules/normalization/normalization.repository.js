'use strict';

const { deriveMachineState } = require('./machineState');
const { computeDedupeKey } = require('./fingerprint');

/**
 * Persistence for normalized submissions. All writes happen inside one
 * transaction supplied by the caller, so a submission's canonical events,
 * failure ledger, and recomputed machine state commit atomically.
 */

const EVENT_COLUMNS = `
  id, vendor, vendor_event_id, source_submission_id, source_record_index,
  machine_id, plant_id, line_id, canonical_event_type, raw_event_type,
  severity, occurred_at, temperature_c, vibration_mm_s, vibration_g, power_kw,
  sensor_health, vendor_confidence, signal_quality, is_active,
  attributes, warnings
`;

function eventParams(record, submissionId, recordIndex) {
  return [
    record.vendor,
    record.vendorEventId,
    submissionId,
    recordIndex,
    record.machine_id,
    record.plant_id,
    record.line_id,
    record.canonicalEventType,
    record.rawEventType,
    record.severity,
    record.occurredAt,
    record.temperatureC,
    record.vibrationMmS,
    record.vibrationG,
    record.powerKw,
    record.machineState,
    record.sensorHealth,
    record.vendorConfidence,
    record.signalQuality,
    record.isActive,
    JSON.stringify(record.unitMetadata || null),
    JSON.stringify(record.attributes || {}),
    JSON.stringify(record.warnings || []),
    computeDedupeKey(record),
    record.sourceVersion || null,
  ];
}

/**
 * Insert one accepted canonical event. Returns the inserted id, or null if an
 * equivalent event already exists (either the content fingerprint or the
 * (vendor, vendor_event_id) unique constraint fired) — in which case the record
 * is an expected replay/duplicate and is counted, not treated as an error.
 */
async function insertEvent(client, record, submissionId, recordIndex) {
  const { rows } = await client.query(
    `INSERT INTO canonical_events
       (vendor, vendor_event_id, source_submission_id, source_record_index,
        machine_id, plant_id, line_id, canonical_event_type, raw_event_type,
        severity, occurred_at, temperature_c, vibration_mm_s, vibration_g, power_kw,
        machine_state, sensor_health, vendor_confidence, signal_quality, is_active,
        unit_metadata, attributes, warnings, dedupe_key, source_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    eventParams(record, submissionId, recordIndex)
  );
  return rows[0] ? rows[0].id : null;
}

/** Record one issue (error or warning) for a rejected/warned source record. */
async function insertFailure(client, submissionId, vendor, index, vendorEventId, raw, issue) {
  await client.query(
    `INSERT INTO normalization_failures
       (source_submission_id, vendor, source_record_index, vendor_event_id,
        raw_event, error_code, error_message, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_submission_id, source_record_index, error_code) DO NOTHING`,
    [
      submissionId,
      vendor,
      index,
      vendorEventId,
      JSON.stringify(raw ?? null),
      issue.code,
      String(issue.message || issue.code).slice(0, 2000),
      issue.severity,
    ]
  );
}

/** Recompute and upsert the derived operational state for one machine. */
async function recomputeMachineState(client, machine, { now, staleWindowMs, processingStatus }) {
  const { rows: events } = await client.query(
    `SELECT ${EVENT_COLUMNS}
       FROM canonical_events
      WHERE machine_id = $1`,
    [machine.machine_id]
  );

  const { rows: workOrders } = await client.query(
    `SELECT work_order_id, machine_id, status, opened_at, closed_at, post_maintenance_check
       FROM maintenance_work_orders
      WHERE machine_id = $1`,
    [machine.machine_id]
  );

  const state = deriveMachineState({
    now,
    staleWindowMs,
    machine,
    events,
    workOrders,
    processingStatusHint: processingStatus || 'processed',
  });

  await client.query(
    `INSERT INTO machine_state
       (machine_id, plant_id, line_id, derived_status, attention_level, needs_attention,
        reason_codes, latest_relevant_event_time, latest_relevant_event_id,
        source_event_refs, processing_status, last_processed_at, source_max_event_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (machine_id) DO UPDATE
       SET plant_id = EXCLUDED.plant_id,
           line_id = EXCLUDED.line_id,
           derived_status = EXCLUDED.derived_status,
           attention_level = EXCLUDED.attention_level,
           needs_attention = EXCLUDED.needs_attention,
           reason_codes = EXCLUDED.reason_codes,
           latest_relevant_event_time = EXCLUDED.latest_relevant_event_time,
           latest_relevant_event_id = EXCLUDED.latest_relevant_event_id,
           source_event_refs = EXCLUDED.source_event_refs,
           processing_status = EXCLUDED.processing_status,
           last_processed_at = EXCLUDED.last_processed_at,
           source_max_event_time = EXCLUDED.source_max_event_time`,
    [
      state.machine_id,
      state.plant_id,
      state.line_id,
      state.derived_status,
      state.attention_level,
      state.needs_attention,
      JSON.stringify(state.reason_codes),
      state.latest_relevant_event_time,
      state.latest_relevant_event_id,
      JSON.stringify(state.source_event_refs),
      state.processing_status,
      state.last_processed_at,
      state.source_max_event_time,
    ]
  );

  return state;
}

module.exports = {
  EVENT_COLUMNS,
  insertEvent,
  insertFailure,
  recomputeMachineState,
};
