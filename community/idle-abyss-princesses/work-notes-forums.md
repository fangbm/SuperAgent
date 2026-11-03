# Forums and remaining live-channel execution notes

## Fixed scope
Prepare for the remaining live Discord setup batch only. Do not use the desktop until root explicitly hands it off; `discord_roles` currently controls the desktop. After handoff, execute the locked plan without introducing new design decisions:

- Create and configure three forums with their approved names, tags, guidelines, and public posting policy: 🐞・问题反馈-bug-reports, 💡・建议-suggestions, and 📘・攻略配装-builds.
- Add 📍・已知问题-known-issues as read-only for members.
- Add 🔒・私密求助-private-help using the agreed manual permission-gated support path; no automated ticket claims.
- Add the private staff-ops area and rename the existing rules/voice channels/categories as specified by the current checklist/blueprint.
- Publish only validated content to the applicable channels; preserve existing 7 default channels, 21 cosmetic roles, and onboarding. Staff roles stay manual and never self-assignable.

## Planned verification after handoff
- Use only the native desktop-control helper after root's explicit handoff. Confirm active guild identity before acting; never message another guild/user.
- Verify each created channel/forum by visible UI and task-specific copied link/ID, validating guild and channel ID format before recording. Do not read prior clipboard contents.
- Verify forum channel names, public member posting, tag labels and moderation flags, post guidelines, known-issues member read-only permission, private-help visibility/entry behavior, and private staff area access boundaries.
- Verify rules and voice/category renames, and confirm default channels, all 21 role names, and onboarding remain unchanged.
- Publish applicable content from the validated content index without mass mentions; confirm each message visibly posted and record target channel/message IDs if available.
- Update shared notes with actual live results only; distinguish prepared from configured/published. No purchases, boosts, new bot/app installation, unrelated guild/user messages, credential access, commits, or pushes.

## Files to read before execution
Read `EXECUTION-CHECKLIST.md`, latest `WORK-NOTES.md`, `onboarding-spec.json`, `server-blueprint.json`, `content-index.json`, and the current content work notes. Resolve discrepancies by treating the latest checklist and root's locked choices as execution authority; do not revise the blueprint or content as part of this prep.

## Current status
Prep only. No desktop control or Discord mutation performed. Waiting for root's explicit desktop handoff.

## Preparation pass — ready, awaiting desktop handoff

Read the locked `EXECUTION-CHECKLIST.md`, latest `WORK-NOTES.md`, `onboarding-spec.json`, `server-blueprint.json`, `content/content-index.json`, `work-notes-content.md`, and `work-notes-roles.md`. Root's current direction says `discord_roles` has sole desktop control and no UI work is permitted until a named handoff.

Fixed execution map from the latest artifacts:
- Existing COMMUNITY category already contains general, help, build-chat, loot, LFG, and international; add 📘・攻略配装-builds there.
- Add 🐞・问题反馈-bug-reports, 💡・建议-suggestions, 📍・已知问题-known-issues, and 🔒・私密求助-private-help under existing FEEDBACK. Bug/suggestion/build forum tag/guideline data is in `forum-tags.json`; member tags remain open and staff status tags moderated. Known issues is read-only. Private help is manual and permission-gated with no bot/command claim.
- Existing STAFF category is already private. Add 🔒/🗂️・版务内部-staff-ops as specified in `server-blueprint.json`; preserve the Community-created `moderator-only` updates channel and do not broaden visibility. If manual staff roles are needed under the blueprint, they stay non-self-assignable, manually assigned, least-privilege, no Administrator by default.
- Rename existing root `rules` and move/place it under START HERE as 📜・规则-rules; rename existing `語音頻道` category and its `一般` voice channel to the blueprint's 🎙️ 冒险者语音 · VOICE / 🔊・冒险者语音-party-voice. Do not create duplicates.
- Keep all seven onboarding defaults and all 21 cosmetic/opt-in roles intact. Preserve announcements and welcome as visible default channels, not Server Guide resources. Existing Guide resources are rules/FAQ/roles; the Guide hello task belongs in general.
- Publication target order is content-index orders 1–13. Strip parenthetical planning notes from channel references when selecting the actual channel; send the staff checklist into 🗂️・版务内部-staff-ops within the private STAFF category. Attach `assets/source/steam-main-capsule.jpg` to welcome per locked checklist. Do not post to private-help absent a specific content-index post.

No UI scratch sequence is prepared because the current Discord UI belongs to `discord_roles`, and forum creation dialogs/tag editors must be verified after handoff. Existing `forum-tags.json`, `server-blueprint.json`, `content-index.json`, and the native helper are the prepared execution inputs. Once root hands off, first capture the then-current Discord UI and verify guild 1567099916126527530 before the batch; no desktop action has happened in this prep.

Ready status: all prep/read-only review complete. Waiting for root's explicit desktop handoff. No Discord settings were changed and no content was published.

## Execution start — desktop handoff received 2026-11-03

Root explicitly handed me sole desktop control for fixed Batch 2/3 channel/forum/content execution. Starting UI control now. Fresh current screenshot path is `D:/code/dc_nai/.artifacts/discord-desktop/current.png`; use explicit absolute screenshot and step paths with helper workdir `D:/code/dc_nai/SuperAgent`. Root remains off UI. Preserve saved onboarding, all seven defaults, 21 cosmetic roles, and current Guide state.

First action: capture and visually confirm active Discord guild 1567099916126527530 before any mutation. Then execute the checklist in small proven loops; record actual channel IDs and published message mapping in this file or `live-batch-results.json`, without editing `server-state.json`.

## Batch 2/3 execution update — safe handoff to root (2026-11-03)

Root explicitly requested a handoff at this boundary. No further desktop actions are planned by this controller; current UI is Discord Server Settings > Overview for 💡・建议-suggestions after saving its expanded native guidelines. Screenshot path last captured: `D:/code/dc_nai/.artifacts/discord-desktop/current.png`. Root owns `server-state.json`; this note records verified names/status but this batch did not copy the newly-created channel IDs.

### Live channels, roles, forums, permissions, onboarding

- Reused the existing private Community `moderator-only` updates channel as `🗂️・版务内部-staff-ops`, set a bilingual staff/safety topic, moved it under the existing private `🔒 制作组营地 · STAFF` category, and synced permissions to that category. UI visibly showed `Aegleseeker (only you can see this channel)` before the move. Discord Community Updates / AutoMod messages already in that channel were retained. The owner remains able to access it; staff roles were not assigned to anyone.
- Renamed the existing rules channel to `📜・规则-rules`, updated its bilingual topic, moved it under START HERE, and visually verified its rules-channel badge remained. START HERE category remains read-only for members.
- Renamed the existing voice category to `🎙️ 冒险者语音 · VOICE` and the existing default voice channel to `🔊・冒险者语音-party-voice`; saved user limit **4** and visually verified the slider tooltip read “4 users”. Did not join voice, activate a microphone, or change global audio/privacy settings.
- Created the two blueprint staff role labels `制作组 · Developer` and `版务 · Moderator`; both remain unassigned and absent from onboarding. They have no Administrator grant.
- Created `🔒・私密求助-private-help` as a native private text channel under FEEDBACK, with only the two manual staff role labels selected (plus inherent owner access). Ordinary members cannot see it. Public support route is owner Aegleseeker or visible staff DM; if DMs are unavailable, the content instructs members to ask for private help in public 🙋・新手求助-help without sensitive details. No bot, slash command, or auto-ticket claim.
- Created `📍・已知问题-known-issues` under FEEDBACK; @everyone View remained inherited and I denied @everyone Send Messages, Send Messages in Threads, Create Public Threads, and Create Private Threads. It is member-read-only.
- Created all three forums with public member posting: `🐛・问题反馈-bug-reports` (18 tags), `💡・建议-suggestions` (16 tags), and `📘・攻略配装-builds` (17 tags) in FEEDBACK/COMMUNITY respectively. Topic/platform tags remain member-selectable; all proposed status tags were created with the “only moderators can use tags” setting enabled. I verified that checkbox visibly for bug/build status tags. Required-tag is unchecked in each.
- Native forum post guidelines now contain the bilingual copyable report, suggestion, and build templates. These native guidelines serve as the forum templates; I did not create separate guide threads or any fake player feedback.
- Saved onboarding defaults now total **9**: the original seven plus bug reports and suggestions. The original five writable chats remain selected. The existing buildcraft answer now assigns both 🧩・配装交流-build-chat and 📘・攻略配装-builds and keeps 🛠️ 配装研究员. Other questions, answers, role mappings, pings, and Server Guide stayed unchanged.

### Published content and mapping

Published and visually verified by channel placement; no @everyone/@here or other broad pings used:

1. `content/welcome.md` → 👋・欢迎-welcome, with original `assets/source/steam-main-capsule.jpg` attached.
2. `content/rules.md` → 📜・规则-rules.
3. `content/faq.md` → 📚・入门-faq.
4. `content/faq-community-support.md` → 📚・入门-faq.
5. `content/private-help-instructions.md` → 📚・入门-faq (private-help is staff-restricted); includes the actual owner/staff DM path and public-help fallback without sensitive details.
6. `content/official-links.md` → 📚・入门-faq.
7. `content/roles-and-notifications.md` → 🎭・身份与提醒-roles, with original Steam `assets/source/gameplay-02.jpg` character-selection screenshot attached.
8. `content/announcement.md` → 📢・公告-announcements.
9. `content/patch-notes-intro.md` → 🛠・更新-patch-notes.
10. `content/known-issues.md` → 📍・已知问题-known-issues; states no verified issue list is posted and does not claim the game has no issues.

Not yet published by this controller: `content/archive-and-privacy.md` → FAQ, and `content/staff-checklist.md` → 🗂️・版务内部-staff-ops. Their text remains prepared and validated. Forum guide content posts at index orders 11–13 were not sent separately because their templates are now in the respective native post-guidelines fields; no duplicate guide threads were created.

The content index now has 15 posts after the content agent’s additions; all 15 files were mechanically checked at ≤1900 UTF-16 units (largest 1,448). No bot/app installation, boost/purchase, game-developer verification claim, role assignment to other people, unrelated-server/user interaction, or credential access occurred. No commits/pushes made.

### Root to finish

- Publish archive/privacy and private staff checklist posts from the current index.
- Run the final assembled check: confirm member view/permissions, all 9 onboarding defaults and four mappings, all forum tags/guidelines, current content map, channel IDs/invite, and that no undesired role/channel was created. This controller leaves actual ID collection and final `server-state.json` updates to root.
