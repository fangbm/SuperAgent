# Steam public feedback adapters — 2026-11-04

## Authorized design

Keep the existing official all-review collector. Add explicit public Steam Discussions collection and an independent review-comment SourcePlugin inside the Steam Reviews package. All material goes through the existing bound Source Host; only Core archives, configures policies and schedules analysis. Preserve frozen SDK/contracts and existing migrations.

## Verified access before implementation

Anonymous bounded probes against AppID 5335850 succeeded: official GetAppReviews returned two 3-review pages (summary 130); General Discussions render returned two distinct 2-topic pages (summary 51); a 9-reply topic returned distinct first/next reply IDs and a valid empty tail. Forum replies require the public `extended_data` initialization parameter. Review comments also returned original text/native IDs and an empty tail. HTTP 200 plus success=false is an error, never an empty page. These site-native endpoints are undocumented and coverage stays partial.

## Work order

1. Confirm base/Core PR state and inspect the previous 19-comment codec without modifying player archives.
2. Parallelize Discussions public mode and the independent review-comment adapter, keeping SDK-only workspace dependencies.
3. Wire explicit Core source registration and one-time checkpoint seeding from only the matching archived source.
4. Add request/normalization/replay/edit/restart/failure fixtures and integration tests, then bounded live API tests on disposable archives through the real Host.
5. Update configuration, coverage/research documentation and work notes. Run frozen install/full checks, commit and open the Steam follow-up PR.

## Defaults and limits

- Poll every 10 minutes; one request at a time per plugin, at least 2 seconds apart, at most 25 requests per sync including retries.
- Resume incomplete work via atomic Host checkpoints; daily known-object rescans detect old edits and comments on old reviews.
- Never infer deletion from missing/private/failed responses. No login/session/cookie extraction or access-control bypass.
- Preserve original text/native body fragments, stable object identity, parent/thread links and truthful native/observation times.
- No persistent service/LLM activation; canonical and prepared 148-record archives remain untouched.

## Readiness

Duplicate check and current architecture read; exact public routes and paging verified against primary responses/site client code. Existing Host transaction/SDK is reused. Implementation confidence meets the required 90% threshold.

## Results

Implemented on the unified application branch. The explicit application example is `examples/steam-public/superagent.json`; it preserves the frozen `config/` inventory. New plugins commit only through scoped Hosts. No frozen contract, SDK, freeze manifest, migration, community resource or original archive was changed.

## Reconciliation after remote changes — 2026-11-04

Before further implementation, fetched the remote and reviewed main `76f3a6c` (PR #6 reverts the old community implementation) and unified application PR #7 at `a2f1d9a`. PR #5 remains open and must not be merged or restored by this Steam task. Preserve the current Steam work locally, then port only connector code, fixtures, tests, documentation and scoped application configuration onto PR #7. Use its trusted Source Registry, supervisor and scoped Host; remove the obsolete `core-runtime.mjs` / `core-config.mjs` integration from the Steam diff. Do not restore community resources, policies, migrations or deployment code reverted by #6. The final result will be a Draft follow-up PR based on #7, with no automatic merge or persistent service activation.

Readiness recheck: duplicate implementation search passed (25/25); current architecture and PR #7 lifecycle read (25/25); official review API and public Steam client response/code evidence retained (20/20); primary Steam site-client reference verified (15/15); identified stale Core integration plus incomplete fairness/seed/body-limit follow-ups (15/15). Score 100/100; proceed with the scoped port and checks.

## Review fixes and validation

- Preserved PR #7's health signals and serialized official review probe/sync. Added opt-in all-review snapshots and monotonic observation IDs so metadata A→B→A→B remains independent history; default negative behavior stays compatible.
- Public Discussions and review comments refresh the head independently of unfinished background work. One-request budgets retain scheduling turns across restart; reply offsets survive comment-count changes. Quiet known objects receive daily rescans. List-row activity excludes relative time/UI text.
- Enforced response byte limits while streaming; rejected duplicate IDs, wrong offsets, premature empty pages, negative totals and mismatched initialization. Failed/private objects retain gaps and their offsets. Old public v1 thread metadata is re-fetched without resetting a committed reply-page offset.
- Exact-source comment initialization validates scope, object/native IDs, parent/thread links, event codec and content before an atomic checkpoint upgrade. A malformed archived projection is a permanent `INVALID_CHECKPOINT`, with no original event rewrite. Supervisor preparation honors committed Retry-After before even diagnostic probes on a fresh instance.
- Frozen install and complete `pnpm check` passed: **338 Node tests, six Python reference suites**, build, typecheck, dependency boundaries and all **45** frozen hashes. Static formal-entry config check passed without database/network access.
- First two full runs found the existing M3 recovery fixture's 25ms successful-retry race under parallel load (isolated suite passed). The fixture now separates its deliberately delayed failure phase and recovered worker using the normal timeout while retaining the durable job budget. M3 production code is unchanged. Final full suite passed; earlier failures remain in ignored local logs.
- Real anonymous API reads through `createApplication` / Source Registry / Supervisor / scoped Host archived **132 reviews, five review comments, three topic bodies and two replies (142 events)** in a disposable database. All replay refs matched the same Host Internal IDs. Discussions discovered 30 topics, completed two, and retained 28 queued tasks plus background offset 30. This is partial backfill, not full history.
- A separate recorded-transport proof used a read-only backup of the existing archive: all **19** comment event IDs, Host IDs and payload bytes survived v1-to-v2 initialization and replay. Both original archive SHA256 values remain unchanged. Current sanitized evidence: `docs/evidence/steam-public-unified-2026-11-04.json`; prior Core evidence is explicitly historical.
- Independent final read-only review confirmed all five checkpoint/budget/identity/serialization findings fixed. No continuous service, paid model, Discord change, Steam write or GitHub business write was activated.

Known limits: undocumented Steam Community routes may change; unavailable/deleted objects and intermediate edits cannot be reconstructed. Large official all-review sweeps return to the head only after their saved cursor completes; this target's smoke does not establish a general latency bound. The new public collectors conservatively do not replenish PR #7's one-hour stability retry budget from ordinary partial snapshots. Delivery is a Draft Steam follow-up PR based on #7, with no auto-merge.
