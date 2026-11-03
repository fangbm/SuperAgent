# Steam archive collection work notes — 2026-11-03

User scope: discover the game's Steam review/rating, discussion and other public comment surfaces; read supported sources into the existing archive before any analysis. AppID 5335850. Include positive and negative feedback, all available languages and distinct authors. Do not perform semantic deduplication or treat aggregate ratings as individual comments.

## Locked execution plan

1. Inspect current connectors, Host/archive interfaces and runner. Reuse them; no second archive/database/queue and no frozen-contract edits.
2. Verify current official APIs and inspect the actual public game surfaces. Record endpoint, access requirements, pagination/revision behavior and gaps. A reachable web endpoint is not automatically a supported all-history API.
3. Extend the existing reviews connector only as needed to archive all reviews and their revisions. Preserve stable IDs, native data, original text, source URL/time and transaction/checkpoint behavior.
4. Enable other public surfaces only where access and reliable identifiers/pagination are verified. Record unavailable/partial capabilities and keep the existing explicit snapshot import fallback when remote collection is unsupported. Never silently skip blocked pages or infer deletion from absence.
5. Run focused archive integration tests and required checks, collect real available data through the real Source Host into the local project archive, restart/replay to verify progress and idempotence, then report actual counts and remaining gaps. Do not start M3 analysis, external GitHub writes or background services as part of this collection run.
6. Save task-scoped code/config/docs/test changes in a local commit; raw player data stays in the ignored local archive, not Git.

## Initial findings

Existing M4 already uses IUserReviewsService/GetAppReviews (the older appreviews docs are deprecated) but retains only negative reviews and subsequent revisions of tracked negatives. Discussions currently supports explicit local snapshots and truthfully reports remote unavailable. Fresh official-doc and live-surface audit is required before changing that status.

## Ownership

Root: reviews/Host integration, live archive run and final verification. Existing Luna agents may independently research public surfaces or review code; no desktop control or unrelated Discord changes in this task. Each delegate records its own scope/notes first.

## Implementation readiness and result

Confidence check before code: duplicate implementation PASS (reuse M4), architecture PASS (SDK Host only), official docs/live API PASS, existing implementation reference PASS (no new client/library), cause PASS (negative-only retention). Confidence95%; proceeded with a local config/connector extension.

Implemented explicit reviewScope=all plus backward-compatible negative default and scope-bound checkpoint. All mode rewalks pages for metadata changes on old reviews. Added --archive-only to the existing trusted runner; no M1 worker/tick or M3 invocation. Real run committed129reviews, then actual Steam terminal omitted reviews with num_reviews0. Fixed and regression-tested that exact shape; restart completed scan. Fresh full rescan added0events; duplicate Host receipt returned same ID;129pending Outbox,0admission/analysis jobs. Canonical game archive path: .artifacts/idle-abyss-princesses/archive.sqlite.

Raw data stays ignored; sanitized counts in docs/evidence/steam-archive-2026-11-03.json. Forum/comment research and independent review pending at this checkpoint.

## Bounded public review-comment observation

Discovered Steam's native InitializeCommentThread Recommendation configuration on a public review page, then anonymous GET /comment/Recommendation/render/{owner}/5335850/?start=0&count=100 succeeded. Bounded capture of17known nonempty review threads yielded19comments, matching each thread's total and review-reported count. Standard HTMLParser retained rendered text plus exact per-comment native HTML, stable IDs, author identity, native timestamps and source URL. No login/session/cookie use. Local task capture/import helpers and raw data remain ignored.

Imported through the same real Source Host as distinct steam-reviews comment events under source steam-5335850-review-comments-observed; thread and explicit parent review source/RecommendationID preserved. Same snapshot replay accepted0 and same Host mapping verified. Overall canonical archive now148events/148pending Outbox/0admissions/0jobs. Website endpoint remains undocumented and partial; no recurring comment collector is claimed.

## Final verification and handover

Official/public and native-site endpoint matrix completed for reviews, review comments, discussions, news/announcements, screenshots/artwork, guides and Workshop. Public discussion/topic HTML is available; one native reply render returned an explicit privacy error, so no universal denial or all-history support is inferred. News API observed26contentitems but no comment bodies; no player-comment archive claim for news/UGC/discussions. Recommendationcomments captured19asboundedobservation only.

Full pnpm check PASS with existing local tooling PATH and UV_PYTHON3.13 / workspace cache:167Node tests,6Python suites,build,typecheck,boundaries,freeze45files. Final focused14tests also passed. Earlier sandbox integration stall and missing uv/defaultPython3.10 were environment issues; corrected using existing .artifacts tools, no global installation or dependency changes. Independent review found no replay/transaction implementation bug; legacy checkpoint and continuous archive-only coverage gaps were addressed. Raw database/events/comments/HTML remain ignored; only sanitized counts, docs, config and code are committed. No M3, QQ or frozen-contract changes; no background service or external writes.
