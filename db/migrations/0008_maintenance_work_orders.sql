-- 0008_maintenance_work_orders.sql
--
-- Maintenance work orders from seed_data/maintenance_work_orders.csv.
--
-- Scope note: work orders are included ONLY where they contribute to the machine
-- operational view or its explainability:
--   * an OPEN work order is a reason a machine needs attention;
--   * a CLOSED work order whose post_maintenance_check = 'passed' is a documented
--     resolution timestamp for prior conditions on that machine.
-- They are reference/seed data (no vendor), loaded idempotently by scripts/seed.js.
--
-- Idempotent (IF NOT EXISTS). Additive only.

CREATE TABLE IF NOT EXISTS maintenance_work_orders (
  work_order_id         text PRIMARY KEY CHECK (work_order_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  plant_id              text NOT NULL,
  machine_id            text NOT NULL REFERENCES machines(machine_id) ON DELETE RESTRICT,
  line_id               text,
  opened_at             timestamptz NOT NULL,
  closed_at             timestamptz,
  maintenance_type      text,
  trigger_source        text,
  status                text NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  downtime_minutes      integer CHECK (downtime_minutes IS NULL OR downtime_minutes >= 0),
  post_maintenance_check text,
  notes                 text,
  source_file           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_machine ON maintenance_work_orders (machine_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON maintenance_work_orders (status);

DROP TRIGGER IF EXISTS trg_work_orders_updated_at ON maintenance_work_orders;
CREATE TRIGGER trg_work_orders_updated_at
  BEFORE UPDATE ON maintenance_work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
