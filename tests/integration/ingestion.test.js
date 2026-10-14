'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { getPool, closePool } = require('../../src/db/pool');
const repo = require('../../src/modules/ingestion/ingestion.repository');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

const ACME_KEY = 'test-key-acme';

maybe('ingestion API', () => {
  const app = createApp();

  const url = (vendor) => `/api/v1/ingestion/${vendor}/submissions`;

  beforeAll(async () => {
    // Fail loudly if the schema is missing rather than silently passing.
    await getPool().query('SELECT 1 FROM ingestion_submissions LIMIT 1');
  });

  beforeEach(async () => {
    await getPool().query(
      'TRUNCATE processing_jobs, ingestion_submissions RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('authentication', () => {
    test('rejects a request without a key', async () => {
      const res = await request(app)
        .post(url('acme'))
        .send({ payload: { a: 1 } });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('rejects a request with the wrong key', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', 'not-the-key')
        .send({ payload: { a: 1 } });

      expect(res.status).toBe(401);
    });

    test('accepts a request with the correct key', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'auth-ok-1')
        .send({ payload: { a: 1 } });

      expect(res.status).toBe(201);
    });
  });

  describe('acceptance', () => {
    test('accepts a new submission and creates exactly one job', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'sub-new-1')
        .send({ payload: { temperature: 20 } });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        vendor: 'acme',
        status: 'accepted',
        processingStatus: 'pending',
        idempotentReplay: false,
      });
      expect(res.body.data.submissionId).toBeDefined();
      expect(res.body.requestId).toBeDefined();

      expect(await repo.countSubmissions()).toBe(1);
      expect(await repo.countJobs()).toBe(1);
    });

    test('accepts an idempotency key supplied in the body', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .send({ submissionId: 'body-key-1', payload: { a: 1 } });

      expect(res.status).toBe(201);
      expect(await repo.countSubmissions()).toBe(1);
    });

    test('returns 400 when no idempotency key is supplied', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .send({ payload: { a: 1 } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('idempotency', () => {
    test('a replay of an identical payload returns 200 and creates no new rows', async () => {
      const body = { payload: { temperature: 20, machineId: 'm1' } };

      const first = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'replay-1')
        .send(body);

      const second = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'replay-1')
        // Same payload with keys in a different order must be treated as equal.
        .send({ payload: { machineId: 'm1', temperature: 20 } });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data.idempotentReplay).toBe(true);
      expect(second.body.data.submissionId).toBe(first.body.data.submissionId);

      expect(await repo.countSubmissions()).toBe(1);
      expect(await repo.countJobs()).toBe(1);
    });

    test('reusing a key with a different payload returns 409 and writes nothing', async () => {
      await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'reuse-1')
        .send({ payload: { a: 1 } });

      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'reuse-1')
        .send({ payload: { a: 2 } });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      expect(await repo.countSubmissions()).toBe(1);
      expect(await repo.countJobs()).toBe(1);
    });

    test('the same key on different vendors is independent', async () => {
      await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'shared-key')
        .send({ payload: { a: 1 } });

      const res = await request(app)
        .post(url('globex'))
        .set('x-api-key', 'test-key-globex')
        .set('Idempotency-Key', 'shared-key')
        .send({ payload: { a: 1 } });

      expect(res.status).toBe(201);
      expect(await repo.countSubmissions()).toBe(2);
    });
  });

  describe('validation', () => {
    test('rejects a body without a payload', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'v-1')
        .send({ source: { system: 'scada' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('rejects an unknown top-level key', async () => {
      const res = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'v-2')
        .send({ payload: { a: 1 }, unexpected: true });

      expect(res.status).toBe(400);
    });

    test('rejects a malformed vendor slug (auth runs before validation)', async () => {
      const res = await request(app)
        .post(url('bad vendor'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'v-3')
        .send({ payload: { a: 1 } });

      // Authentication is vendor-scoped, so an unconfigured/malformed vendor is
      // indistinguishable from a wrong key: 401, not 400.
      expect(res.status).toBe(401);
    });
  });

  describe('status', () => {
    test('returns the submission and its jobs', async () => {
      const created = await request(app)
        .post(url('acme'))
        .set('x-api-key', ACME_KEY)
        .set('Idempotency-Key', 'status-1')
        .send({ payload: { a: 1 } });

      const res = await request(app).get(
        `/api/v1/ingestion/submissions/${created.body.data.submissionId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.submissionId).toBe(created.body.data.submissionId);
      expect(res.body.data.jobs).toHaveLength(1);
      expect(res.body.data.jobs[0]).toMatchObject({
        type: 'normalize_submission',
        status: 'pending',
        attempts: 0,
      });
    });

    test('returns 404 for an unknown submission', async () => {
      const res = await request(app).get(
        '/api/v1/ingestion/submissions/11111111-1111-4111-8111-111111111111'
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('returns 400 for a malformed submission id', async () => {
      const res = await request(app).get(
        '/api/v1/ingestion/submissions/not-a-uuid'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
