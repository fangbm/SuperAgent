# PR integration review — 2026-11-03

User authorized review and merge of useful open PRs. The four PRs form a dependency stack (#1 → #2 → #3 → #4). Integration preserves main's M5/M6 implementations, dependencies, commands and tests.

## PR #1 — Steam Reviews

Reviewed official API parameters, paging, watermark overlap, stable review identity, recommendation changes, retries, atomic event/checkpoint commits and the source runner. No connector blocker found. Existing partial-coverage limits remain explicit. The later archive-all mode is reviewed in #4.

Merged main `04392e6` into the PR branch without rewriting history. Resolved README/package/TypeScript reference conflicts by retaining both feature sets.

The first integrated check exposed two existing Windows-only cleanup failures in M5/QQ tests: a second SQLite connection was still open when the shared fixture removed its directory. An isolated bounded run reproduced `EPERM` in both tests. Close the M5 runtime before fixture teardown and close the reopened retirement store in `finally`; production QQ/M5 code is unchanged.

Readiness check: duplicate implementation ✓ (25), architecture ✓ (25), primary API documentation ✓ (20), repository/reference implementation ✓ (15), reproduced root cause ✓ (15). Total 100/100; proceed with the narrow integration/test fixes.

Validation: `pnpm install --frozen-lockfile` and the full `pnpm check` pass on the main-integrated branch: 227 Node tests, six Python reference suites, build/typecheck, boundaries and 45-file contract freeze. These are local/fixture checks, not new live platform permission tests.

## PR #2 — Discord Source

Found and fixed duplicate REST backfill records for full messages already archived from Gateway. Checkpointed message fingerprints ignore transport-only guild/member/nonce fields while retaining the complete original payload and distinct Gateway dispatch history. Different message IDs and real revisions remain independent; partial updates do not fabricate full content. Failed commits retain the prior observation state, and incomplete backfill retains older observations until consumed. See `DISCORD-PR-REVIEW-FIX-NOTES.md`.

Updated onto #1/current main. Frozen install and full `pnpm check` pass: 240 Node tests and six Python reference suites, including the 13 dedicated Discord tests. Live Discord bot/Intent permissions remain untested.

## PR #3 — Steam Discussions

Reviewed the opt-in snapshot envelope, size/count limits, stable object/revision identity, thread/reply consistency, explicit deletion handling and atomic checkpoint recovery. No blocking defect found. The default remote capability remains unavailable; local snapshots report partial. An absent snapshot record never implies deletion.

Updated onto reviewed #2/current main. Frozen install and full `pnpm check` pass: 244 Node tests and six Python reference suites. This validates the local fallback, not continuous or complete remote Steam Discussions access.

## PR #4 — archive-first community bot

Reviewed the shared Gateway routing, private archive policy and its admission/evidence callers, durable lifecycle state/leases, ticket access/deletion, voice ownership/cleanup, setup/runner, backup and deployment paths. No new direct M3/QQ/report/Web business behavior is introduced. The one domain change enforces archive-only evidence visibility.

Fixed the documented install permission set: Discord requires `MANAGE_ROLES` for channel overwrite PUT/DELETE; Administrator remains absent. A realistic 403 test verifies close/add/remove can resume after permission restoration. Guild role assignment remains manual. Carried #2's history reconciliation into both shared-dispatch sources and verified private failure/restart behavior.

Preserved main migrations 001–011 byte-for-byte; source privacy and community state now use 012/013. Renumbered the Discord ADR to 0013. Added upgrade tests from schema 8 and schema 11, preserving events/internal IDs, cursors, outbox and existing migration checksums. Earlier unreleased draft-bot databases intentionally fail closed on mismatched histories; do not edit their migration ledger.

Stabilized two test-only timing assumptions exposed by the larger integrated suite: use an injected clock for the 10 ms lease-validation test; hold the first model response explicitly instead of requiring a successful retry within 25 ms. Production lease and model timeout defaults are unchanged.

Full integrated `pnpm check` passes: **295 Node tests, six Python reference suites**, build/typecheck, dependency boundaries and 45-file freeze. Community validation passes for 21 selectable roles, 9 defaults, 51 tags, 15 original content items and official-artwork hashes.

Known recovery tradeoff: channel creation is not blindly retried after an ambiguous in-flight result. An absent marker can require operator reconciliation, including a crash between saving `creating` and issuing POST. This is a conservative external-effect barrier, not a guarantee of automatic recovery for an unknowable result. Original ticket submissions remain archived. See `DISCORD-PR4-PERMISSION-REVIEW.md`.

No live bot/Intent/ticket/automatic-room verification or Docker execution was performed in this review. The prepared voice creator remains locked while no bot runs. Steam Discussions remains an explicit local fallback. Merge does not deploy or activate services.

## Confirmed GitHub merges

- #1: reviewed head `bfd920a`; merge `1eea48760df6243df70b50db9a8f78f681c564c4`; Linux/Windows CI passed.
- #2: reviewed head `4d2e505`; merge `e9f394300e9d5272b6fd7966fb4b2b05d6a39cdd`; Linux/Windows CI passed.
- #3: reviewed head `09dbb0e`; merge `448c2cc9b287221b4252750d090c124a4a4d8a46`; Linux/Windows CI passed.
- #4: local review and full integrated validation passed; GitHub CI/merge follow.
