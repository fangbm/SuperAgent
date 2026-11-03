# Core runtime composition coverage — 2026-11-04

## Scope
Add integration coverage for the existing `createCore` composition API only. Use injected fake source plugins and analysis service while sending contract-normalized events through registry-bound SDK Hosts. Do not alter runtime implementation.

## Behaviors under test
- A preexisting, already processed QQ source remains unlisted and retains its identity/policy through Core startup and restart.
- Configured public Discord and Steam sources retain standard processing and reach Core admission/analysis in the same runtime.
- A separately scoped staff/archive-only source remains archived and is absent from analysis eligibility.
- A platform source URI mismatch is rejected before the database file is created.

## Validation
Run the focused `core-runtime.test.mjs`; no live integrations or HTTP loopback are required.

## Validation/results
- `node --test --test-force-exit tests/integration/core-runtime.test.mjs` passed (2 tests).
- `createCore` was exercised with injected fake plugins that submit actual connector-normalized Discord and Steam events through frozen source Hosts. The injected analysis service observed the same runtime after Core dispatch/admission.
- The test verifies a preprocessed, unlisted QQ source keeps its binding and standard/public policy across a Core restart; configured public sources stay standard and reach analysis eligibility; the configured staff/archive-only source remains in the raw archive with its outbox pending and no admission decision; source URI mismatch is rejected before database creation.
- No HTTP or live platform integration was used. No implementation interface questions remained from the current `createCore` signature.
