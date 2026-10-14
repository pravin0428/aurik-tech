'use strict';

const fs = require('fs');
const path = require('path');

const { withTransaction } = require('../../db/tx');
const { parseCsv } = require('../../util/csv');
const repo = require('./reference.repository');

/**
 * Load reference data (machines, lines, derived plants) from the assessment
 * asset CSVs. Idempotent: safe to run repeatedly.
 *
 * Plants are DERIVED from validated reference data — there is no plants file.
 */

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCsv(text).rows;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullable(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

async function loadReferenceData(baseDir) {
  const assetRows = readCsv(path.join(baseDir, 'asset_reference.csv'));
  const lineRows = readCsv(path.join(baseDir, 'line_reference.csv'));

  const lines = lineRows.map((r) => ({
    line_id: r.line_id,
    plant_id: r.plant_id,
    line_name: toNullable(r.line_name),
    operating_window: toNullable(r.operating_window),
  }));

  const machines = assetRows.map((r) => ({
    machine_id: r.machine_id,
    plant_id: r.plant_id,
    line_id: r.line_id,
    machine_type: toNullable(r.machine_type),
    criticality: r.criticality,
    installed_date: toNullable(r.installed_date),
    rated_max_temp_c: toNumber(r.rated_max_temp_c),
    rated_max_vibration_mm_s: toNumber(r.rated_max_vibration_mm_s),
    baseline_power_kw: toNumber(r.baseline_power_kw),
    asset_status: r.asset_status,
  }));

  const plantIds = [
    ...new Set([...lines.map((l) => l.plant_id), ...machines.map((m) => m.plant_id)]),
  ];

  await withTransaction(async (client) => {
    await repo.upsertPlants(client, plantIds);
    await repo.upsertLines(client, lines);
    await repo.upsertMachines(client, machines);
  });

  return { plants: plantIds.length, lines: lines.length, machines: machines.length };
}

module.exports = { loadReferenceData, readCsv, toNumber, toNullable };
