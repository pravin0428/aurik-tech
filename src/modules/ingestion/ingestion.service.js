'use strict';

const { withTransaction } = require('../../db/tx');
const AppError = require('../../errors/AppError');
const { ErrorCategory } = require('../../errors/AppError');
const logger = require('../../logger');
const config = require('../../config');
const { hashPayload } = require('./idempotency');
const repo = require('./ingestion.repository');

function toSubmissionView(submission, idempotentReplay) {
  return {
    submissionId: submission.id,
    vendor: submission.vendor,
    status: submission.status,
    processingStatus: submission.processing_status,
    acceptedAt: (submission.received_at || submission.created_at).toISOString?.() ??
      submission.received_at,
    idempotentReplay,
  };
}

/**
 * Accept a provisional generic submission.
 *
 * TRANSACTIONAL GUARANTEE: the submission row and its processing job are
 * inserted inside one transaction. If either insert fails, the whole thing
 * rolls back, so a payload is never "accepted" without a corresponding job.
 */
async function acceptSubmission({
  vendor,
  idempotencyKey,
  idempotencySource,
  envelope,
  requestId,
}) {
  const payloadHash = hashPayload(envelope.payload);

  const result = await withTransaction(async (client) => {
    const inserted = await repo.insertSubmission(client, {
      vendor,
      idempotencyKey,
      idempotencySource,
      payloadHash,
      // Store the envelope exactly as received for traceability/reprocessing.
      rawPayload: envelope,
      sourceMetadata: envelope.source ?? null,
      requestId,
    });

    if (inserted) {
      await repo.insertJobIfAbsent(client, inserted.id, repo.JOB_TYPE, config.worker.maxAttempts);
      return { submission: inserted, created: true };
    }

    // Conflict path: a submission with this (vendor, key) already exists.
    const existing = await repo.findSubmissionByKey(client, vendor, idempotencyKey);

    if (!existing) {
      // Defensive: ON CONFLICT DO NOTHING guarantees the row exists at this
      // point. Falling through would mean we cannot honour the idempotency
      // contract, so fail loudly rather than silently creating duplicate work.
      logger.error({ vendor, requestId }, 'Idempotent submission lookup returned no row');
      throw AppError.processing('Could not resolve existing submission for idempotency key', {
        code: 'IDEMPOTENCY_RESOLUTION_FAILED',
      });
    }

    if (existing.payload_hash !== payloadHash) {
      // Same key, different payload: deterministic, documented client error.
      throw new AppError(
        'Idempotency key was already used with a different payload',
        {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          category: ErrorCategory.CONFLICT,
          details: [{ path: 'Idempotency-Key', message: 'key reuse with a different payload' }],
        }
      );
    }

    return { submission: existing, created: false };
  });

  logger.info(
    {
      submissionId: result.submission.id,
      vendor,
      requestId,
      idempotentReplay: !result.created,
      idempotencySource,
    },
    'Submission accepted'
  );

  return toSubmissionView(result.submission, !result.created);
}

/** Read a submission's ingestion + processing status. */
async function getSubmissionStatus(submissionId) {
  const submission = await repo.findSubmissionById(submissionId);
  if (!submission) {
    throw AppError.notFound('Submission not found');
  }

  const jobs = await repo.findJobsBySubmission(submissionId);

  return {
    submissionId: submission.id,
    vendor: submission.vendor,
    status: submission.status,
    processingStatus: submission.processing_status,
    receivedAt: submission.received_at,
    createdAt: submission.created_at,
    updatedAt: submission.updated_at,
    jobs: jobs.map((job) => ({
      type: job.job_type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      availableAt: job.available_at,
    })),
  };
}

module.exports = {
  acceptSubmission,
  getSubmissionStatus,
  toSubmissionView,
};
