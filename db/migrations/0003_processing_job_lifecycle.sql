-- 0003_processing_job_lifecycle.sql
--
-- Extends the Phase 3 processing queue with the states required by the
-- Phase 4 worker. No new tables are introduced: the existing processing_jobs
-- and ingestion_submissions tables already carry every column the worker needs
-- (attempts, max_attempts, available_at, locked_at, locked_by, last_error,
-- error_category, timestamps). The only thing missing was two lifecycle states.
--
-- WHY THIS MIGRATION IS NECESSARY (and minimal):
--
--   1. 'retrying' — a job whose most recent attempt failed but which is
--      scheduled for a future attempt (available_at > now). Without this state
--      a scheduled retry is indistinguishable from a brand-new, never-attempted
--      job, which makes submission status ("retrying") unrepresentable.
--
--   2. 'blocked'  — a job whose domain processing cannot proceed because the
--      handler is not implemented yet (the Phase 4 normalize_submission
--      placeholder). This must be observable and must NOT be reported as
--      'succeeded' or 'failed'. There is no existing state that expresses
--      "intentionally not processed".
--
-- The pre-existing states are retained. 'failed' and 'cancelled' remain defined
-- for future use but are not emitted by the Phase 4 worker.
--
-- Safe to run exactly once (the migration runner records it); the statements
-- are themselves idempotent.

-- --- processing_jobs.status ------------------------------------------------
-- The Phase 3 constraint was created inline and is auto-named by PostgreSQL.
ALTER TABLE processing_jobs
  DROP CONSTRAINT IF EXISTS processing_jobs_status_check;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_status_check CHECK (status IN (
    'pending',     -- ready to be claimed (available_at may be in the past now)
    'processing',  -- claimed by a worker, lease held (locked_by/locked_at set)
    'retrying',    -- an attempt failed; a future attempt is scheduled
    'succeeded',   -- terminal success
    'failed',      -- reserved
    'dead_letter', -- terminal failure (permanent error or retries exhausted)
    'blocked',     -- domain processing not implemented / cannot proceed
    'cancelled'    -- reserved
  ));

-- --- ingestion_submissions.processing_status -------------------------------
ALTER TABLE ingestion_submissions
  DROP CONSTRAINT IF EXISTS ingestion_submissions_processing_status_check;

ALTER TABLE ingestion_submissions
  ADD CONSTRAINT ingestion_submissions_processing_status_check CHECK (processing_status IN (
    'pending',
    'processing',
    'retrying',
    'succeeded',
    'partially_failed', -- reserved for multi-job submissions in a later phase
    'failed',           -- reserved
    'dead_letter',
    'blocked'
  ));

-- Supports the bounded, indexed scan used to reclaim jobs whose worker died
-- (status = 'processing' AND locked_at < lease cutoff). A partial index keeps
-- it small: only in-flight jobs are included.
CREATE INDEX IF NOT EXISTS idx_processing_jobs_lease
  ON processing_jobs (locked_at)
  WHERE status = 'processing';
