'use strict';

const crypto = require('crypto');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { getPool, closePool } = require('../../src/db/pool');
const config = require('../../src/config');
const ingestionService = require('../../src/modules/ingestion/ingestion.service');
const referenceLoader = require('../../src/modules/reference/reference.loader');
const { createRegistry } = require('../../src/modules/processing/registry');
const processingRepo = require('../../src/modules/processing/processing.repository');
const { createWorker } = require('../../src/modules/processing/worker');
const normalizeHandler = require('../../src/modules/processing/handlers/normalizeSubmission');
const { ASSETS_DIR, readAssetJson } = require('../helpers/assets');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const maybe = hasDb ? describe : describe.skip;

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
};

function makeWorker() {
  return createWorker({
    registry: createRegistry([normalizeHandler]),
    repository: processingRepo,
    logger: noopLogger,
    settings: config.worker,
    workerId: 'pipeline-test',
  });
}

async function drainWorker(worker) {
  let idlePasses = 0;
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await worker.runOnce();
    if (claimed === 0) {
      // A job inserted with the DB clock (`processing_jobs.available_at`
      // defaults to `now()`, microsecond precision) can sit marginally in the
      // future of the worker's millisecond-resolution `Date`, so the first pass
      // may legitimately claim nothing. Require a few consecutive empty passes
      // before concluding the queue is drained.
      idlePasses += 1;
      if (idlePasses >= 3) break;
    } else {
      idlePasses = 0;
    }
  }
}

async function ingest(vendor, payload) {
  return ingestionService.acceptSubmission({
    vendor,
    idempotencyKey: `it-${vendor}-${crypto.randomUUID()}`,
    idempotencySource: 'body',
    envelope: { payload },
    requestId: 'pipeline-test',
  });
}

async function ingestAndRun(vendor, payload) {
  await ingest(vendor, payload);
  await drainWorker(makeWorker());
}

maybe('normalization pipeline (DB)', () => {
  const app = createApp();

  beforeAll(async () => {
    await getPool().query('SELECT 1 FROM canonical_events LIMIT 1');
    await referenceLoader.loadReferenceData(ASSETS_DIR);
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE normalization_failures, canonical_events, processing_jobs,
                ingestion_submissions, machine_state RESTART IDENTITY CASCADE`
    );
  });

  afterAll(async () => {
    await closePool();
  });

  test('happy path produces canonical events and machine state', async () => {
    const combined = readAssetJson('vendor_api_samples/happy_path.json');
    await ingestAndRun('pulseforge', combined.pulseforge);
    await ingestAndRun('thermexwatch', combined.thermexwatch);
    await ingestAndRun('maintaflow', combined.maintaflow);

    const { rows: events } = await getPool().query('SELECT count(*)::int AS n FROM canonical_events');
    expect(events[0].n).toBe(5); // 2 PF + 2 TW + 1 MF

    const { rows: state } = await getPool().query(
      'SELECT derived_status FROM machine_state WHERE machine_id = $1',
      ['EQ-001']
    );
    expect(state).toHaveLength(1);
  });

  test('malformed records are rejected per-record and traced, valid ones survive', async () => {
    const malformed = readAssetJson('vendor_api_samples/malformed.json');
    await ingestAndRun('pulseforge', malformed.pulseforge);

    const { rows: events } = await getPool().query('SELECT count(*)::int AS n FROM canonical_events');
    expect(events[0].n).toBe(0);

    const { rows: failures } = await getPool().query(
      'SELECT error_code, severity FROM normalization_failures ORDER BY error_code'
    );
    const codes = failures.map((f) => f.error_code);
    expect(codes).toContain('missing_machine');
    expect(codes).toContain('invalid_timestamp');
    expect(codes).toContain('unsupported_severity');

    // EQ-002 resolved but its record was rejected -> machine is partially processed.
    const { rows: state } = await getPool().query(
      'SELECT derived_status, processing_status FROM machine_state WHERE machine_id = $1',
      ['EQ-002']
    );
    expect(state).toHaveLength(1);
    expect(state[0].derived_status).toBe('unknown');
    expect(state[0].processing_status).toBe('partially_processed');
  });

  test('duplicate records collapse to one canonical event (content fingerprint)', async () => {
    const duplicates = readAssetJson('vendor_api_samples/duplicates.json');
    await ingestAndRun('pulseforge', duplicates.pulseforge);
    await ingestAndRun('thermexwatch', duplicates.thermexwatch);

    const { rows } = await getPool().query(
      `SELECT vendor, count(*)::int AS n FROM canonical_events GROUP BY vendor ORDER BY vendor`
    );
    const byVendor = Object.fromEntries(rows.map((r) => [r.vendor, r.n]));
    expect(byVendor.pulseforge).toBe(1); // PF-1001 twice
    expect(byVendor.thermexwatch).toBe(1); // TW-8801 vs TW-8801-R
  });

  test('out-of-order records resolve by event time, not arrival order', async () => {
    const outOfOrder = readAssetJson('vendor_api_samples/out_of_order.json');
    // The fixture lists the LATER recovery (PF-1302, 08:32:05) BEFORE the
    // EARLIER high vibration (PF-1301, 08:31:02). Arrival/processing order must
    // not decide the result: the later recovery clears the earlier
    // non-critical vibration, so no active vibration condition remains.
    await ingestAndRun('pulseforge', outOfOrder.pulseforge);

    const { rows: events } = await getPool().query(
      'SELECT count(*)::int AS n FROM canonical_events WHERE machine_id = $1',
      ['EQ-001']
    );
    expect(events[0].n).toBe(2); // both records accepted

    const { rows } = await getPool().query(
      `SELECT derived_status, attention_level, reason_codes
         FROM machine_state WHERE machine_id = $1`,
      ['EQ-001']
    );
    expect(rows).toHaveLength(1);
    // The recovery is recognized as the (later) resolving signal...
    expect(rows[0].reason_codes).toContain('recovery_signal');
    // ...so the earlier high vibration is not left active.
    expect(rows[0].reason_codes).not.toContain('vibration_high');
    expect(rows[0].attention_level).not.toBe('high');
    expect(rows[0].derived_status).not.toBe('critical');
  });

  test('retry_cases: bad-timestamp and empty-machine records are rejected, valid ones land', async () => {
    const retry = readAssetJson('vendor_api_samples/retry_cases.json');
    await ingestAndRun('pulseforge', retry.pulseforge);
    await ingestAndRun('maintaflow', retry.maintaflow);

    // PF-1501 (EQ-005) and MF-901 (EQ-002) are accepted; PF-1502 (bad time) and
    // MF-902 (empty machine_ref) are rejected.
    const { rows: events } = await getPool().query(
      'SELECT count(*)::int AS n FROM canonical_events'
    );
    expect(events[0].n).toBe(2);

    const { rows: failures } = await getPool().query(
      'SELECT DISTINCT error_code FROM normalization_failures ORDER BY error_code'
    );
    const codes = failures.map((f) => f.error_code);
    expect(codes).toEqual(expect.arrayContaining(['invalid_timestamp', 'missing_machine']));

    // A submission that had some records rejected is surfaced as partially
    // processed, so the view never implies completeness it does not have.
    const { rows: state } = await getPool().query(
      'SELECT processing_status FROM machine_state WHERE machine_id = $1',
      ['EQ-005']
    );
    expect(state).toHaveLength(1);
    expect(state[0].processing_status).toBe('partially_processed');
  });

  test('a critical temperature is not cleared by a later recovery signal', async () => {
    const conflicting = readAssetJson('vendor_api_samples/conflicting_updates.json');
    // Ingest in an order where the recovery arrives first, then the critical,
    // then the maintenance defect — the reducer must still end at critical.
    await ingestAndRun('pulseforge', conflicting.pulseforge);
    await ingestAndRun('thermexwatch', conflicting.thermexwatch);
    await ingestAndRun('maintaflow', conflicting.maintaflow);

    const { rows } = await getPool().query(
      `SELECT derived_status, attention_level, reason_codes
         FROM machine_state WHERE machine_id = $1`,
      ['EQ-008']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].derived_status).toBe('critical');
    expect(rows[0].attention_level).toBe('critical');
    expect(rows[0].reason_codes).toContain('temperature_critical');
  });

  test('a vendor with no adapter dead-letters the submission', async () => {
    await ingest('acme', { hello: 'world' });
    await drainWorker(makeWorker());

    const { rows } = await getPool().query(
      `SELECT status, error_category FROM processing_jobs`
    );
    expect(rows[0].status).toBe('dead_letter');
    expect(rows[0].error_category).toBe('unsupported_vendor');
  });

  test('a payload without the vendor slice dead-letters as an invalid batch', async () => {
    await ingest('pulseforge', { not_events: true });
    await drainWorker(makeWorker());

    const { rows } = await getPool().query(
      `SELECT status, error_category FROM processing_jobs`
    );
    expect(rows[0].status).toBe('dead_letter');
    expect(rows[0].error_category).toBe('invalid_batch');
  });

  test('reprocessing the same submission is idempotent', async () => {
    const sample = readAssetJson('vendor_api_samples/pulseforge_sample.json');
    await ingestAndRun('pulseforge', sample);

    const before = await getPool().query('SELECT count(*)::int AS n FROM canonical_events');
    // Force a second run of the same job by re-queuing it.
    await getPool().query(
      `UPDATE processing_jobs SET status = 'pending', attempts = 0, available_at = now(), locked_by = NULL, locked_at = NULL`
    );
    await drainWorker(makeWorker());

    const after = await getPool().query('SELECT count(*)::int AS n FROM canonical_events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  describe('operational read APIs', () => {
    test('machine status exposes the critical condition', async () => {
      const conflicting = readAssetJson('vendor_api_samples/conflicting_updates.json');
      await ingestAndRun('pulseforge', conflicting.pulseforge);
      await ingestAndRun('thermexwatch', conflicting.thermexwatch);
      await ingestAndRun('maintaflow', conflicting.maintaflow);

      const res = await request(app).get('/api/v1/machines/EQ-008/status');
      expect(res.status).toBe(200);
      expect(res.body.data.machine_id).toBe('EQ-008');
      expect(res.body.data.derived_status).toBe('critical');
      expect(res.body.data.needs_attention).toBe(true);
      expect(res.body.data.reason_codes).toContain('temperature_critical');
      expect(Array.isArray(res.body.data.source_event_refs)).toBe(true);
    });

    test('unknown machine is a 404', async () => {
      const res = await request(app).get('/api/v1/machines/EQ-999/status');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('plant summary counts are consistent and expose critical machines', async () => {
      const conflicting = readAssetJson('vendor_api_samples/conflicting_updates.json');
      await ingestAndRun('pulseforge', conflicting.pulseforge);
      await ingestAndRun('thermexwatch', conflicting.thermexwatch);
      await ingestAndRun('maintaflow', conflicting.maintaflow);

      const res = await request(app).get('/api/v1/plants/PLANT_02/summary');
      expect(res.status).toBe(200);
      const { by_status: byStatus, machine_count: machineCount } = res.body.data;
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      expect(total).toBe(machineCount);
      expect(res.body.data.critical_machines).toContain('EQ-008');
    });

    test('a machine with no events is reported unknown, never ok', async () => {
      const res = await request(app).get('/api/v1/machines/EQ-005/status');
      expect(res.status).toBe(200);
      expect(res.body.data.derived_status).toBe('unknown');
      expect(res.body.data.needs_attention).toBe(true);
    });

    test('line summary is reachable', async () => {
      const res = await request(app).get('/api/v1/lines/LINE-E/summary');
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe('line');
      expect(res.body.data.line_id).toBe('LINE-E');
    });
  });
});
