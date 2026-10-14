# Assumptions Register

> **STATUS: Phase 5 complete.** The assessment assets were inspected and the Phase 5 decisions
> (A–H) were approved before implementation. Domain values are taken from the assets, not invented.
> Anything still assumed rather than sourced from Aurik is explicitly labelled **ASSUMPTION** and
> listed below.

Legend — Status: `RESOLVED` (implemented and tested) · `ASSUMPTION` (implemented on an explicit,
documented assumption that Aurik did not specify) · `PLANNED` · `BLOCKED`.

## Phase 1–4 items (now resolved)

| ID | Decision | Status | Resolution |
|----|----------|--------|------------|
| A01 | Vendor set comes from `vendor_api_samples/`. | RESOLVED | Three vendors: `pulseforge`, `thermexwatch`, `maintaflow`. |
| A02 | Vendor field names / record shapes come only from real samples. | RESOLVED | Encoded in `src/modules/normalization/adapters/*` + tests using fixture files. |
| A03 | Canonical `event_type`/`severity` enums derive from `event_type_reference.md`. | RESOLVED | `src/modules/normalization/constants.js`; vendor codes mapped, unknown → rejected. |
| A04 | Machine/plant/line identities come only from reference CSVs. | RESOLVED | `reference.loader.js` reads `asset_reference.csv`/`line_reference.csv`; plants derived from them. |
| A05 | Unit conversion only where supported. | RESOLVED | Fahrenheit→Celsius only. **`vibration_g` is preserved, never converted to mm/s.** |
| A06 | Attention rules / reason codes derive from the asset docs. | RESOLVED | Implemented in `machineState.js` + `constants.js`. |
| A07 | Plant/line summaries mirror machine-level rules. | RESOLVED | `operations.service.js`. |
| A08 | Per-record accept/reject vs whole-batch reject. | RESOLVED | **Per-record**: valid records persist; invalid ones are recorded in `normalization_failures` with a reason code and raw record. |
| A09 | Severity precedence when signals conflict. | RESOLVED | Critical never cleared by a later generic recovery; documented in `DESIGN_NOTES.md`. |
| A10 | "Stale data" window. | RESOLVED (ASSUMPTION) | `NORMALIZATION_STALE_WINDOW_MS`, default 24h. Aurik did not specify — see N01. |
| A11 | Fallback dedup fingerprint. | RESOLVED | Deterministic SHA-256 content fingerprint + `UNIQUE(vendor, vendor_event_id)`. |
| A12 | Missing/ambiguous timestamp timezone. | RESOLVED (ASSUMPTION) | MaintaFlow zone-less timestamps read as **UTC** — see N02. |
| A13 | Out-of-order conflict resolution. | RESOLVED | Order by event timestamp, then stable tie-breaker (id/dedupe key); processing order never decides. |
| A14 | Vendor auth mechanism. | RESOLVED | Vendor-scoped API keys via `X-API-Key`/Bearer (Phase 3). |
| A15 | Retry bounds + backoff. | RESOLVED | `WORKER_*` config (Phase 4). |
| A16 | Validation library. | RESOLVED | Zod. |
| A17 | Node runtime. | RESOLVED | Node 20 LTS. |
| A18 | Migration approach. | RESOLVED | Numbered SQL + `schema_migrations` checksum runner. |
| A19 | Queue semantics. | RESOLVED | PostgreSQL `FOR UPDATE SKIP LOCKED`; at-least-once + idempotent effects. |
| A20 | Data layer. | RESOLVED | `pg` pool, no ORM. |

## Phase 5 assumptions (explicit, documented)

| ID | Assumption | Rationale | Impact if wrong |
|----|-----------|-----------|-----------------|
| N01 | A machine's evidence is `stale` after `NORMALIZATION_STALE_WINDOW_MS` (default 24h), configurable. | Aurik does not define freshness; an explicit, tunable window is safer than hiding age. | Machines may be flagged stale earlier/later than intended; single config change fixes it. |
| N02 | MaintaFlow `recorded_at` (zone-less `"YYYY/MM/DD HH:mm:ss"`) is **UTC**. | All other vendors are UTC; no offset is provided. | Timestamps could be off by the plant offset; isolated to `time.parseMaintaflowLocal`. |
| N03 | ThermexWatch bare production-line letters (`"A"`) mean `LINE-<letter>`. | Reference data and evidence show `LINE-A`; `A` is the same line with a shortened code. | Line resolution for ThermexWatch; isolated to `normalizeLineId`. |
| N04 | Unknown-but-valid enum/field problems are **warnings** on accept; invalid measurements/enums are **rejected** with a reason code. | Avoids silent coercion while preserving maximal valid data. | Failure ledger volume; error taxonomy is centralized in `errors.js`. |
| N05 | Plant IDs are derived from validated reference rows (no plants metadata file exists). | Only `PLANT_01`/`PLANT_02` appear; no dedicated plants CSV. | Plant roll-ups; derived from `asset_reference.csv`. |

## Notes

- **No fabricated data policy:** machine IDs, plant/line records, event types, unit mappings, and
  industrial thresholds are taken from the assets and are **not** invented to make samples pass.
- Detailed normalization and state rules live in `docs/DESIGN_NOTES.md`.
- As-implemented schema/API are described in `docs/ARCHITECTURE_PROPOSED.md` and
  `openapi/openapi.yaml`.
