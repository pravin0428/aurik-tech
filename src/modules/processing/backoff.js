'use strict';

/**
 * Exponential backoff, isolated as a pure function so retry timing is fully
 * deterministic in tests (no clock or database involved).
 *
 * `attempt` is the number of attempts already made (1 == first attempt just
 * failed). Delay after the Nth failed attempt is `base * 2^(N-1)`, capped at
 * `maxMs`:
 *
 *   attempt 1 -> base
 *   attempt 2 -> 2 * base
 *   attempt 3 -> 4 * base
 *   ...
 *
 * Invalid or missing attempts are treated as the first attempt so a bad value
 * can never produce a negative or NaN delay.
 */
function computeBackoffMs(attempt, { baseMs, maxMs }) {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const raw = baseMs * Math.pow(2, n - 1);
  return Math.min(raw, maxMs);
}

/** Absolute time at which the next attempt becomes claimable. */
function nextAvailableAt(now, attempt, backoff) {
  return new Date(now.getTime() + computeBackoffMs(attempt, backoff));
}

module.exports = { computeBackoffMs, nextAvailableAt };
