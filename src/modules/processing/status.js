'use strict';

/**
 * Submission processing-status consistency.
 *
 * In Phase 4 a submission has exactly one job (normalize_submission), so the
 * submission's processing_status is a direct projection of its job's status.
 * This module is the single source of truth for that projection and is applied
 * inside the same transaction as every job transition, so the two tables can
 * never diverge:
 *
 *   job pending     -> submission pending     (accepted, not yet claimed)
 *   job processing  -> submission processing  (claimed, lease held)
 *   job retrying    -> submission retrying    (attempt failed, retry scheduled)
 *   job succeeded   -> submission succeeded   (domain processing actually completed)
 *   job dead_letter -> submission dead_letter (terminal failure)
 *   job blocked     -> submission blocked     (domain processing cannot proceed)
 *
 * 'failed' and 'cancelled' are defined for completeness/reserved use.
 *
 * INVARIANT: a submission is only ever 'succeeded' when its handler genuinely
 * reported success.
 */
const SUBMISSION_STATUS_BY_JOB_STATUS = Object.freeze({
  pending: 'pending',
  processing: 'processing',
  retrying: 'retrying',
  succeeded: 'succeeded',
  dead_letter: 'dead_letter',
  blocked: 'blocked',
  // Reserved states.
  failed: 'failed',
  cancelled: 'failed',
});

function submissionStatusForJob(jobStatus) {
  const mapped = SUBMISSION_STATUS_BY_JOB_STATUS[jobStatus];
  if (!mapped) {
    throw new Error(`No submission status mapping for job status "${jobStatus}"`);
  }
  return mapped;
}

module.exports = { submissionStatusForJob, SUBMISSION_STATUS_BY_JOB_STATUS };
