# Discord community feature implementation notes — 2026-11-03

Scope: implement the approved ticket and temporary voice-room lifecycle in `packages/discord-community` and `tests/integration/discord-community.test.mjs` only. Shared contract: `docs/DISCORD-BOT-WORK-NOTES.md`. No Core/DB imports, no root/workspace wiring, no live Discord actions, no commits.

Plan:
1. Inspect existing Discord connector/plugin-host types and test conventions after this note is created; use them only as references.
2. Implement a small REST adapter with GET/definitive-429 retry behavior and unknown outcome errors for ambiguous mutation failures.
3. Implement `DiscordCommunity` with validated actor/guild/role handling, lightweight durable intent handling in dispatch, immediate safe acknowledgement, and resumable external lifecycle work in `tick`.
4. Model ticket/room entities in the provided JSON state interface, persist evidence references only, and flush private/public archives before user-facing success or destructive actions.
5. Add focused fixture-driven integration coverage for authorization, archive-before-accept, idempotency/unknown create reconciliation, ticket lifecycle, room capacity/host transfer/cleanup, and safe REST retry behavior.
6. Review scope and run only relevant checks requested/needed for these focused tests; report limitations without changing shared wiring.

Important invariants: no interaction tokens or message bodies in lifecycle state; one open ticket per member; ticket channel restricted to requester, bot, owner, and configured staff roles; private archive first; one room per owner with four seats by default; no audio capture; 60-second empty-room delay plus final flush; unknown mutating outcomes are reconciled before another write.

## Implementation handoff — 2026-11-03

Implemented `packages/discord-community` (SDK + Node built-ins only) and `tests/integration/discord-community.test.mjs`.

Review fixes included: voice moves use `PATCH /guilds/{guild}/members/{user}`; temporary voice channels reconcile by unique type-2/category/name suffix; ticket events use stable Gateway `receivedAt` and preserve the submitted title/body verbatim in the private event; permission bitfields include VIEW and deny thread creation bits 35 and 36; ticket deletion checks channel existence before flush and persists final-flush proof. State updates merge current ticket/room fields after REST awaits, cleanup rereads occupancy after flush, and room lifecycle waits for a complete voice snapshot. Room owner index recovery checks the deterministic room entity before creating another.

Visible panels and ticket messages contain no lifecycle markers or internal archive IDs. Ticket content is retained across messages capped at 1900 UTF-16 units, with continuation replies reconciled by bot author, component IDs, and message references. Ambiguous message/channel operations are reconciled before any retry. Submitted text and interaction tokens are never stored in lifecycle state.

Verification at handoff: `pnpm exec tsc -p packages/discord-community/tsconfig.json --pretty false`, all 13 community integration tests, and `pnpm check:boundaries` passed. No live Discord API actions were made. Root still owns workspace/runner integration and assembled Host/connector/CLI verification.

Operational limits: deferred interaction tokens exist only in memory, so a process crash may lose the ephemeral follow-up while the durable archive/entity intent remains. An unknown channel create with no matching deterministic marker remains unresolved rather than being retried. Voice cleanup remains paused until READY/GUILD_CREATE supplies the guild voice-state snapshot.
