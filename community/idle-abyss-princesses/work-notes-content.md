# Content work notes — Idle Abyss Princesses Discord

## Scope
Prepare ready-to-post bilingual Chinese/English Markdown copy and an index under `content/`. Cover welcome, concise rules, FAQ, official links, roles and notification opt-ins, initial announcement, native bug-report/suggestion forum instructions and templates, build-sharing guidance, a cautious initial known-issues note, staff setup/moderation checklist, and plain-language archive/privacy notice. Do not touch Discord, desktop files, code, or external services.

## Intended actions
1. Read shared `WORK-NOTES.md` and the supplied English/Chinese Steam app-details snapshots plus the source image manifest/gameplay screenshot facts.
2. Draft player-facing copy grounded only in verified notes; include provenance links, avoid invented translations/claims, distinguish policy from automation activation, and keep each individual post within 1900 UTF-16 code units.
3. Create UTF-8 Markdown files and `content-index.json` with target channel, audience/permissions, public/read-only/staff status, and post order.
4. Verify local facts, links, JSON parseability, and UTF-16 post lengths; update this file with outputs and actual checks.

## Verification plan
Check every JSON file parses; inspect each document for required topics, source links and unsafe/invented claims; mechanically count each post's UTF-16 units and split any over-limit post. Confirm archive notice does not claim an archive bot or AI processing is live. No live Discord verification is in scope.

## Status
Completed after reading the shared work notes; outputs and checks are recorded below.

## Completed work (2026-11-03)
- Created `content/` with 12 ready-to-post bilingual Markdown posts: welcome, rules, FAQ, official links, role/notification guide, community opening announcement, known-issues initial note, bug-report forum guide/template, suggestion forum guide/template, build-sharing guide/template, archive/privacy notice, and a private staff checklist.
- Created `content/content-index.json` with ordered target channels, audience, visibility and posting mode. It marks currently planned forums/known-issues channel as requiring setup and preserves the explicitly-not-live archive status.
- Grounded game facts and official links in shared `WORK-NOTES.md` and the supplied Steam metadata snapshots. Character Chinese names and class list follow the supplied gameplay screenshot notes. No English heroine translations, support email, roadmap, rewards, or game-change announcements were added.
- Confirmed QQ group is shown only as published number `492771364`. Public support is routed to the forum; private staff help is described as manual, without claiming a working bot/command.
- Verified JSON parsing, required role/notification labels and privacy wording. Measured each Markdown post in UTF-16 code units: all 12 are below 1900 (largest is `rules.md` at 1448). No live Discord verification was performed in this content-only scope.

## Remaining work
- Root/setup owner should map the indexed posts to the final live channel names, create/configure native forums and read-only channel permissions, and only post after checking the final server setup. The archive/privacy notice must be revisited if activation, retention, access, or deletion handling changes.

## Follow-up scope (2026-11-03)
Root requested a publication polish pass and desired-state blueprint. First revise this note before changes. Fix the FAQ co-op count to 2–4 players total and add English answers throughout. Replace the announcement with a natural community welcome. Use the final planned full forum/channel names consistently. Keep archive activation truthful, concise, and useful. Prepare `server-blueprint.json` as a desired inventory only, matching shared notes and `onboarding-spec.json` if available. Include existing categories, channel topics and access policies, roles (including two desired non-self-selectable staff roles, with no claim of assignment), moderation basics, and source Steam asset paths. Do not operate Discord, post externally, edit frozen/M3/QQ material, or commit.

Verification: inspect onboarding-spec and live server-state as references, never conflate them; parse blueprint and content index; verify FAQ counts, full channel names, and every post's UTF-16 length <=1900.

Status: follow-up polish and desired blueprint completed; see verification below.

## Follow-up completed (2026-11-03)
- Split the FAQ into `faq.md` (game basics) and `faq-community-support.md` (community/support), both with Chinese and English answers. Co-op wording now explicitly says 2–4 players total, including the reader.
- Rewrote `announcement.md` as a natural bilingual community welcome; removed meta-disclaimers and unsupported future promises.
- Aligned posts and `content-index.json` to the final requested full names: 🐞・问题反馈-bug-reports, 💡・建议-suggestions, 📘・攻略配装-builds, 📍・已知问题-known-issues, and 🔒・私密求助-private-help. Player-facing copy points to visible moderators/manual support and claims no working automation.
- Shortened the privacy notice while retaining the policy goal, inactive archive/AI status, proposed public-only scope, pending retention/access/edit/deletion details, and practical advice not to post sensitive data.
- Added `server-blueprint.json` as `desired_setup_only_not_live_configuration`. It lays out the five existing category areas, desired channels/topics and access modes, exact 21 cosmetic/opt-in roles, two desired non-self-assignable staff roles (not assigned), moderation basics, and Steam source artwork paths. It references `server-state.json` only as the source for limited actual IDs; no desired setting is represented as live.
- Verification: parsed `content-index.json`, `server-blueprint.json`, `onboarding-spec.json`, and `server-state.json`; verified 13 indexed Markdown posts all at or below 1900 UTF-16 units (largest 1,450); verified co-op total wording, FAQ split, 5 blueprint categories, 21 member cosmetic/notification roles, and 2 unassigned staff roles.

Remaining live setup/posting is outside my file-only scope. Reconcile desired channel names and private-help permissions with the server UI before posting; blueprint remains a proposal, not proof of configuration.

## Final publication batch scope (2026-11-03)
Root requested two concise bilingual posts for publication: an intro for the already-live 🛠・更新-patch-notes channel linking to verified Steam announcements/news and describing where confirmed patch notes will appear, with no invented version/date/changelog/roadmap; and a manual private-help instruction post for the restricted-help channel or FAQ depending on actual public visibility. Update the index. Do not ping @everyone/@here, modify blueprint topology or server-state, operate Discord, or edit other agents' files. Notify onboarding_research once files are ready.

Verification: link destinations, channel names, index ordering, JSON parse, and <=1900 UTF-16 units for every indexed post.

Status: final publication-batch posts complete; verification is recorded below.

## Final publication batch completed (2026-11-03)
- Added `patch-notes-intro.md` for the already-live 🛠・更新-patch-notes channel. It points to the verified Steam News Hub (`https://store.steampowered.com/news/app/5335850/`) and Steam Community, and states that confirmed patch notes will be listed in the Discord channel. It names no version, date, changelog, or roadmap.
- Added `private-help-instructions.md`, indexed to 📚・入门-faq if 🔒・私密求助-private-help is staff-restricted, with an alternate target in private-help if public-facing. It explains how to DM a visible staff member with only a general topic, avoid sensitive details in public, and that requests are handled manually with no automatic ticket command.
- Updated the content index with both posts and the Steam News Hub source link. No mass-ping text appears in these posts.
- Verification: content-index JSON parses; 15 unique indexed posts; every post is below 1900 UTF-16 units (new posts: 443 and 489 units); no `@everyone` or `@here` in any indexed post. FAQ facts and character names were unchanged.

Next: onboarding_research should choose FAQ versus private-help target based on the actual channel visibility before posting. No desktop or external publishing action was performed by this content task.
