-- 0007_machine_state.sql
--
-- Derived machine operational-state projection. One row per machine, recomputed
-- deterministically from canonical_events (and, where relevant, open maintenance
-- work orders) whenever affected records are processed.
--
-- This is the source of truth for the operational read APIs. It is a stored
-- table (not a view) so summaries can aggregate cheaply and so freshness /
-- processing context can be surfaced explicitly.
--
-- `derived_status` values and semantics are documented in docs/DESIGN_NOTES.md;
-- a machine with no evidence is 'unknown' and is NEVER reported as healthy.
--
-- Idempotent (IF NOT EXISTS). Additive only.

CREATE TABLE IF NOT EXISTS machine_state (
  machine_id                 text PRIMARY KEY REFERENCES machines(machine_id) ON DELETE CASCADE,
  plant_id                   text NOT NULL,
  line_id                    text NOT NULL,
  derived_status             text NOT NULL CHECK (derived_status IN (
                               'ok', 'warning', 'critical', 'recovering', 'stale', 'unknown'
                             )),
  attention_level            text NOT NULL CHECK (attention_level IN (
                               'none', 'low', 'medium', 'high', 'critical'
                             )),
  needs_attention            boolean NOT NULL,
  -- Ordered, de-duplicated list of stable reason codes (see DESIGN_NOTES).
  reason_codes               jsonb NOT NULL DEFAULT '[]'::jsonb,
  latest_relevant_event_time timestamptz,
  latest_relevant_event_id   uuid,
  -- Traceability refs: [{ canonicalEventId, vendor, vendorEventId, submissionId, recordIndex }]
  source_event_refs          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Read-time processing context: no event ever rejected/lost -> 'processed'.
  processing_status          text NOT NULL CHECK (processing_status IN (
                               'processed', 'partially_processed', 'failed', 'unknown'
                             )) DEFAULT 'unknown',
  last_processed_at          timestamptz,
  source_max_event_time      timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_machine_state_plant
  ON machine_state (plant_id);
CREATE INDEX IF NOT EXISTS idx_machine_state_line
  ON machine_state (line_id);
CREATE INDEX IF NOT EXISTS idx_machine_state_status
  ON machine_state (derived_status, attention_level);

DROP TRIGGER IF EXISTS trg_machine_state_updated_at ON machine_state;
CREATE TRIGGER trg_machine_state_updated_at
  BEFORE UPDATE ON machine_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
