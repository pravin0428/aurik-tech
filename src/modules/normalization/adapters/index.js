'use strict';

const { normalizeVendorKey } = require('../constants');
const pulseforge = require('./pulseforge');
const thermexwatch = require('./thermexwatch');
const maintaflow = require('./maintaflow');

/**
 * Vendor adapter registry. Adding a vendor means adding one file and one entry
 * here; the worker, pipeline, and persistence layers are vendor-agnostic.
 */
const ADAPTERS = Object.freeze({
  [pulseforge.vendor]: pulseforge,
  [thermexwatch.vendor]: thermexwatch,
  [maintaflow.vendor]: maintaflow,
});

function getAdapter(vendor) {
  return ADAPTERS[normalizeVendorKey(vendor)] || null;
}

module.exports = { ADAPTERS, getAdapter, normalizeVendorKey };
