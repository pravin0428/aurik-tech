'use strict';

const path = require('path');

const config = require('../src/config');
const logger = require('../src/logger');
const { closePool } = require('../src/db/pool');
const { withTransaction } = require('../src/db/tx');
const { parseCsv } = require('../src/util/csv');
const referenceLoader = require('../src/modules/reference/reference.loader');
const referenceRepo = require('../src/modules/reference/reference.repository');
const ingestionService = require('../src/modules/ingestion/ingestion.service');
const { createRegistry } = require('../src/modules/processing/registry');
const processingRepo = require('../src/modules/processing/processing.repository');
const { createWorker } = require('../src/modules/processing/worker');
const normalizeHandler = require('../src/modules/processing/handlers/normalizeSubmission');

/**
 * Seed loader.
 *
 * Always (idempotent): reference data (plants/lines/machines) + maintenance work
 * orders, read from the assessment asset CSVs.
 *
 * With `--events` (or SEED_EVENTS=true): the three vendor seed CSVs are
 * accepted as submissions and processed through the REAL ingestion + worker
 * pipeline (so canonical events and machine state are produced exactly as in
 * production) rather than by a second bespoke path.
 */

function assetsDir() {
  return path.isAbsolute(config.assetsDir)
    ? config.assetsDir
    : path.resolve(process.cwd(), config.assetsDir);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullable(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function readRows(filePath) {
  const fs = require('fs');
  return parseCsv(fs.readFileSync(filePath, 'utf8')).rows;
}

async function loadWorkOrders(baseDir) {
  const rows = readRows(path.join(baseDir, 'seed_data', 'maintenance_work_orders.csv'));
  const workOrders = rows.map((r) => ({
    work_order_id: r.work_order_id,
    plant_id: r.plant_id,
    machine_id: r.machine_id,
    line_id: toNullable(r.line_id),
    opened_at: r.opened_at,
    closed_at: toNullable(r.closed_at),
    maintenance_type: toNullable(r.maintenance_type),
    trigger_source: toNullable(r.trigger_source),
    status: r.status,
    downtime_minutes: toNumberOrNull(r.downtime_minutes),
    post_maintenance_check: toNullable(r.post_maintenance_check),
    notes: toNullable(r.notes),
    source_file: 'seed_data/maintenance_work_orders.csv',
  }));

  await withTransaction((client) => referenceRepo.upsertWorkOrders(client, workOrders));
  return workOrders.length;
}

/** Build vendor payloads directly from the seed CSVs (testable, pure). */
function buildSeedPayloads(baseDir) {
  const pfRows = readRows(path.join(baseDir, 'seed_data', 'pulseforge_events.csv'));
  const twRows = readRows(path.join(baseDir, 'seed_data', 'thermexwatch_readings.csv'));
  const mfRows = readRows(path.join(baseDir, 'seed_data', 'maintaflow_records.csv'));

  const pulseforge = {
    vendor: 'PulseForge',
    plant_id: pfRows[0] ? pfRows[0].plant_id : null,
    events: pfRows,
  };

  const thermexwatch = {
    source: 'ThermexWatch',
    site_code: twRows[0] ? twRows[0].site_code : null,
    readings: twRows.map((r) => ({
      readingId: r.reading_id,
      assetCode: r.asset_code,
      productionLine: r.production_line,
      timestampMs: toNumberOrNull(r.timestamp_ms),
      alertCode: r.alert_code,
      level: toNumberOrNull(r.level),
      vibration_g: toNumberOrNull(r.vibration_g),
      temperature_f: toNumberOrNull(r.temperature_f),
      power_kw: toNumberOrNull(r.power_kw),
      is_active: String(r.is_active).toLowerCase() === 'true',
      signal_quality: r.signal_quality,
    })),
  };

  const maintaflow = {
    provider_name: 'MaintaFlow',
    factory_id: mfRows[0] ? mfRows[0].factory_id : null,
    records: mfRows,
  };

  return { pulseforge, thermexwatch, maintaflow };
}

async function ingestSeedEvents(baseDir) {
  const payloads = buildSeedPayloads(baseDir);
  const submissions = [];

  for (const [vendor, payload] of Object.entries(payloads)) {
    const submission = await ingestionService.acceptSubmission({
      vendor,
      idempotencyKey: `seed-${vendor}-v1`,
      idempotencySource: 'body',
      envelope: { submissionId: `seed-${vendor}-v1`, payload },
      requestId: 'seed-script',
    });
    submissions.push(submission.submissionId);
  }

  const registry = createRegistry([normalizeHandler]);
  const worker = createWorker({
    registry,
    repository: processingRepo,
    logger,
    settings: config.worker,
    workerId: 'seed-script',
  });

  let processed = 0;
  for (let i = 0; i < 100; i += 1) {
    const claimed = await worker.runOnce();
    if (claimed === 0) break;
    processed += claimed;
  }

  return { submissions, processed };
}

async function main({ withEvents = false } = {}) {
  const baseDir = assetsDir();

  const reference = await referenceLoader.loadReferenceData(baseDir);
  const workOrders = await loadWorkOrders(baseDir);

  const result = { reference, workOrders, events: null };

  if (withEvents) {
    result.events = await ingestSeedEvents(baseDir);
  }

  logger.info(result, 'Seed complete');
  return result;
}

if (require.main === module) {
  const withEvents = process.argv.includes('--events') || String(process.env.SEED_EVENTS) === 'true';
  main({ withEvents })
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Seed step failed');
      process.exitCode = 1;
      return closePool();
    });
}

module.exports = { main, buildSeedPayloads, loadWorkOrders, assetsDir };
