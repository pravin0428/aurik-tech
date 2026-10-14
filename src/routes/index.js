'use strict';

const express = require('express');
const healthRoutes = require('./health.routes');
const ingestionRoutes = require('../modules/ingestion/ingestion.routes');
const operationsRoutes = require('../modules/operations/operations.routes');

const router = express.Router();

// Infrastructure routes (Phase 2).
router.use('/', healthRoutes);

// Generic ingestion (Phase 3).
router.use('/api/v1', ingestionRoutes);

// Operational attention view (Phase 5): machine status + plant/line summaries.
router.use('/api/v1', operationsRoutes);

module.exports = router;
