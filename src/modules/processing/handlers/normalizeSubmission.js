'use strict';

const config = require('../../../config');
const ingestionRepo = require('../../ingestion/ingestion.repository');
const { normalizeSubmission: runNormalization } = require('../../normalization/normalization.service');
const { OUTCOME, permanentError } = require('../outcome');

/**
 * `normalize_submission` handler.
 *
 * Loads the persisted submission and its raw payload, then delegates to the
 * normalization service (adapter selection + canonical persistence + state
 * recomputation). The handler is idempotent: canonical rows dedupe on a content
 * fingerprint and the failure ledger is upsert-by-key, so re-executing after a
 * crash or lease expiry converges to the same result and is safe to succeed.
 *
 * Success is reported ONLY when the batch contract is fulfilled (payload parsed,
 * every record either accepted or recorded as a failure, state recomputed).
 * Unrecoverable submission-level problems throw a permanent error -> dead-letter.
 * Transient DB/infra errors bubble up -> retried with backoff.
 */
async function normalizeSubmission(job, ctx = {}) {
  const { logger, clock } = ctx;
  const now = clock ? clock() : new Date();

  const submission = await ingestionRepo.findSubmissionWithPayloadById(job.submission_id);
  if (!submission) {
    throw permanentError(`Submission ${job.submission_id} not found`, {
      category: 'submission_not_found',
    });
  }

  const result = await runNormalization({
    submission,
    now,
    staleWindowMs: config.normalization.staleWindowMs,
    logger,
  });

  return { outcome: OUTCOME.SUCCEEDED, summary: result.summary };
}

module.exports = {
  jobType: 'normalize_submission',
  handler: normalizeSubmission,
};
