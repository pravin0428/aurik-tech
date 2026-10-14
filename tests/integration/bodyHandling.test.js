'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('request body handling', () => {
  test('malformed JSON returns a controlled 400', async () => {
    const res = await request(createApp())
      .post('/does-not-exist')
      .set('content-type', 'application/json')
      .send('{"broken": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
    expect(res.body.requestId).toBeDefined();
  });

  test('oversized JSON body returns 413', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(50 * 1024) });

    const res = await request(createApp())
      .post('/does-not-exist')
      .set('content-type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
