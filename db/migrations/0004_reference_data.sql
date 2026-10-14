-- 0004_reference_data.sql
--
-- Reference data derived from the assessment assets:
--
--   asset_reference.csv  -> plants, production_lines, machines
--   line_reference.csv   -> production_lines
--
-- There is NO plants metadata file in the assets, so `plants` is intentionally
-- minimal: plant IDs are DERIVED from the validated reference data (distinct
-- plant_id values), not invented.
--
-- Values map directly to the CSVs:
--   machines.criticality  in {low, medium, high}
--   machines.asset_status in {active, maintenance}  (+ 'unknown' for forward safety)
--   production_lines.operating_window is free text (day_shift, 24x7, night_shift)
--
-- Idempotent (IF NOT EXISTS). Additive only: migrations 0001-0003 are untouched.

CREATE TABLE IF NOT EXISTS plants (
  plant_id   text PRIMARY KEY CHECK (plant_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_lines (
  line_id          text PRIMARY KEY CHECK (line_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  plant_id         text NOT NULL REFERENCES plants(plant_id) ON DELETE RESTRICT,
  line_name        text,
  operating_window text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_lines_plant
  ON production_lines (plant_id);

CREATE TABLE IF NOT EXISTS machines (
  machine_id              text PRIMARY KEY CHECK (machine_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  plant_id                text NOT NULL REFERENCES plants(plant_id) ON DELETE RESTRICT,
  line_id                 text NOT NULL REFERENCES production_lines(line_id) ON DELETE RESTRICT,
  machine_type            text,
  criticality             text NOT NULL CHECK (criticality IN ('low', 'medium', 'high')),
  installed_date          date,
  rated_max_temp_c        numeric(7, 2),
  rated_max_vibration_mm_s numeric(7, 3),
  baseline_power_kw       numeric(10, 3),
  asset_status            text NOT NULL CHECK (asset_status IN ('active', 'maintenance', 'unknown')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_machines_line ON machines (line_id);
CREATE INDEX IF NOT EXISTS idx_machines_plant ON machines (plant_id);

DROP TRIGGER IF EXISTS trg_plants_updated_at ON plants;
CREATE TRIGGER trg_plants_updated_at
  BEFORE UPDATE ON plants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_production_lines_updated_at ON production_lines;
CREATE TRIGGER trg_production_lines_updated_at
  BEFORE UPDATE ON production_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_machines_updated_at ON machines;
CREATE TRIGGER trg_machines_updated_at
  BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
