'use strict';

const { OUTCOME, classifyThrown, normalizeHandlerResult, sanitizeErrorMessage } = require('./outcome');
const { computeBackoffMs, nextAvailableAt } = require('./backoff');

/**
 * Job worker: owns the polling loop, claim/execute/transition mechanics, and
 * graceful shutdown. It knows nothing about what a job *means* — that lives in
 * the handler registry. Job-specific business logic is therefore swappable
 * without touching queue reliability code.
 *
 * Delivery is at-least-once, never exactly-once: a job may be re-executed after
 * a crash or lease expiry. Safety comes from (a) claims being atomic, (b) the
 * ownership guard on every transition, and (c) handlers being idempotent.
 *
 * @param {object} deps
 * @param {{ get: Function, has: Function }} deps.registry  job handlers
 * @param {object} deps.repository  processing.repository
 * @param {object} deps.logger      pino logger
 * @param {object} deps.settings    config.worker
 * @param {() => Date} [deps.clock] injectable clock (defaults to real time)
 * @param {string} deps.workerId    unique worker identity for lease ownership
 */
function createWorker({ registry, repository, logger, settings, clock = () => new Date(), workerId }) {
  const backoff = { baseMs: settings.backoffBaseMs, maxMs: settings.backoffMaxMs };

  let running = false;
  let loopPromise = null;
  let tickPromise = null;
  let sleepTimer = null;
  let sleepResolve = null;

  function now() {
    return clock();
  }

  /** Reclaim jobs abandoned by dead workers before claiming new work. */
  async function recoverExpired() {
    const recovered = await repository.recoverExpiredJobs({
      now: now(),
      leaseMs: settings.leaseMs,
      limit: settings.recoveryBatchSize,
      nextAvailableAt: (attempts) => nextAvailableAt(now(), attempts, backoff),
    });
    if (recovered.length > 0) {
      logger.warn(
        { workerId, recovered: recovered.length },
        'Recovered jobs whose lease expired'
      );
    }
    return recovered;
  }

  /**
   * Execute a single claimed job and persist its terminal/retry transition.
   * Every transition is ownership-guarded; a null result means the lease was
   * lost (e.g. reclaimed by another worker) and this worker's result is
   * discarded rather than allowed to overwrite the new owner's work.
   */
  async function handleJob(job) {
    const startedAt = now().getTime();
    const logFields = {
      jobId: job.id,
      submissionId: job.submission_id,
      jobType: job.job_type,
      attempt: job.attempts,
      workerId,
    };

    const handler = registry.get(job.job_type);
    let outcome;

    if (!handler) {
      outcome = {
        outcome: OUTCOME.PERMANENT,
        error: new Error(`No handler registered for job type "${job.job_type}"`),
        category: 'handler_not_found',
      };
    } else {
      try {
        outcome = normalizeHandlerResult(await handler(job, { logger, clock }));
      } catch (err) {
        outcome = classifyThrown(err);
      }
    }

    const durationMs = now().getTime() - startedAt;
    const lastError = sanitizeErrorMessage(outcome.error || outcome.reason);

    const persist = async (fn) => {
      const updated = await fn();
      if (!updated) {
        logger.warn(
          { ...logFields, outcome: 'lease_lost' },
          'Job lease lost before transition; result discarded'
        );
        return null;
      }
      return updated;
    };

    switch (outcome.outcome) {
      case OUTCOME.SUCCEEDED: {
        const updated = await persist(() =>
          repository.completeJob({ jobId: job.id, workerId, now: now() })
        );
        if (updated) {
          logger.info({ ...logFields, outcome: 'succeeded', durationMs }, 'Job succeeded');
        }
        return updated;
      }

      case OUTCOME.BLOCKED: {
        const updated = await persist(() =>
          repository.blockJob({
            jobId: job.id,
            workerId,
            reason: outcome.reason,
            now: now(),
          })
        );
        if (updated) {
          logger.warn(
            { ...logFields, outcome: 'blocked', durationMs },
            'Job blocked: domain processing unavailable'
          );
        }
        return updated;
      }

      case OUTCOME.PERMANENT: {
        const updated = await persist(() =>
          repository.deadLetter({
            jobId: job.id,
            workerId,
            lastError,
            errorCategory: outcome.category || 'permanent',
            now: now(),
          })
        );
        if (updated) {
          logger.error(
            { ...logFields, outcome: 'dead_letter', errorCategory: outcome.category, durationMs },
            'Job terminally failed'
          );
        }
        return updated;
      }

      case OUTCOME.RETRY:
      default: {
        const exhausted = job.attempts >= job.max_attempts;

        if (exhausted) {
          const updated = await persist(() =>
            repository.deadLetter({
              jobId: job.id,
              workerId,
              lastError,
              errorCategory: 'retries_exhausted',
              now: now(),
            })
          );
          if (updated) {
            logger.error(
              { ...logFields, outcome: 'dead_letter', errorCategory: 'retries_exhausted', durationMs },
              'Job terminally failed: retries exhausted'
            );
          }
          return updated;
        }

        const availableAt = nextAvailableAt(now(), job.attempts, backoff);
        const updated = await persist(() =>
          repository.scheduleRetry({
            jobId: job.id,
            workerId,
            availableAt,
            lastError,
            errorCategory: outcome.category || 'transient',
            now: now(),
          })
        );
        if (updated) {
          logger.warn(
            {
              ...logFields,
              outcome: 'retrying',
              nextAttemptAt: availableAt.toISOString(),
              durationMs,
            },
            'Job failed; retry scheduled'
          );
        }
        return updated;
      }
    }
  }

  /** One poll cycle: recover expired leases, claim a batch, process it. */
  async function doRunOnce() {
    await recoverExpired();

    const jobs = await repository.claimBatch({
      workerId,
      limit: settings.batchSize,
      now: now(),
    });

    // Sequential within a batch keeps shutdown simple and deterministic; the
    // batch size bounds how much work is taken per cycle.
    for (const job of jobs) {
      await handleJob(job);
    }

    return jobs.length;
  }

  function runOnce() {
    const promise = doRunOnce();
    tickPromise = promise;
    promise
      .finally(() => {
        if (tickPromise === promise) tickPromise = null;
      })
      .catch(() => {});
    return promise;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      sleepResolve = resolve;
      if (ms <= 0) {
        sleepResolve = null;
        resolve();
        return;
      }
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        sleepResolve = null;
        resolve();
      }, ms);
      if (sleepTimer.unref) sleepTimer.unref();
    });
  }

  function wakeSleep() {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      resolve();
    }
  }

  async function loop() {
    while (running) {
      try {
        await runOnce();
      } catch (err) {
        logger.error({ err, workerId }, 'Worker tick failed');
      }

      if (!running) break;
      await sleep(settings.pollIntervalMs);
    }
  }

  /** Begin polling. Returns immediately; use stop() to shut down. */
  function start() {
    if (running) return loopPromise;
    running = true;
    logger.info({ workerId, settings: { ...settings } }, 'Worker polling started');
    loopPromise = loop();
    return loopPromise;
  }

  /**
   * Stop claiming new work, wake any poll wait, and wait for the in-flight
   * cycle (including the current job) to finish within the shutdown timeout.
   */
  async function stop() {
    running = false;
    wakeSleep();

    const pending = [];
    if (tickPromise) pending.push(tickPromise);
    if (loopPromise) pending.push(loopPromise);

    if (pending.length > 0) {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), settings.shutdownTimeoutMs);
        if (timer.unref) timer.unref();
      });
      const result = await Promise.race([Promise.allSettled(pending), timeout]);
      clearTimeout(timer);
      if (result === 'timeout') {
        logger.error({ workerId }, 'Worker shutdown timed out; abandoning in-flight work');
      }
    }

    logger.info({ workerId }, 'Worker stopped');
  }

  return {
    start,
    stop,
    runOnce,
    recoverExpired,
    handleJob,
    isRunning: () => running,
    get workerId() {
      return workerId;
    },
  };
}

module.exports = { createWorker };
