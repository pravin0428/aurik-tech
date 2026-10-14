-- 0005_canonical_events.sql
--
-- Canonical event store. One row per accepted (normalized) source record from a
-- vendor submission. Vendor-specific extras live in `attributes` jsonb; the
-- fields that the operational view and summaries depend on are explicit columns.
--
-- Traceability: every row carries the originating submission id and the record
-- index within that submission's payload, plus the vendor's own event id.
--
-- Idempotency / dedup (see docs/DESIGN_NOTES.md):
--   * `dedupe_key` is a deterministic CONTENT fingerprint (vendor + machine +
--     normalized event type + occurred_at + measures). It is UNIQUE, so the same
--     logical record replayed (even with a mutated vendor id, e.g. TW-8801-R)
--     never creates a second canonical event.
--   * `(vendor, vendor_event_id)` is UNIQUE when the id is present, so a vendor
--     re-using the same id with different content is a detectable conflict.
--
-- `temperature_c` is normalized from any supported unit; ThermexWatch vibration
-- is preserved as `vibration_g` and NEVER converted to `vibration_mm_s`
-- (acceleration -> velocity is not a valid conversion without frequency).
--
-- Idempotent (IF NOT EXISTS). Additive only.

CREATE TABLE IF NOT EXISTS canonical_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor                text NOT NULL CHECK (length(vendor) BETWEEN 1 AND 64),
  vendor_event_id       text,
  source_submission_id  uuid NOT NULL REFERENCES ingestion_submissions(id) ON DELETE CASCADE,
  source_record_index   integer NOT NULL CHECK (source_record_index >= 0),
  machine_id            text NOT NULL REFERENCES machines(machine_id) ON DELETE RESTRICT,
  plant_id              text NOT NULL,
  line_id               text NOT NULL,
  canonical_event_type  text NOT NULL CHECK (canonical_event_type IN (
                          'vibration', 'temperature', 'power', 'sensor_health',
                          'recovery', 'ok',
                          'inspection', 'maintenance', 'operator_note', 'calibration'
                        )),
  raw_event_type        text NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('none', 'low', 'medium', 'high', 'critical')),
  occurred_at           timestamptz NOT NULL,
  source_ingested_at    timestamptz,
  temperature_c         numeric(8, 3),
  vibration_mm_s        numeric(8, 3),
  vibration_g           numeric(8, 4),
  power_kw              numeric(10, 3),
  machine_state         text,
  sensor_health         numeric(6, 4),
  vendor_confidence     numeric(6, 4),
  signal_quality        text,
  is_active             boolean,
  -- Original unit metadata as received, so conversions stay auditable.
  unit_metadata         jsonb,
  -- Vendor-specific fields not promoted to columns.
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings              jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key            text NOT NULL,
  source_version        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_events_dedupe_unique UNIQUE (dedupe_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_events_vendor_event_id_unique
  ON canonical_events (vendor, vendor_event_id)
  WHERE vendor_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_events_machine_time
  ON canonical_events (machine_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_events_source_submission
  ON canonical_events (source_submission_id);

-- Supports the "latest event in a category" scans used by the state reducer.
CREATE INDEX IF NOT EXISTS idx_canonical_events_machine_type_time
  ON canonical_events (machine_id, canonical_event_type, occurred_at DESC);
