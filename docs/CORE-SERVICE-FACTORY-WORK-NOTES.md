# Core service factory reuse — 2026-11-04

## Scope and agreement

This change extracts the existing M3 service wiring into `createAnalysisServices(runtime, options)` so the main Core launcher can reuse its existing M1 runtime and trusted source Host. The factory owns no database or runtime. It returns the existing memory/domain/analysis/sync services and a tick function for analysis, GitHub sync, and embeddings; the caller remains responsible for `runtime.tick()`.

M3 CLI keeps its flags, defaults, output and runtime lifecycle, delegating service creation and tick work to the factory. A configured model is still required unless an injected model is provided.

M5 gains optional borrowed runtime, memory and domain services. A borrowed runtime must resolve to the same database filename as M5's requested path. Borrowing skips runtime creation, backup and batching policy loading, and M5 close/error cleanup must leave the runtime open. Existing owned-runtime behavior, backup and access configuration remain intact.

## Files

- `scripts/m3-services.mjs` (new)
- `scripts/m3-worker.mjs`
- `scripts/m5-runtime.mjs`
- `tests/integration/core-service-factories.test.mjs` (new)

No CLI surface, plugin API, contracts, migrations, package metadata, or external-write defaults change.

## Validation

`node --test tests/integration/core-service-factories.test.mjs` passes both integration checks: factory reuse with an existing fixture runtime and injected model, and borrowed M5 runtime survival after close plus database mismatch rejection. Syntax checks and `git diff --check` pass for the changed scripts.

The pre-existing M3 HTTP and M5 runtime integration files were also attempted. The M3 worker HTTP test reached `MODEL_NETWORK_ERROR` against its local model server, and the M3 GitHub guard test did not observe its expected rejection; the M5 GitHub receipt test failed before app startup because its fixture had no defect row. These failures are outside the new factory tests and need root-level full-suite diagnosis.

Root integration verification subsequently ran with local HTTP access: the complete 318-test suite passes, including the existing M3/M5 tests and the new real M3 orchestration fixture. The earlier sandbox attempts are historical, not outstanding failures.
