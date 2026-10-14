'use strict';

/**
 * Job-handler registry: a small, explicit map from job_type to handler. This is
 * the seam that separates queue mechanics (claim/retry/dead-letter) from
 * job-specific business logic. Real vendor normalization can be registered in a
 * later phase without touching the worker.
 */
function createRegistry(initial = []) {
  const handlers = new Map();

  const registry = {
    /**
     * @param {string} jobType
     * @param {(job: object, ctx: object) => Promise<object>} handler
     */
    register(jobType, handler) {
      if (typeof jobType !== 'string' || jobType.length === 0) {
        throw new Error('register requires a non-empty jobType');
      }
      if (typeof handler !== 'function') {
        throw new Error(`Handler for "${jobType}" must be a function`);
      }
      handlers.set(jobType, handler);
      return registry;
    },

    /** Register from an array of `{ jobType, handler }` descriptors. */
    registerAll(definitions) {
      for (const definition of definitions || []) {
        registry.register(definition.jobType, definition.handler);
      }
      return registry;
    },

    get(jobType) {
      return handlers.get(jobType);
    },

    has(jobType) {
      return handlers.has(jobType);
    },

    list() {
      return [...handlers.keys()];
    },
  };

  registry.registerAll(initial);
  return registry;
}

module.exports = { createRegistry };
