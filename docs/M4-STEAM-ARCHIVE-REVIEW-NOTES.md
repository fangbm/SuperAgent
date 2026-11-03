# M4 Steam archive review notes — 2026-11-03

Scope: code review only of the current uncommitted Steam Reviews changes and `scripts/m4-source.mjs`, focusing on `reviewScope` all/negative, checkpoint compatibility, full rescans/native metadata revisions, and Host/archive invariants. No implementation, test, runner, or archive changes will be made.

Intended review steps:
- Inspect the current diff and changed files.
- Read relevant M4 connector contracts, Host/archive interfaces, runner invariants, and existing focused tests.
- Trace event replay, checkpoint migration/compatibility (including old checkpoints), rescan/revision semantics, and source collection vs M1/M3 boundaries. Root plans to add `--archive-only`; account for that boundary but do not implement it.
- Record concrete actionable findings and material missing tests only; omit optional refactors.

Status: notes created before review work. No code changes made.

## Review result — 2026-11-03

Scope reviewed: connector diff and surrounding code, M1 Host/Ingress atomic commit and outbox behavior, `scripts/m4-source.mjs`, M4 Steam integration tests, archive-only subprocess test, and Steam Reviews README/connector docs. No code changes made. Official Steamworks GetAppReviews docs confirm `filter: 2` is `Updated` (the filter that can page to an empty list) and `review_type: 0` is All. The metadata-snapshot ID path appears replay-safe under atomic `commitBatch`: accepted events and checkpoint advance together, and restart rescans dedupe unchanged hashes.

Actionable gaps:

1. Add a legacy checkpoint compatibility test. Current scope-change test at `tests/integration/m4-steam-reviews.test.mjs` creates a new negative checkpoint that already contains `reviewScope`; actual existing deployed checkpoints predate this field. Seed the old shape `{version, appId, cursor, watermark, scanHigh, tracked}` without `reviewScope`, verify default/explicit negative resumes, and verify all rejects before fetching. The current fallback at `packages/connectors/steam-reviews/src/index.ts:71` appears correct but is not protected by the regression test.
2. Exercise the non-`--once` `--archive-only` path. `tests/integration/m4-archive-only.test.mjs` only covers the `--once` branch; the continuous `plugin.start` branch at `scripts/m4-source.mjs:43` is the separate code path that must leave outbox pending. Add a bounded subprocess/cancellation test that confirms events are committed while admissions/jobs remain zero.
3. Document `reviewScope` in `packages/connectors/steam-reviews/README.md` and `docs/M4-CONNECTORS.md`. The new config values are `negative` (default) and `all`; existing docs only describe the negative default, so operators cannot tell how to enable archive-all or why switching an existing source/checkpoint is rejected.

No must-fix data-loss issue found in reviewed code. `--archive-only` once-mode test confirms outbox remains pending and repeat import dedupes, but I did not run tests or a real archive job (review-only scope).

## Root follow-up

Addressed the review findings: explicit pre-change checkpoint fixture without reviewScope verifies implicit/explicit negative resume and all rejection before fetch. Added continuous archive-only subprocess test with a second snapshot poll, cancellation and zero admission/jobs. Both target files pass14tests. Scope/default/checkpoint and archive-only docs are now updated. No correctness bug was reported in the reviewed implementation.
