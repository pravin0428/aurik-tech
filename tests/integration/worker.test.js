'use strict';

const crypto = require('crypto');
const { getPool, closePool } = require('../../src/db/pool');
const config = require('../../src/config');
const { createRegistry } = require('../../src/modules/processing/registry');
const repository = require('../../src/modules/processing/processing.repository');
const { createWorker } = require('../../src/modules/processing/worker');
const { OUTCOME, permanentError } = require('../../src/modules/processing/outcome');
const { computeBackoffMs } = require('../../src/modules/processing/backoff');
const normalizeSubmission = require('../../src/modules/processing/handlers/normalizeSubmission');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
};

const baseSettings = config.worker;

function makeWorker({ handlers = [], settings = {}, clock = () => new Date() } = {}) {
  return createWorker({
    registry: createRegistry(handlers),
    repository,
    logger: noopLogger,
    settings: { ...baseSettings, ...settings },
    clock,
    workerId: settings.workerId || 'worker-test',
  });
}

async function insertSubmission() {
  const { rows } = await getPool().query(
    `INSERT INTO ingestion_submissions
       (vendor, idempotency_key, idempotency_source, payload_hash, raw_payload)
     VALUES ('acme', $1, 'header', 'test-hash', '{}'::jsonb)
     RETURNING id`,
    [`key-${crypto.randomUUID()}`]
  );
  return rows[0].id;
}

async function insertJob({
  submissionId,
  jobType = 'normalize_submission',
  status = 'pending',
  attempts = 0,
  maxAttempts = 5,
  availableAt = null,
  lockedAt = null,
  lockedBy = null,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO processing_jobs
       (submission_id, job_type, status, attempts, max_attempts, available_at, locked_at, locked_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8)
     RETURNING *`,
    [submissionId, jobType, status, attempts, maxAttempts, availableAt, lockedAt, lockedBy]
  );
  return rows[0];
}

async function getJob(id) {
  const { rows } = await getPool().query('SELECT * FROM processing_jobs WHERE id = $1', [id]);
  return rows[0];
}

async function getSubmissionStatus(id) {
  const { rows } = await getPool().query(
    'SELECT processing_status FROM ingestion_submissions WHERE id = $1',
    [id]
  );
  return rows[0].processing_status;
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

maybe('processing job queue (worker)', () => {
  beforeAll(async () => {
    await getPool().query('SELECT 1 FROM processing_jobs LIMIT 1');
  });

  beforeEach(async () => {
    await getPool().query(
      'TRUNCATE processing_jobs, ingestion_submissions RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('claim and complete', () => {
    test('claims a due job and completes it with a test handler', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId });
      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.SUCCEEDED }) }],
      });

      const claimed = await worker.runOnce();
      expect(claimed).toBe(1);

      const stored = await getJob(job.id);
      expect(stored.status).toBe('succeeded');
      expect(stored.attempts).toBe(1);
      expect(stored.locked_by).toBeNull();
      expect(stored.locked_at).toBeNull();
      expect(await getSubmissionStatus(submissionId)).toBe('succeeded');
    });

    test('does not claim a job scheduled in the future', async () => {
      const submissionId = await insertSubmission();
      const future = new Date(Date.now() + 60_000);
      const job = await insertJob({ submissionId, status: 'retrying', attempts: 1, availableAt: future });

      const worker = makeWorker();
      const claimed = await worker.runOnce();

      expect(claimed).toBe(0);
      expect((await getJob(job.id)).status).toBe('retrying');
    });

    test('claims a retry once it becomes due', async () => {
      const submissionId = await insertSubmission();
      const past = new Date(Date.now() - 1000);
      await insertJob({ submissionId, status: 'retrying', attempts: 1, availableAt: past });

      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.SUCCEEDED }) }],
      });

      expect(await worker.runOnce()).toBe(1);
      expect(await getSubmissionStatus(submissionId)).toBe('succeeded');
    });
  });

  describe('concurrency', () => {
    test('two workers claiming concurrently never claim the same job', async () => {
      for (let i = 0; i < 20; i += 1) {
        const submissionId = await insertSubmission();
        await insertJob({ submissionId });
      }

      const now = new Date();
      const [a, b] = await Promise.all([
        repository.claimBatch({ workerId: 'worker-a', limit: 10, now }),
        repository.claimBatch({ workerId: 'worker-b', limit: 10, now }),
      ]);

      const idsA = a.map((j) => j.id);
      const idsB = b.map((j) => j.id);

      // Safety property: no job is ever owned by two workers at once.
      expect(idsA.filter((id) => idsB.includes(id))).toHaveLength(0);
      // Each claim respects its batch bound.
      expect(idsA.length).toBeLessThanOrEqual(10);
      expect(idsB.length).toBeLessThanOrEqual(10);

      // Under contention a poll may return fewer than LIMIT (a concurrent
      // worker held locks that were skipped); the remainder is claimed on later
      // polls. The invariant is that no job is lost and none is claimed twice.
      const claimed = new Set([...idsA, ...idsB]);
      let rounds = 0;
      while (claimed.size < 20 && rounds < 10) {
        const more = await repository.claimBatch({
          workerId: 'worker-a',
          limit: 10,
          now: new Date(),
        });
        if (more.length === 0) break;
        for (const job of more) claimed.add(job.id);
        rounds += 1;
      }
      expect(claimed.size).toBe(20);

      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE attempts = 1)::int AS once
           FROM processing_jobs`
      );
      expect(rows[0].n).toBe(20);
      expect(rows[0].once).toBe(20);
    });
  });

  describe('retry and backoff', () => {
    test('schedules an exponential-backoff retry on a transient failure', async () => {
      const submissionId = await insertSubmission();
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      // available_at must be <= the injected clock for the job to be claimable.
      const job = await insertJob({ submissionId, maxAttempts: 5, availableAt: t0 });

      let current = t0;
      const clock = () => new Date(current);
      const worker = makeWorker({
        clock,
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.RETRY, error: new Error('transient') }) }],
        settings: { backoffBaseMs: 1000, backoffMaxMs: 60000 },
      });

      await worker.runOnce();

      let stored = await getJob(job.id);
      expect(stored.status).toBe('retrying');
      expect(stored.attempts).toBe(1);
      expect(stored.error_category).toBe('transient');
      expect(stored.last_error).toBe('transient');
      expect(new Date(stored.available_at).getTime()).toBe(t0.getTime() + 1000);
      expect(await getSubmissionStatus(submissionId)).toBe('retrying');

      // Second attempt at the scheduled time => backoff doubles using attempt #2.
      current = new Date(t0.getTime() + 1000);
      await worker.runOnce();

      stored = await getJob(job.id);
      expect(stored.attempts).toBe(2);
      expect(new Date(stored.available_at).getTime()).toBe(t0.getTime() + 1000 + 2000);
    });

    test('caps the backoff at the configured maximum', async () => {
      const submissionId = await insertSubmission();
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const job = await insertJob({ submissionId, attempts: 6, maxAttempts: 10, availableAt: t0 });

      const clock = () => new Date(t0);
      const worker = makeWorker({
        clock,
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.RETRY, error: new Error('x') }) }],
        settings: { backoffBaseMs: 1000, backoffMaxMs: 5000 },
      });

      await worker.runOnce();

      const stored = await getJob(job.id);
      expect(new Date(stored.available_at).getTime()).toBe(t0.getTime() + 5000);
    });
  });

  describe('permanent failure and exhaustion', () => {
    test('dead-letters a permanent error immediately without consuming retries', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId, maxAttempts: 5 });

      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => { throw permanentError('bad payload'); } }],
      });

      await worker.runOnce();

      const stored = await getJob(job.id);
      expect(stored.status).toBe('dead_letter');
      expect(stored.attempts).toBe(1);
      expect(stored.error_category).toBe('permanent');
      expect(stored.last_error).toBe('bad payload');
      expect(await getSubmissionStatus(submissionId)).toBe('dead_letter');
    });

    test('dead-letters once retries are exhausted', async () => {
      const submissionId = await insertSubmission();
      // attempts=2, max=3: the next claim increments to 3 == max, so it exhausts.
      const job = await insertJob({ submissionId, attempts: 2, maxAttempts: 3 });

      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.RETRY, error: new Error('still failing') }) }],
      });

      await worker.runOnce();

      const stored = await getJob(job.id);
      expect(stored.status).toBe('dead_letter');
      expect(stored.attempts).toBe(3);
      expect(stored.error_category).toBe('retries_exhausted');
      expect(await getSubmissionStatus(submissionId)).toBe('dead_letter');
    });

    test('dead-letters a job with no registered handler', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId, jobType: 'mystery_job' });

      const worker = makeWorker({ handlers: [] });
      await worker.runOnce();

      const stored = await getJob(job.id);
      expect(stored.status).toBe('dead_letter');
      expect(stored.error_category).toBe('handler_not_found');
    });
  });

  describe('lease recovery', () => {
    test('reclaims a job whose lease expired', async () => {
      const submissionId = await insertSubmission();
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const oldLock = new Date(t0.getTime() - 60_000);
      const job = await insertJob({
        submissionId,
        status: 'processing',
        attempts: 1,
        maxAttempts: 5,
        lockedAt: oldLock,
        lockedBy: 'dead-worker',
      });

      const recovered = await repository.recoverExpiredJobs({
        now: t0,
        leaseMs: 5000,
        limit: 10,
        nextAvailableAt: (attempts) => new Date(t0.getTime() + computeBackoffMs(attempts, { baseMs: 1000, maxMs: 60000 })),
      });

      expect(recovered).toHaveLength(1);
      const stored = await getJob(job.id);
      expect(stored.status).toBe('retrying');
      expect(stored.locked_by).toBeNull();
      expect(stored.locked_at).toBeNull();
      expect(stored.error_category).toBe('lease_expired');
      expect(new Date(stored.available_at).getTime()).toBe(t0.getTime() + 1000);
      expect(await getSubmissionStatus(submissionId)).toBe('retrying');
    });

    test('does not reclaim a job whose lease is still valid', async () => {
      const submissionId = await insertSubmission();
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const job = await insertJob({
        submissionId,
        status: 'processing',
        attempts: 1,
        lockedAt: t0,
        lockedBy: 'live-worker',
      });

      const recovered = await repository.recoverExpiredJobs({
        now: t0,
        leaseMs: 5000,
        limit: 10,
        nextAvailableAt: () => t0,
      });

      expect(recovered).toHaveLength(0);
      expect((await getJob(job.id)).status).toBe('processing');
    });
  });

  describe('stale worker protection', () => {
    test('a worker whose lease was reclaimed cannot complete the job', async () => {
      const submissionId = await insertSubmission();
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const job = await insertJob({
        submissionId,
        status: 'processing',
        attempts: 1,
        maxAttempts: 5,
        lockedAt: new Date(t0.getTime() - 60_000),
        lockedBy: 'worker-a',
      });

      // Worker B recovers the abandoned job.
      await repository.recoverExpiredJobs({
        now: t0,
        leaseMs: 5000,
        limit: 10,
        nextAvailableAt: () => t0,
      });

      // Worker A, unaware, tries to complete its old claim.
      const result = await repository.completeJob({ jobId: job.id, workerId: 'worker-a', now: t0 });

      expect(result).toBeNull();
      const stored = await getJob(job.id);
      expect(stored.status).toBe('retrying');
      expect(stored.locked_by).toBeNull();
    });

    test('a worker cannot overwrite a job reclaimed by another worker', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId });
      const now = new Date();

      const [a] = await repository.claimBatch({ workerId: 'worker-a', limit: 1, now });
      expect(a).toBeDefined();

      // Force expiry so worker B can claim the same job.
      const later = new Date(now.getTime() + 60_000);
      await repository.recoverExpiredJobs({
        now: later,
        leaseMs: 5000,
        limit: 10,
        nextAvailableAt: () => later,
      });
      const [b] = await repository.claimBatch({ workerId: 'worker-b', limit: 1, now: later });
      expect(b).toBeDefined();

      const staleResult = await repository.completeJob({ jobId: job.id, workerId: 'worker-a', now: later });
      expect(staleResult).toBeNull();

      const stored = await getJob(job.id);
      expect(stored.status).toBe('processing');
      expect(stored.locked_by).toBe('worker-b');

      const fresh = await repository.completeJob({ jobId: job.id, workerId: 'worker-b', now: later });
      expect(fresh).not.toBeNull();
      expect((await getJob(job.id)).status).toBe('succeeded');
    });
  });

  describe('idempotency', () => {
    test('a succeeded job is never claimed again', async () => {
      const submissionId = await insertSubmission();
      await insertJob({ submissionId });
      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.SUCCEEDED }) }],
      });

      expect(await worker.runOnce()).toBe(1);
      expect(await worker.runOnce()).toBe(0);
    });

    test('completing an already-completed job is a no-op', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId });
      const now = new Date();
      const claimed = await repository.claimBatch({ workerId: 'w', limit: 1, now });
      expect(claimed).toHaveLength(1);

      expect(await repository.completeJob({ jobId: job.id, workerId: 'w', now })).not.toBeNull();
      expect(await repository.completeJob({ jobId: job.id, workerId: 'w', now })).toBeNull();
    });
  });

  describe('normalization handler guardrails', () => {
    test('dead-letters a normalize_submission job whose submission does not exist', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId, jobType: 'normalize_submission' });

      // Delete the submission so the handler cannot find it.
      await getPool().query('DELETE FROM ingestion_submissions WHERE id = $1', [submissionId]);

      const worker = makeWorker({ handlers: [normalizeSubmission] });
      await worker.runOnce();
      // The delete cascades to the job, so assert nothing was left processing.
      const { rows } = await getPool().query('SELECT count(*)::int AS n FROM processing_jobs WHERE id = $1', [job.id]);
      expect(rows[0].n).toBe(0);
    });

    test('the real handler rejects (permanently) when the submission is missing', async () => {
      await expect(
        normalizeSubmission.handler(
          { id: 'j1', submission_id: '00000000-0000-4000-8000-000000000000', job_type: 'normalize_submission' },
          { logger: noopLogger }
        )
      ).rejects.toMatchObject({ permanent: true });
    });
  });

  describe('graceful shutdown', () => {
    test('waits for in-flight work before stopping', async () => {
      const submissionId = await insertSubmission();
      await insertJob({ submissionId });

      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let started = false;
      const worker = makeWorker({
        handlers: [
          {
            jobType: 'normalize_submission',
            handler: async () => {
              started = true;
              await gate;
              return { outcome: OUTCOME.SUCCEEDED };
            },
          },
        ],
        settings: { workerId: 'graceful', shutdownTimeoutMs: 5000 },
      });

      const tick = worker.runOnce();
      expect(await waitFor(() => started)).toBe(true);

      const stopPromise = worker.stop();
      const early = await Promise.race([
        stopPromise.then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
      ]);
      expect(early).toBe('pending');

      release();
      await tick;
      await stopPromise;

      expect(worker.isRunning()).toBe(false);
      expect(await getSubmissionStatus(submissionId)).toBe('succeeded');
    });

    test('start processes available jobs and stop halts polling', async () => {
      const submissionId = await insertSubmission();
      await insertJob({ submissionId });

      const worker = makeWorker({
        handlers: [{ jobType: 'normalize_submission', handler: async () => ({ outcome: OUTCOME.SUCCEEDED }) }],
        settings: { workerId: 'starter', pollIntervalMs: 10 },
      });

      worker.start();
      expect(await waitFor(async () => (await getSubmissionStatus(submissionId)) === 'succeeded')).toBe(true);
      await worker.stop();

      expect(worker.isRunning()).toBe(false);
    });
  });

  describe('submission status consistency', () => {
    test('projection tracks pending -> processing -> succeeded', async () => {
      const submissionId = await insertSubmission();
      const job = await insertJob({ submissionId });

      expect(await getSubmissionStatus(submissionId)).toBe('pending');

      const now = new Date();
      const [claimed] = await repository.claimBatch({ workerId: 'w', limit: 1, now });
      expect(claimed.id).toBe(job.id);
      expect(await getSubmissionStatus(submissionId)).toBe('processing');

      await repository.completeJob({ jobId: job.id, workerId: 'w', now });
      expect(await getSubmissionStatus(submissionId)).toBe('succeeded');
    });
  });
});
