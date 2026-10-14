'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('unknown routes', () => {
  test('return a consistent 404 error envelope', async () => {
    const res = await request(createApp()).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      category: 'not_found',
    });
    expect(res.body.error.message).toContain('/does-not-exist');
    expect(res.body.requestId).toBeDefined();
  });
});
