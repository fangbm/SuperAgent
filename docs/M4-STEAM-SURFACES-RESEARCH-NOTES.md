# Steam community surfaces research notes — 2026-11-03

## Scope
Independently audit anonymous public Steam feedback/comment surfaces for AppID 5335850: discussions/topics/replies, news/announcement comments, review comments, screenshots/artwork/guides/Workshop comments or ratings. Produce a concise endpoint/capability matrix and current live findings in `docs/M4-STEAM-SURFACES-RESEARCH.md`.

## Planned actions
1. Use current primary Steamworks/Steam Support documentation for supported public API capabilities, authentication, pagination, reply coverage, and revision behavior.
2. Inspect the actual public store/community pages and anonymous responses for the target AppID; use documented endpoints where possible and distinguish them from site-only/undocumented endpoints.
3. Record public-access observations and real URLs/endpoints, explicitly labeling API support, pagination/completeness, access rules, and blocked/unknown states.
4. Verify claims against the local official AppID and live Steam response. Do not infer unavailable surfaces from a browser/tool failure.

## Verification and boundaries
- No cookies, login/session extraction, authentication bypass, desktop actions, code changes, root-note edits, or archive run.
- Do not claim a complete archive API unless docs and live behavior support it; note any user-initiated/community-snapshot paths separately.
- Root owns review implementation and archive execution.

Status: read `docs/M4-STEAM-ARCHIVE-WORK-NOTES.md` first; this note is recorded before research. Research pending.

## Completion — 2026-11-03

Created `docs/M4-STEAM-SURFACES-RESEARCH.md` from current official Steamworks documentation, anonymous public Steam Community/API probes, and root-provided live review-comment evidence. The matrix separates documented anonymous endpoints (GetAppReviews/GetNewsForApp), API-key or client-only UGC methods, public current HTML surfaces, undocumented native comment render routes, and explicit privacy/unknown results. No code, root notes, desktop state, cookies/session values, or archive data were changed.

Verified live evidence included: public discussions index HTTP 200 with topic links; sample public topic GET HTTP 200 with one reply count and stable topic/thread IDs; its derived anonymous native render POST returned `success=false` / `This profile is private.`; public GetNewsForApp HTTP 200 with 26 items and no comment fields; screenshots index HTTP 200 with five item IDs and a sampled screenshot detail page with no comment renderer; guides/images/workshop indexes returned HTTP 200 with no item IDs observed; review-comment native endpoint evidence was supplied by root (19 bodies/17 review threads). Report labels all undocumented or incomplete areas as such and does not infer platform unavailability from the web tool failure.
