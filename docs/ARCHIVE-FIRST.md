# Archive as the sole source of truth

The user's 2026-11-03 requirement is authoritative: **save messages to the archive first, then analyze archived records**.

## Required order

Platform input → immutable archive commit → durable outbox/admission → archive-backed context/batches → analysis → derived projections and external synchronization.

Every message in the authorized collection scope is retained before downstream screening: ordinary chat, bot messages, feedback, edits and deletion events. Screening controls analysis eligibility and priority, never whether the original collected message is first saved. Historical backfill is retained as context; choosing not to analyze old chat does not remove it from the archive.

The existing M1 Source Host already commits source_events, object projections, outbox and checkpoint in one transaction. The M3 worker resolves its candidate/context IDs through stored archive evidence. This order must remain the only analysis path; a Gateway callback, form submission, in-memory buffer or Discord-visible transcript must not bypass it.

## Authority and replay

- source_events is the canonical committed message/revision evidence, including original text and available native platform payload.
- Source URI/event ID identifies the upstream observation; the Host supplies InternalEventId for references.
- Edits and deletions add new immutable events. Derived current views may change, original history is not silently overwritten.
- Batches, extracted items, memory/search indexes, ticket summaries, GitHub issues and reports are derived. They do not override archived evidence.
- A new analysis revision reads the archived records and preserves its source evidence references and run history. It does not silently replace archived content with a new live fetch.
- Submission retries and duplicate deliveries retain existing Host event mappings. Failed archive commits do not advance durable collection progress or acknowledge acceptance as durable.

## Structured tickets and private content

A ticket submission must be persisted before analysis, classification or external issue creation. Persisting a submission and scheduling its work is distinct from creating a Discord channel/post. Generated bot copies and status messages are archived too, but must not become duplicate primary player feedback.

Private evidence remains in its authorized staff-only scope. Any approved sanitized promotion is a new auditable archive event linked internally to its source and approval; it does not rewrite the private original. Public search, Discord replies and GitHub exports must not inherit private raw text through shared context.

## Collection coverage is a separate claim

Archive-first guarantees the processing order for collected data. Discord can withhold inaccessible messages or lose recoverable history during an unresumable connection, and the current connector still requires explicit channel/thread configuration. Report those gaps; do not claim that every platform message was captured merely because the archive commit path is reliable.

The new Idle Abyss Princesses server's community setup is live; see [its handover](../community/idle-abyss-princesses/ACCEPTANCE.md). No archive bot, analysis worker or automatic private-ticket workflow has been activated for that server in this setup task. Live coverage must be verified after collector installation; player-facing setup content must not claim otherwise.

No frozen interface, additional database or second job queue is introduced by this policy statement.
