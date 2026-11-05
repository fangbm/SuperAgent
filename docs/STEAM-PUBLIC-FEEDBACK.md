# Steam public feedback: unified application configuration

This guide describes Steam connector use through the unified application. The formal entry is `pnpm start`, backed by the trusted Source Registry and application Supervisor. JSON selects built-in sources and their settings; it cannot load arbitrary modules or grant itself extra permissions. Sources commit through their scoped Host. Plugins do not open SQLite, configure admission policy, or call the model.

Current merged functionality and validation are summarized in [Project status](PROJECT-STATUS.md). PRs #6, #7 and #8 are merged into main; dated smoke results below retain their original scope.

## Steam-only application config

`examples/steam-public/superagent.json` enables three Steam sources: all public reviews, comments on reviews, and public Discussions. It uses `.artifacts/steam-public/state.sqlite`. M3 analysis is enabled in this Steam-only config, using a **user-selected OpenAI-compatible endpoint** (cloud API or local server). No Ollama installation or specific model is required. Set `SA_LLM_BASE_URL` (for example `https://your-provider.example/v1`), `SA_LLM_MODEL` (provider model identifier), and `SA_LLM_API_KEY` (provider credential) in the process environment. `analysis.baseURLEnv`, `analysis.modelEnv` and `analysis.apiKeyEnv` resolve the values at startup; do not commit credentials to JSON. If the chosen provider needs no key, remove `apiKeyEnv`. GitHub writes, QQ Delivery, reports and Web remain disabled. Core archives source events first; M1 filters trivial messages to `archive_only`, while actionable feedback reaches M3. No Steam publisher key or login credential is needed for these public routes.

The three sources remain independently bound:

| Surface | Source ID | Source URI | Platform |
|---|---|---|---|
| All reviews | `steam-5335850-reviews-all` | `urn:superagent:source:steam:5335850:all-reviews` | `steam-reviews` |
| Review comments | `steam-5335850-review-comments-observed` | `urn:superagent:source:steam:5335850:review-comments-observed` | `steam-reviews` |
| Public General discussions | `steam-5335850-discussions-public` | `urn:superagent:source:steam:5335850:discussions:public` | `steam-discussions` |

The review-comment connector config names parent source `steam-5335850-reviews-all`. A trusted application initializer can seed its checkpoint from matching existing normalized comment projections for the same bound project/source; it checks source scope and parent/object identity before saving the checkpoint. Plugins never inspect the database. The Discussions config explicitly sets `mode: "public"` and `forumIds: ["0"]`; missing mode remains unavailable, while `mode: "snapshot"` remains available for operator supplied JSON. The forum owner, group, and topic IDs are learned from public page initialization and are not universal constants.

Trusted built-in definitions and factories are in `scripts/source-registry.mjs`. Each enabled source entry in the application config must select a built-in plugin, provide its config, and declare Manifest-matching `permissions` and `secrets`. The config parser resolves relative config and database paths from `examples/steam-public/superagent.json`. Use [the unified application guide](UNIFIED-APPLICATION.md) for the full schema and lifecycle.

## Commands

Validate without starting connectors or opening the database, then run the formal application for a bounded operator window:

```powershell
pnpm install --frozen-lockfile
pnpm build
# Set SA_LLM_BASE_URL, SA_LLM_MODEL and SA_LLM_API_KEY for your chosen provider.
pnpm start --config examples/steam-public/superagent.json --check-config
pnpm start --config examples/steam-public/superagent.json --run-for-ms 60000
```

`--check-config` validates application fields, enabled plugin configs, manifests, and declared permissions; it does not make a Steam request. The application normally runs until stopped. `--run-for-ms` starts the same supervised application and then shuts it down after the requested interval; it is not a one-shot or a full-history guarantee. The connectors begin their own bounded sync on start and poll according to their configs. One active application process should own the database.

The default formal config is `config/superagent.json`; it leaves platform sources disabled. Use `examples/steam-public/superagent.json` when you want the three Steam sources with M3 LLM analysis. For capture without a model, explicitly set `analysis` to `{ "enabled": false, "allowExternalCalls": false }` in a local copy. Trivial greetings/thanks normally remain archive-only, but the frozen default auditSampleRate is 0.02: sampled messages remain analysis candidates and can consume model calls when M3 is enabled. Substantive withdrawals, pending revision chains, new attachments and meaningful thread titles retain reanalysis eligibility. Do not use the old Core configuration, the removed `scripts/core-runtime.mjs` integration, or standalone workers against this application database.

Thread titles remain in attributes.title and verbatim bodies in content.text. M1 considers both; M3 extraction and Bug/suggestion matching receive the original title separately from generated summaries. Exact quotes must come from either title or body, without spanning their boundary; optional evidence offsets still address the body only. QQ/Web original queries display the archived title and body through the same authorized evidence lookup.

## Collection limits

Review comments use defaults of a 10-minute poll, 2-second inter-request delay, a maximum of 25 requests per sync including retries, daily known-object rescans, and page size 100. Discussions uses the same poll and request limits, daily known-topic rescans, and site page size 15. These are local budgets, not Steam rate-limit commitments. A bounded sync continues from Host checkpoints; many topics or review threads may need later polls.

Standalone diagnostic probes still serialize with sync: comments use at most two requests, while Discussions verifies its public forum initialization. In the unified application the new public collectors use passive pre-Host probes; network verification starts through bound Source Host sync. A first-ever 429 is checkpointed immediately without waiting through a long Retry-After, and Core honors that deadline before restarting or probing another instance. The new public collectors do not yet use ordinary partial snapshots to replenish the Supervisor's hour-long stability budget; existing recovery limits remain conservative. Official all-review scans resume their saved cursor until the sweep finishes, so much larger review sets have no established head-freshness latency bound. The opt-in all-review mode stores a strictly increasing observation timestamp in the checkpoint for latest-object ordering; Steam's native timestamp_updated stays in the event attributes.

GetAppReviews is Valve's documented public snapshot API. Review comments and Discussions use anonymous Steam Community site routes that Valve does not document as collection APIs. Health therefore remains partial for these site-native surfaces. A failed request, 403, 429, malformed page, or HTTP 200 with `success: false` is an error, not an empty page, and does not justify advancing the failed page checkpoint. Forum replies require `extended_data` from the public topic's `InitializeCommentThread` data. Missing or inaccessible objects are not deletions; polls cannot reconstruct every intermediate edit or offline deletion.

## Validation evidence — unified application

A real bounded Host smoke completed on unified base `a2f1d9a` at 2026-11-04T06:07:27Z through `createApplication`, the trusted Source Registry, Supervisor, and scoped Hosts. Analysis was disabled and collection was not continuous. Read-back contained 132 review records, 5 review-comment records, and 3 discussion topic bodies plus 2 replies (5 discussion records), for 142 normalized events. Replay mapped all 142 events to the same Internal IDs; the original and prepared archive hashes remained unchanged. The sanitized [smoke evidence](evidence/steam-public-unified-2026-11-04.json) records these results.

The forum scan discovered 30 topics, read 3 topic bodies, completed 2 topic reply scans, and left 28 tasks queued with the background index at 30. The run did not complete full history. Integration fixtures exercise fresh topic/reply discovery during pending backfill under a four-request budget and checkpoint resume with a one-request budget; those checks do not establish a real-world latency bound.

A separate compatibility proof used a read-only SQLite backup and a recorded native comment capture (no live API assertion). It preserved all 19 existing comment source event IDs and payload bytes after checkpoint v1-to-v2 initialization and replay. The production archive was unchanged.

Initial unified Steam validation passed `pnpm install --frozen-lockfile` and full `pnpm check`: 338 Node tests, six Python reference suites, build/typecheck, dependency boundaries and all 45 frozen hashes. That initial snapshot corrected the existing M3 25ms timeout fixture without changing M3 production behavior. Subsequent PR #8 review fixes did change M1 revision admission, M3 title evidence and matching, Domain quote checks, and QQ/Web original views; their regressions bring the merged main baseline to 355 Node tests plus six reference suites. Windows and Ubuntu PR CI passed for final feature head 121f1cb. See [current validation](PROJECT-STATUS.md) for the baseline and limits. Fixtures do not replace live permission or long-running evidence.

The earlier pre-unified branch smoke remains historical: 131 reviews, 5 review comments, and 2 topic bodies plus 9 replies, from the removed Core integration; see its [historical evidence file](evidence/steam-public-feedback-2026-11-04.json). Its checkpoint proof and the earlier 129-review/19-comment archive counts are not results from this unified-application smoke. No production full-history or new-feedback latency claim follows from a bounded run.

See [Discussion route research](M4-STEAM-DISCUSSIONS-RESEARCH.md), [Steam surface research](M4-STEAM-SURFACES-RESEARCH.md), [connector behavior](M4-CONNECTORS.md), and [unified application acceptance](UNIFIED-APPLICATION-ACCEPTANCE.md). Do not copy player text into checked-in docs or fixtures.
