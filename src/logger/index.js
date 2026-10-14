'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * pino-pretty is a dev-only dependency. It launches a worker thread, so it is
 * enabled only outside tests and only when the transport is actually installed
 * (production images install runtime dependencies only).
 */
function buildTransport() {
  if (!config.log.pretty || config.env === 'test') return undefined;
  try {
    require.resolve('pino-pretty');
  } catch (err) {
    return undefined;
  }
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      singleLine: false,
    },
  };
}

const logger = pino({
  name: config.serviceName,
  level: config.log.level,
  base: { service: config.serviceName, env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'password',
      'secret',
      'apiKey',
      'api_key',
      'token',
    ],
    remove: true,
  },
  transport: buildTransport(),
});

module.exports = logger;
