'use strict';

const { query } = require('../../db/pool');

/**
 * Reference-data persistence and the in-memory context the normalizer uses to
 * resolve machines/lines. Reference data is small and static; the normalizer
 * loads it once per submission.
 */

const MACHINE_COLUMNS = `
  machine_id, plant_id, line_id, machine_type, criticality,
  installed_date, rated_max_temp_c, rated_max_vibration_mm_s,
  baseline_power_kw, asset_status
`;

/**
 * Load the reference context. `queryFn` is injectable so the normalizer can
 * reuse it inside a transaction or against the pool.
 */
async function loadContext(queryFn = query) {
  const [machinesResult, linesResult, plantsResult] = await Promise.all([
    queryFn(`SELECT ${MACHINE_COLUMNS} FROM machines`),
    queryFn('SELECT line_id, plant_id FROM production_lines'),
    queryFn('SELECT plant_id FROM plants'),
  ]);

  const machines = new Map();
  for (const row of machinesResult.rows) machines.set(row.machine_id, row);

  const lines = new Map();
  for (const row of linesResult.rows) lines.set(row.line_id, row);

  const plants = new Set(plantsResult.rows.map((row) => row.plant_id));

  return { machines, lines, plants };
}

async function upsertPlants(client, plantIds) {
  for (const plantId of plantIds) {
    await client.query(
      `INSERT INTO plants (plant_id)
       VALUES ($1)
       ON CONFLICT (plant_id) DO NOTHING`,
      [plantId]
    );
  }
}

async function upsertLines(client, lines) {
  for (const line of lines) {
    await client.query(
      `INSERT INTO production_lines (line_id, plant_id, line_name, operating_window)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (line_id) DO UPDATE
         SET plant_id = EXCLUDED.plant_id,
             line_name = EXCLUDED.line_name,
             operating_window = EXCLUDED.operating_window`,
      [line.line_id, line.plant_id, line.line_name, line.operating_window]
    );
  }
}

async function upsertMachines(client, machines) {
  for (const m of machines) {
    await client.query(
      `INSERT INTO machines (machine_id, plant_id, line_id, machine_type, criticality,
                             installed_date, rated_max_temp_c, rated_max_vibration_mm_s,
                             baseline_power_kw, asset_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (machine_id) DO UPDATE
         SET plant_id = EXCLUDED.plant_id,
             line_id = EXCLUDED.line_id,
             machine_type = EXCLUDED.machine_type,
             criticality = EXCLUDED.criticality,
             installed_date = EXCLUDED.installed_date,
             rated_max_temp_c = EXCLUDED.rated_max_temp_c,
             rated_max_vibration_mm_s = EXCLUDED.rated_max_vibration_mm_s,
             baseline_power_kw = EXCLUDED.baseline_power_kw,
             asset_status = EXCLUDED.asset_status`,
      [
        m.machine_id,
        m.plant_id,
        m.line_id,
        m.machine_type,
        m.criticality,
        m.installed_date,
        m.rated_max_temp_c,
        m.rated_max_vibration_mm_s,
        m.baseline_power_kw,
        m.asset_status,
      ]
    );
  }
}

async function upsertWorkOrders(client, workOrders) {
  for (const wo of workOrders) {
    await client.query(
      `INSERT INTO maintenance_work_orders
         (work_order_id, plant_id, machine_id, line_id, opened_at, closed_at,
          maintenance_type, trigger_source, status, downtime_minutes,
          post_maintenance_check, notes, source_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (work_order_id) DO UPDATE
         SET plant_id = EXCLUDED.plant_id,
             machine_id = EXCLUDED.machine_id,
             line_id = EXCLUDED.line_id,
             opened_at = EXCLUDED.opened_at,
             closed_at = EXCLUDED.closed_at,
             maintenance_type = EXCLUDED.maintenance_type,
             trigger_source = EXCLUDED.trigger_source,
             status = EXCLUDED.status,
             downtime_minutes = EXCLUDED.downtime_minutes,
             post_maintenance_check = EXCLUDED.post_maintenance_check,
             notes = EXCLUDED.notes,
             source_file = EXCLUDED.source_file`,
      [
        wo.work_order_id,
        wo.plant_id,
        wo.machine_id,
        wo.line_id,
        wo.opened_at,
        wo.closed_at,
        wo.maintenance_type,
        wo.trigger_source,
        wo.status,
        wo.downtime_minutes,
        wo.post_maintenance_check,
        wo.notes,
        wo.source_file,
      ]
    );
  }
}

/** Work orders relevant to deriving machine state (open, or resolved+passed). */
async function loadWorkOrdersForMachine(queryFn, machineId) {
  const { rows } = await queryFn(
    `SELECT work_order_id, machine_id, status, opened_at, closed_at,
            post_maintenance_check
       FROM maintenance_work_orders
      WHERE machine_id = $1`,
    [machineId]
  );
  return rows;
}

async function countMachines() {
  const { rows } = await query('SELECT count(*)::int AS n FROM machines');
  return rows[0].n;
}

module.exports = {
  MACHINE_COLUMNS,
  loadContext,
  upsertPlants,
  upsertLines,
  upsertMachines,
  upsertWorkOrders,
  loadWorkOrdersForMachine,
  countMachines,
};
