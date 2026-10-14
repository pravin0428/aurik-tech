# Architecture

> **STATUS: Phases 0–5 implemented.** This document began as the Phase 1 planning artifact
> (no assets available) and is retained for design rationale. The assessment assets are now
> present and the domain sections have been implemented — see **§11 As implemented (Phase 5)**
> for the actual schema/endpoints and `docs/DESIGN_NOTES.md` for the rule details. Sections
> below that say `[BLOCKED — awaiting assets]` reflect the planning-time state; the current
> status supersedes them.

---

## 1. Context

Phase 0 inspection found the repository empty (`.git` only, "No commits yet") and the configured
remote (`https://github.com/pravin0428/aurik-tech.git`) with no refs. None of the required assets
were present on disk:

- `README_FOR_ASSESSMENT_ASSETS.md`
- `expected_output_context.md`
- `event_type_reference.md`
- `asset_reference.csv`
- `line_reference.csv`
- `vendor_api_samples/` (JSON)
- `seed_data/` (CSV)

The candidate brief is available and is sufficient to build generic, domain-agnostic infrastructure.
It is **not** sufficient to design vendor adapters, the canonical schema, entity resolution, or the
operational attention rules without fabricating domain data.

## 2. Requirements categorization

### Category 1 — Safe from the brief alone (implementable now)
- Project scaffolding, `package.json`, CommonJS, Node version pinning.
- Environment configuration via `dotenv` + fail-fast validation.
- Structured logging (pino) with request/correlation IDs and redaction.
- Centralized error handling + error taxonomy (api / validation / normalization / db / processing).
- Express app factory, request-ID middleware, 404 + error middleware.
- `GET /health` (liveness) and `GET /ready` (DB-availability readiness).
- PostgreSQL connection pool (`pg`), transaction helper, and a **migration tooling runner**
  (numbered SQL files + `schema_migrations` table).
- Docker Compose for `postgres`, `api`, `worker`; Dockerfile(s); `wait-for-db` script.
- `.env.example`, `.gitignore`, `.dockerignore`.
- Jest + Supertest harness, test DB setup/teardown helpers, deterministic fixture conventions.
- Worker process **entry skeleton** (config, logging, DB, graceful shutdown) — no domain handlers.
- OpenAPI serving mechanism with only `/health` + `/ready` documented initially.

### Category 2 — Requires the missing assets `[BLOCKED]`
- Vendor adapters and exact vendor field mappings (needs `vendor_api_samples/*.json`).
- Canonical schema finalization (needs samples + `event_type_reference.md`).
- Event-type / severity enum mappings (needs `event_type_reference.md`).
- Unit normalization and conversion rules (needs samples + any reference).
- `plants` / `production_lines` / `machines` tables and FK relationships
  (needs `asset_reference.csv`, `line_reference.csv`).
- Machine identity resolution rules (needs reference data).
- Reference/seed data loader (needs `seed_data/*.csv`).
- Ingestion request schemas, idempotency keys, dedup identifiers (needs vendor event IDs).
- Operational attention rules, reason codes, plant/line aggregation (needs
  `expected_output_context.md` + `event_type_reference.md`).
- Final API response field names and full OpenAPI examples.

### Category 3 — Requires explicit assumptions + your approval
- Whether an invalid record rejects the whole batch or is accepted/rejected per-record.
- Attention thresholds and severity precedence when signals conflict (if not in the docs).
- Definition of "stale" data (time window) for the operational view.
- Fallback dedup fingerprint when no reliable vendor event ID exists.
- Timestamp timezone handling when missing/ambiguous.
- Late/out-of-order conflict resolution policy (source version vs timestamp).
- Scope of unit conversion.
- Vendor ingestion authentication mechanism (API key vs basic auth) and credential source.
- Retry bounds and backoff values.

All Category 3 items are tracked in `ASSUMPTIONS_REGISTER.md`.

## 3. Revised phase plan

| Phase | Scope | Status |
|------|-------|--------|
| 0 | Repo & asset inspection | **Done (blocked on assets for domain parts)** |
| 1 | Architecture docs, assumptions register, plan | **This deliverable** |
| 2 | Foundation: scaffolding, config, logging, errors, health/ready, DB pool, migration tooling, Docker Compose, test harness | Category 1 — safe now |
| 3 | Ingestion **framework** (routes, validation plumbing, raw payload persistence, transactional batch+job creation, idempotency framework, auth middleware, adapter **interfaces** + vendor registry with no real adapters) | Category 1 (framework) / partly approval-gated |
| 4 | PostgreSQL-backed **job queue framework** (claiming via `FOR UPDATE SKIP LOCKED`, retries/backoff, stale-lock recovery, dead-letter, attempt tracking, graceful shutdown) — handlers registered but no domain logic | **Done** |
| 5 | Canonical schema, vendor adapters, normalization, reference loading, entity resolution | **Done** |
| 6 | Operational attention view + plant/line summaries | **Done** |
| 7 | Domain tests/fixtures (valid ingestion, dupes, resolution, out-of-order, retries, attention rules, summaries) | **Done** |
| 8 | OpenAPI full spec, README domain sections, design notes | **Done** |
| 9 | Final clean-environment verification & submission review | — |

Phases 3–4 are framework-only and are proposed for your approval; they are designed behind interfaces
so that real vendor/domain code drops in at Phase 5 without rework (see §7). If you prefer to defer
all business-adjacent work until assets arrive, Phase 2 alone is fully self-contained.

## 4. Proposed folder structure

> **Historical planning artifact.** This tree was written *before* implementation and is kept for
> provenance. It is **indicative, not an inventory of the current repo** — some listed files were
> never created (`scripts/wait-for-db.js`, `errors/taxonomy.js`, `middleware/rawBody.js`,
> `middleware/auth.js`, `middleware/notFound.js`, `modules/operational/`, `modules/ingestion/adapters/`)
> and others were added beyond this sketch. For the actual layout, read the repository itself.

```
aurik-tech/
├─ .env.example
├─ .gitignore
├─ .dockerignore
├─ package.json
├─ jest.config.js
├─ docker-compose.yml
├─ Dockerfile
├─ docs/
│  ├─ ARCHITECTURE_PROPOSED.md        (this file)
│  ├─ ASSUMPTIONS_REGISTER.md
│  ├─ DESIGN_NOTES.md                 (Phase 8)
│  └─ AI_USAGE_DISCLOSURE.md          (Phase 8)
├─ openapi/
│  └─ openapi.yaml
├─ db/
│  ├─ migrations/
│  │  ├─ 0001_infrastructure.sql      (schema_migrations; queue envelope if approved)
│  │  └─ (domain migrations added later — additive, numbered)
│  └─ seed/                           [BLOCKED — needs CSVs]
├─ scripts/
│  ├─ migrate.js
│  ├─ seed.js                         (stub until CSVs)
│  └─ wait-for-db.js
├─ src/
│  ├─ config/index.js
│  ├─ logger/index.js
│  ├─ errors/{AppError.js,taxonomy.js}
│  ├─ db/{pool.js,tx.js}
│  ├─ middleware/{requestId.js,errorHandler.js,notFound.js,rawBody.js,auth.js}
│  ├─ routes/{index.js,health.routes.js}
│  ├─ modules/                        (domain slots — populated in Phase 5+)
│  │  ├─ ingestion/{adapters/,adapterRegistry.js,batchService.js}
│  │  ├─ normalization/
│  │  └─ operational/
│  ├─ worker/index.js                 (entry skeleton; handlers registered later)
│  ├─ app.js
│  └─ server.js
└─ tests/
   ├─ setup/{globalSetup.js,db.js}
   ├─ unit/
   └─ integration/
```

## 5. Candidate canonical schema (PROVISIONAL) `[BLOCKED — awaiting assets]`

To be finalized only against real samples. Candidate shape, so the infra seams line up:

- `plants`, `production_lines`, `machines` — reference data (populated from CSVs, never invented).
- `machine_identifiers(machine_id, vendor, vendor_machine_key)` UNIQUE `(vendor, vendor_machine_key)`
  — identity resolution seam.
- `ingestion_batches(batch_id, vendor, received_at, status, accepted, rejected, correlation_id)`.
- `raw_payloads(payload_id, batch_id, vendor, raw jsonb, checksum, received_at, vendor_event_id NULL)`.
- `canonical_events(event_id, payload_id, machine_id, event_type, severity, occurred_at timestamptz,
  unit info, attributes jsonb, source_version, dedupe_key UNIQUE)`.
- `processing_jobs(job_id, payload_id, job_type, status, attempts, max_attempts, available_at,
  locked_by, locked_at, last_error, error_category)`.
- `job_attempts(attempt_id, job_id, attempt_no, started_at, finished_at, error_category, message)`.
- `machine_state(machine_id, derived_status, needs_attention, severity, reason_codes jsonb,
  last_event_at, evaluated_at, source_max_event_time)` — materialized derived view.

`event_type`, `severity`, and unit enums are **not defined here** — they come from the assets.

## 6. Candidate API contract (PROVISIONAL)

- `POST /api/v1/ingest/{vendor}` — vendor ingestion (adapters added Phase 5).
- `GET  /api/v1/ingest/batches/{batchId}` — processing status.
- `GET  /api/v1/machines/{machineId}/status` — operational attention view.
- `GET  /api/v1/plants/{plantId}/summary` — plant summary.
- `GET  /api/v1/lines/{lineId}/summary` — line summary.
- `GET  /health`, `GET /ready`.
- `GET  /docs` — OpenAPI UI/spec.

Final paths, params, and field names will reflect the inspected assets (Phase 8).

## 7. Async processing strategy (framework design)

- Ingestion persists `raw_payload` **and** its `processing_job` in a single transaction before ack —
  no raw-commit-with-lost-job race.
- Worker claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers cannot claim the
  same job.
- **At-least-once** execution with **idempotent effects** (unique dedupe key + job state guard).
  Exactly-once is not claimed.
- Explicit states: `pending → processing → succeeded | partially_failed | failed | dead_letter`.
- Retryable vs permanent error classification; bounded retries with exponential backoff;
  attempt counts and error messages recorded; crashed-worker jobs recovered via stale `locked_at`.
- Never retry invalid records indefinitely; terminal failures land in dead-letter and stay observable.

## 8. How real assets drop in later without rewrites

1. **Adapters behind an interface**: `normalize(rawPayload) -> { events[], warnings[], errors[] }`.
   A `adapterRegistry` maps `vendor -> adapter`. Adding a vendor = one new file + one registry line;
   no changes to ingestion/queue/business code.
2. **Additive migrations**: numbered SQL files. Domain tables are *new* migration files; infra
   migrations (`0001`) are never edited.
3. **Declarative seed loader**: a generic CSV loader driven by a small mapping config. When CSVs land,
   only the mapping config + target migration are added.
4. **Canonical events carry `jsonb` `attributes`** for vendor-specific extras, so unknown fields are
   preserved rather than forcing schema churn.
5. **Rules as pure functions in a registry** with reason-code constants. Real thresholds swap config
   values, not structure.
6. **OpenAPI is assembled** from infra paths first; domain paths appended in Phase 8.

## 9. Highest-risk cases (to test once assets exist)

- Duplicate vendor events producing duplicate canonical effects.
- Job retried after partial failure (idempotency).
- Two workers claiming the same job.
- Late/out-of-order event overwriting newer machine state.
- Unknown machine / unresolvable identity.
- Malformed records inside an otherwise valid batch.
- Timestamp ambiguity/timezone and unit ambiguity.
- Conflicting signals in the operational view (precedence).

## 10. Explicit non-goals / non-claims

- No AI/ML, no invented industrial safety thresholds.
- No Redis/Kafka/K8s/cloud/microservices/external paid services.
- No claim of exactly-once processing; delivery is at-least-once + idempotent effects.
- No monitoring/alerting/production-infra claims beyond a health/readiness endpoint.

---

## 11. As implemented (Phase 5)

### 11.1 Database (migrations 0001–0008)

| Table | Migration | Purpose |
|-------|-----------|---------|
| `schema_migrations` | 0001 | applied-migration ledger (checksum-guarded) |
| `ingestion_submissions`, `processing_jobs` | 0002–0003 | ingestion + queue (Phases 3–4) |
| `plants`, `production_lines`, `machines` | 0004 | reference data (from `asset_reference.csv`, `line_reference.csv`) |
| `canonical_events` | 0005 | normalized events; `dedupe_key` UNIQUE + partial `UNIQUE(vendor, vendor_event_id)` |
| `normalization_failures` | 0006 | per-record reject/warn ledger; UNIQUE `(submission, record index, code)` |
| `machine_state` | 0007 | derived operational projection (one row per machine) |
| `maintenance_work_orders` | 0008 | open WO → attention; closed+passed → documented resolution |

`canonical_events` keeps vendor-specific data in `attributes` jsonb and the original unit form in
`unit_metadata`; the columns the operational view depends on are explicit
(`temperature_c`, `vibration_mm_s`, `vibration_g`, `power_kw`, `sensor_health`, `signal_quality`,
`is_active`, `canonical_event_type`, `severity`, `occurred_at`). ThermexWatch vibration is stored as
`vibration_g` and is **never** converted to mm/s.

### 11.2 Reconciliation with the planning schema (§5)

The earlier candidate names were refined to the concrete, tested schema above:

- `ingestion_batches` → the submission is the batch (`ingestion_submissions.raw_payload`); one
  `processing_job` per submission. No separate batch table was needed.
- `raw_payloads(payload_id, ...)` → folded into `ingestion_submissions` (the raw envelope is stored
  verbatim; per-record raw values are preserved in `canonical_events.attributes` and
  `normalization_failures.raw_event`).
- `job_attempts` → attempt count + sanitized `last_error`/`error_category` live on `processing_jobs`
  (sufficient for the assessment; a separate attempts table would be added if per-attempt history
  were required).
- `machine_identifiers` → not needed: vendor records carry the canonical `machine_id` directly
  (identity resolution reduced to reference-data validation + line-code normalization).
- `machine_state` → as implemented, with `attention_level`, `reason_codes`, `source_event_refs`,
  `processing_status`, `last_processed_at`.

### 11.3 API (as implemented)

- `POST /api/v1/ingestion/:vendor/submissions` — accept (201/200/409).
- `GET  /api/v1/ingestion/submissions/:submissionId` — ingestion + processing status.
- `GET  /api/v1/machines/:machineId/status` — operational attention view.
- `GET  /api/v1/plants/:plantId/summary` — plant roll-up.
- `GET  /api/v1/lines/:lineId/summary` — line roll-up.
- `GET /health`, `GET /ready`.

Full request/response shapes: `openapi/openapi.yaml`.

### 11.4 Module layout (as implemented)

- `src/modules/normalization/` — `time`, `units`, `fingerprint`, `machineState`, `adapterSupport`,
  `errors`, `constants`, `normalization.repository`, `normalization.service`, `adapters/*`.
- `src/modules/reference/` — `reference.repository`, `reference.loader` (CSV import).
- `src/modules/operations/` — `operations.{repository,service,schemas,routes}`.
- `src/util/csv.js` — dependency-free RFC 4180 CSV parser.
- `src/modules/processing/handlers/normalizeSubmission.js` — real handler (replaced the Phase 4
  placeholder).
