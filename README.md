# aurik-tech — Industrial Equipment Monitoring Backend

> **Status: Phase 5 (canonical normalization + operational attention view) complete.**
> Vendor adapters (PulseForge, ThermexWatch, MaintaFlow), the canonical event model, reference
> data loading, and the machine operational view are implemented on top of the Phase 3 ingestion
> pipeline and the Phase 4 reliable worker.
> See `docs/ARCHITECTURE_PROPOSED.md`, `docs/ASSUMPTIONS_REGISTER.md`, and `docs/DESIGN_NOTES.md`.

## Prerequisites

- Node.js 20+ and npm 10+
- PostgreSQL 16+ (local, or via Docker Compose)
- Docker + Docker Compose (optional; requires a working container engine)

## Environment configuration

```bash
cp .env.example .env
# then edit .env as needed
```

`.env` is git-ignored — never commit it. `.env.example` contains placeholders only.
Configuration is validated with Zod at startup (`src/config/index.js`); the process
exits with a clear message if a required variable (e.g. `DATABASE_URL`) is missing or invalid.

## Install dependencies

```bash
npm ci
```

## Apply migrations

```bash
npm run migrate          # apply pending migrations
npm run migrate:status   # show applied/pending state
```

Migrations are numbered SQL files under `db/migrations/`. Applied versions are recorded in
`schema_migrations` (with a checksum) so re-runs are safe, and an advisory lock serialises
concurrent runners. Never edit an applied migration — add a new numbered file.

## Seed reference data

```bash
npm run seed              # reference data (plants/lines/machines) + work orders
npm run seed:events       # also ingest the seed vendor CSVs through the real pipeline
```

`npm run seed` idempotently loads reference data (`asset_reference.csv`,
`line_reference.csv`) and maintenance work orders (`seed_data/maintenance_work_orders.csv`).
`npm run seed:events` additionally accepts the three vendor seed CSVs as submissions and
processes them through the **same** ingestion + worker pipeline used in production (no
bespoke import path). Re-running either is safe.

The asset directory is configured via `ASSETS_DIR` (default:
`Aurik_Tech_Lead_Assessment_Assets/Aurik_Tech_Lead_Assessment_Assets`).

## Run the API

```bash
npm run start            # node src/server.js
npm run dev              # node --watch (development)
```

Endpoints:

| Endpoint   | Purpose                          | Notes                      |
|------------|----------------------------------|----------------------------|
| `GET /health` | Liveness                      | No DB check                |
| `GET /ready`  | Readiness                      | Real DB check; 503 if down |
| `POST /api/v1/ingestion/:vendor/submissions` | Accept a submission | `201` new, `200` replay, `409` key reuse |
| `GET /api/v1/ingestion/submissions/:submissionId` | Ingestion/processing status | `404` if unknown |
| `GET /api/v1/machines/:machineId/status` | Machine operational attention view | `404` if unknown machine |
| `GET /api/v1/plants/:plantId/summary` | Plant roll-up (status counts, critical machines, per-line attention) | `404` if unknown plant |
| `GET /api/v1/lines/:lineId/summary` | Line roll-up | `404` if unknown line |

See **Ingestion API (Phase 3)** and **Operational view (Phase 5)** below; the machine
response shape matches the assessment's expected fields (`derived_status`, `attention_level`,
`reason_codes`, `latest_relevant_event_time`, `processing_status`, `source_event_refs`,
`last_processed_at`). A machine whose latest evidence is older than
`NORMALIZATION_STALE_WINDOW_MS` is reported `stale`; a machine with no evidence is `unknown`
— neither is ever reported `ok`.

The full request/response contract (all paths, envelopes, enums, and errors) is in
[`openapi/openapi.yaml`](openapi/openapi.yaml).

## Ingestion API (Phase 3)

A **generic, vendor-agnostic** ingestion layer. It validates and durably records submissions
and enqueues one processing job per submission. It does not itself interpret vendor payloads:
that is the job of the Phase 5 normalization worker (see **Normalization & operational view**
below), which consumes the persisted payload.

### Request envelope

The envelope stays deliberately vendor-neutral: it carries only what the ingestion layer needs.
The (now-implemented) vendor adapters unwrap their own slice of `payload`:

```json
{
  "submissionId": "optional-idempotency-key",
  "source": { "any": "free-form metadata" },
  "payload": { "opaque": "vendor data, object or array, stored verbatim" }
}
```

Unknown top-level keys are rejected. The full envelope is stored as `raw_payload` (jsonb)
for traceability and future reprocessing.

### Idempotency contract

A submission is identified by the pair **(vendor, idempotency key)** — a UNIQUE database
constraint.

1. The key comes from the `Idempotency-Key` header if present, otherwise from the body's `submissionId`. If neither is present → `400 IDEMPOTENCY_KEY_REQUIRED`.
2. Replaying the same key with an **equal** payload (key-order-insensitive) resolves to the existing submission → `200` with `idempotentReplay: true`, and creates no new rows.
3. Reusing the same key with a **different** payload → `409 IDEMPOTENCY_KEY_REUSED`, and writes nothing.

This is **at-least-once ingestion with idempotent effects**; it does not claim exactly-once
processing. Equality is checked via a SHA-256 hash of the canonicalised payload.

### Authentication

Vendor-scoped API keys, off by default for local development:

| Variable | Meaning |
|----------|---------|
| `INGESTION_AUTH_REQUIRED` | `true` to require a key on `POST` (default `false`). If `true`, at least one key must be configured or startup fails. |
| `INGESTION_API_KEYS` | Comma-separated `vendor:key` entries, e.g. `acme:key-a,globex:key-b`. Never commit real keys. |

Send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`. Failures return a
generic `401` that cannot be used to distinguish "unknown vendor" from "wrong key"
(constant-time comparison).

### Ingestion-layer boundaries

The ingestion layer stays free of domain logic. The following deliberately live elsewhere:

- Vendor adapters, the canonical event model, reference-data loading, and operational rules live
  in Phase 5 (see **Normalization & operational view** below).
- Each submission's job is created transactionally with the submission; execution is handled
  by the worker (see below).
- `GET .../submissions/:id` is intentionally unauthenticated and returns metadata only (never
  payload contents).

## Job queue & worker (Phase 4)

The worker reliably executes jobs from the existing `processing_jobs` table. The queue mechanics
(claiming, leases, retries, dead-lettering) are complete and independent of business logic;
job-specific behavior lives in registered handlers. The registered `normalize_submission`
handler (Phase 5) runs the real normalization pipeline (see below).

### Job lifecycle (state machine)

```
pending ──claim──▶ processing ──success──▶ succeeded          (terminal)
   ▲                   │
   │                   ├──retryable fail──▶ retrying ──due──▶ processing ...
   │                   │                       └── exhausted / permanent ──▶ dead_letter (terminal)
   │                   └──blocked (cannot proceed) ──▶ blocked
   └── lease expired, reclaimed ────────────────────────────┘
```

- `pending` — ready to be claimed now (`available_at <= now`).
- `processing` — claimed by a worker; `locked_by`/`locked_at` hold the lease.
- `retrying` — an attempt failed; the next attempt is scheduled at `available_at`.
- `succeeded` / `dead_letter` — terminal success / terminal failure.
- `blocked` — domain processing cannot proceed. Observable and
  deliberately distinct from success and failure.
- `failed` / `cancelled` — reserved, not currently emitted.

`attempts` is incremented at **claim** time, so a crashed attempt still counts.

### Claiming, leases, and recovery

- Claims use `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, so concurrent
  workers never own the same job. Under contention a poll may return fewer than
  `WORKER_BATCH_SIZE`; the remainder is claimed on the next poll (nothing is lost).
- The claim runs in a short transaction that also sets the submission to `processing`.
- `WORKER_LEASE_MS` bounds how long a claim is trusted. A job still `processing` with an
  expired lease is reclaimed (bounded, `FOR UPDATE SKIP LOCKED`) as `retrying` (or
  `dead_letter` if attempts are already exhausted).
- Every transition is ownership-guarded (`locked_by = this worker AND status = 'processing'`).
  A stale worker whose lease was reclaimed updates zero rows and its result is discarded —
  it can never overwrite the new owner's work.

### Retry & failure semantics

- Retryable failures are scheduled with **exponential backoff**: `base * 2^(attempt-1)`,
  capped at `WORKER_BACKOFF_MAX_MS` (pure function in `src/modules/processing/backoff.js`).
- Permanent failures (e.g. `permanentError`, validation) dead-letter immediately.
- When `attempts >= max_attempts`, the job dead-letters (`error_category = retries_exhausted`).
- Stored errors are sanitized: message only, length-capped; never payloads or stack traces.
- Delivery is **at-least-once**, never exactly-once; handlers must be idempotent.

### Submission status consistency

With one job per submission, `ingestion_submissions.processing_status` is a direct
projection of the job status, applied in the same transaction as every transition
(`src/modules/processing/status.js`). A submission is only ever `succeeded` when its
handler genuinely reported success.

### `normalize_submission` handler (Phase 5)

`src/modules/processing/handlers/normalizeSubmission.js` loads the persisted submission and
delegates to the normalization service. It reports `succeeded` only when the batch contract is
fulfilled (payload parsed, every record accepted or recorded as a failure, state recomputed).
Unrecoverable submission-level problems (unknown vendor, malformed batch) throw a permanent
error and dead-letter; transient DB/infra errors are retried. Re-execution is idempotent
(content-fingerprint dedupe + upsert-by-key failure ledger), so an at-least-once redelivery
converges to the same result.

### Worker configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKER_ID` | host+pid+nonce | Unique worker identity (lease owner). |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Delay between poll cycles. |
| `WORKER_BATCH_SIZE` | `10` | Max jobs claimed per cycle. |
| `WORKER_RECOVERY_BATCH_SIZE` | `10` | Max expired leases reclaimed per cycle. |
| `WORKER_MAX_ATTEMPTS` | `5` | Default `max_attempts` for newly enqueued jobs. |
| `WORKER_LEASE_MS` | `60000` | Claim/lease duration before a job is recoverable. |
| `WORKER_BACKOFF_BASE_MS` | `1000` | Base retry delay. |
| `WORKER_BACKOFF_MAX_MS` | `60000` | Retry delay cap (must be ≥ base). |

Shutdown stops new claims and waits for in-flight work up to `SHUTDOWN_TIMEOUT_MS`.

## Run the worker

```bash
npm run start:worker     # node src/worker/index.js
npm run dev:worker       # node --watch
```

The worker connects to PostgreSQL, reclaims expired leases, then polls for due jobs and
executes them. The registered `normalize_submission` handler normalizes each submission into
canonical events, writes per-record failures, and recomputes the derived machine state.

## Normalization & operational view (Phase 5)

### Vendor adapters

Each vendor has a dedicated, deterministic, unit-testable adapter under
`src/modules/normalization/adapters/`. Adapters map a vendor payload into the canonical model;
they are selected by the **validated** vendor slug.

| Vendor | Input shape | Units / specifics |
|--------|-------------|-------------------|
| `pulseforge` | `{ vendor, plant_id, events[] }`, `event_time` ISO-8601 UTC | `event_type` + `severity` mapped; `vibration_mm_s`, `temperature_c` |
| `thermexwatch` | `{ source, site_code, readings[] }`, `timestampMs` epoch ms | Fahrenheit → Celsius; vibration **preserved as `vibration_g`** (never converted to mm/s); `level` 1–5 → severity; bare line `"A"` → `LINE-A` |
| `maintaflow` | `{ provider_name, records[] }`, `recorded_at` `"YYYY/MM/DD HH:mm:ss"` | zone-less timestamps interpreted as **UTC** (documented assumption); maintenance semantics |

An adapter unwraps its own slice when given a combined `{ pulseforge, thermexwatch, maintaflow }`
payload.

### Canonical model & dedup

Accepted records become rows in `canonical_events`. Rejected/warned records are recorded in
`normalization_failures` with a stable reason code, the offending raw record, and its index —
raw payloads are never lost. Dedup uses a deterministic **content fingerprint** (`dedupe_key`,
UNIQUE) plus `UNIQUE(vendor, vendor_event_id)`; a replayed record collapses even if the vendor
mutated its id (e.g. `TW-8801` vs `TW-8801-R`). Invalid measurements and unsupported enums are
**rejected**, never silently coerced; recoverable field problems (e.g. an unknown line) are
recorded as warnings and the machine's authoritative line is used.

### Derived machine state

`machine_state` is recomputed deterministically from a machine's canonical events (plus its work
orders) whenever affected records are processed. Key rules (details in `docs/DESIGN_NOTES.md`):

- A critical condition is **not** cleared by a later generic recovery signal; it clears only on a
  later same-category event below critical, or a documented maintenance resolution.
- Recovery clears warnings and yields `recovering`; missing/stale evidence yields `unknown`/`stale`
  and is never `ok`.

### Operational configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `NORMALIZATION_STALE_WINDOW_MS` | `86400000` (24h) | Age after which a machine's evidence is `stale`. **Assumption** — not from Aurik. |
| `ASSETS_DIR` | `Aurik_Tech_Lead_Assessment_Assets/Aurik_Tech_Lead_Assessment_Assets` | Location of the assessment CSVs for seeding. |

## Run tests

```bash
npm test                 # full suite (DB tests skip if TEST_DATABASE_URL is unset)
TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname npm test   # include DB integration
```

- Unit + non-DB integration tests always run (they do not require PostgreSQL).
- DB-backed suites (`ready`, `migrate`, `tx`, `ingestion`, `worker`, `normalizationPipeline`)
  run only when `TEST_DATABASE_URL` is set, so the suite never claims DB verification it did not
  perform.
- When `TEST_DATABASE_URL` is set, a Jest `globalSetup` applies migrations to that database first.
- `tests/unit/{time,units,csv,machineState,adapters}.test.js` cover the normalization core and
  adapters against the real asset fixtures; `tests/integration/normalizationPipeline.test.js`
  covers the full ingest → worker → canonical → derived-state → read-API flow against PostgreSQL.

## Docker Compose

```bash
docker compose config     # validate configuration (no daemon required)
docker compose up --build # postgres + migrate + api + worker
```

`docker compose up` starts PostgreSQL (with a health check and persistent named volume),
runs a one-shot `migrate` service, then starts `api` and `worker` after the DB is healthy.

> **Local limitation on this machine:** the container engine could not be started because
> WSL2 is not installed, so `docker build`/`docker compose up` could not be executed here.
> `docker compose config` validates successfully.

## Useful commands

```bash
npm start                # API
npm run start:worker     # worker
npm run migrate          # migrations
npm test                 # tests
npm run test:unit        # unit only
npm run test:integration # integration only
```
