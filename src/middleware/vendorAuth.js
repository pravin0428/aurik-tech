'use strict';

const crypto = require('crypto');
const config = require('../config');
const AppError = require('../errors/AppError');

/**
 * Compare two strings without leaking relative timing.
 * Length differences are normalised so a mismatch still performs the same
 * constant-time comparison work.
 */
function timingSafeEqualString(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');

  if (a.length !== b.length) {
    // Equalise work; comparing a buffer with itself always succeeds but costs
    // the same as a real comparison, so timing does not reveal the length gap.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Read a key from either an `Authorization: Bearer <key>` header or an
 * `X-API-Key` header. Never returns or logs the credential itself beyond the
 * comparison that follows.
 */
function extractKey(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }

  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();

  return null;
}

/**
 * Build a vendor-scoped API-key guard.
 *
 * `required` disables the guard entirely when false (local development).
 * When required, the request must carry a key that matches the one configured
 * for the vendor in the URL. Failures are deliberately indistinguishable
 * ("unknown vendor" and "wrong key" behave identically) so responses cannot be
 * used to enumerate registered vendors.
 */
function createVendorAuth({ required, apiKeys }) {
  return function vendorAuth(req, res, next) {
    if (!required) return next();

    const vendor = typeof req.params.vendor === 'string' ? req.params.vendor : '';
    const expected = apiKeys.get(vendor);
    const provided = extractKey(req);

    if (!expected || !provided) {
      return next(AppError.unauthorized('Missing or invalid API key'));
    }

    if (!timingSafeEqualString(provided, expected)) {
      return next(AppError.unauthorized('Missing or invalid API key'));
    }

    return next();
  };
}

module.exports = createVendorAuth({
  required: config.ingestion.authRequired,
  apiKeys: config.ingestion.apiKeys,
});

module.exports.createVendorAuth = createVendorAuth;
module.exports.extractKey = extractKey;
module.exports.timingSafeEqualString = timingSafeEqualString;
