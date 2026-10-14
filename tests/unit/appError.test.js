'use strict';

const AppError = require('../../src/errors/AppError');
const { ErrorCategory } = require('../../src/errors/AppError');

describe('AppError', () => {
  test('defaults to a non-exposed internal error', () => {
    const err = new AppError('boom');

    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.category).toBe(ErrorCategory.INTERNAL);
    expect(err.expose).toBe(false);
    expect(err.isOperational).toBe(true);
  });

  test('4xx errors expose their message by default', () => {
    const err = AppError.validation('bad input', [{ path: 'name', message: 'required' }]);

    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.category).toBe(ErrorCategory.VALIDATION);
    expect(err.expose).toBe(true);
    expect(err.details).toEqual([{ path: 'name', message: 'required' }]);
  });

  test('factory helpers set the expected status and category', () => {
    expect(AppError.notFound('nope').statusCode).toBe(404);
    expect(AppError.unauthorized().statusCode).toBe(401);
    expect(AppError.forbidden().statusCode).toBe(403);
    expect(AppError.conflict('dup').statusCode).toBe(409);
    expect(AppError.database().statusCode).toBe(500);
    expect(AppError.database().category).toBe(ErrorCategory.DATABASE);
    expect(AppError.database().expose).toBe(false);
    expect(AppError.processing('failed').category).toBe(ErrorCategory.PROCESSING);
  });

  test('preserves an underlying cause', () => {
    const cause = new Error('root cause');
    const err = AppError.internal('wrapped', cause);

    expect(err.cause).toBe(cause);
    expect(err.expose).toBe(false);
  });
});
