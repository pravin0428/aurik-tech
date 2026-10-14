'use strict';

/**
 * Error categories let logs and metrics distinguish the origin of a failure
 * (client validation vs. database vs. background processing vs. unknown).
 */
const ErrorCategory = Object.freeze({
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  DATABASE: 'database',
  PROCESSING: 'processing',
  INTERNAL: 'internal',
});

/**
 * Operational error carrying an HTTP status, a stable machine-readable code,
 * a category, and an explicit decision about whether the message is safe to
 * expose to clients.
 */
class AppError extends Error {
  constructor(message, options = {}) {
    super(message);

    const {
      statusCode = 500,
      code = 'INTERNAL_ERROR',
      category = ErrorCategory.INTERNAL,
      details,
      cause,
      expose,
    } = options;

    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.category = category;
    this.details = details;
    this.isOperational = true;
    // Client-facing message is only shown for 4xx unless explicitly overridden.
    this.expose = expose !== undefined ? expose : statusCode < 500;

    if (cause !== undefined) this.cause = cause;

    Error.captureStackTrace(this, AppError);
  }

  static badRequest(message, details) {
    return new AppError(message, {
      statusCode: 400,
      code: 'BAD_REQUEST',
      category: ErrorCategory.VALIDATION,
      details,
    });
  }

  static validation(message, details) {
    return new AppError(message, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      category: ErrorCategory.VALIDATION,
      details,
    });
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(message, {
      statusCode: 401,
      code: 'UNAUTHORIZED',
      category: ErrorCategory.AUTHENTICATION,
    });
  }

  static forbidden(message = 'Insufficient permissions') {
    return new AppError(message, {
      statusCode: 403,
      code: 'FORBIDDEN',
      category: ErrorCategory.AUTHORIZATION,
    });
  }

  static notFound(message = 'Resource not found', details) {
    return new AppError(message, {
      statusCode: 404,
      code: 'NOT_FOUND',
      category: ErrorCategory.NOT_FOUND,
      details,
    });
  }

  static conflict(message, details) {
    return new AppError(message, {
      statusCode: 409,
      code: 'CONFLICT',
      category: ErrorCategory.CONFLICT,
      details,
    });
  }

  static database(message = 'Database error', options = {}) {
    return new AppError(message, {
      statusCode: 500,
      code: options.code || 'DATABASE_ERROR',
      category: ErrorCategory.DATABASE,
      details: options.details,
      cause: options.cause,
      expose: false,
    });
  }

  static processing(message, options = {}) {
    return new AppError(message, {
      statusCode: 500,
      code: options.code || 'PROCESSING_ERROR',
      category: ErrorCategory.PROCESSING,
      details: options.details,
      cause: options.cause,
      expose: false,
    });
  }

  static internal(message = 'Internal server error', cause) {
    return new AppError(message, {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      category: ErrorCategory.INTERNAL,
      cause,
      expose: false,
    });
  }
}

module.exports = AppError;
module.exports.ErrorCategory = ErrorCategory;
