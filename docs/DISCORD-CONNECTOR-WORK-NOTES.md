# Discord connector layer — work notes

Scope from the approved Discord bot plan: own only `packages/connectors/discord` and new `tests/integration/discord-shared.test.mjs`. Implement the additive public Gateway dispatch callback/options/API described in `docs/DISCORD-BOT-WORK-NOTES.md`; do not edit community runtime, migrations, Host state, workspace/root config, frozen contracts/SDK, or deployment. No live Discord actions, credentials, tokens, or archive run.

Intended implementation:
- Add `DiscordDispatch` with packet type/data, gateway sequence/session, and first `receivedAt`.
- Preserve existing SourcePluginV1 defaults and tests while adding `onDispatch`, `onDispatchImmediate`, `additionalIntents`, `channelResolver`, `discovery: 'public'`, empty `channelIds` in discovery/resolver modes, and `consumeDispatch` for private collectors without a second Gateway.
- Route one serial dispatch through public archival, immediate interaction acknowledgement hook, callback, and final sequence checkpoint in the approved order. Persist pending-dispatch identity/receivedAt before split commits; do not store interaction tokens/payload.
- Implement resumable public channel/thread discovery including archived-thread pagination, and dynamic resolver allowlisting for private ticket channels while excluding private/DM content from public sync.
- Add focused real-Host integration tests for backward compatibility, new hooks/options, discovery/resume, replay after split-commit failure, interaction acknowledgement ordering, and deletion receivedAt stability.

Status: work notes created before code inspection. No code changes made.

## Root privacy follow-up — 2026-11-03

Approved additive requirement received during implementation: expose `channelExcluder` in `DiscordOptions`, apply it to discovered/cached public channels, public parents, threads, and dispatch routing. Revalidate discovery after public channel or guild-role permission update events before routing later messages. Root will exclude the managed ticket category and registered ticket IDs; this is an independent defense in addition to Discord overwrites. Preserve the prior scope and ownership boundaries.
# Follow-up execution intent (2026-11-03)

Resume connector-only implementation and verification. I will inspect the locked execution checklist, connector diff, and integration helpers; add targeted tests for cached public channel privacy invalidation/excluder behavior and durable archived-thread pagination/replay; then run the focused Discord integration tests and connector TypeScript build. I will not edit Host/community/root config or any live Discord state. Report concrete failures and leave root-owned changes untouched.

## Handoff — 2026-11-03

Completed the bounded archived-thread continuation correction: an incomplete initial scan now resumes its stored `before` cursor; only a completed cycle starts a newest-overlap rescan. Added `tests/integration/discord-shared.test.mjs` with restart pagination coverage and a cached-public-channel permission refresh plus `channelExcluder`-even-when-@everyone-allows test. Validation passed: `node node_modules/typescript/bin/tsc -b packages/connectors/discord --pretty false`; `node --test tests/integration/m4-discord.test.mjs tests/integration/discord-shared.test.mjs` (13/13 tests).

Current exact UI state: no Discord desktop/UI was opened or changed during this connector task. Root has sole control to integrate from here. Remaining test coverage within this new file does not yet independently exercise immediate interaction ACK timing, callback/public-archive split-commit replay with delete `receivedAt`, or private `consumeDispatch` dynamic resolution; existing `m4-discord` coverage exercises ordinary Gateway resume/replay but not those additive paths. Root asked to stop expanding and take ownership of remaining implementation fixes after this handoff. No code issue surfaced in the focused checks.
