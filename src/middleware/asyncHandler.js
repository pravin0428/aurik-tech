'use strict';

/**
 * Wrap an async route handler so rejections reach the central error handler.
 * Express 4 does not forward rejected promises automatically.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
