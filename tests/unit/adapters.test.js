'use strict';

const pulseforge = require('../../src/modules/normalization/adapters/pulseforge');
const thermexwatch = require('../../src/modules/normalization/adapters/thermexwatch');
const maintaflow = require('../../src/modules/normalization/adapters/maintaflow');
const { getAdapter } = require('../../src/modules/normalization/adapters');
const { computeDedupeKey } = require('../../src/modules/normalization/fingerprint');
const { RECORD_ERROR_CODES } = require('../../src/modules/normalization/errors');
const { loadAssetContext, readAssetJson } = require('../helpers/assets');

const context = loadAssetContext();

function codes(item) {
  return item.issues.issues.map((i) => i.code);
}

describe('adapter registry', () => {
  test('resolves adapters case-insensitively and rejects unknown vendors', () => {
    expect(getAdapter('PulseForge')).toBe(pulseforge);
    expect(getAdapter('thermexwatch')).toBe(thermexwatch);
    expect(getAdapter('MAINTAFLOW')).toBe(maintaflow);
    expect(getAdapter('nope')).toBeNull();
  });

  test('each adapter unwraps its slice of a combined payload', () => {
    const combined = readAssetJson('vendor_api_samples/happy_path.json');
    expect(pulseforge.normalize(combined, context).items).toHaveLength(2);
    expect(thermexwatch.normalize(combined, context).items).toHaveLength(2);
    expect(maintaflow.normalize(combined, context).items).toHaveLength(1);
  });
});

describe('PulseForge adapter', () => {
  test('normalizes the happy path', () => {
    const sample = readAssetJson('vendor_api_samples/pulseforge_sample.json');
    const { items } = pulseforge.normalize(sample, context);
    expect(items).toHaveLength(2);
    const [first] = items;
    expect(first.record.canonicalEventType).toBe('vibration');
    expect(first.record.severity).toBe('high');
    expect(first.record.machine_id).toBe('EQ-001');
    expect(first.record.line_id).toBe('LINE-A');
    expect(first.record.occurredAt.toISOString()).toBe('2026-04-18T07:59:12.000Z');
    expect(Number(first.record.vibrationMmS)).toBe(11.8);
  });

  test('rejects records with missing machine and malformed fields', () => {
    const sample = readAssetJson('vendor_api_samples/malformed.json');
    const { items } = pulseforge.normalize(sample, context);

    expect(items[0].record).toBeNull();
    expect(codes(items[0])).toContain(RECORD_ERROR_CODES.MISSING_MACHINE);

    expect(items[1].record).toBeNull();
    const c = codes(items[1]);
    expect(c).toContain(RECORD_ERROR_CODES.INVALID_TIMESTAMP);
    expect(c).toContain(RECORD_ERROR_CODES.UNSUPPORTED_SEVERITY);
    expect(c).toContain(RECORD_ERROR_CODES.INVALID_MEASUREMENT);
    expect(c).toContain(RECORD_ERROR_CODES.INVALID_SENSOR_HEALTH);
    expect(c).toContain(RECORD_ERROR_CODES.INVALID_CONFIDENCE);
  });
});

describe('ThermexWatch adapter', () => {
  test('converts F->C, preserves vibration_g, maps level to severity, expands line', () => {
    const sample = readAssetJson('vendor_api_samples/thermexwatch_sample.json');
    const { items } = thermexwatch.normalize(sample, context);
    const [first] = items;

    expect(first.record.canonicalEventType).toBe('vibration');
    expect(first.record.severity).toBe('high'); // level 4
    expect(first.record.line_id).toBe('LINE-A'); // productionLine "A"
    expect(Number(first.record.vibrationG)).toBe(0.81);
    expect(first.record.vibrationMmS).toBeNull(); // never converted
    expect(Number(first.record.temperatureC)).toBe(82.889); // 181.2F
    expect(first.record.occurredAt.toISOString()).toBe('2026-04-18T07:59:12.000Z');
  });

  test('TEMP_CRIT 206.6F becomes 97.0C (EQ-002 rated max 90)', () => {
    const readings = [
      {
        readingId: 'TW-8803',
        assetCode: 'EQ-002',
        productionLine: 'A',
        timestampMs: 1776499120000,
        alertCode: 'TEMP_CRIT',
        level: 5,
        vibration_g: 0.31,
        temperature_f: 206.6,
        power_kw: 30.4,
        is_active: true,
        signal_quality: 'GOOD',
      },
    ];
    const { items } = thermexwatch.normalize({ readings }, context);
    expect(items[0].record.canonicalEventType).toBe('temperature');
    expect(items[0].record.severity).toBe('critical');
    expect(Number(items[0].record.temperatureC)).toBe(97.0);
  });

  test('rejects malformed readings, retaining an unknown-line warning', () => {
    const sample = readAssetJson('vendor_api_samples/malformed.json');
    const { items } = thermexwatch.normalize(sample, context);

    expect(items[0].record).toBeNull();
    expect(codes(items[0])).toContain(RECORD_ERROR_CODES.MISSING_MACHINE);
    expect(codes(items[0])).toContain(RECORD_ERROR_CODES.INVALID_TIMESTAMP);
    expect(codes(items[0])).toContain(RECORD_ERROR_CODES.UNSUPPORTED_SEVERITY);

    expect(items[1].record).toBeNull();
    expect(codes(items[1])).toContain(RECORD_ERROR_CODES.UNSUPPORTED_EVENT_TYPE);
    expect(codes(items[1])).toContain(RECORD_ERROR_CODES.UNKNOWN_LINE);
    expect(items[1].machineId).toBe('EQ-008');
  });
});

describe('MaintaFlow adapter', () => {
  test('parses zone-less timestamps as UTC and derives severity', () => {
    const sample = readAssetJson('vendor_api_samples/maintaflow_sample.json');
    const { items } = maintaflow.normalize(sample, context);
    const [first] = items;

    expect(first.record.canonicalEventType).toBe('inspection');
    expect(first.record.severity).toBe('medium'); // minor_defect_found
    expect(first.record.occurredAt.toISOString()).toBe('2026-04-18T08:14:05.000Z');
    expect(first.record.attributes.inspection_result).toBe('minor_defect_found');
  });

  test('completed maintenance update is a resolution (severity none)', () => {
    const records = [
      {
        record_id: 'MF-701',
        machine_ref: 'EQ-004',
        line_ref: 'LINE-C',
        recorded_at: '2026/04/18 08:40:00',
        record_type: 'maintenance_update',
        maintenance_status: 'completed',
      },
    ];
    const { items } = maintaflow.normalize({ records }, context);
    expect(items[0].record.severity).toBe('none');
  });

  test('carries the batch-level factory_id onto each record', () => {
    const sample = readAssetJson('vendor_api_samples/maintaflow_sample.json');
    // `factory_id` lives on the MaintaFlow envelope, not on each record.
    expect(sample.factory_id).toBe('PLANT_01');
    expect(sample.records[0].factory_id).toBeUndefined();

    const { items } = maintaflow.normalize(sample, context);
    expect(items[0].record.attributes.factory_id).toBe('PLANT_01');
    expect(items[1].record.attributes.factory_id).toBe('PLANT_01');
  });
});

describe('dedupe fingerprints', () => {
  test('identical replayed records share a dedupe key', () => {
    const sample = readAssetJson('vendor_api_samples/duplicates.json');
    const { items } = pulseforge.normalize(sample, context);
    expect(computeDedupeKey(items[0].record)).toBe(computeDedupeKey(items[1].record));
  });

  test('a content-identical record with a mutated id shares a dedupe key', () => {
    const sample = readAssetJson('vendor_api_samples/duplicates.json');
    const { items } = thermexwatch.normalize(sample, context);
    expect(items[0].vendorEventId).not.toBe(items[1].vendorEventId); // TW-8801 vs TW-8801-R
    expect(computeDedupeKey(items[0].record)).toBe(computeDedupeKey(items[1].record));
  });
});
