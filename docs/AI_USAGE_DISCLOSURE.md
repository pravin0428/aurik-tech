# AI Usage Disclosure

This document states, plainly, how AI assistance was used to build this repository, what a human
reviewed, and what has **not** been verified. It is written for an assessor who needs to judge the
submission on substance rather than on the polish that AI tooling can add.

## 1. Summary

An AI coding assistant (opencode) was used as a **pair-programmer**: it wrote most of the code,
configuration, documentation, and test bodies from human-authored direction, and a human reviewed,
approved, and directed every phase. The submission was produced in explicit, approval-gated phases;
no phase was merged without the human reading the diff and results first.

In short: the *design decisions and domain rules are human-directed*; the *typing-out and much of
the boilerplate and test scaffolding are AI-assisted*; and *correctness rests on the human-reviewed,
executed test suite and on the human's reading of the code*, not on the AI's claim of correctness.

## 2. What was AI-assisted

- Repository scaffolding: config loading, logging (Pino), error taxonomy / `AppError`, health and
  readiness routes, DB pool and transaction helper, migration runner, Dockerfile / Compose, Jest
  harness.
- SQL: the numbered migrations under `db/migrations/` and the seed scripts.
- The ingestion module (routes, Zod validation, raw-payload persistence, transactional
  submission + job creation, idempotency).
- The reliable worker: claiming via `FOR UPDATE SKIP LOCKED`, leases, exponential backoff,
  dead-lettering, graceful shutdown.
- The Phase 5 normalization module: the three vendor adapters, the canonical event model,
  reference-data loading, dedupe fingerprinting, and the operational/attention rules.
- The OpenAPI document, the README, and the docs set.
- The bodies of the Jest unit and integration tests, and the local PostgreSQL test setup.

## 3. What was human-directed and human-reviewed

- The phase plan and its approval gates; scope control at each phase (e.g. explicitly *no* ML, *no*
  Kafka/Redis, *no* ORM).
- All domain decisions that appear in `DESIGN_NOTES.md` and `ASSUMPTIONS_REGISTER.md`: the
  `derived_status` / `attention_level` vocabularies, the rule that a critical condition must not be
  silently cleared by a later generic recovery, the stale-data window (configurable, 24 h default),
  the deterministic out-of-order / conflict tie-break ordering, preserving ThermexWatch `vibration_g`
  separately from `vibration_mm_s` (no unit coercion), zone-less MaintaFlow timestamps treated as UTC,
  and the per-record accept/reject behaviour.
- Reading the full diff, running the commands below, and accepting or rejecting AI output.

## 4. Verification that was actually executed

The following were run locally against a **real PostgreSQL 16** instance (not a mock) during
development and review. Commands are given so results can be reproduced.

- Migrations (all 8) applied cleanly and are **idempotent** — a second run reports
  `applied 0 / total 8`.
- Reference seed loads 2 plants / 5 lines / 8 machines and 4 work orders; `seed:events` loads 21
  events and is idempotent on re-run.
- The full Jest suite **with `TEST_DATABASE_URL` set**: see the current counts in the final phase
  report (`npx jest --runInBand`). The suite covers config, logging, errors and envelopes, migrations,
  health/readiness, ingestion (validation, idempotency, transactional enqueue), the worker (claim,
  retry/backoff, dead-letter, lease recovery, shutdown), the three adapters, reference loading,
  dedupe, out-of-order / conflicting updates, `retry_cases` / `out_of_order` fixtures, the
  operational view, and the read APIs.
- The suite also runs **without a database**, where database-backed suites self-skip and the pure
  unit suites still pass (the no-DB mode exists so the logic can be reviewed without provisioning
  PostgreSQL).
- Every source file passes `node --check` (syntax), and `openapi/openapi.yaml` parses as valid YAML.
- `docker compose config -q` validates the Compose file.

## 5. What has NOT been verified (honest limitations)

- **Docker image build and `docker compose up` were never executed.** The development machine could
  not start a Docker daemon (no WSL2). Only `docker compose config -q` (syntax validation) passed.
  The Dockerfile and Compose file are therefore **unverified at runtime**.
- **No live vendor APIs were called** — none exist; behaviour was built against the provided JSON
  fixtures in the assessment assets.
- **No load, soak, or multi-worker concurrency test** was run beyond the automated tests; the
  `SKIP LOCKED` claim path is exercised by unit/integration tests, not by a stress harness.
- **PostgreSQL version/runtime parity** in a container was not checked (see Docker note).
- One integration test was found to be **timing-sensitive** during final verification: its drain
  loop assumed an immediate claim, but `processing_jobs.available_at` (default `now()`, microsecond
  precision) can sit marginally ahead of the worker's millisecond-resolution clock. The **test
  harness** was hardened to tolerate this (the production claim path was left unchanged). This is
  recorded for transparency; it is a test-harness concern, not a production defect.
- AI-generated text can be plausible but wrong. The defence against that here is the human review of
  the diff plus the executed test suite — **not** the AI's own confidence.

## 6. How to evaluate this quickly

1. Read `docs/DESIGN_NOTES.md` and `docs/ASSUMPTIONS_REGISTER.md` for the *decisions*.
2. Read `README.md` for how to run and test it.
3. Run the suite (`npx jest --runInBand` against a local PostgreSQL) and read the tests — they encode
   the intended behaviour and the edge cases that were consciously handled.
4. Treat the UI/polish as secondary; judge the schema, the queue semantics, the normalization rules,
   and the tests.
