'use strict';

/**
 * Handler outcome contract.
 *
 * A job handler MUST return one of these outcomes (or throw). Returning an
 * outcome makes the queue's decision explicit and keeps retry classification
 * out of the queue mechanics.
 *
 *   succeeded -> terminal success
 *   retry     -> transient failure; retry with backoff until max_attempts
 *   permanent -> terminal failure; dead-letter immediately
 *   blocked   -> domain processing cannot proceed (e.g. not implemented);
 *                observable, never reported as success or failure
 */
const OUTCOME = Object.freeze({
  SUCCEEDED: 'succeeded',
  RETRY: 'retry',
  PERMANENT: 'permanent',
  BLOCKED: 'blocked',
});

const OUTCOME_VALUES = new Set(Object.values(OUTCOME));

/**
 * Error type a handler can throw to force an immediate terminal failure even if
 * the retry budget is not exhausted (e.g. malformed payload, unknown unit).
 */
class PermanentJobError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PermanentJobError';
    this.permanent = true;
    this.category = options.category || 'permanent';
    this.cause = options.cause;
  }
}

function permanentError(message, options) {
  return new PermanentJobError(message, options);
}

/**
 * Classify a thrown value into a retry or permanent outcome.
 *
 * Default is RETRY: an unexpected exception is assumed transient and will be
 * retried up to max_attempts, at which point it dead-letters. Permanent is
 * reserved for explicit signals so a transient bug is not silently discarded.
 */
function classifyThrown(err) {
  if (err && err.permanent === true) {
    return { outcome: OUTCOME.PERMANENT, error: err, category: err.category || 'permanent' };
  }
  // Reuse the existing error taxonomy: validation/not_found are never retryable.
  if (err && (err.category === 'validation' || err.category === 'not_found')) {
    return { outcome: OUTCOME.PERMANENT, error: err, category: err.category };
  }
  return { outcome: OUTCOME.RETRY, error: err, category: 'transient' };
}

/**
 * Validate a handler's returned value. A malformed return is treated as a
 * permanent contract violation: retrying it can never succeed and could loop
 * forever, so it dead-letters deterministically.
 */
function normalizeHandlerResult(result) {
  if (result && typeof result === 'object' && OUTCOME_VALUES.has(result.outcome)) {
    if (result.outcome === OUTCOME.BLOCKED && typeof result.reason !== 'string') {
      return {
        outcome: OUTCOME.PERMANENT,
        error: new Error('Handler returned "blocked" without a reason string'),
        category: 'handler_contract',
      };
    }
    return result;
  }
  return {
    outcome: OUTCOME.PERMANENT,
    error: new Error('Handler returned an invalid outcome'),
    category: 'handler_contract',
  };
}

/**
 * Produce a short, safe, storable error message. Never includes stack traces,
 * raw payloads, or secrets; only the message is kept, length-capped.
 */
function sanitizeErrorMessage(err) {
  let message;
  if (err === null || err === undefined) {
    message = 'Unknown error';
  } else if (typeof err === 'string') {
    message = err;
  } else {
    message = err.message || String(err);
  }
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

module.exports = {
  OUTCOME,
  PermanentJobError,
  permanentError,
  classifyThrown,
  normalizeHandlerResult,
  sanitizeErrorMessage,
};
