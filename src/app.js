'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./logger');
const requestId = require('./middleware/requestId');
const routes = require('./routes');
const notFoundHandler = require('./errors/notFoundHandler');
const errorHandler = require('./errors/errorHandler');

/**
 * Build the Express application. Kept separate from server.js so tests can
 * exercise the app with Supertest without binding a port.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: {
        // Probes are high-volume and low-signal; skip them.
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
      // Access logs stay at info; the central error handler owns warn/error
      // logging so failures are not double-reported.
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        return 'info';
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  // Body parsing with an explicit size limit. Malformed and oversized bodies
  // are surfaced through the central error handler.
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.http.bodyLimit }));

  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
