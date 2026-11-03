# Core ticket submission transaction — 2026-11-04

## Root cause and goal

Discord currently inserts a normalized private submission through `privateArchive.commitBatch`, then independently writes the ticket intent, open-user index, and interaction de-duplication state. A crash between those operations leaves an archived event without recoverable lifecycle state; existing recovery relies on replaying the Discord Interaction. Startup also initializes archive policy from the plugin, risking changes to unrelated sources.

Move ownership of ticket submission into Core. `CommunityHost.submitTicket(event)` is required, and Discord normalizes the modal event and passes it once to that method. A Core `CommunitySubmissions` service will synchronously commit the source event and lifecycle state in one SQLite transaction, bound to the exact private source scope and fenced by its community lease.

## Scope

- Add `packages/plugin-host/src/community-submissions.ts`; export it from the plugin-host index and add only dependency/type references required by the current package setup.
- Extend `DurableCommunityState` with synchronous transaction-safe operations needed by Core and export them from `community-state.ts`/index as applicable.
- Update `packages/discord-community/src/index.ts` to require and call `submitTicket`; remove its independent reservation/commit/state-init path and archive-only event metadata.
- Update Discord Community unit/integration mocks and add real Core service transaction and recovery tests.
- Do not change frozen APIs, migrations, root scripts/config/docs outside this notes file, package lock, or unrelated source policy.

## Transaction and recovery design

- Core owns a fixed `{projectId, sourceId}` and guild binding; validate the event's private normalized scope and Discord-native interaction metadata against that binding.
- In one synchronous store transaction, check the lease/fence, enforce interaction idempotency/payload identity and one-open-ticket-per-user, then call synchronous `IngressService.commitBatch` and write `ticket:<id>`, `ticket:open:<user>`, and `interaction:<interactionId>` state. No async host call may occur inside the transaction.
- A repeated identical interaction returns the original ticket ID after payload identity validation. A different payload for the same interaction rejects. A distinct valid submission while the user already has an open ticket archives the new form and returns the existing ticket ID.
- Recovery scans only the bound source's private ticket events, identified by interaction source ID and native attributes. It reconstructs absent ticket/open/idempotency records without Discord Interaction replay, preserves existing IDs and payloads, and leaves creating/unknown channel effects for reconciliation rather than blindly retrying them. Remove only stale pending locks whose exact bound event lookup proves absent.
- Do not persist interaction tokens or duplicate submitted bodies in lifecycle state. Keep original archive event as the sole body record. `pending_create` ticket intents are recovered so the existing tick can continue.

## Validation plan

- Test atomic rollback after injected failure following ingress insertion and following lifecycle writes.
- Test committed-before-receipt restart recovery without `handleDispatch`/Interaction replay, legacy orphan recovery, same-player concurrent submissions (both archived, one ticket), duplicate and conflicting replay, exact-scope isolation, lease loss, and stale lock cleanup.
- Integration coverage must instantiate the actual Core submission service; mocks are acceptable only for plugin-host unit tests and should model the required result faithfully.
- Run focused package builds and the relevant integration tests. Do not use live Discord API credentials or send platform requests.

## Confidence assessment

- [x] No duplicate service found by repository search (25/25): only the current Discord-owned flow exists.
- [x] Architecture compliance confirmed in `AGENTS.md` and ownership notes (25/25): Core owns SQLite/state; platform connector uses Host capabilities.
- [x] Official documentation verified (20/20): SQLite transactions are synchronous boundaries; the existing store uses synchronous `BEGIN IMMEDIATE` and nested savepoints.
- [x] OSS reference verified (15/15): better-sqlite3 documents synchronous transaction callbacks and nested savepoints.
- [x] Root cause confirmed (15/15): Discord commits ingress before separate state writes and recovery currently relies on replay.

Total: 100/100. Proceed.

## Results

Implemented `CommunitySubmissions`, synchronous lease-checked state reads/writes, the required Discord Host method, and real Core service integration tests. `CommunitySubmissions` startup recovery must be invoked by the Core composition after lease acquisition; the Core runtime owner is wiring that facade.

Focused verification: `node_modules/.bin/tsc -b packages/plugin-host packages/discord-community --pretty false` passed. `node --test tests/integration/community-submissions.test.mjs tests/integration/discord-community.test.mjs tests/integration/discord-community-host.test.mjs` passed 23/23 after review fixes. No live Discord calls were made. `pnpm --filter @superagent/plugin-host build` could not run because pnpm attempted to create a sandbox-blocked symlink in its store (`EPERM`); local TypeScript build and node test runner were used instead.
