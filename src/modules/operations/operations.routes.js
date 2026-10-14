'use strict';

const express = require('express');
const asyncHandler = require('../../middleware/asyncHandler');
const {
  machineIdParamSchema,
  plantIdParamSchema,
  lineIdParamSchema,
} = require('./operations.schemas');
const operationsService = require('./operations.service');

const router = express.Router();

/**
 * GET /api/v1/machines/:machineId/status
 * Latest derived operational status and attention context for one machine.
 */
router.get(
  '/machines/:machineId/status',
  asyncHandler(async (req, res) => {
    const machineId = machineIdParamSchema.parse(req.params.machineId);
    const view = await operationsService.getMachineStatus(machineId);
    res.json({ data: view, requestId: req.id });
  })
);

/**
 * GET /api/v1/plants/:plantId/summary
 * Plant-level roll-up: status counts, critical machines, and per-line attention.
 */
router.get(
  '/plants/:plantId/summary',
  asyncHandler(async (req, res) => {
    const plantId = plantIdParamSchema.parse(req.params.plantId);
    const summary = await operationsService.getPlantSummary(plantId);
    res.json({ data: summary, requestId: req.id });
  })
);

/**
 * GET /api/v1/lines/:lineId/summary
 * Line-level roll-up.
 */
router.get(
  '/lines/:lineId/summary',
  asyncHandler(async (req, res) => {
    const lineId = lineIdParamSchema.parse(req.params.lineId);
    const summary = await operationsService.getLineSummary(lineId);
    res.json({ data: summary, requestId: req.id });
  })
);

module.exports = router;
