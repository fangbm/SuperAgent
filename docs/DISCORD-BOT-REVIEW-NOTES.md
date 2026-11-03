# Discord Bot Independent Review — Work Notes

## Scope
Read-only review of `packages/discord-community/src/index.ts` and `scripts/discord-bot.mjs`, `scripts/discord-bot-setup.mjs`, and `scripts/discord-bot-config.mjs`. Check correctness, private-data isolation, replay/durability, privilege checks, lifecycle scheduling, and whether deployment CLI references match the now-present runner. Report only concrete issues with file/line references and impact. Root reviews/integrates independently.

Do not modify implementation or existing tests. Do not add tests without coordinating with root first. No Discord/live actions, credentials, or commits. Keep work notes in this file.

## Intended review method
Inspect the complete relevant sources and associated tests/readmes only as needed to validate suspected findings. Trace lifecycle transitions and trust boundaries against the shared Discord bot contracts and migration/state API. Check deploy Dockerfile/Compose entrypoint alignment; Docker is unavailable here, so distinguish static review from a real Compose build.

## Status
Review pending.

## Review findings (2026-11-03)
Read-only review completed; no implementation/test files edited and no tests/live operations run.

### Concrete issues sent to root/author
1. **High — concurrent lifecycle snapshots can overwrite newer Gateway state.** `tick()` materializes tickets/rooms at `:264` and `:273`, then awaits REST/flush operations and later writes those full objects. `handleDispatch` can update the same entities during those awaits. For example `postTicketIntro` saves the stale ticket after a `close` interaction, potentially reverting `closed` to `open`; `applyTicketAccess` can overwrite queue entries appended while it waits for channel permissions; room cleanup/settings can replace fresh occupants or ownership. Reported to root with file/line references; root is reviewing integration/fixes.
2. **High — startup cleanup may run before a fresh voice snapshot.** `scripts/discord-bot.mjs` starts `community.tick()` immediately after starting the collector; connector startup first awaits history sync before the Gateway handshake. Thus an expired `emptyAt` from an earlier run can be deleted using stale occupants before READY/GUILD_CREATE reconciliation. Reported to root.
3. **Medium — ticket control message can duplicate after a transient read error.** `postTicketIntro` catches every history GET error and converts it to `null` (`index.ts:546`), then sends a new message. After an ambiguous POST, a transient GET failure can cause duplicate control messages. Only a successful empty GET should be treated as absence. Reported.
4. **High — malformed success JSON for a mutation is treated as definite failure.** `DiscordREST.request` maps non-204 JSON parse failure to `INVALID_RESPONSE` (around `:132–133`). A 2xx channel-create may have succeeded; `ensureRoom`/`ensureTicketChannel` treat this as blocked instead of unknown and marker reconciliation, leaving an orphaned channel. Reported.
5. **High — voice room entity and owner index are separate commits.** `ensureRoom` stores active room/channel then the `room:owner:` index (`:658–659`). A crash between commits followed by a lobby state event recreates the deterministic `room:voice-<user>` entity as `pending_create`, overwriting its channel ID; that path can POST another room. Reported.

### Resolved/in-progress items seen during review
- The private ticket event source URI initially mismatched the runner binding. Current code now uses `urn:superagent:source:discord:<guildId>:tickets`; I no longer count it as an outstanding issue. Root is adding a real Host proof because the existing community fixture's in-memory archive did not enforce source binding.
- Root's concurrent review addressed the move route, deterministic room marker, receivedAt handling, thread permission bits, and ticket-delete 404 ordering; I did not duplicate those findings.
- A connector callback/intent wiring gap was visible while another owner was still implementing it; after root clarified it was unfinished concurrent work, I excluded it from this review's findings.

### Deployment contract review
The Dockerfile's base ENTRYPOINT matches the runner's `--config`/`--database` arguments; Compose appends `--setup`, and its healthcheck uses read-only `--status`. `--check-config` is credential/database-free, and `--status` opens the DB read-only. Docker remains unavailable, so this is static alignment only; no image build/Compose validation was possible.

Status: review findings delivered to root; changes/fixes are root-owned and were not modified by this review.

## Real Host integration test follow-up (2026-11-03)
Root requested a new test-only real Host proof in `tests/integration/discord-community-host.test.mjs` and a review-notes update. Use `fixture(t)`/M1Runtime, exact private source binding URI, `DurableCommunityState`, archive-only private policy, injected ticket-state write failure after archive commit, runtime restart/lease takeover, and replay the same packet with identical `receivedAt`. Also prove single archived event/host ID, zero downstream admission/jobs, event reference-only lifecycle state, project isolation from public Domain evidence, private channel overwrites for two requesters, and nonstaff cross-ticket action denial. REST remains a strict injected transport; no live calls. No implementation edits, new config, or unrelated tests.

Verification: build first if needed, then run the new focused test with Node 24. Report any failures truthfully; root notes the community author is fixing stable event time and that the test may initially be red while that change builds.

Status: test follow-up pending.

## Real Host test implementation and first run (2026-11-03)
- Added `tests/integration/discord-community-host.test.mjs` using the existing file-backed M1 fixture, exact public/private bindings, `staff/archive_only` private policy, real `DurableCommunityState` lease acquisition/takeover, and a strict injected Discord REST transport. It injects a ticket state write failure after actual private archive commit, closes/reopens the runtime after lease expiry, replays the same interaction packet and timestamp, then checks single host ID, no body/token in state, archive-only downstream guards, Domain project isolation, least-access overwrites for two requesters, and nonstaff cross-ticket rejection.
- The source-binding/replay/privacy portions pass against the emitted Host/community dist. The test then fails at its deliberate permission check: requester overwrite `allow=67584` omits VIEW_CHANNEL (1024), so a regular requester cannot see the ticket while @everyone is denied view. Reported to root; root is correcting the implementation.
- Build/test run was attempted. `pnpm build` was blocked by community author edits in progress: a connector syntax error at `packages/connectors/discord/src/index.ts:167`, `previousOwner` missing in `packages/discord-community/src/index.ts`, and exact-optional-property typing errors for clearing room fields with explicit `undefined`. Because the build exited nonzero, the test command ran the last emitted dist; its permission failure is real against the currently emitted overwrite contract, but a clean re-build is still required before final acceptance.

Status: test added; first host-path assertions pass; permission assertion awaits root's fix and clean build for rerun.

### Test handoff update
- Added explicit VIEW_CHANNEL assertions for requester and staff, and no overwrite/view access for the other requester, as root requested. `node --check tests/integration/discord-community-host.test.mjs` passes.
- Root forwarded the `ACCESS=67584` visibility finding to the implementation author; expected open access is to include VIEW, READ_HISTORY, and SEND (`68608`). Per root, no further builds or test runs were made while implementation files were mid-write. Root will run a clean build and all integration tests after author handoff.

Final review/test status: the new real-Host test is ready for root's clean build; no implementation files were edited.


## Root resolution and final proof

All review findings were addressed and the real Host integration test passes: binding URI, stable replay, VIEW access, private policy, role isolation and reference-only state. Additional tests cover delayed REST/voice races, snapshot-gated cleanup, unknown writes and provider marker recovery. Root also verified immediate Gateway ACKs while commits block, deletion split-replay preserving first observation time, dynamic private capture without a second socket, and protected channel permission changes. Migration numbering now follows unchangedQQ008 with source009/community010; scratch migration preserves148IDs/payloads/checkpoints. Local tests and live limits remain separately recorded in DISCORD-BOT.md/evidence.
