# Discord role setup — work notes

Scope: complete the live cosmetic and opt-in member roles in guild 1567099916126527530 through the existing native desktop-control helper. User/root explicitly authorized this setup. Use only the role editor and verify saved names/colors and absence of a remaining unnamed blank role.

Intended actions:
- Rename the already-created selected blank role 新身分 to 🔮 诺艾尔 · 法师; do not create another blank before renaming it.
- Complete the remaining six Steam-verified character roles, then five language roles, three notification roles, and five fun-interest roles (21 total roles, counting the already saved ⚔️ 绯娜 · 战士).
- Keep every role cosmetic/opt-in: solid free color, no extra admin permission, no hoist, no mentionable, no paid styles/icons. Do not create/configure staff roles or change onboarding.
- Use agent-specific ignored scratch files under .artifacts/discord-desktop/ and capture/inspect the live UI after small loops and completion.

Verification plan: inspect role editor screenshots while saving small batches; verify the inventory totals 21 expected named roles and no 新身分/unnamed extra role remains; record exact current UI state and any limitations here and report to root.

Status: beginning; role editor opened with ⚔️ 绯娜 · 战士 saved and a second blank role 新身分 selected, per shared notes.

## Completion update — 2026-11-03

Completed and saved the 21 requested roles in guild 1567099916126527530:

- Characters (8): ⚔️ 绯娜 · 战士; 🔮 诺艾尔 · 法师; 🛡️ 塞西莉亚 · 圣骑士; 🏹 琳恩 · 猎人; ⚙️ 缇亚 · 机械师; 🐉 伊格妮 · 龙姬; 💀 薇拉 · 死灵法师; ☯️ 云遥 · 修仙者.
- Languages (5): 语言 · 简体中文; 語言 · 繁體中文; Language · English; 言語 · 日本語; 언어 · 한국어.
- Notifications (3): 🔔 更新提醒; 🎉 活动提醒; 🧪 测试招募.
- Interests (5): 🛠️ 配装研究员; 🎁 刷宝收藏家; 🌀 秘境挑战者; 📖 剧情考据党; 🤝 联机搭子.

Verification: live role list visibly showed all five languages, three notification roles, and five interests; the eight character roles were visibly present above them. No `新身分`, unnamed role, or extra blank role remained; `@everyone` followed the final named role. Each role was assigned a free solid palette color. Checked the selected interest role's Permissions view: visible server permissions (View Channels, Manage Channels, Manage Roles, emoji permissions) were off. Checked the lower Display options: “display separately from online members” (hoist) and “allow anyone to @mention this role” were both off. All roles were created from default cosmetic settings; no extra permissions or privileged roles were added. No staff roles configured. No paid role style or icon used.

Exact current UI state: native Discord Settings > Roles editor remains open in guild 1567099916126527530, with `🤝 联机搭子` selected, Display tab active, scrolled to the bottom. The hoist and mention toggles are visibly off. No unsaved-change banner. Last screenshot is `.artifacts/discord-desktop/current.png` (local ignored scratch; do not commit).

Next: hand Discord desktop control back to root. Onboarding not opened or changed.

## Follow-up intent — native Community Onboarding

Follow-up authorized by root 2026-11-03. I regain sole desktop control; root will not touch Discord until I explicitly hand back. Scope: configure live native Community Onboarding, first set only the START HERE informational category's @everyone permissions to View/History allowed and Send denied; then use the prepared `onboarding-spec.json` and `forum-tags.json` to map existing channels and the 21 roles already completed. Do not duplicate channels/roles or alter public discussion permissions. Seven onboarding defaults are the specified welcome, announcements, general, help, build-chat, loot and lfg channels. Configure required single-choice language, optional multi-choice interest/character, and optional notification opt-ins if the native UI supports those mappings. Do not pretend forums exist. Configure Server Guide only with 3–5 to-dos and actually present/read-only FAQ, rules, roles resources. Native rules screening may use content/rules.md if ready, but do not post seed messages or modify source content. Record exact live changes, blockers, and final UI state before handoff.

Current follow-up status: intent recorded; next inspect prepared spec files and shared live-channel notes before UI action.

## Locked execution checklist reviewed — 2026-11-03

Read `EXECUTION-CHECKLIST.md` per root's direction. Proceed in the locked batch order without revisiting settled choices. Current native Onboarding wizard is in step 3, pre-join required questions. Seven default channels and category overwrite are completed. Language question (5 mappings) and interests question (5 mappings) are configured. The first five of eight optional favorite-character answers are now configured. Continue with three remaining character answers, then post-join optional notifications, Guide, save/publish, and one final verification. Record actual completion and hand off desktop only after the fixed batch is done.

## Native Onboarding / Guide completion — 2026-11-03

Completed in guild 1567099916126527530 and enabled through the native Community Onboarding settings. The final page displayed `Enabled` with the toggle on and no unsaved-change banner; the previous save action completed. Desktop handoff is now safe.

### Live onboarding configuration

- Defaults: exactly seven selected — 👋・欢迎-welcome; 📢・公告-announcements; 💬・闲聊-general; 🙋・新手求助-help; 🧩・配装交流-build-chat; 🎁・掉落展示-loot; 🤝・组队招募-lfg. The UI reported seven defaults and marked them `Very good`. START HERE @everyone has View/History allowed and Send/Send in Threads denied, verified inherited by welcome. The other five defaults remain writable.
- Pre-join Q1: required, single-choice language, with 简体中文→语言 · 简体中文; 繁體中文→語言 · 繁體中文 + 🌐・国际交流-international; English→Language · English + international; 日本語→言語 · 日本語 + international; 한국어→언어 · 한국어 + international. Preview confirmed English grants its role and international channel.
- Pre-join Q2: optional multi-select interests. 🛠️ 配装与理论构筑 / Builds→🛠️ 配装研究员 + build-chat; 🎁 掉落、装备与收藏 / Loot & collecting→🎁 刷宝收藏家 + loot; 🌀 秘境与终局挑战 / Rifts & endgame→🌀 秘境挑战者 + help; 📖 剧情与世界观 / Story & lore→📖 剧情考据党 + general; 🤝 联机与组队 / Co-op & parties→🤝 联机搭子 + lfg. Preview selecting all five confirmed five roles and the five existing public channels; no proposed forums treated as live.
- Pre-join Q3: optional multi-select favorite character question, all eight exact role choices and one-to-one role mappings verified in preview: 绯娜, 诺艾尔, 塞西莉亚, 琳恩, 缇亚, 伊格妮, 薇拉, 云遥. During setup, the Tiya and Igni choices were briefly combined by selecting an existing option instead of Add Answer; corrected to separate choices with only their respective roles, and final preview shows all eight individually.
- Post-join Q4: optional multi-select `你想接收哪些提醒？ / Which optional notifications?`; choices map separately to 🔔 更新提醒, 🎉 活动提醒, 🧪 测试招募. No channels assigned and no roles preassigned; opt-in remains separate from language/interests/characters. The step-3 UI was configured in the post-join mandatory-question section. This post-join prompt did not appear in the pre-join preview flow, as intended.

### Server Guide

- Welcome card saved under the server owner author with the concise bilingual text: `欢迎来到深渊放置姬！聊配装、掉落、秘境与组队。请选择语言，按需选兴趣和角色身份组。通知提醒完全自愿。 | Welcome! Talk builds, loot, rifts and co-op. Choose a language and any interest or character roles. Notifications are opt-in.` Final preview displayed the full text without truncation.
- Four explicit tasks: `看看新手频道 / Visit player help`→help (send message); `分享你的配装 / Share a build`→build-chat (send message); `加入组队 / Find a party`→lfg (send message); `打个招呼 / Say hello`→general (send message). The native Read Rules task is also present. Preview showed the four custom tasks and Read Rules. The UI's task list also displayed a vague default `Talk to community in #general` example flagged “not specific enough”; it was not an editable task in the editor or part of the preview task count. Explicit Say hello was added in general as requested.
- Guide resources added only for `📚・入门-faq`, `🎭・身份与提醒-roles`, and `规则 / Rules` linked to the existing rules channel. No welcome resource was added. The rules resource title/description are bilingual. The rules channel was available in the Guide resource picker, which only lists channels readable by @everyone.
- Final preview verified the language/interest/character screens, mapping summaries, four tasks plus Read Rules, and the three resource pages. Review still shows a warning: 8 of 12 public channels are assigned through defaults or questions; four optional public channels remain unassigned. The seven defaults and Server Guide show green status; this unused-channel warning did not prevent enabling.

Exact current UI state: native server settings > Community Onboarding (`培訓`), review/configuration page, onboarding is enabled and saved, no pending changes. Discord desktop control is handed back to root. Last screenshot in ignored `.artifacts/discord-desktop/current.png` shows `Enabled` toggle on and no save banner. No content seed messages, staff roles, forum channels, purchases, or onboarding source/spec files were changed by this controller.

### Final save-state correction / handoff — 2026-11-03

Coordinator's earlier screenshot showed the independent Server Guide switch still off while the save was settling. Captured the current live settings again after save completed: both `Enabled Onboarding` and the separate `Server Guide` toggle are on, no unsaved-change banner is present, and the review lists 7 defaults, the 8-of-12 channel-assignment warning, and Guide ready. This is the authoritative final state. Fresh handoff screenshot absolute path: `D:\code\dc_nai\.artifacts\discord-desktop\current.png` (caller cwd ignored scratch, not `SuperAgent/.artifacts/current.png`). Desktop remains with sole controller/root; no further UI actions pending from this role controller.
