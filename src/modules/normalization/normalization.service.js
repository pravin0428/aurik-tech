'use strict';

const { withTransaction } = require('../../db/tx');
const { getAdapter } = require('./adapters');
const { permanentError, OUTCOME } = require('../processing/outcome');
const referenceRepo = require('../reference/reference.repository');
const normRepo = require('./normalization.repository');

/**
 * Normalize one accepted submission end-to-end.
 *
 * Flow: select the vendor adapter (by the VALIDATED vendor), load reference
 * data, run the adapter, then persist inside ONE transaction — accepted records
 * become canonical events, every rejected/warned record is written to the
 * failure ledger, and the derived machine state for every affected machine is
 * recomputed.
 *
 * Returns a per-run summary. Unrecoverable submission-level problems throw a
 * permanent error (dead-letter); DB/infra errors bubble up and are retried by
 * the queue.
 */

function extractPayload(rawPayload) {
  if (rawPayload && typeof rawPayload === 'object' && rawPayload.payload !== undefined) {
    return rawPayload.payload;
  }
  return rawPayload;
}

async function normalizeSubmission({ submission, now, staleWindowMs, logger }) {
  const adapter = getAdapter(submission.vendor);
  if (!adapter) {
    throw permanentError(`No adapter registered for vendor "${submission.vendor}"`, {
      category: 'unsupported_vendor',
    });
  }

  const payload = extractPayload(submission.raw_payload);
  const context = await referenceRepo.loadContext();

  const result = adapter.normalize(payload, context);
  if (result.batchError) {
    throw permanentError(result.batchError, { category: 'invalid_batch' });
  }

  const summary = await withTransaction(async (client) => {
    const affected = new Map();
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let warnings = 0;
    let submissionHasErrors = false;

    for (const item of result.items) {
      const index = item.recordIndex;

      if (item.record) {
        const insertedId = await normRepo.insertEvent(client, item.record, submission.id, index);
        if (insertedId) {
          accepted += 1;
          affected.set(item.record.machine_id, {
            machine_id: item.record.machine_id,
            plant_id: item.record.plant_id,
            line_id: item.record.line_id,
          });
        } else {
          duplicates += 1;
        }
        for (const issue of item.issues.warnings) {
          warnings += 1;
          await normRepo.insertFailure(
            client,
            submission.id,
            result.vendor,
            index,
            item.vendorEventId,
            item.raw,
            issue
          );
        }
      } else {
        rejected += 1;
        submissionHasErrors = true;
        if (item.machineId && context.machines.has(item.machineId)) {
          const machine = context.machines.get(item.machineId);
          affected.set(item.machineId, {
            machine_id: machine.machine_id,
            plant_id: machine.plant_id,
            line_id: machine.line_id,
          });
        }
        for (const issue of item.issues.issues) {
          await normRepo.insertFailure(
            client,
            submission.id,
            result.vendor,
            index,
            item.vendorEventId,
            item.raw,
            issue
          );
        }
      }
    }

    const processingStatus = submissionHasErrors ? 'partially_processed' : 'processed';
    for (const machine of affected.values()) {
      await normRepo.recomputeMachineState(client, machine, {
        now,
        staleWindowMs,
        processingStatus,
      });
    }

    return {
      accepted,
      duplicates,
      rejected,
      warnings,
      records: result.items.length,
      machinesAffected: affected.size,
      partiallyProcessed: submissionHasErrors,
    };
  });

  if (logger) {
    logger.info(
      { submissionId: submission.id, vendor: submission.vendor, ...summary },
      'Submission normalized'
    );
  }

  return { outcome: OUTCOME.SUCCEEDED, summary };
}

module.exports = { normalizeSubmission, extractPayload };
