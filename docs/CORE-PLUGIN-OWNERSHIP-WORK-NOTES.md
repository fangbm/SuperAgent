# Core-owned ingestion and processing — 2026-11-04

## Agreed design

The main program loads QQ, Discord and Steam plugins in-process. Only Core owns the existing SQLite archive, source registration/policy, durable state, outbox and analysis scheduling. Plugins receive bound Host capabilities and return platform material; they cannot change another source's policy. Archive-first does not mean analysis-disabled.

## Implementation order

1. Confirm current main, preserve frozen APIs and migrations 001–013, and reuse the existing runtime/services.
2. Centralize trusted source configuration and process/runtime ownership; keep legacy collection commands as compatible delegates.
3. Make ticket submission archival plus lifecycle/open-user/idempotency initialization one synchronous Host transaction. Recover legacy orphaned submissions without replaying Interaction.
4. Verify normal public analysis eligibility, private isolation, unrelated-source preservation, transaction failure/restart recovery and database upgrade compatibility.
5. Update usage/deployment/architecture docs, run full checks, commit and open one corrective PR.

## Constraints

- No new network ingress service, database, queue or Agent Runtime.
- No frozen Source SDK/contracts or existing migration edits.
- Public source policy comes from Core; private tickets keep the previously agreed staff-only archive policy.
- Model/network writes remain explicit Core configuration. No live activation or credentials are part of this work.
- Real Discord API effects with unknown outcomes still require reconciliation rather than blind POST retry.

## Starting findings

Baseline: `66eecc5`. Discord startup changes every existing source under its public project to archive_only. Ticket submission commits the source event before independently writing three state keys; the current test recovers by replaying Interaction. Both are confirmed defects. Migration numbering was already corrected to 012/013 before the prior merge.

## Validation/results

Readiness: duplicate implementation check ✓ (25), architecture/frozen API check ✓ (25), official SQLite transaction documentation ✓ (20), existing repository/Node implementation reference ✓ (15), confirmed root causes ✓ (15). Total 100/100. Reused existing services instead of adding storage/queue/runtime implementations.

Implemented `pnpm start --config community/idle-abyss-princesses/core-config.json`. The Core owner loads QQ/Discord/Steam sources, provides exact registry-bound Hosts, owns community controller leases/state and shares its runtime with optional M3/M5 services. Legacy collection commands delegate to Core. Discord configuration no longer selects a Steam collector; Core declares them independently.

Core ticket submission atomically commits the event, open-ticket index, pending lifecycle entity and interaction receipt. Startup repairs legacy orphaned submissions and stale indexes without replay. An independent review reproduced the stale-closed-pointer case; the fix is covered, including preserving closed history. Recovery builds its active-ticket index once per pass. The legacy event audit marker remains byte-compatible for strict in-flight replay and never controls source policy.

Final local checks: locked install and complete `pnpm check` pass, **318 Node tests and six Python reference suites**, including build/typecheck, dependency boundaries, 45-file freeze and schema 8/11 upgrade checks. Separate community configuration/artwork validation passes. Frozen APIs and migrations 001–013 have no diff.

New evidence includes actual child-process SIGKILL inside and after the ticket transaction; recovery succeeds without Interaction replay. A local HTTP model fixture verifies plugin material is committed before the existing M3 worker analyzes it. Multi-source tests preserve previously processed/unlisted QQ sources and private-source isolation. Offline config validation checks platform files/bindings without credentials or opening an archive.

Canonical and prepared archive hashes remain `68e260760724e61d7b906b536ea644ff6e6eb66b774d5e0dcbaf9fd4eec1e2cd` and `74ed4205d6a224dc543e7e02b9ce5e51bb48ddc0eb3ef2855fce35d1a7182336`. No live bot/platform permission test, paid model call, deployment or Docker build was performed. The example Core config explicitly leaves model analysis disabled; public-source standard processing eligibility is independent of that switch.
