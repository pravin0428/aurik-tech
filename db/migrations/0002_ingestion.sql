-- 0002_ingestion.sql
--
-- Generic, vendor-agnostic ingestion infrastructure.
--
-- Purpose of each table:
--
--   ingestion_submissions
--     The accepted-work record. One row per (vendor, idempotency_key). It stores
--     the raw request envelope verbatim (jsonb) for traceability/reprocessing,
--     the vendor/source metadata, a payload hash for idempotency comparison, the
--     ingestion status, the coarse processing status, and request correlation.
--     This is the audit anchor: every later canonical event will reference the
--     submission it was derived from.
--
--   processing_jobs
--     The single, PostgreSQL-backed work queue. Phase 3 only CREATES one job per
--     submission transactionally; the Phase 4 worker will claim, retry, recover,
--     and dead-letter jobs from this same table. `available_at`, `locked_at`,
--     `locked_by`, attempt counters, and terminal states are defined now so the
--     queue can be extended without a schema migration.
--
-- Deliberately NOT created here (added only once the assessment assets exist):
-- machines, plants, production lines, canonical events, vendor field mappings,
-- and any operational-state tables.
--
-- Idempotent: IF NOT EXISTS / DROP-THEN-CREATE for triggers. The runner also
-- records each version exactly once.

CREATE TABLE IF NOT EXISTS ingestion_submissions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor             text NOT NULL CHECK (length(vendor) BETWEEN 1 AND 64),
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  idempotency_source text NOT NULL CHECK (idempotency_source IN ('header', 'body')),
  payload_hash       text NOT NULL,
  raw_payload        jsonb NOT NULL,
  source_metadata    jsonb,
  status             text NOT NULL DEFAULT 'accepted'
                       CHECK (status IN ('accepted', 'rejected')),
  processing_status  text NOT NULL DEFAULT 'pending'
                       CHECK (processing_status IN
                         ('pending', 'processing', 'succeeded', 'partially_failed', 'failed', 'dead_letter')),
  request_id         text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_submissions_vendor_key_unique UNIQUE (vendor, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_submissions_vendor_received
  ON ingestion_submissions (vendor, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_submissions_processing_status
  ON ingestion_submissions (processing_status);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES ingestion_submissions(id) ON DELETE CASCADE,
  job_type       text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN
                     ('pending', 'processing', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  available_at   timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  locked_by      text,
  last_error     text,
  error_category text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One job per submission per job type: makes job creation idempotent and
  -- guarantees repeated submissions cannot create duplicate work.
  CONSTRAINT processing_jobs_submission_type_unique UNIQUE (submission_id, job_type)
);

-- Supports the Phase 4 claim query (status = 'pending' AND available_at <= now()).
CREATE INDEX IF NOT EXISTS idx_processing_jobs_claim
  ON processing_jobs (status, available_at);

-- Reuse the generic trigger function defined in 0001_infrastructure.sql.
DROP TRIGGER IF EXISTS trg_ingestion_submissions_updated_at ON ingestion_submissions;
CREATE TRIGGER trg_ingestion_submissions_updated_at
  BEFORE UPDATE ON ingestion_submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_processing_jobs_updated_at ON processing_jobs;
CREATE TRIGGER trg_processing_jobs_updated_at
  BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
