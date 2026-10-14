-- 0006_normalization_failures.sql
--
-- Per-record rejection / warning ledger. When a batch is processed, valid
-- records become canonical_events and every rejected/warned record is recorded
-- here with a stable reason code, the raw record, and its index in the batch.
-- Raw payloads are therefore never lost even when a record is rejected.
--
-- One row per (submission, record index, error code) so re-processing the same
-- submission is idempotent (ON CONFLICT DO NOTHING).
--
-- Idempotent (IF NOT EXISTS). Additive only.

CREATE TABLE IF NOT EXISTS normalization_failures (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_submission_id uuid NOT NULL REFERENCES ingestion_submissions(id) ON DELETE CASCADE,
  vendor               text NOT NULL,
  source_record_index  integer,
  vendor_event_id      text,
  raw_event            jsonb,
  error_code           text NOT NULL CHECK (error_code ~ '^[a-z0-9_]{1,64}$'),
  error_message        text NOT NULL,
  severity             text NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalization_failures_unique
    UNIQUE (source_submission_id, source_record_index, error_code)
);

CREATE INDEX IF NOT EXISTS idx_normalization_failures_submission
  ON normalization_failures (source_submission_id);

CREATE INDEX IF NOT EXISTS idx_normalization_failures_code
  ON normalization_failures (error_code);
