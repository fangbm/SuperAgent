# Steam Discussions public collector — work notes (2026-11-04)

## Scope and compatibility

Add an opt-in `mode: 'public'` collector to `@superagent/connector-steam-discussions`. Preserve the default unavailable behavior and existing explicit snapshot mode. Keep `SourcePluginV1` and the frozen contracts unchanged. The collector uses only the bound Source Host for durable event/checkpoint commits and reports partial coverage because the Steam routes are undocumented and deletions/intermediate edits cannot be recovered.

## Verified public routes

- `GET /app/{appid}/discussions/{forumId}/` initializes the app forum and identifies the app's own forum key, forum gid, and page size.
- `GET /forum/{owner}/{type}/render/{feature}/?start={offset}&count={count}` returns topic HTML and total count. The render path uses the initialized forum `feature` (for the default forum, `0`), not `gidforum`. Topic ids come from `data-gidforumtopic` and the topic permalink.
- `GET /app/{appid}/discussions/{forumId}/{topicId}/` initializes the public comment thread metadata and contains the original post.
- `GET /comment/ForumTopic/render/{owner}/{feature}/?feature2={topicId}&start={offset}&count={count}&oldestfirst=true&extended_data={metadata}` returns reply HTML. The initialization metadata must be echoed; HTTP 200 with `success: false` is an error, not an empty page.

The app/forum owner and gid must be learned from and validated against the matching public app page. No cookies, session values, scripts, or unrelated forum keys are persisted. Steam comment-thread ids vary between requests and are not object identities.

## Collection behavior

- Defaults: forum `0`, 10-minute polling, 2-second request spacing, at most 25 requests per sync including retries, and a 24-hour known-object rescan interval. Requests are serialized per plugin instance.
- Each scan discovers every topic page and visits every topic currently listed. Every poll checks the list head and outstanding/incomplete work; a daily sweep revisits known topics that have moved off the current list. Missing objects never imply deletion.
- Persist unfinished list/topic/reply work, object revisions, observed timestamps, and retryable per-topic gaps in the Host checkpoint. Checkpoints are bound to `appId`, `sourceUri`, and the ordered `forumIds` configuration. Only `commitBatch` advances that checkpoint.
- Object identity is `thread:{topicGid}` and `comment:{topicGid}:{commentGid}`. Replies point to their parent comment or thread and always carry the thread id.
- A changed payload generates a monotonic per-object revision with a persisted observation time. Repeated identical payloads do not create events; A→B→A creates three revisions. No upstream edit timestamp is fabricated.
- When Steam omits a native creation timestamp, the event keeps `createdAt: null` and uses the observation time for the CloudEvent time. Text extraction preserves `<br>` and paragraph breaks while retaining the original HTML fragment.
- Bound public Steam requests to approved hosts/app ids, reject redirects, cap response size and timeout, retry transient failures within the request budget, honor `Retry-After`, and treat private/captcha/permission responses as unavailable or partial. No login or access-control bypass.

## Verification plan

Integration tests use the real Source Host and injected fetch/sleep/clock. Synthetic HTML/JSON fixtures cover list and reply pagination, associations, same-host idempotency, restart and request-budget continuation, A/B/A and title edits, malformed initialization, false-success permissions, 403/429/network failures, failed commits, and missing/deleted topics without deletion inference. No continuous live polling is run.

## Implementation results

Implemented opt-in `mode: 'public'`, kept default unavailable and snapshot behavior, and did not change `SourcePluginV1` or frozen contracts. Public config example: `packages/connectors/steam-discussions/examples/public-config.json`. The connector depends on workspace SDK plus already-installed `linkedom@0.18.15` for HTML parsing.

Targeted verification passed: connector TypeScript build; 9 public collector tests and 4 legacy Discussions tests (13/13). Tests use synthetic fixtures and the real Host; no live or continuous Steam requests were made by the connector tests. Coverage limitations remain as described above.

Root integration follow-up: final public checkpoint version 2 separates per-poll head refresh, daily background pagination and topic/reply work. A persisted scheduling turn supports a one-request budget across restart. Fresh head activity is processed while earlier backfill remains pending, and relative display-time text does not cause a rescan. Streamed responses are capped at 5 MiB; nonnegative totals and exact page offsets/counts are required. Retry-After is checkpointed and the trusted application waits before a restarted instance probes. V1 cached thread metadata can be re-fetched without resetting the reply offset. Final complete checks pass 338 Node tests and six reference suites; root's distinct live smoke remains partial (30 topics discovered, three bodies, two completed, 28 queued), documented in `STEAM-PUBLIC-FEEDBACK-WORK-NOTES.md`.
