'use strict';

const AppError = require('../../errors/AppError');
const {
  DERIVED_STATUS,
  ATTENTION_LEVELS,
} = require('../normalization/constants');
const repo = require('./operations.repository');

/**
 * Operational read model. Deterministic, explainable, no ML.
 *
 * A machine that has never been processed has no machine_state row; it is
 * surfaced as derived_status 'unknown' with needs_attention true (missing
 * evidence is never healthy) and processing_status 'unknown'.
 */

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toMachineView(row) {
  const derivedStatus = row.derived_status || DERIVED_STATUS.UNKNOWN;
  const processingStatus = row.processing_status || 'unknown';
  const needsAttention =
    row.needs_attention === null || row.needs_attention === undefined
      ? true
      : row.needs_attention;

  return {
    machine_id: row.machine_id,
    plant_id: row.plant_id,
    line_id: row.line_id,
    machine_type: row.machine_type,
    criticality: row.criticality,
    asset_status: row.asset_status,
    derived_status: derivedStatus,
    attention_level: row.attention_level || ATTENTION_LEVELS.NONE,
    needs_attention: needsAttention,
    reason_codes: row.reason_codes || [],
    latest_relevant_event_time: toIso(row.latest_relevant_event_time),
    processing_status: processingStatus,
    source_event_refs: row.source_event_refs || [],
    last_processed_at: toIso(row.last_processed_at),
    source_max_event_time: toIso(row.source_max_event_time),
    ratings: {
      rated_max_temp_c: row.rated_max_temp_c !== null ? Number(row.rated_max_temp_c) : null,
      rated_max_vibration_mm_s:
        row.rated_max_vibration_mm_s !== null ? Number(row.rated_max_vibration_mm_s) : null,
      baseline_power_kw: row.baseline_power_kw !== null ? Number(row.baseline_power_kw) : null,
    },
  };
}

function emptyStatusCounts() {
  return Object.values(DERIVED_STATUS).reduce((acc, s) => {
    acc[s] = 0;
    return acc;
  }, {});
}

function emptyAttentionCounts() {
  return Object.values(ATTENTION_LEVELS).reduce((acc, s) => {
    acc[s] = 0;
    return acc;
  }, {});
}

function buildSummary(scope, scopeIds, machines) {
  const byStatus = emptyStatusCounts();
  const byAttention = emptyAttentionCounts();
  const criticalMachines = [];
  const machinesNeedingAttention = [];
  const lineBreakdown = new Map();
  const dataQuality = { stale: 0, failed: 0, partially_processed: 0, never_processed: 0 };

  for (const row of machines) {
    const view = toMachineView(row);
    byStatus[view.derived_status] = (byStatus[view.derived_status] || 0) + 1;
    byAttention[view.attention_level] = (byAttention[view.attention_level] || 0) + 1;

    if (view.derived_status === DERIVED_STATUS.CRITICAL) criticalMachines.push(view.machine_id);
    if (view.needs_attention) machinesNeedingAttention.push(view.machine_id);

    if (view.derived_status === DERIVED_STATUS.STALE) dataQuality.stale += 1;
    if (view.processing_status === 'failed') dataQuality.failed += 1;
    if (view.processing_status === 'partially_processed') dataQuality.partially_processed += 1;
    if (view.processing_status === 'unknown') dataQuality.never_processed += 1;

    if (!lineBreakdown.has(view.line_id)) {
      lineBreakdown.set(view.line_id, {
        line_id: view.line_id,
        machine_count: 0,
        needs_attention_count: 0,
        critical_count: 0,
      });
    }
    const line = lineBreakdown.get(view.line_id);
    line.machine_count += 1;
    if (view.needs_attention) line.needs_attention_count += 1;
    if (view.derived_status === DERIVED_STATUS.CRITICAL) line.critical_count += 1;
  }

  const lines = [...lineBreakdown.values()].sort((a, b) => {
    if (b.needs_attention_count !== a.needs_attention_count) {
      return b.needs_attention_count - a.needs_attention_count;
    }
    if (b.critical_count !== a.critical_count) return b.critical_count - a.critical_count;
    return a.line_id < b.line_id ? -1 : a.line_id > b.line_id ? 1 : 0;
  });

  return {
    scope,
    ...scopeIds,
    machine_count: machines.length,
    by_status: byStatus,
    by_attention: byAttention,
    needs_attention_count: machinesNeedingAttention.length,
    critical_machines: criticalMachines.sort(),
    machines_needing_attention: machinesNeedingAttention.sort(),
    lines_by_attention: lines,
    data_quality: dataQuality,
  };
}

async function getMachineStatus(machineId) {
  const row = await repo.findMachineById(machineId);
  if (!row) throw AppError.notFound(`Machine ${machineId} not found`);
  return toMachineView(row);
}

async function getPlantSummary(plantId) {
  if (!(await repo.plantExists(plantId))) {
    throw AppError.notFound(`Plant ${plantId} not found`);
  }
  const machines = await repo.listMachinesByPlant(plantId);
  return buildSummary('plant', { plant_id: plantId }, machines);
}

async function getLineSummary(lineId) {
  if (!(await repo.lineExists(lineId))) {
    throw AppError.notFound(`Line ${lineId} not found`);
  }
  const machines = await repo.listMachinesByLine(lineId);
  const plantId = machines[0] ? machines[0].plant_id : null;
  return buildSummary('line', { plant_id: plantId, line_id: lineId }, machines);
}

module.exports = {
  getMachineStatus,
  getPlantSummary,
  getLineSummary,
  toMachineView,
  buildSummary,
};
