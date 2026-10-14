'use strict';

const { getPool, query } = require('../../db/pool');

// One job per submission; the Phase 4 worker will execute it.
const JOB_TYPE = 'normalize_submission';

const SUBMISSION_COLUMNS = `
  id, vendor, idempotency_key, idempotency_source, payload_hash,
  status, processing_status, request_id, received_at, created_at, updated_at
`;

/**
 * Insert a submission, or do nothing if (vendor, idempotency_key) already
 * exists. Returns the inserted row, or null on a conflict. Must be called with
 * the transaction client.
 */
async function insertSubmission(client, params) {
  const { rows } = await client.query(
    `INSERT INTO ingestion_submissions
       (vendor, idempotency_key, idempotency_source, payload_hash,
        raw_payload, source_metadata, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (vendor, idempotency_key) DO NOTHING
     RETURNING ${SUBMISSION_COLUMNS}`,
    [
      params.vendor,
      params.idempotencyKey,
      params.idempotencySource,
      params.payloadHash,
      params.rawPayload,
      params.sourceMetadata,
      params.requestId,
    ]
  );
  return rows[0] || null;
}

/** Look up an existing submission by its idempotency scope (transaction client). */
async function findSubmissionByKey(client, vendor, idempotencyKey) {
  const { rows } = await client.query(
    `SELECT ${SUBMISSION_COLUMNS}
       FROM ingestion_submissions
      WHERE vendor = $1 AND idempotency_key = $2`,
    [vendor, idempotencyKey]
  );
  return rows[0] || null;
}

/**
 * Create the submission's job unless one already exists. The UNIQUE constraint
 * on (submission_id, job_type) makes repeated submissions unable to create
 * duplicate work. Transaction client.
 */
async function insertJobIfAbsent(client, submissionId, jobType = JOB_TYPE, maxAttempts = null) {
  await client.query(
    `INSERT INTO processing_jobs (submission_id, job_type, max_attempts)
     VALUES ($1, $2, COALESCE($3::int, 5))
     ON CONFLICT (submission_id, job_type) DO NOTHING`,
    [submissionId, jobType, maxAttempts]
  );
}

/** Read a submission by id (non-transactional). */
async function findSubmissionById(submissionId) {
  const { rows } = await query(
    `SELECT ${SUBMISSION_COLUMNS}
       FROM ingestion_submissions
      WHERE id = $1`,
    [submissionId]
  );
  return rows[0] || null;
}

/**
 * Read a submission INCLUDING its stored raw payload. Used by the worker, which
 * needs the payload to normalize; the read APIs deliberately use the lighter
 * projection above so payload contents are never returned to clients.
 */
async function findSubmissionWithPayloadById(submissionId) {
  const { rows } = await query(
    `SELECT ${SUBMISSION_COLUMNS}, raw_payload, source_metadata
       FROM ingestion_submissions
      WHERE id = $1`,
    [submissionId]
  );
  return rows[0] || null;
}

/** Read all jobs for a submission (non-transactional). */
async function findJobsBySubmission(submissionId) {
  const { rows } = await query(
    `SELECT id, job_type, status, attempts, max_attempts, available_at, created_at, updated_at
       FROM processing_jobs
      WHERE submission_id = $1
      ORDER BY created_at ASC`,
    [submissionId]
  );
  return rows;
}

/** Row counts used by tests / diagnostics. */
async function countSubmissions() {
  const { rows } = await query('SELECT count(*)::int AS n FROM ingestion_submissions');
  return rows[0].n;
}

async function countJobs() {
  const { rows } = await query('SELECT count(*)::int AS n FROM processing_jobs');
  return rows[0].n;
}

module.exports = {
  JOB_TYPE,
  insertSubmission,
  findSubmissionByKey,
  insertJobIfAbsent,
  findSubmissionById,
  findSubmissionWithPayloadById,
  findJobsBySubmission,
  countSubmissions,
  countJobs,
};

// Re-export for convenience in tests that need a raw pool handle.
module.exports.getPool = getPool;
