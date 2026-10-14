'use strict';

// These tests require a real PostgreSQL instance. They are skipped unless
// TEST_DATABASE_URL is explicitly provided, so the default `npm test` run
// never claims database verification it did not perform.

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

maybe('GET /ready against PostgreSQL', () => {
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const { closePool } = require('../../src/db/pool');

  afterAll(async () => {
    await closePool();
  });

  test('returns 200 and reports the database as available', async () => {
    const res = await request(createApp()).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.checks.database).toBe('ok');
    expect(res.body.requestId).toBeDefined();
  });
});
