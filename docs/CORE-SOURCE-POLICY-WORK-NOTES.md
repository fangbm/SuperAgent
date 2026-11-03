# Core source registry — 2026-11-04

## Scope
Add a trusted Core-owned registry that validates and clones a fixed source configuration, registers only those sources, applies only their configured policies in one SQLite transaction, and returns frozen per-source ingress hosts. No platform SDK imports, schema changes, or new runtime services.

## Findings before implementation
- `IngressService.registerSource` and `setSourcePolicy` each open transactions; `SqliteStore.transaction` uses nested savepoints, so the registry can wrap existing service calls in one atomic outer transaction.
- `setSourcePolicy` currently rejects archive-only policy for already processed sources even when the configured policy is unchanged. The registry must skip unchanged policies; explicit public archive-only to standard transitions remain allowed.
- `sourceHost` already returns frozen, scope-bound Source SDK capabilities and validates the scope against registered sources.
- Existing source binding identity is immutable. Policy rules preserve staff isolation and reject mixed visibility per project.

## Implementation and validation
Implement `packages/plugin-host/src/source-registry.ts` and `tests/integration/core-source-registry.test.mjs`. Cover config validation/rollback, project/source preservation, policy transitions, scoped host access, and normal event dispatch. Record focused typecheck and integration test results below after implementation.

## Validation/results
- `node node_modules/typescript/bin/tsc -b packages/plugin-host` passed.
- `node --test tests/integration/core-source-registry.test.mjs` passed (5 tests).
- The integration test confirms processed public sources remain dispatchable, archive-only Steam remains held, private staff events stay hidden, invalid identity/mixed-visibility configurations roll back, unchanged processed archive policy is accepted, and configured public policy can explicitly return to standard.
- Focused run uses the local TypeScript binary because `pnpm exec` attempted a workspace store symlink and failed with `EPERM`; no lockfile or dependency changes were made by that attempt.
