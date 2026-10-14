'use strict';

const { withTransaction } = require('../../db/tx');
const { submissionStatusForJob } = require('./status');

const JOB_COLUMNS =
  'id, submission_id, job_type, status, attempts, max_attempts, available_at, locked_at, locked_by, last_error, error_category, created_at, updated_at';

/**
 * Job-queue persistence. Every method that changes state runs inside a single
 * transaction that updates BOTH the job and its submission, so the queue and
 * the submission's processing_status can never drift apart.
 *
 * All methods take an explicit `now` (Date) supplied by the caller's clock, so
 * timing is deterministic in tests and the worker can inject a clock.
 */

/**
 * Atomically claim up to `limit` due jobs for this worker.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never block on or steal
 * each other's rows: each worker walks past rows already locked by another and
 * claims the next available ones. `attempts` is incremented at claim time, so
 * every claim counts as an attempt even if the worker later crashes.
 */
async function claimBatch({ workerId, limit, now }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE processing_jobs
          SET status = 'processing',
              locked_at = $1,
              locked_by = $2,
              attempts = processing_jobs.attempts + 1,
              updated_at = $1
        WHERE id IN (
          SELECT id
            FROM processing_jobs
           WHERE status IN ('pending', 'retrying')
             AND available_at <= $1
           ORDER BY available_at ASC, created_at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${JOB_COLUMNS}`,
      [now, workerId, limit]
    );

    if (rows.length > 0) {
      const submissionIds = rows.map((row) => row.submission_id);
      await client.query(
        `UPDATE ingestion_submissions
            SET processing_status = 'processing', updated_at = $1
          WHERE id = ANY($2::uuid[])`,
        [now, submissionIds]
      );
    }

    return rows;
  });
}

/**
 * Ownership-guarded terminal transition. The `locked_by = $workerId AND
 * status = 'processing'` predicate is the stale-worker guard: if the lease had
 * expired and another worker reclaimed the job, `locked_by` no longer matches,
 * zero rows update, and this returns null so the caller discards its result.
 */
async function applyOwnedTransition(
  client,
  { jobId, workerId, toStatus, availableAt = null, lastError = null, errorCategory = null, now }
) {
  const { rows } = await client.query(
    `UPDATE processing_jobs
        SET status = $4,
            available_at = COALESCE($5, available_at),
            locked_at = NULL,
            locked_by = NULL,
            last_error = $6,
            error_category = $7,
            updated_at = $8
      WHERE id = $1
        AND locked_by = $2
        AND status = $3
      RETURNING ${JOB_COLUMNS}`,
    [jobId, workerId, 'processing', toStatus, availableAt, lastError, errorCategory, now]
  );

  const job = rows[0];
  if (!job) return null;

  await client.query(
    `UPDATE ingestion_submissions
        SET processing_status = $1, updated_at = $2
      WHERE id = $3`,
    [submissionStatusForJob(toStatus), now, job.submission_id]
  );

  return job;
}

function completeJob({ jobId, workerId, now }) {
  return withTransaction((client) =>
    applyOwnedTransition(client, {
      jobId,
      workerId,
      toStatus: 'succeeded',
      now,
    })
  );
}

function scheduleRetry({ jobId, workerId, availableAt, lastError, errorCategory = 'transient', now }) {
  return withTransaction((client) =>
    applyOwnedTransition(client, {
      jobId,
      workerId,
      toStatus: 'retrying',
      availableAt,
      lastError,
      errorCategory,
      now,
    })
  );
}

function deadLetter({ jobId, workerId, lastError, errorCategory = 'permanent', now }) {
  return withTransaction((client) =>
    applyOwnedTransition(client, {
      jobId,
      workerId,
      toStatus: 'dead_letter',
      lastError,
      errorCategory,
      now,
    })
  );
}

function blockJob({ jobId, workerId, reason, now }) {
  return withTransaction((client) =>
    applyOwnedTransition(client, {
      jobId,
      workerId,
      toStatus: 'blocked',
      lastError: reason,
      errorCategory: 'not_implemented',
      now,
    })
  );
}

/**
 * Reclaim jobs whose lease expired (the owning worker died or stalled).
 *
 * Bounded by `limit` and guarded with `FOR UPDATE SKIP LOCKED`, so running this
 * concurrently on many workers is safe. A job that already exhausted its
 * attempts on the abandoned run is dead-lettered instead of being retried
 * forever. `nextAvailableAt(attempts)` is injected so backoff stays a pure
 * function owned by the caller.
 */
async function recoverExpiredJobs({ now, leaseMs, limit, nextAvailableAt }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, submission_id, attempts, max_attempts
         FROM processing_jobs
        WHERE status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at < ($1::timestamptz - ($2::int * interval '1 millisecond'))
        ORDER BY locked_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [now, leaseMs, limit]
    );

    const recovered = [];
    for (const job of rows) {
      const exhausted = job.attempts >= job.max_attempts;
      const toStatus = exhausted ? 'dead_letter' : 'retrying';
      const availableAt = exhausted ? null : nextAvailableAt(job.attempts);

      await client.query(
        `UPDATE processing_jobs
            SET status = $1,
                available_at = COALESCE($2, available_at),
                locked_at = NULL,
                locked_by = NULL,
                last_error = $3,
                error_category = 'lease_expired',
                updated_at = $4
          WHERE id = $5`,
        [toStatus, availableAt, 'Job lease expired; reclaimed after worker crash', now, job.id]
      );

      await client.query(
        `UPDATE ingestion_submissions
            SET processing_status = $1, updated_at = $2
          WHERE id = $3`,
        [submissionStatusForJob(toStatus), now, job.submission_id]
      );

      recovered.push({ id: job.id, submissionId: job.submission_id, status: toStatus });
    }

    return recovered;
  });
}

module.exports = {
  JOB_COLUMNS,
  claimBatch,
  completeJob,
  scheduleRetry,
  deadLetter,
  blockJob,
  recoverExpiredJobs,
};
