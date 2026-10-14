# Design Notes (Phase 5 — Normalization & Operational View)

This document explains **why** the normalization and operational-view rules work the way they
do, and maps each rule to the asset evidence or the approved assumption it came from. It is the
companion to `ASSUMPTIONS_REGISTER.md` (what was assumed) and `ARCHITECTURE_PROPOSED.md`
(where the code lives).

## 1. Pipeline overview

```
POST /ingestion/:vendor/submissions        (Phase 3)
        │  validate envelope, persist submission + enqueue one job
        ▼
processing_jobs (pending)                  (Phase 4)
        │  worker claims with FOR UPDATE SKIP LOCKED
        ▼
normalize_submission handler               (Phase 5)
        │  load submission.row_payload -> select adapter -> load reference context
        ▼
adapter.normalize(payload, context)        -> { items[], batchError }
        │  per record: { record | null, issues, vendorEventId, recordIndex }
        ▼
normalization.service.normalizeSubmission  (one transaction)
        ├─ canonical_events      (accepted records; dedupe on conflict)
        ├─ normalization_failures(rejected records + warnings)
        └─ machine_state         (recompute every affected machine)
```

The worker/handler contract is unchanged from Phase 4: **succeeded** only when the batch
contract is fulfilled; **permanent** errors (unknown vendor, malformed batch) dead-letter;
transient DB/infra errors retry with backoff.

## 2. Per-record validation policy

The approved decision is **per-record accept/reject**: one bad record must not lose a whole
batch. For every source record the adapter produces either:

- a canonical **record** (possibly with warnings), or
- one or more **issues** with a stable code.

Issue codes and their severity (`src/modules/normalization/errors.js`):

| Code | Severity | Meaning |
|------|----------|---------|
| `unsupported_vendor` | error | No adapter registered for the submission vendor (submission-level). |
| `unsupported_event_type` | error | Vendor event/alert/record type not in the mapping. |
| `unsupported_severity` | error | Severity token / level outside the supported set. |
| `missing_machine` | error | Record has no machine reference. |
| `unknown_machine` | error | Machine reference is not in validated reference data. |
| `unknown_line` | **warning** | Vendor line disagrees with the machine's authoritative line; machine line wins. |
| `invalid_timestamp` | error | Timestamp unparseable for that vendor's format. |
| `invalid_measurement` | error | Numeric measure outside the plausibility window. |
| `invalid_confidence` | **warning** | Confidence not a `[0,1]` ratio. |
| `invalid_sensor_health` | **warning** | Sensor health not a `[0,1]` ratio. |
| `invalid_signal_quality` | **warning** | Signal quality not `GOOD|FAIR|POOR`. |
| `non_object_record` | error | Array element is not an object. |

**No silent coercion.** An invalid measurement (e.g. the `-999` sentinel in `malformed.json`) or
an unknown enum is *rejected*, never clamped or guessed. Warnings are recorded in the ledger and
attached to the accepted event (`canonical_events.warnings`) so an accepted record with a data
quality caveat is still visible.

`normalization_failures` is unique on `(source_submission_id, source_record_index, error_code)`,
so **re-processing a submission is idempotent** — re-running the same batch cannot duplicate the
ledger. Rejected records keep their `raw_event` jsonb, so no source data is ever lost.

## 3. Vendor adapters

Each adapter is a small pure-ish module that returns `{ vendor, items, batchError }`. Shared
machine/line resolution and record assembly live in `adapterSupport.js` so no two adapters can
diverge.

### PulseForge (`adapters/pulseforge.js`)

- Batch: `{ vendor, plant_id, events[] }`; unwraps a combined `{ pulseforge: {...} }` payload.
- `event_time` **must** be ISO-8601 UTC (`parseIsoUtc`). The malformed
  `"18-04-2026 08:28:20"` shape is rejected (`invalid_timestamp`) — never guessed.
- `event_type` → canonical: `HIGH_VIBRATION→vibration`, `TEMP_SPIKE→temperature`,
  `SENSOR_HEALTH_DROP→sensor_health`, `POWER_FLUCTUATION→power`, `RECOVERY_SIGNAL→recovery`.
- `severity` ∈ `{low,medium,high,critical}`. `sensor_health` / `vendor_confidence` are `[0,1]`
  ratios. Units: `vibration_mm_s`, `temperature_c` used as-is.

### ThermexWatch (`adapters/thermexwatch.js`)

- Batch: `{ source, site_code, readings[] }`; unwraps `{ thermexwatch: {...} }`.
- `timestampMs` is epoch milliseconds (UTC). `parseEpochMs` validates the range.
- `alertCode` → canonical: `VIB_WARN→vibration`, `TEMP_WARN`/`TEMP_CRIT→temperature`,
  `POWER_DROP→power`, `OK→ok`.
- **Severity from `level` 1–5** → `none/low/medium/high/critical`.
- **Units:** `temperature_f` is converted to Celsius; **`vibration_g` is preserved as
  `vibration_g`** and never converted to `vibration_mm_s` (acceleration → velocity needs
  frequency; the conversion would be invented). Unit provenance is kept in `unit_metadata`.
- `productionLine` may be a bare letter (`"A"`); `normalizeLineId` maps `A → LINE-A`.
- `is_active` and `signal_quality` (`GOOD/FAIR/POOR`) are preserved.

### MaintaFlow (`adapters/maintaflow.js`)

- Batch: `{ provider_name, factory_id, records[] }`; unwraps `{ maintaflow: {...} }`.
- `recorded_at` is `"YYYY/MM/DD HH:mm:ss"` with **no timezone** → interpreted as **UTC**
  (approved assumption N02).
- `record_type` → canonical: `inspection`, `maintenance_update`, `operator_note`, `calibration`.
- Severity is derived from meaning, not a numeric level: `major_defect_found→high`,
  `minor_defect_found→medium`, `passed_with_observation→low`, `overdue→high`, `due_soon→medium`,
  `operator_note`/`calibration→low`; a `maintenance_update` with `maintenance_status='completed'`
  is a **resolution signal**, so its severity is `none`.
- `inspection_result`, `maintenance_status`, `days_since_last_service`, and the technician note
  are stored in `attributes`. A `contentKey` (type|result|status|days|confidence) discriminates
  maintenance records that carry few numeric measures for dedup purposes.

## 4. Deduplication / idempotency

Two independent guards:

1. **Content fingerprint** — `canonical_events.dedupe_key` UNIQUE
   (`src/modules/normalization/fingerprint.js`). It is a SHA-256 of the *normalized content*
   (`vendor, machineRef, canonicalEventType, rawEventType, occurredAt(ms), temperatureC,
   vibrationMmS, vibrationG, powerKw, contentKey`) and deliberately **excludes the vendor event
   id and the submission**. This is why `duplicates.json`'s `TW-8801` and `TW-8801-R` (same
   reading, mutated id) collapse to one canonical event. Key format: `"<vendor>:fp:<sha256>"`.
2. **Vendor id guard** — partial `UNIQUE(vendor, vendor_event_id) WHERE vendor_event_id IS NOT
   NULL`. A vendor re-using an id with different content is a detectable conflict rather than a
   silent overwrite.

`insertEvent` uses `ON CONFLICT DO NOTHING`; a replayed record counts as a *duplicate*, not an
error. Re-running the handler for the same submission therefore converges (no new rows).

The deterministic **stable stringify** used for the fingerprint hash is reused from
`src/modules/ingestion/idempotency.js`, so key-order differences never change the digest.

## 5. Derived machine state

`machine_state` is **recomputed** (not incrementally mutated) from a machine's canonical events
plus its work orders whenever any of its records are processed
(`src/modules/normalization/machineState.js`). This makes the result independent of processing
order and safe to re-run.

### 5.1 Ordering

Events are sorted by their **own `occurred_at` timestamp, descending** — never by processing
order. Ties are broken deterministically: higher severity → fixed vendor precedence
(`maintaflow > thermexwatch > pulseforge`) → vendor event id → record index. This satisfies the
"out-of-order must be deterministic with a stable tie-breaker" requirement (e.g.
`out_of_order.json` listing `PF-1302` before `PF-1301` still resolves by timestamp).

### 5.2 Active-condition model

Four signal categories participate: `vibration`, `temperature`, `power`, `sensor_health`. Each
category's *active* severity is the severity of its **most recent** event. Only `medium`+ counts
as an active condition. Other events contribute as follows:

- **Maintenance** (`inspection` with a defect result) → `maintenance_defect_major` (high) or
  `maintenance_defect_minor` (low); `maintenance_status='overdue'` → `maintenance_overdue`
  (medium); `'due_soon'` → `maintenance_due_soon`.
- **Open work order** → `open_work_order` (at least medium).
- **Low confidence** — the latest event's `vendor_confidence` or `sensor_health` `< 0.5` →
  `low_sensor_confidence`.
- **Recovery** — a `recovery`/`ok` event that follows a real prior condition →
  `recovery_signal`.
- **Staleness** — latest event older than the stale window → `stale_data`.

### 5.3 Resolution rules (the important semantics)

- **A generic recovery never erases an active critical.** `recovery`/`ok` events clear only
  non-critical (`medium`/`high`) conditions. This directly implements the approved rule that a
  critical unresolved signal must not disappear due to a later generic recovery, and is asserted
  by `a critical temperature is not cleared by a later recovery signal`.
- A critical is cleared only by (a) a **later same-category event below critical**, or (b) a
  **later documented maintenance resolution**: a `maintenance_update` with
  `maintenance_status='completed'`, or a work order `closed` with `post_maintenance_check='passed'`.
- **Missing/stale is never healthy.** No events → `derived_status = unknown`. Latest evidence
  older than `NORMALIZATION_STALE_WINDOW_MS` → `stale`. Neither is ever `ok`.

### 5.4 Status & attention mapping

| Condition | derived_status | attention_level |
|-----------|----------------|-----------------|
| any active critical | `critical` | `critical` |
| active high | `warning` | `high` |
| active medium | `warning` | `medium` |
| active low only | `ok` | `low` |
| stale, no active condition | `stale` | `none` |
| recovery after a prior condition | `recovering` | `none` |
| no active condition, fresh | `ok` | `none` |
| no events at all | `unknown` | `none` |

`needs_attention` is `true` for `warning`, `critical`, `stale`, `unknown`; `false` for `ok`,
`recovering`. Note that an active low-only condition yields `derived_status = ok` with
`attention_level = low`: `attention_level` can be above `none` while the derived status is not a
warning, and `needs_attention` follows the derived status (so it is `false`). If the evidence is
also older than the stale window, the `stale` row takes precedence.

**Reason codes** are emitted as `<category>_<critical|high|attention>` for conditions plus the
named codes above, and are sorted by a fixed rank (`constants.js REASON_CODE_ORDER`) so responses
are byte-stable regardless of arrival order.

### 5.5 Traceability

Each state row carries `source_event_refs` (up to the 10 most recent contributing events, with
`canonicalEventId`, `vendor`, `vendorEventId`, `submissionId`, `recordIndex`),
`latest_relevant_event_time`, `latest_relevant_event_id`, `last_processed_at`, and
`processing_status`.

## 6. Processing status on the machine view

`processing_status` is derived from the submission that last touched the machine:

- `processed` — the submission had no rejected records.
- `partially_processed` — the submission had at least one rejected record (some records still
  landed, so the view is usable but not complete).
- `unknown` — the machine has never been processed.

This is computed in the normalization transaction and passed to the reducer, so the machine view
never implies completeness it does not have.

`failed` is reserved by the schema and the summary counter but is **not emitted as a machine
state**. A submission that cannot be processed surfaces as a terminal `dead_letter` *job*, and
individual bad records surface in `normalization_failures`; neither produces a per-machine `failed`
row. This is a deliberate limitation (see §7).

## 7. Operational read APIs

`src/modules/operations/*` serves the machine status plus plant/line roll-ups. Machines are read
via a `LEFT JOIN` from `machines`, so a machine that has **never been processed** still appears
with `derived_status='unknown'` — it is never omitted and never reported healthy. Summaries count
by `derived_status`/`attention_level` consistently with the machine view.

The summary `data_quality` block reports `stale`, `failed`, `partially_processed` and
`never_processed`. It **exposes** the `failed` bucket the asset context asks about, but that bucket
is currently always `0`: there is no per-machine `failed` status (see §6). Failures are observable
at the level where they actually occur — a `dead_letter` job on the submission, and rejected records
in `normalization_failures` — rather than being smeared onto whichever machine the submission
happened to touch. We chose to document this rather than invent a synthetic machine-level `failed`
state that the processing contract does not actually produce.

## 8. The stale window (assumption)

`NORMALIZATION_STALE_WINDOW_MS` (default `86400000` = 24h, bounds `60000`..`2592000000`) is the
only freshness threshold. Aurik did not specify one, so it is explicit, documented, and tunable
rather than buried in code. Because the reducer runs against event timestamps, a historical
dataset (e.g. the April-2026 seed data viewed from a later date) is correctly reported `stale`
rather than silently `ok`.

## 9. Evidence mapping (assets → rules)

| Asset evidence | Rule |
|----------------|------|
| `TW-8801.timestampMs=1776499152000` == `2026-04-18T07:59:12Z` == `PF-1001.event_time` | Epoch-ms and ISO time both map to the same instant; cross-vendor ordering is meaningful. |
| `TW-8803 temperature_f=206.6` → `97.0°C`, vs `EQ-002.rated_max_temp_c=90` | F→C conversion is intended and valid. |
| `duplicates.json`: `TW-8801` / `TW-8801-R` | Content fingerprint collapses mutated-id duplicates. |
| `malformed.json` (`""` machine, `DD-MM-YYYY`, `severity:"urgent"`, `temperature_c:-999`, `sensor_health:"bad"`, `confidence:1.2`, `level:"four"`, `line:"ZZ"`, `alertCode:"UNKNOWN_ALERT"`) | Per-record rejection with explicit codes; `ZZ` line is a warning (machine line authoritative). |
| `out_of_order.json` (`PF-1302` recovery listed before `PF-1301` high vibration, but is later) | Ordering by event time + stable tie-break; the later recovery clears the earlier vibration. |
| `conflicting_updates.json` (EQ-008 recovery vs `TEMP_CRIT` vs `major_defect_found`) | Critical/high survive a later generic recovery. |
| `retry_cases.json` (`PF-1502` bad time; `MF-902` empty `machine_ref`) | `invalid_timestamp` rejection and `missing_machine` rejection; the valid records in the same batches still land, so the submission is `partially_processed`. |
| `maintenance_work_orders.csv` | Open WO → attention; closed + `post_maintenance_check='passed'` → documented resolution. |

All of the fixtures above are exercised by tests: `out_of_order.json` and `retry_cases.json` by
`tests/integration/normalizationPipeline.test.js` (through the full ingest → worker → canonical →
derived-state path), and the rest by `tests/unit/adapters.test.js` and the same integration suite.
