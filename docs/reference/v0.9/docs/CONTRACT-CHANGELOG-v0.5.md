# Contract Changelog v0.5

## Changes

- `TriageResultV2` replaces single-label triage for **new** Agent analyses: `items: FeedbackItemV2[]` (0..N); defect/suggestion discriminated union.
- `EvidenceAnchorV2` uses Host `InternalEventId`, can point multiple items at the same source event; optional quote and range must match stored evidence.
- Added `SuggestionMatchResultV1`, `SuggestionStatusV1`, `SuggestionActionRequestV1`, `AgentContextV2`, `AgentWorkerV2`.
- `AgentContextV1` remains unchanged, `AgentCoreV1` and Source/Delivery Plugin v1 remain unchanged.
- Added `ReportV2`, separate defect/suggestion counts and source event count. Default time remains Asia/Shanghai 18:00/00:00.
- DB: `002_feedback_items_and_suggestions.sql`, unified `external_work_links`, suggestion domain tables.
- Tests and fixtures added for mixed intent, 2 suggestions, question-only, invalid category combinations, SQLite identity/uniqueness.

## Compatibility

- `NormalizedEventV1` stays exactly the v0.4 protocol; `feedback-batch-v1.schema.json` stays unchanged.
- `TriageResultV1` and `ReportV1` are deprecated but retained for old records.
- The new internal Agent output requires a v2 worker; don't replace a v1 parser without version negotiation.
- New task kinds added to the `AgentTaskV1` list are only processed by runtimes advertising suggestion support; older task consumers must reject unknown kinds explicitly rather than silently acknowledge.
- Migrate link reads to `external_work_links`; the prior `external_issue_links` becomes legacy read-only after successful migration.

## Non-goals

- No live QQ/GitHub integration is implied by these static contracts.
- LLM classification accuracy and suggestion dedupe quality require labeled-data evaluation, not just schema validation.
