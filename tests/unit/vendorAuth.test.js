'use strict';

const vendorAuth = require('../../src/middleware/vendorAuth');
const AppError = require('../../src/errors/AppError');

const {
  createVendorAuth,
  extractKey,
  timingSafeEqualString,
} = vendorAuth;

function makeKeys() {
  return new Map([
    ['acme', 'key-acme'],
    ['globex', 'key-globex'],
  ]);
}

function makeReq(vendor, headers = {}) {
  return { params: { vendor }, headers };
}

describe('timingSafeEqualString', () => {
  test('is true for equal strings', () => {
    expect(timingSafeEqualString('secret', 'secret')).toBe(true);
  });

  test('is false for same-length strings that differ', () => {
    expect(timingSafeEqualString('secret', 'secreT')).toBe(false);
  });

  test('is false for different-length strings', () => {
    expect(timingSafeEqualString('short', 'much-longer-secret')).toBe(false);
  });
});

describe('extractKey', () => {
  test('reads an X-API-Key header', () => {
    expect(extractKey({ headers: { 'x-api-key': 'abc' } })).toBe('abc');
  });

  test('reads a Bearer token', () => {
    expect(extractKey({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
  });

  test('returns null when no credential is present', () => {
    expect(extractKey({ headers: {} })).toBeNull();
  });
});

describe('createVendorAuth', () => {
  test('passes through when auth is disabled', () => {
    const guard = createVendorAuth({ required: false, apiKeys: new Map() });
    const next = jest.fn();

    guard(makeReq('acme'), {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('accepts a valid X-API-Key for the matching vendor', () => {
    const guard = createVendorAuth({ required: true, apiKeys: makeKeys() });
    const next = jest.fn();

    guard(makeReq('acme', { 'x-api-key': 'key-acme' }), {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('accepts a valid Bearer token', () => {
    const guard = createVendorAuth({ required: true, apiKeys: makeKeys() });
    const next = jest.fn();

    guard(makeReq('globex', { authorization: 'Bearer key-globex' }), {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('rejects a missing credential', () => {
    const guard = createVendorAuth({ required: true, apiKeys: makeKeys() });
    const next = jest.fn();

    guard(makeReq('acme'), {}, next);

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
  });

  test('rejects a wrong key for a known vendor', () => {
    const guard = createVendorAuth({ required: true, apiKeys: makeKeys() });
    const next = jest.fn();

    guard(makeReq('acme', { 'x-api-key': 'wrong' }), {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  test('cannot distinguish an unknown vendor from a wrong key', () => {
    const guard = createVendorAuth({ required: true, apiKeys: makeKeys() });

    const unknownNext = jest.fn();
    guard(makeReq('nope', { 'x-api-key': 'anything' }), {}, unknownNext);

    const wrongNext = jest.fn();
    guard(makeReq('acme', { 'x-api-key': 'wrong' }), {}, wrongNext);

    expect(unknownNext.mock.calls[0][0].message).toBe(
      wrongNext.mock.calls[0][0].message
    );
  });
});
