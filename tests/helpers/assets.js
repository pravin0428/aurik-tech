'use strict';

const fs = require('fs');
const path = require('path');

const { parseCsv } = require('../../src/util/csv');

/**
 * Build the normalizer reference context directly from the assessment asset
 * CSVs, without touching the database. Used by adapter/reducer unit tests so
 * machine/line resolution matches production exactly.
 */
const ASSETS_DIR = path.resolve(
  process.cwd(),
  'Aurik_Tech_Lead_Assessment_Assets',
  'Aurik_Tech_Lead_Assessment_Assets'
);

function loadAssetContext() {
  const assetRows = parseCsv(
    fs.readFileSync(path.join(ASSETS_DIR, 'asset_reference.csv'), 'utf8')
  ).rows;
  const lineRows = parseCsv(
    fs.readFileSync(path.join(ASSETS_DIR, 'line_reference.csv'), 'utf8')
  ).rows;

  const machines = new Map();
  for (const r of assetRows) {
    machines.set(r.machine_id, {
      machine_id: r.machine_id,
      plant_id: r.plant_id,
      line_id: r.line_id,
      machine_type: r.machine_type,
      criticality: r.criticality,
      asset_status: r.asset_status,
    });
  }

  const lines = new Map();
  for (const r of lineRows) lines.set(r.line_id, { line_id: r.line_id, plant_id: r.plant_id });

  const plants = new Set([...lines.values()].map((l) => l.plant_id));
  return { machines, lines, plants };
}

function readAssetJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, relativePath), 'utf8'));
}

module.exports = { ASSETS_DIR, loadAssetContext, readAssetJson };
