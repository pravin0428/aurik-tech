'use strict';

const { ZodError } = require('zod');
const AppError = require('./AppError');
const { ErrorCategory } = require('./AppError');
const logger = require('../logger');

/**
 * Duck-type a node-postgres error: SQLSTATE is a 5-character code and pg always
 * attaches a `severity`. Our own AppError also has a `code` but never a
 * `severity`, so the two cannot be confused.
 */
function isDatabaseError(err) {
  return Boolean(
    err &&
      typeof err.code === 'string' &&
      err.code.length === 5 &&
      typeof err.severity === 'string'
  );
}

/**
 * Convert any thrown value into an AppError with a safe, consistent shape.
 * Recognises Zod validation errors and body-parser failures in addition to
 * our own AppError instances.
 */
function normalizeError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError('Request validation failed', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      category: ErrorCategory.VALIDATION,
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (err && err.type === 'entity.parse.failed') {
    return new AppError('Malformed JSON body', {
      statusCode: 400,
      code: 'MALFORMED_JSON',
      category: ErrorCategory.VALIDATION,
    });
  }

  if (err && err.type === 'entity.too.large') {
    return new AppError('Request body too large', {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      category: ErrorCategory.VALIDATION,
    });
  }

  if (isDatabaseError(err)) {
    return new AppError('Database error', {
      statusCode: 500,
      code: 'DATABASE_ERROR',
      category: ErrorCategory.DATABASE,
      cause: err,
      expose: false,
    });
  }

  // Anything unrecognised is treated as an unexpected internal failure. The
  // original error is preserved as a cause for server-side logs only.
  return new AppError('Internal server error', {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    category: ErrorCategory.INTERNAL,
    cause: err,
    expose: false,
  });
}

/**
 * Centralised Express error handler. Always responds with a stable envelope:
 *   { error: { code, message, category, details? }, requestId }
 * Never leaks stack traces or secrets to clients.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const appError = normalizeError(err);
  const log = req.log || logger;
  const logPayload = {
    err: appError.cause || err,
    code: appError.code,
    category: appError.category,
    statusCode: appError.statusCode,
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
  };

  if (appError.statusCode >= 500) {
    log.error(logPayload, 'Request failed');
  } else {
    log.warn(logPayload, 'Request rejected');
  }

  if (res.headersSent) {
    return next(err);
  }

  const body = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : 'Internal server error',
      category: appError.category,
      ...(appError.details ? { details: appError.details } : {}),
    },
    requestId: req.id,
  };

  return res.status(appError.statusCode).json(body);
}

module.exports = errorHandler;
module.exports.normalizeError = normalizeError;
module.exports.isDatabaseError = isDatabaseError;
