'use strict';

// Simulate the database being unavailable so readiness must report failure
// without requiring a real PostgreSQL instance.
jest.mock('../../src/db/pool', () => ({
  getPool: jest.fn(),
  query: jest.fn(),
  closePool: jest.fn(),
  checkConnectivity: jest.fn().mockRejectedValue(new Error('database unreachable')),
}));

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('GET /ready when the database is unavailable', () => {
  test('returns 503 with a not_ready payload', async () => {
    const res = await request(createApp()).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe('not_ready');
    expect(res.body.data.checks.database).toBe('unavailable');
    expect(res.body.requestId).toBeDefined();
  });
});
