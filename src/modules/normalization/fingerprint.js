'use strict';

const crypto = require('crypto');
const { stableStringify } = require('../ingestion/idempotency');

/**
 * Deterministic content fingerprint used as `canonical_events.dedupe_key`.
 *
 * WHY CONTENT (not the vendor id alone): the `duplicates.json` fixture contains
 * `TW-8801` and `TW-8801-R` — the same logical reading replayed with a mutated
 * id. A replayed duplicate whose id changed has, in effect, an unreliable id, so
 * identity is derived from the normalized CONTENT. Vendor ids are still stored
 * and separately guarded by UNIQUE(vendor, vendor_event_id).
 *
 * The fingerprint intentionally EXCLUDES the vendor event id and the source
 * submission, so the same record re-sent in a later batch collapses onto one row.
 *
 * Included fields are the normalized, unit-consistent values plus an
 * adapter-supplied `contentKey` discriminator for records with few measures
 * (e.g. maintenance records: record_type + result + status).
 */
function computeFingerprintSource(record) {
  return {
    vendor: record.vendor,
    machineRef: record.machineRef || null,
    canonicalEventType: record.canonicalEventType,
    rawEventType: record.rawEventType,
    occurredAt: record.occurredAt instanceof Date ? record.occurredAt.getTime() : null,
    temperatureC: record.temperatureC ?? null,
    vibrationMmS: record.vibrationMmS ?? null,
    vibrationG: record.vibrationG ?? null,
    powerKw: record.powerKw ?? null,
    contentKey: record.contentKey ?? null,
  };
}

function computeDedupeKey(record) {
  const digest = crypto
    .createHash('sha256')
    .update(stableStringify(computeFingerprintSource(record)))
    .digest('hex');
  return `${record.vendor}:fp:${digest}`;
}

module.exports = { computeDedupeKey, computeFingerprintSource };
