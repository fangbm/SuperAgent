# Live Discord handover — 2026-11-03

[Join 深渊放置姬 · Idle Abyss Princesses](https://discord.gg/pCKZvmNhFe).

Guild `1567099916126527530`; welcome channel `1567099917372227679`. The invite has no expiration, no usage cap, no automatic role grant and no temporary membership. An anonymous GET to Discord's public invite endpoint independently returned the matching guild/channel IDs and `expires_at: null`. No invitation was sent to another person.

## Configured live

| Area | Actual result |
| --- | --- |
| Identity | Steam title/artwork, purple profile theme, game description and five profile traits |
| START HERE | Welcome, announcements, patch notes, FAQ, roles and designated rules; members read only |
| COMMUNITY | General, help, build chat, loot, LFG, international chat and builds forum |
| FEEDBACK | Public bug/suggestion forums, read-only known issues, restricted manual private-help room |
| VOICE | One optional voice room with a four-user limit |
| STAFF | Private staff-ops channel; retains Community/safety updates |
| Roles | Eight Steam-sourced favorites, five game languages, five interests, three independent notification opt-ins; two additional manual staff labels remain unassigned |
| Onboarding | Enabled and saved; language required/single choice, interests/favorites optional/multiple, notification opt-ins separate after joining; nine defaults including the original five writable chats |
| Server Guide | Enabled and saved; bilingual welcome, five tasks, rules/FAQ/roles resources |
| Forums | Builds 17 tags, bugs 18, suggestions 16; topic/platform tags open, staff status tags moderated; no mandatory tag gate |
| Content | All 15 indexed items applied: 12 messages plus three native guidelines; original Steam art attached to welcome and character guide; no broad pings |
| Safety | Community mode, verified-email requirement, media screening, mentions-only defaults; no Administrator on cosmetic or unassigned staff labels |

## Live verification

Native Discord role preview using a cosmetic character role confirmed welcome is read-only, general has a normal composer, public bug reports has the New Post control, and private-help/STAFF are hidden. Root caught known-issues still inheriting writable FEEDBACK permissions despite an earlier handoff claim. Root applied explicit channel-level Send Messages / Send in Threads / Create Public Threads denials, saved, and repeated role preview: Discord now displays the no-send-permission notice. No fake player report was posted.

The role agent separately saved and previewed all four onboarding groups and Server Guide. The forum controller saved the nine defaults and buildcraft-to-builds mapping. The voice room visibly shows `0/04`. A second account has not completed a real first-time join; role/onboarding previews are not equivalent to that test. The final native discoverability warning counter was not recounted; optional channels remain available through Browse Channels. A voice-channel assignment to the optional co-op answer was not verified.

Native desktop screenshots remain in ignored `.artifacts/discord-desktop/` for local review; they are not committed because they show account UI. The actual live inventory is recorded by verified names; only the guild/welcome IDs and invite target were copied, so other channel IDs are not invented.

## Automation still to connect

The archive bot, analysis worker and automatic private-ticket workflow are **not installed or activated for this server**. Public forums and owner/staff contact provide the current manual reporting path. The owner must explicitly grant each private case access; the prepared private room is not an automatic isolated ticket system. Staff role labels do not by themselves create a moderation team.

The processing requirement is recorded in [ARCHIVE-FIRST.md](../../docs/ARCHIVE-FIRST.md): archive collected originals, edits and deletions first, then analyze only committed archive records. No live capture or recovery coverage is claimed until the authorized bot is connected and tested. Public text/forums/threads are the intended scope; private staff/support and DMs are excluded unless separately authorized.

The four-character Discord Server Tag remains the candidate `ABYS`, not activated. Paid banner/boost perks were not purchased. Free profile branding and Steam image attachments are live. Character choices are member roles, independent of Discord's paid Server Tag feature.

## Local checks

`node community/idle-abyss-princesses/tools/validate-setup.mjs` verifies assets, content and configuration consistency. PowerShell parser checks the desktop helper. `pnpm check:boundaries`, `pnpm check:freeze`, and `git diff --check` cover repository boundaries/freeze/patch hygiene. These checks do not validate platform collection. The previous 161 Node tests and six Python suites belong to the integrated connector baseline, not a live bot test for this guild. No contracts, M3, QQ or runtime code was changed in this setup task.

Final run: setup validator PASS; PowerShell parser PASS; package boundaries PASS; M0 freeze PASS (45 files).
