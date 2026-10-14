'use strict';

const AppError = require('./AppError');

/**
 * Catch-all for unmatched routes. Delegates to the central error handler so
 * 404s share the same response envelope as every other error.
 */
function notFoundHandler(req, res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

module.exports = notFoundHandler;
