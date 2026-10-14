'use strict';

const { createRegistry } = require('../../src/modules/processing/registry');

describe('createRegistry', () => {
  test('registers and retrieves handlers', () => {
    const registry = createRegistry();
    const handler = async () => ({ outcome: 'succeeded' });

    registry.register('demo', handler);

    expect(registry.has('demo')).toBe(true);
    expect(registry.get('demo')).toBe(handler);
    expect(registry.list()).toEqual(['demo']);
  });

  test('accepts initial descriptors', () => {
    const a = async () => ({});
    const b = async () => ({});
    const registry = createRegistry([
      { jobType: 'a', handler: a },
      { jobType: 'b', handler: b },
    ]);

    expect(registry.list().sort()).toEqual(['a', 'b']);
  });

  test('rejects a non-function handler', () => {
    const registry = createRegistry();
    expect(() => registry.register('x', 'not-a-fn')).toThrow(/must be a function/);
  });

  test('rejects an empty job type', () => {
    const registry = createRegistry();
    expect(() => registry.register('', async () => ({}))).toThrow(/non-empty jobType/);
  });

  test('returns undefined for an unregistered type', () => {
    expect(createRegistry().get('nope')).toBeUndefined();
  });

  test('is chainable', () => {
    const registry = createRegistry();
    const result = registry.register('a', async () => ({})).register('b', async () => ({}));
    expect(result).toBe(registry);
  });
});
