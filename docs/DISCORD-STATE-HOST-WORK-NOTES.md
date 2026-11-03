# Discord Community Lifecycle State Host — Work Notes

## Scope
Implement the assigned durable JSON state and lease API only in:
- `packages/persistence/migrations/010_community_lifecycle.sql`
- `packages/plugin-host/src/community-state.ts` and `packages/plugin-host/src/index.ts` export
- `tests/integration/community-state.test.mjs`

Follow `docs/DISCORD-BOT-WORK-NOTES.md`. Do not edit migration 008/privacy, root workspace/package configuration, frozen interfaces/contracts, connector/community feature packages, or live Discord state. Do not commit.

## Intended implementation
1. Inspect repository guidance and existing migration, SQLite/M1, host, test patterns.
2. Define tables `community_state` and `community_leases` in the same SQLite store.
3. Implement `DurableCommunityState(store, namespace, {clock?})` for async JSON get/set/update/list and synchronous transactional reducers, canonical JSON validation, namespace-isolated prefix listing, and owner/TTL lease acquire/renew/release with expiry/fencing behavior.
4. Add focused integration tests using real temporary SQLite files and existing M1 fixtures/patterns for persistence across restart, namespace isolation, reducer atomicity/rollback, invalid JSON, listing isolation, and lease acquisition/renewal/takeover/release.
5. Run the requested focused tests and report exact results; make no unrelated changes.

## Verification plan
Use repository migration/test conventions. Verify same-write durability using real file-backed storage, restart/reopen behavior, namespace prefix safety, synchronous reducer enforcement, canonical JSON constraints, rollback on invalid reducer output, and lease ownership/expiry fencing. Run only the focused requested test file unless repo guidance requires more.

## Status
Read shared Discord bot notes; implementation pending.

## Implementation completed (2026-11-03)
- Added migration `010_community_lifecycle.sql` with only `community_state` and `community_leases` tables in the existing SQLite database. State rows are keyed by namespace/key and guarded by SQLite JSON validity; leases retain generation for expired-owner takeover fencing.
- Added and exported `DurableCommunityState` from `packages/plugin-host/src/community-state.ts` and host index. It implements async get/set/update/list, canonical JSON, copy-on-read/return snapshots, transaction-bound synchronous reducers, literal prefix listing per namespace, and acquire/renew/release lease operations. Expired owners cannot renew; takeovers increment generation; stale owners cannot delete/renew a replacement lease.
- Added five real-file M1/SQLite integration tests covering restart persistence/canonical form, reducer sync and rollback behavior, invalid JSON, independent snapshots, namespace and literal-prefix isolation, lease persistence/expiry/takeover/fencing, and invalid lease inputs.
- Verification: `pnpm build` passed. Focused run `pnpm exec node --test tests/integration/community-state.test.mjs tests/integration/persistence-ingress.test.mjs` passed 19/19 tests. Node emitted its normal experimental SQLite warning.
- Scope stayed within migration 009, plugin-host community state and export, the assigned integration test, plus this work-notes file. No commit, platform code, migration 008, root config, live Discord operation, or external action.

## Handoff
Root should wire a unique per-process lease owner and stop controller work when renewal fails. This API does not expose the internal generation as a fencing token; ownership fencing is enforced through a distinct owner string, unexpired lease checks, generation increments on takeover, and owner-conditional renewal/release.

## Lease-owner fencing follow-up (2026-11-03)
Root requested optional `leaseOwner?: string` in `DurableCommunityState` options. When configured, set/update must verify within their SQLite transaction that the namespace lease is still owned by that value and has not expired; get/list must also reject access if the lease is lost. Keep default no-owner behavior unchanged. `acquireLease`, `renewLease`, and `releaseLease` remain usable without the write/read guard so startup can acquire before accessing state. Add tests proving stale-owner writes and reads fail and the reducer is not called. Do not change any other files outside community-state.ts, community-state.test.mjs, and this work note.

Verification: run build and focused community-state tests; update this note with results.

Status: follow-up completed; see verification above.

## Lease-owner fencing follow-up completed (2026-11-03)
- Added optional `leaseOwner` to `DurableCommunityStateOptions`. With it configured, `get` and `list` reject when the namespace lease is missing, expired, or owned by another controller. `set` checks ownership and expiry inside its write transaction. `update` checks before invoking the synchronous reducer and again immediately before the write, so a slow reducer cannot commit after expiry; a lost lease rolls the transaction back. Default instances without a leaseOwner retain their original behavior. Acquire/renew/release remain available for startup/shutdown.
- Added a takeover test proving stale `set`, `update`, `get`, and `list` fail, the reducer is not called, and stale-owner release cannot remove the replacement owner's lease.
- Verification: `pnpm build` passed; `pnpm exec node --test tests/integration/community-state.test.mjs` passed 6/6. Node emitted its standard experimental SQLite warning.
