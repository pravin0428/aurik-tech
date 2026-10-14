'use strict';

const { deriveMachineState } = require('../../src/modules/normalization/machineState');

const machine = { machine_id: 'EQ-001', plant_id: 'PLANT_01', line_id: 'LINE-A' };
const NOW = new Date('2026-04-18T09:00:00.000Z');
const STALE_MS = 24 * 60 * 60 * 1000;

function ev(type, severity, at, extra = {}) {
  return {
    vendor: extra.vendor || 'pulseforge',
    vendorEventId: extra.vendorEventId || `${type}-${at}`,
    canonicalEventType: type,
    rawEventType: extra.rawEventType || type.toUpperCase(),
    severity,
    occurredAt: new Date(at),
    attributes: extra.attributes || {},
    ...extra,
  };
}

function derive(events, workOrders = []) {
  return deriveMachineState({
    now: NOW,
    staleWindowMs: STALE_MS,
    machine,
    events,
    workOrders,
  });
}

describe('machine state reducer', () => {
  test('no events is "unknown" and never healthy', () => {
    const state = derive([]);
    expect(state.derived_status).toBe('unknown');
    expect(state.needs_attention).toBe(true);
  });

  test('a later recovery does NOT clear an active critical', () => {
    const state = derive([
      ev('temperature', 'critical', '2026-04-18T08:29:10Z'),
      ev('recovery', 'low', '2026-04-18T08:39:10Z'),
    ]);
    expect(state.derived_status).toBe('critical');
    expect(state.attention_level).toBe('critical');
    expect(state.reason_codes).toContain('temperature_critical');
    expect(state.reason_codes).toContain('recovery_signal');
    expect(state.needs_attention).toBe(true);
  });

  test('a later recovery DOES clear a warning (=> recovering)', () => {
    const state = derive([
      ev('vibration', 'high', '2026-04-18T08:31:02Z'),
      ev('recovery', 'low', '2026-04-18T08:32:05Z'),
    ]);
    expect(state.derived_status).toBe('recovering');
    expect(state.attention_level).toBe('none');
    expect(state.needs_attention).toBe(false);
    expect(state.reason_codes).toContain('recovery_signal');
    expect(state.reason_codes).not.toContain('vibration_high');
  });

  test('latest evidence older than the stale window is "stale"', () => {
    const state = derive([ev('vibration', 'low', '2026-04-17T08:00:00Z')]);
    expect(state.derived_status).toBe('stale');
    expect(state.reason_codes).toContain('stale_data');
    expect(state.needs_attention).toBe(true);
  });

  test('an unresolved warning outranks staleness', () => {
    const state = derive([ev('temperature', 'medium', '2026-04-17T08:00:00Z')]);
    expect(state.derived_status).toBe('warning');
    expect(state.reason_codes).toContain('temperature_attention');
    expect(state.reason_codes).toContain('stale_data');
  });

  test('active maintenance defect major drives warning', () => {
    const state = derive([
      ev('inspection', 'high', '2026-04-18T08:41:00Z', {
        attributes: { inspection_result: 'major_defect_found' },
      }),
    ]);
    expect(state.derived_status).toBe('warning');
    expect(state.reason_codes).toContain('maintenance_defect_major');
  });

  test('an open work order is a reason for attention', () => {
    const state = derive([ev('temperature', 'medium', '2026-04-18T08:00:00Z')], [
      { work_order_id: 'WO-1', status: 'open', opened_at: NOW, closed_at: null },
    ]);
    expect(state.reason_codes).toContain('open_work_order');
    expect(state.attention_level).toBe('medium');
  });

  test('a passed, closed work order resolves a prior condition', () => {
    const state = derive(
      [ev('temperature', 'high', '2026-04-18T08:00:00Z')],
      [
        {
          work_order_id: 'WO-2',
          status: 'closed',
          closed_at: '2026-04-18T08:10:00Z',
          post_maintenance_check: 'passed',
        },
      ]
    );
    expect(state.reason_codes).not.toContain('temperature_high');
    expect(state.derived_status).not.toBe('warning');
  });

  test('low vendor confidence on the latest event is flagged', () => {
    const state = derive([
      ev('sensor_health', 'medium', '2026-04-18T08:00:00Z', {
        vendorConfidence: 0.4,
      }),
    ]);
    expect(state.reason_codes).toContain('low_sensor_confidence');
  });

  test('is order-independent (later event wins regardless of input order)', () => {
    const sorted = derive([
      ev('vibration', 'high', '2026-04-18T08:31:02Z'),
      ev('recovery', 'low', '2026-04-18T08:32:05Z'),
    ]);
    const unsorted = derive([
      ev('recovery', 'low', '2026-04-18T08:32:05Z'),
      ev('vibration', 'high', '2026-04-18T08:31:02Z'),
    ]);
    expect(unsorted.derived_status).toBe(sorted.derived_status);
    expect(unsorted.reason_codes).toEqual(sorted.reason_codes);
  });

  test('reason codes are emitted in a fixed order', () => {
    const state = derive([
      ev('temperature', 'critical', '2026-04-18T08:00:00Z'),
      ev('vibration', 'medium', '2026-04-18T08:01:00Z'),
    ]);
    const tIndex = state.reason_codes.indexOf('temperature_critical');
    const vIndex = state.reason_codes.indexOf('vibration_attention');
    expect(tIndex).toBeLessThan(vIndex);
  });
});
