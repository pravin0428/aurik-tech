-- 0001_infrastructure.sql
--
-- Infrastructure-only migration.
--
-- The migration runner itself creates `schema_migrations`, so this file does
-- not touch domain data. It defines a single, domain-agnostic utility that
-- future tables can reuse: a trigger function that stamps `updated_at` on row
-- updates.
--
-- Deliberately excluded (added in a later, approved phase once the assessment
-- assets are available): machines, plants, production lines, vendor payloads,
-- canonical events, processing jobs, machine operational state.
--
-- Safe to run repeatedly: CREATE OR REPLACE and IF NOT EXISTS are idempotent,
-- and the migration runner additionally records each version exactly once.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
