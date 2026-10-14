'use strict';

const express = require('express');
const config = require('../config');
const { checkConnectivity } = require('../db/pool');

const router = express.Router();
const startedAt = Date.now();

/**
 * Liveness probe: the process is up and serving. Intentionally does not touch
 * the database so it stays cheap and cannot flap on a transient DB blip.
 */
router.get('/health', (req, res) => {
  res.json({
    data: {
      status: 'ok',
      service: config.serviceName,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    },
    requestId: req.id,
  });
});

/**
 * Readiness probe: reports whether the service can do useful work, which for
 * this service means the database is reachable. Returns 503 when it is not.
 */
router.get('/ready', async (req, res) => {
  try {
    await checkConnectivity();
    res.json({
      data: {
        status: 'ready',
        checks: { database: 'ok' },
      },
      requestId: req.id,
    });
  } catch (err) {
    if (req.log) req.log.warn({ err }, 'Readiness check failed: database unavailable');
    res.status(503).json({
      data: {
        status: 'not_ready',
        checks: { database: 'unavailable' },
      },
      requestId: req.id,
    });
  }
});

module.exports = router;
