'use strict';

const { query } = require('../../db/pool');

/**
 * Read models for the operational attention view. Machines are always the
 * spine (LEFT JOIN machine_state) so a machine that has never been processed is
 * still counted — as 'unknown', never as healthy.
 */

const MACHINE_VIEW_QUERY = `
  SELECT
    m.machine_id, m.plant_id, m.line_id, m.machine_type, m.criticality,
    m.asset_status, m.rated_max_temp_c, m.rated_max_vibration_mm_s, m.baseline_power_kw,
    ms.derived_status, ms.attention_level, ms.needs_attention, ms.reason_codes,
    ms.latest_relevant_event_time, ms.latest_relevant_event_id, ms.source_event_refs,
    ms.processing_status, ms.last_processed_at, ms.source_max_event_time
  FROM machines m
  LEFT JOIN machine_state ms ON ms.machine_id = m.machine_id
`;

async function findMachineById(machineId) {
  const { rows } = await query(`${MACHINE_VIEW_QUERY} WHERE m.machine_id = $1`, [machineId]);
  return rows[0] || null;
}

async function listMachinesByPlant(plantId) {
  const { rows } = await query(`${MACHINE_VIEW_QUERY} WHERE m.plant_id = $1 ORDER BY m.machine_id ASC`, [
    plantId,
  ]);
  return rows;
}

async function listMachinesByLine(lineId) {
  const { rows } = await query(`${MACHINE_VIEW_QUERY} WHERE m.line_id = $1 ORDER BY m.machine_id ASC`, [
    lineId,
  ]);
  return rows;
}

async function plantExists(plantId) {
  const { rows } = await query('SELECT 1 FROM plants WHERE plant_id = $1', [plantId]);
  return rows.length > 0;
}

async function lineExists(lineId) {
  const { rows } = await query('SELECT 1 FROM production_lines WHERE line_id = $1', [lineId]);
  return rows.length > 0;
}

module.exports = {
  findMachineById,
  listMachinesByPlant,
  listMachinesByLine,
  plantExists,
  lineExists,
};
