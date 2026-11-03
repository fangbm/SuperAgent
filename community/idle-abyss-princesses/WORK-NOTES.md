# Idle Abyss Princesses Discord — shared work notes

Updated 2026-11-03. Read this file before any work. Each delegated agent must first create its own work-notes file recording scope, intended actions and verification, then do its assigned work. Record completed actions and remaining work truthfully. Do not equate prepared content with a live setting.

**Latest coordination snapshot (final):** live community setup is complete. Root has sole desktop control and has left the app on welcome. Native Onboarding/Guide, 21 selectable roles plus two unassigned staff labels, nine defaults, three forums/51 tags and all 15 indexed content items (12 messages + three native guidelines) are applied. Root final member preview caught and fixed known-issues inheriting writable permissions, then verified it read-only; general and bug forum remain usable, private-help/STAFF hidden. Permanent invite https://discord.gg/pCKZvmNhFe was copied from Discord and anonymously verified against the correct guild/welcome IDs. See ACCEPTANCE.md and server-state.json. Earlier snapshots below are chronological history and are superseded by this handover. Archive/AI bot and automatic private-ticket workflow are not activated. Candidate paid Server Tag remains unactivated. Task branch: feat/game-discord-community.

## User objective and decisions

Create a dedicated Discord server from scratch for Steam AppID **5335850**, using the game's Steam page as the source of truth for game information, images, names and mechanics. Study real indie-game Discord communities. Configure the language, rules, ping preferences, member join questions, channels, permissions, favorite-character roles and other community basics. The user explicitly authorized opening the signed-in Discord desktop app and using computer control to create/configure the server. Posting the requested setup content to this newly created server is authorized; do not message unrelated servers or people.

Archive requirement: **the archive is the sole source of truth**. Every collected message must be persisted before analysis; analysis reads the archived records. Preserve ordinary messages, bot messages, original text, edits and deletion history. Filtering or prioritization happens after archive commit. Derived issues, summaries, indexes and GitHub are projections, not independent truth. Do not claim the new server's archive/AI bot is already running: it has not been installed or activated in this task.

Previously chosen preferences: collect all public text channels/forums/threads, excluding general staff/private/DM areas; offer public reports plus private support; analyze new public chat in batches; backfill existing history for context without an automatic historical AI backlog; automatic GitHub only when existing evidence checks pass; private report export requires staff approval. The current task prioritizes the dedicated server and complete community setup over a backend rewrite.

The user now explicitly asks to delegate repetitive work using “6.1 Luna.” The available tool model is **gpt-6-luna**; 6.1 Luna is not listed. Delegation may use the available Luna model with that distinction stated to the user.

## Repo and safety boundaries

Repository: D:/code/dc_nai/SuperAgent, private origin fangbm/SuperAgent. Current local branch feat/m4-connectors includes the original M4 implementation plus main 5c2dedf (QQ work preserved). Do not edit frozen packages/contracts, packages/plugin-sdk, contracts.freeze.json or root config. Do not alter M3 or QQ in this server-setup task. Existing M1 archives before its outbox/admission/M3 processing; do not build a second database or queue.

M4 has three draft PRs: #1 Steam Reviews, #2 Discord, #3 Steam Discussions snapshot fallback. Full integrated checks previously passed 161 Node tests and 6 Python suites; Ubuntu/Windows CI passed. This is background evidence, not verification of the new Discord server or an installed archive bot.

Work product folder: community/idle-abyss-princesses/. Native desktop screenshots/action scratch are in ignored .artifacts/discord-desktop/. Do not commit screenshots containing the user's unrelated guild list, DMs or other private desktop details. No Discord bot token was discovered in environment variables; never extract user/session tokens, cookies, local storage or profile credentials.

## Steam facts already verified

Source https://store.steampowered.com/app/5335850/ and public appdetails API with l=schinese / l=english. Metadata snapshots and anonymous HTML are under research/. Image provenance and SHA-256 hashes are in assets/source-manifest.json. All images in assets/source/ are downloaded publisher-provided Steam assets, not AI-generated replacements.

- Chinese name: 深渊放置姬. Official English name: **Idle Abyss Princesses**.
- Developer Peter; publisher Mirako; Steam release date 2026-10-14.
- Desktop idle loot RPG; transparent always-on-top widget; Windows and Apple Silicon macOS.
- Eight heroines, three talent paths each. Loot/build crafting, sets/legendaries/oddities/mythic equipment, rifts and endgame challenges.
- Optional 2–4-player Everlasting Night Court co-op. Single-player works offline. Battles continue minimized, but NOT while the game is closed or the computer sleeps; camp dispatches use real time.
- Steam languages: Simplified Chinese, Traditional Chinese, English, Japanese, Korean.
- Chinese store description lists QQ player group **492771364**. Treat it as the published QQ group number, not an API OpenID, and do not join/message it.
- Favorite-character names are legible in **assets/source/gameplay-02.jpg**, Steam's character-selection screenshot. Exact mapping:
  - 绯娜 — 战士 / Warrior
  - 诺艾尔 — 法师 / Mage
  - 塞西莉亚 — 圣骑士 / Paladin
  - 琳恩 — 猎人 / Hunter
  - 缇亚 — 机械师 / Machinist
  - 伊格妮 — 龙姬 / Dragon Princess
  - 薇拉 — 死灵法师 / Necromancer
  - 云遥 — 修仙者 / Cultivator
- Do not invent English character-name translations, extra characters, roadmap, events, giveaways, support email, rewards, verified status or release promises. Avoid stale secondary descriptions claiming four heroines.

## Research completed

- Discord Game Developer Playbook Part One: https://discord.com/blog/the-game-developer-playbook-part-one-getting-started-on-discord
- Part Two: https://discord.com/blog/the-game-developer-playbook-part-two-early-access-and-pre-launch
- Milky Way Idle public community profile: https://discord.com/servers/milky-way-idle-891160051459436574 — public profile emphasizes strategies/guides and direct feedback/bug discussion with staff.
- Melvor Idle public community profile: https://discord.com/servers/melvor-idle-625838709203271680 — public profile emphasizes idle RPG, updates, guides/theorycraft and community.
- These public profiles and official layout examples were researched. We did NOT inspect private internal channel lists or chats in those other servers, and did not join them.
- Native Onboarding FAQ: https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ — at least **7 default channels**, including **5** where @everyone can View and Send.
- Server Guide: https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ — welcome sign, 3–5 to-dos, read-only resource pages.
- Server banners: https://support.discord.com/hc/en-us/articles/360028716472-Server-Banners — static banner normally requires Boost Level 2; recommended 960x540. Invite background normally Level 1, 1920x1080. Do not buy boosts or paid perks. Free icon/profile color and message-attachment artwork are usable.
- Native four-character server badge/tag is separate from cosmetic member roles and forum tags. Candidate ABYS may be prepared, but paid/eligibility-gated activation has not been authorized or done.
- Grok search is not configured (GROK_API_URL missing); built-in web research and direct public Steam fetches were used. Browser plugin was broken (missing browser-service path); dev-browser Chromium launch failed. Native Discord desktop control works and the account is already signed in.

## Live server created and verified

Stored in server-state.json:

- Guild ID: **1567099916126527530**.
- Name: **深渊放置姬 · Idle Abyss Princesses**.
- Original starter/welcome channel ID: **1567099917372227679**.
- Server created through the signed-in Discord desktop app; no other server modified.
- Icon: official Steam main capsule uploaded and cropped through Discord's own uploader.
- Profile banner color: purple. Description saved with Steam-grounded Chinese/English/Japanese/Korean navigation text.
- Five saved profile traits: 放置刷宝 Idle RPG; 配装研究 Builds; 秘境挑战 Rifts; 联机组队 Co-op; 中文 / English.
- Community mode enabled. Verified-email requirement and explicit-media scan applied. Default notifications set to mentions-only; dangerous @everyone administrative/mass-mention permissions removed via Community wizard.
- Community primary language set to Chinese (中文; Traditional Chinese is a different option). Community updates and safety notifications routed to Discord-created private moderator-only channel; setting save was performed.

### Live channels/categories verified so far

Root channels from Community wizard: **rules** (designated rules channel) and **moderator-only** (private staff updates). They still need bilingual rename, content and placement.

Category **📌 开始这里 · START HERE** (public):
- 👋・欢迎-welcome — starter renamed; bilingual topic saved.
- 📢・公告-announcements — verified native announcement/megaphone type.
- 🛠・更新-patch-notes — verified native announcement type.
- 📚・入门-faq
- 🎭・身份与提醒-roles

Category **語音頻道** (default, still needs rename to game co-op/voice and channel setup): one default voice channel 一般.

Category **🏕 冒险者营地 · COMMUNITY** (public), all six created and visually verified:
- 💬・闲聊-general
- 🙋・新手求助-help
- 🧩・配装交流-build-chat
- 🎁・掉落展示-loot
- 🤝・组队招募-lfg
- 🌐・国际交流-international

Category **🛠 反馈与支持 · FEEDBACK** created, still empty.
Category **🔒 制作组营地 · STAFF** created as PRIVATE; no extra staff roles or members selected (owner retains access), still empty.

**🧩 配装与秘境 · BUILDS category was NOT created**: an early batch missed that dialog and left an unsent draft. The draft was cleared. Prefer adding a builds forum under COMMUNITY to avoid an unnecessary empty category. No setup-draft text has been knowingly posted to chat. No actual player feedback has been received.

### Current desktop state — single-controller handoff point

Discord native UI is Traditional Chinese. Window normally 1951x1101 pixels at physical top-left (86,321), though dialogs can have their own bounds. The helper always uses coordinates relative to the CURRENT active Discord window. The Windows file picker is also owned by Discord and supported. Do not hardcode global display offsets.

**The role editor is currently open.** First character role **⚔️ 绯娜 · 战士** has been created, colored red, and SAVED. Then the role-editor plus button was clicked: a SECOND BLANK ROLE named **新身分** now exists and is selected. Complete/rename this blank role as the next character (诺艾尔), rather than creating another blank first.

Observed role-editor coordinates (relative to main Discord window):
- New role plus: **(882,154)**.
- Role name field: **(1260,410)**; click, Ctrl+A, type.
- Default solid color palette top row at y=938: teal1201, green1246, blue1291, purple1336, pink1381, yellow1426, orange1471, red1516, light-gray1561, slate1606.
- Save Changes sticky button: approximately **(1578,1013)** when changes exist.
- Display / Permissions / Links tabs: x978 / 1103 / 1230, y254.
- Do not click the paid gradient/role-icon/boost controls. Cosmetic role defaults should have no extra administrative permissions, no hoist, no mentionable flag.

### Desktop helper

tools/desktop-control.ps1 provides native Win32 foreground-guarded capture/click/rightclick/type/keys/scroll and optional visible UI Automation inspection (Electron returned no accessible controls, so use screenshots). It does not access account credentials or app internals. It aborts if the app loses focus during a sequence.

Run through elevated exec_command (the default sandbox cannot see/control the desktop):

    powershell -NoProfile -ExecutionPolicy Bypass -File community/idle-abyss-princesses/tools/desktop-control.ps1 -Action capture

Other flags: -X/-Y for relative click/scroll coordinates, -Text for type or SendKeys, -Delta for scroll. Use tools.view_image on .artifacts/discord-desktop/current.png after meaningful changes. Do not print screenshot base64.

For a sequence, write UTF-8 JSON array to an agent-specific ignored scratch path, e.g. .artifacts/discord-desktop/roles-steps.json, then pass -StepsFile that path. Steps look like {"action":"click","x":1260,"y":410,"pause":100}, {"action":"keys","text":"^a","pause":100}, {"action":"type","text":"🔮 诺艾尔 · 法师","pause":200}. Every step pauses only its specified milliseconds, default 600. Use >=900ms to open creation dialogs and >=1500ms after network-backed creation. Verify small proven loops before running batches.

Known main-window navigation:
- ESC exits most settings, but a page transition may consume it; verify.
- Server header dropdown (503,83); Community menu Server Settings (333,300), Create Channel (333,410), Create Category (333,463). Menu changed after Community was enabled; inspect if it changes again.
- Ctrl+Shift+N opens create/join server — do NOT create a second server.
- Server settings sidebar near top: Roles (275,698). Scroll sidebar up to reset before using this coordinate.
- Category plus opens a create-channel modal. **Category-specific dialog has a subtitle and shifted positions:** Text radio(668,323), Voice(668,410), Forum(668,497), Announcement(668,584), Stage(668,671), name field(930,828), Create(1141,941). Text name field auto-focuses; after changing a type, explicitly focus the name field. Root-create dialog omits subtitle and has positions ~42px higher.
- Rename/edit channel/category overview: name field about(1014,282), topic editor(960,482), Save Changes(1576,1021). Permission settings require separate careful inspection.
- Current names can be opened through the server sidebar; Ctrl+K is global across unrelated guilds, so never blindly choose a common name like rules.
- Channel context Copy Link was used; if reading clipboard, only do so immediately after an explicit task copy and validate the expected discord.com/channels/GUILD/CHANNEL format before outputting it. Do not read arbitrary prior clipboard contents.

## Intended remaining setup

1. Complete eight character roles using verified Steam names. Language roles for 简体中文/繁體中文/English/日本語/한국어. Opt-in update/event/playtest pings separate from all cosmetic interests. A few fun interest roles: 配装研究员, 刷宝收藏家, 秘境挑战者, 剧情考据党, 联机搭子. Separate staff roles must never be self-assignable or accidentally granted to everyone.
2. Native Community Onboarding: required language choice; optional multi-interest choices; optional favorite-character choices using the eight Steam names; notifications explicitly opt-in. Plan 7 default channels: welcome, announcements, general, help, build-chat, loot, lfg (5 writable). Optional international/builds/guides/lore/voice channels can be added through interests/language answers. Native Server Guide should contain a welcome and 3–5 short to-dos.
3. Forums under FEEDBACK for public bug reports and suggestions, useful tags and posting guidelines. A builds/guides forum under COMMUNITY can use the 8 heroine/class tags without creating eight empty channels. Create known-issues read-only channel and clear private-support instructions; do not advertise nonexistent slash commands or a working bot/ticket automation.
4. Rules, welcome, official Steam/community links, FAQ, role/ping instructions, initial announcement, feedback templates, moderation notes. Prepare content locally before posting it. Stay below Discord message length limits and never ping @everyone/@here during setup. Do not invent known issues or changelog content.
5. Rename/default voice category and configure 2–4-person co-op voice; keep additional voice optional.
6. Set informational channels read-only, preserve public discussion permissions, verify private staff areas. Review anti-spam/mention-spam settings. No purchases, boosts or unrequested app installations.
7. Capture a working invite and exact live setup inventory, distinguish live/ready/pending. Record original-source asset provenance and archive-first policy.

## Delegation / concurrency

Only **one** agent may issue desktop-control commands at a time. Root will coordinate handoffs. Content/research agents MUST NOT touch Discord, shared screenshots or desktop step files. Use distinct work-notes/output files to avoid overwrite races. Keep regular concise progress updates; no repeated approval questions for already authorized server configuration.
