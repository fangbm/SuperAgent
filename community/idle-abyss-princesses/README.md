# 深渊放置姬 · Idle Abyss Princesses community

Dedicated Discord setup for [Steam AppID 5335850](https://store.steampowered.com/app/5335850/).

Live server: **1567099916126527530**. [Join the community](https://discord.gg/pCKZvmNhFe) (nonexpiring, unlimited uses). Discord's public invite endpoint verified the guild and welcome-channel IDs. Existing members can [open the welcome channel](https://discord.com/channels/1567099916126527530/1567099917372227679).

The live setup includes five categories, 19 channels (three forums and one four-person voice room), 21 self-selectable roles plus two unassigned staff labels, four onboarding questions, Server Guide, and 51 forum tags. All 15 content items were applied: 12 messages and three native forum guidelines. See [ACCEPTANCE.md](ACCEPTANCE.md) for evidence and remaining limitations.

## Work records and configuration

- [WORK-NOTES.md](WORK-NOTES.md): authoritative task context, sources, permissions, completed live work and desktop handoffs.
- [EXECUTION-CHECKLIST.md](EXECUTION-CHECKLIST.md): fixed plan for completing setup in batches.
- [server-state.json](server-state.json): actual guild/channel IDs and verified live settings, with draft/pending states kept explicit.
- [server-blueprint.json](server-blueprint.json): desired categories, channels, topics and policies; not proof those changes are live.
- [onboarding-spec.json](onboarding-spec.json): member-role choices, nine default channels, the original five writable chats and Guide settings; live evidence remains in server-state.json.
- [forum-tags.json](forum-tags.json): topic/platform/character tags and moderated staff status tags.
- [content/content-index.json](content/content-index.json): ordered, bilingual seed posts, each within 1,900 UTF-16 code units.
- Agent work notes record their own verified actions and remaining work separately.

## Game and design sources

[research/game-facts.json](research/game-facts.json) records the Steam-grounded title, supported languages/platforms, co-op and offline-play facts, and all eight Chinese heroine/class names. The character selection screenshot in [assets/source/gameplay-02.jpg](assets/source/gameplay-02.jpg) is the name reference. English class names are documented on Steam; unverified English heroine-name translations are not invented.

[research/community-references.md](research/community-references.md) distinguishes official Discord requirements, publicly observed indie-community descriptions and this server's design decisions. No private channel list or chat history from another server was inspected. Original Steam artwork URLs/hashes are in [assets/source-manifest.json](assets/source-manifest.json); full anonymous page snapshots remain local research cache.

## Archive-first requirement

The archive is the sole source of truth: collected messages are committed before screening, batching or analysis. Original messages and revisions remain evidence; summaries, search indexes and GitHub are derived. The existing M1 path already enforces archive commit before its outbox/admission chain. See [ARCHIVE-FIRST.md](../../docs/ARCHIVE-FIRST.md).

**The new server's archive/AI bot and automatic private-ticket workflow are not installed or enabled by this setup.** Native forums and manual staff support must not be described as verified bot automation. Public seed content states activation status honestly; collector installation, permissions, continuous capture and recovery require separate live verification.

The game's separate Steam sources have populated the existing M1 archive with 129 public reviews and a bounded observation of 19 review comments, without analysis. Their [archive record and run command](../../docs/M4-STEAM-ARCHIVE.md) use `.artifacts/idle-abyss-princesses/archive.sqlite`; the Discord bot is still unconnected.

## Local verification

Run `node community/idle-abyss-princesses/tools/validate-setup.mjs` from the repository root. Checks cover source-asset hashes, exact eight character identities, 21 cosmetic/opt-in roles, role-choice consistency, nine defaults/the original five writable chats, forum tags, message lengths and absence of broad setup pings. They do not establish live Discord permissions or bot coverage. [ACCEPTANCE.md](ACCEPTANCE.md) records desktop verification separately.

The desktop helper is Windows-only and must be used by one controller at a time, from the repository root, with the signed-in Discord app. It uses native UI controls, screenshots and foreground checks; it does not read credentials or session tokens. Per-account screenshots and action scratch belong under ignored `.artifacts/discord-desktop/`, not Git.

## Prepared Discord automation

The SuperAgent-native bot implementation, private tickets, and join-to-create voice rooms are ready for friend-PC setup. See [behavior and privacy](../../docs/DISCORD-BOT.md) and [deployment](../../docs/DISCORD-BOT-DEPLOYMENT.md). `bot-config.json` targets this existing guild. The live bot remains uninstalled/unactivated; server-state.json continues to describe actual live settings.
