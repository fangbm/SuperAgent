# Onboarding research work notes

Scope: verify game and public indie Discord reference facts; produce `research/community-references.md`, `onboarding-spec.json`, and `forum-tags.json` in `SuperAgent/community/idle-abyss-princesses/`.

Planned actions: use the local Steam appdetails JSON and `assets/source/gameplay-02.jpg` as truth for Steam-facing names/features/classes; verify relevant constraints against current official Discord documentation; review publicly visible Milky Way Idle and Melvor Idle community pages. Distinguish documentary constraints from design recommendations. Do not join servers or inspect private channels. Do not make desktop changes or post to Discord.

Verification: include direct primary source URLs and scope caveats; ensure onboarding and channel specs are fully populated and bilingual, match shared work notes, keep all self-selectable roles cosmetic, and separate opt-in notification roles. Validate JSON syntax and check all proposed forum tags fit Discord's 20-tag limit per forum.

Boundaries: no edits to `content/`, root `WORK-NOTES.md`, frozen/M3/QQ work, and no commits. Report prepared artifacts distinctly from live Discord settings.

## Completed

- Read `WORK-NOTES.md` first and recorded this task-specific note before research.
- Verified English/Simplified Chinese Steam appdetails fields and visually inspected `assets/source/gameplay-02.jpg`; confirmed English title, five supported languages, eight exact Chinese hero/class names, gameplay facts, and offline/co-op caveats.
- Verified current Discord Community Onboarding, Onboarding Examples, Server Guide, Forums, API Forum Tag Object, permissions, and Server Banner docs. Reviewed the public Milky Way Idle and Melvor Idle Discovery pages plus Discord's 2025 game-developer Playbook parts 1 and 2. No server joining, private-channel inspection, Discord desktop action, or posting occurred.
- Created `research/community-references.md`, `onboarding-spec.json`, and `forum-tags.json`. They are proposals/research artifacts; no live Discord onboarding, forums, tags, badge, or Server Guide was configured by this work.
- Parsed both JSON outputs. Onboarding validation: 7 default channels, exactly 5 with @everyone view/send, 4 bilingual questions (required single-choice language; optional multi-select interests and favorites before join; separate optional notification multi-select after join), 5 languages, 5 interests, 8 characters, 3 notification roles left unassigned by default.
- Forum tag validation: bug 18, suggestions 16, builds 17 tags; all under the 20-per-forum limit and tag names under 20 characters. Staff status tags are marked moderated; roles remain cosmetic.

Note on evidence: Discord's live API docs confirm 0–20 characters per tag name and the `moderated`/Manage Threads behavior. The 20-tags-per-forum / five-per-post product limit is attributed in the research file to Discord's archived Help Center community feedback page; it is not represented as language from the current official FAQ/API docs.

## Remaining

None within this delegated research/spec scope. Root may now carry the prepared artifacts into its server-configuration workflow if desired.

## Consistency pass — 2026-11-03

Scope: reconcile `onboarding-spec.json`, `forum-tags.json`, and `research/community-references.md` with the current prepared `server-blueprint.json` and root's exact channel names. Do not edit `content/` or `server-blueprint.json`; do not use Discord UI or post externally. Preserve the seven default channels and all 21 member-role labels verbatim while the desktop agent configures them.

Planned fixes: point Server Guide's hello task to general; standardize the five live-intended forum/reference channel names; keep welcome and announcements as visible default channels rather than Guide resources, using rules/FAQ/roles as resources; clarify native guild-tag versus paid/eligibility-gated server perks without claiming unlock or purchase; remove any implication that archived community feedback is current official hard-limit documentation.

Verification: parse both JSON files; compare role labels against the prior spec (21 total); verify seven defaults/five writable remain unchanged; check Discord-facing string lengths using UTF-16 where applicable; inspect the blueprint read-only for relevant names and copy alignment; update this note with results.

### Consistency pass complete

Compared read-only against `server-blueprint.json`; did not edit blueprint or `content/` and did not use Discord UI or post externally.

Fixes made:
- Server Guide “Say hello” now points to writable `💬・闲聊-general`.
- Standardized forum and feedback names to the blueprint: `🐞・问题反馈-bug-reports`, `💡・建议-suggestions`, `📘・攻略配装-builds`, `📍・已知问题-known-issues`, and `🔒・私密求助-private-help`.
- Guide resources are read-only rules, FAQ, and roles/notification instructions; welcome and announcements remain Default Channels and are explicitly excluded from resource conversion. To-do copy is bilingual.
- Reworded forum-tag counts (20/forum, 5/post) as conservative planning targets reported by archived community feedback, not current official hard limits. Current API-documented tag-name character limits remain separate.
- Verified Discord's current Server Tags Help Center and Boosting FAQ: “Server Tag” is the current feature name, a separate additional perk needing three available Server Boosts and ongoing allocation, distinct from roles/forum tags and Discord Guilds. ABYS remains only a candidate; no availability check, allocation, activation, or purchase occurred.

Validation: JSON parse passes; seven defaults and five writable defaults preserved; all 21 member role labels exactly match the blueprint with no missing/extra labels; all five exact requested feedback names match; forum tag counts are 18/16/17; max forum tag label is 17 UTF-16 units, max onboarding question/answer is 95 UTF-16 units, max referenced channel name is 21 UTF-16 units; five Server Guide to-dos and resource/read-only exclusions check out.
