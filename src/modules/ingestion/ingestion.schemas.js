'use strict';

const { z } = require('zod');

/**
 * PROVISIONAL generic ingestion contract.
 *
 * The assessment vendor samples are unavailable, so this envelope is
 * deliberately vendor-neutral. It only carries what ingestion plumbing
 * requires: a stable submission id, optional free-form source metadata, and an
 * opaque `payload`. Vendor-specific adapters (Phase 5) map real payloads into
 * the canonical model; they do NOT rely on this envelope.
 */

// Vendor slug from the URL path: short, lowercase-ish, URL-safe.
const vendorParamSchema = z
  .string()
  .min(1, 'vendor is required')
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'vendor must be a simple identifier');

// Caller-supplied idempotency token (also used as `submissionId`).
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'idempotency key contains unsupported characters');

const ingestionEnvelopeSchema = z
  .object({
    // Optional alternative to the Idempotency-Key header.
    submissionId: idempotencyKeySchema.optional(),
    // Free-form vendor/source metadata. Never interpreted by the ingestion layer.
    source: z.record(z.unknown()).optional(),
    // Opaque vendor data: any JSON object or array. Preserved verbatim.
    payload: z.union([z.record(z.any()), z.array(z.any())]),
  })
  .strict();

const submissionIdParamSchema = z.string().uuid('submissionId must be a UUID');

module.exports = {
  vendorParamSchema,
  idempotencyKeySchema,
  ingestionEnvelopeSchema,
  submissionIdParamSchema,
};
