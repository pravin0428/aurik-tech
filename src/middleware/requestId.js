'use strict';

const { randomUUID } = require('crypto');

const MAX_ID_LENGTH = 200;

/**
 * Assign a correlation id to every request. Reuses a caller-supplied
 * `x-request-id` when it looks sane, otherwise generates one. The id is echoed
 * back on the response and attached to `req.id` for logging.
 */
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const candidate = typeof incoming === 'string' ? incoming.trim() : '';

  req.id =
    candidate.length > 0 && candidate.length <= MAX_ID_LENGTH
      ? candidate
      : randomUUID();

  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = requestId;
