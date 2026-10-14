'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('GET /health', () => {
  test('returns 200 with the documented payload shape', async () => {
    const res = await request(createApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ok',
      service: 'aurik-tech',
    });
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(typeof res.body.data.timestamp).toBe('string');
  });

  test('echoes a generated request id in the body and header', async () => {
    const res = await request(createApp()).get('/health');

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  test('honours an inbound x-request-id', async () => {
    const res = await request(createApp())
      .get('/health')
      .set('x-request-id', 'correlation-123');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('correlation-123');
    expect(res.body.requestId).toBe('correlation-123');
  });
});
