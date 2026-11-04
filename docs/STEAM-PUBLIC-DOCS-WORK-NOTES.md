# Steam public feedback docs work notes — unified application port

## Branch and scope

Created before editing the Steam documentation for `feat/steam-public-feedback-unified` based on unified application PR #7 (`a2f1d9a`). Only assigned documentation files are in scope: `docs/M4-CONNECTORS.md`, `docs/M4-STEAM-DISCUSSIONS-RESEARCH.md`, `docs/M4-STEAM-SURFACES-RESEARCH.md`, this operator guide, and these work notes. No old Core/community integration files are to be restored.

## New architecture to document

- Formal entry is `pnpm start --config <application-config>`, implemented by the unified application.
- Trusted plugin definitions and constructors live in `scripts/source-registry.mjs`; the application supervisor owns Source Hosts and lifecycle.
- Steam sources use the unified application config and existing Host abstractions. There is no `scripts/core-runtime.mjs`, `createCore`, or old `core-config.json` in the new Steam architecture.
- Root added `examples/steam-public/superagent.json` with reviews, review comments, and public Discussions enabled; model, GitHub, delivery, and web integrations remain disabled. Database path is `.artifacts/steam-public/state.sqlite`.
- This branch is a Draft follow-up to #7; #5 remains unmerged. Do not push or commit.

## Evidence handling

Live smoke and compatibility proof from the prior branch are historical only because that run used the removed Core integration. The prior record is 131 reviews, 5 comments and 11 discussion events (2 topic bodies and 9 replies), with 49 other topic bodies and remaining reply work queued. Do not present those values as validation of this unified-application branch. A separate bounded Host smoke on the new base is recorded below. No real latency claims are made.


## Documentation port completed

- Ported `M4-STEAM-SURFACES-RESEARCH.md` selectively from `stash@{0}` because it was not present on the unified base; retained route research and marked old Core smoke as historical.
- Updated `M4-CONNECTORS.md` to describe the unified application config, trusted Source Registry, Supervisor, Host, `--check-config`, and `--run-for-ms` entry. Removed obsolete `source:m4`, `--once`, Core config, and old worker instructions.
- Updated Discussions research to distinguish anonymous route observations from old-branch Core smoke and point to the new application guide.
- Rewrote the public-feedback operator guide for `examples/steam-public/superagent.json`, `.artifacts/steam-public/state.sqlite`, and formal `pnpm start` usage. Old Core smoke figures remain explicitly historical; the current unified-application smoke is documented separately with its incomplete topic progress.
- Root owns application config and final evidence; no commit/push was made.


## Unified application smoke update from implementation lead

The new Host smoke at `2026-11-04T06:07:27Z` on base `a2f1d9a` archived 132 reviews, 5 review comments, and 3 discussion topic bodies plus 2 replies (142 events), replayed to the same Internal IDs, and left both original/prepared archive hashes unchanged. Discussions progress was 30 discovered, 3 bodies, 2 completed, 28 queued, background index 30; no full-history or latency claim. Evidence is in `docs/evidence/steam-public-unified-2026-11-04.json`.
