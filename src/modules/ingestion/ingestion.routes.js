'use strict';

const express = require('express');
const asyncHandler = require('../../middleware/asyncHandler');
const vendorAuth = require('../../middleware/vendorAuth');
const {
  vendorParamSchema,
  ingestionEnvelopeSchema,
  submissionIdParamSchema,
} = require('./ingestion.schemas');
const { resolveIdempotencyKey } = require('./idempotency');
const ingestionService = require('./ingestion.service');

const router = express.Router();

/**
 * POST /api/v1/ingestion/:vendor/submissions
 * Accept a provisional generic submission. 201 for a new submission,
 * 200 for an idempotent replay of an identical payload.
 */
router.post(
  '/ingestion/:vendor/submissions',
  vendorAuth,
  asyncHandler(async (req, res) => {
    const vendor = vendorParamSchema.parse(req.params.vendor);
    const envelope = ingestionEnvelopeSchema.parse(req.body ?? {});
    const { key, source } = resolveIdempotencyKey(req, envelope);

    const submission = await ingestionService.acceptSubmission({
      vendor,
      idempotencyKey: key,
      idempotencySource: source,
      envelope,
      requestId: req.id,
    });

    res.status(submission.idempotentReplay ? 200 : 201).json({
      data: submission,
      requestId: req.id,
    });
  })
);

/**
 * GET /api/v1/ingestion/submissions/:submissionId
 * Ingestion + processing status. Intentionally unauthenticated in Phase 3
 * (returns metadata only, never payload contents) — see README limitations.
 */
router.get(
  '/ingestion/submissions/:submissionId',
  asyncHandler(async (req, res) => {
    const submissionId = submissionIdParamSchema.parse(req.params.submissionId);
    const status = await ingestionService.getSubmissionStatus(submissionId);

    res.json({ data: status, requestId: req.id });
  })
);

module.exports = router;
