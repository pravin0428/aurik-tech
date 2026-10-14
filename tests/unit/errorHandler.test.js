'use strict';

const { ZodError } = require('zod');
const errorHandler = require('../../src/errors/errorHandler');
const { normalizeError } = require('../../src/errors/errorHandler');
const AppError = require('../../src/errors/AppError');

function mockReq() {
  return {
    id: 'req-test-1',
    method: 'GET',
    originalUrl: '/demo',
    headers: {},
    log: { warn() {}, error() {}, info() {} },
  };
}

function mockRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('errorHandler', () => {
  test('serializes an operational 4xx error and includes requestId', () => {
    const res = mockRes();
    errorHandler(AppError.validation('bad input'), mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        category: 'validation',
      },
      requestId: 'req-test-1',
    });
  });

  test('hides the message of unexpected internal errors but keeps a safe code', () => {
    const res = mockRes();
    const secret = new Error('connection string postgres://user:pass@host leaked');
    errorHandler(secret, mockReq(), res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
    expect(res.body.error.category).toBe('internal');
  });

  test('maps malformed JSON body-parser errors to a controlled 400', () => {
    const res = mockRes();
    const parseError = Object.assign(new Error('bad json'), { type: 'entity.parse.failed' });
    errorHandler(parseError, mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  test('maps Zod errors to a structured 400 with details', () => {
    const res = mockRes();
    let zodErr;
    try {
      const { z } = require('zod');
      z.object({ name: z.string() }).parse({ name: 123 });
    } catch (err) {
      zodErr = err;
    }
    expect(zodErr).toBeInstanceOf(ZodError);

    errorHandler(zodErr, mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  test('delegates to next when headers were already sent', () => {
    const res = mockRes();
    res.headersSent = true;
    let delegated = false;
    errorHandler(new Error('late failure'), mockReq(), res, () => {
      delegated = true;
    });

    expect(delegated).toBe(true);
    expect(res.body).toBeUndefined();
  });
});

describe('normalizeError', () => {
  test('passes AppError instances through unchanged', () => {
    const original = AppError.notFound('missing');
    expect(normalizeError(original)).toBe(original);
  });
});
