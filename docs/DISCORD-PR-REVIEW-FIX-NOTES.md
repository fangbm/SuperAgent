# Discord source review fix

## Root cause

The REST history path and Gateway dispatch path use different event keys when they normalize the same message. Because those keys participate in the normalized event ID, host idempotency does not recognize an unchanged Gateway message when the periodic history poll reads it again.

## Approach

Track a hash of each complete message representation in the existing source checkpoint, scoped by channel and message ID. The comparison excludes Gateway/REST transport-only fields (`guild_id`, top-level `member` and `nonce`, and `member` snapshots nested in `mentions`). Gateway create and complete update dispatches store that observation in the same atomic `commitBatch` as their events. History skips representations whose hash matches a Gateway observation, while preserving existing event IDs and raw native payloads. Partial Gateway updates and deletes remain independent dispatch events and do not overwrite a known complete representation.

Observations are only added by Gateway dispatches, since REST snapshots already have stable content-derived IDs. When history catches up, the checkpoint keeps only the 100 most recent Gateway observations per channel (the REST page size); older backfill observations are dropped as their pages are processed.

The regression test covers an unchanged REST representation being skipped after Gateway ingestion and a changed full representation still being archived.
