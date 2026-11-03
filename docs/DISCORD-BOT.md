# SuperAgent Discord community bot

The Discord community plugin runs under the trusted Core owner in this private monorepo. Public/private collection and community features share one Gateway and one M1 SQLite archive. The checked-in Core configuration enables standard public M1 admission, keeps the private ticket source staff-only/archive-only, and leaves model analysis, Web and GitHub writes disabled.

## Delivery status

Implemented and locally verified for guild `1567099916126527530`, 深渊放置姬 · Idle Abyss Princesses. **The live application/token and friend-PC deployment are not activated.** Tests use actual file-backed Source Hosts with injected Discord transport; they do not establish live permissions. Docker is absent here, so container build/run remains unverified.

The original `.artifacts/idle-abyss-princesses/archive.sqlite` remains authoritative until cutover. An integrity-checked 148-record backup is prepared at `.artifacts/discord-bot/data/archive.sqlite`. This is an offline handoff copy. Keep raw databases out of Git; use the [deployment guide](DISCORD-BOT-DEPLOYMENT.md).

## Application and startup

Create a dedicated application named **深渊放置姬 Community** on the server owner's Discord Developer Portal account. Use the original Steam capsule artwork in the community assets as its icon. Enable Message Content Intent and save its bot token to the ignored secret file in the deployment guide. Do not paste tokens into chat, configuration or Git.

```powershell
pnpm build
pnpm start --config community/idle-abyss-princesses/core-config.json --check-config
pnpm start --config community/idle-abyss-princesses/core-config.json --setup
pnpm start --config community/idle-abyss-princesses/core-config.json
```

Use `--database .artifacts/discord-bot/data/archive.sqlite` to override the configured database path on the host; Compose mounts the archive at `/data/archive.sqlite`. `--setup` runs Discord community setup only. The normal command starts all plugins listed by the Core config, currently Discord community plus Steam Reviews. The legacy `pnpm discord:bot --config ... --database ...` remains a thin Core delegate; `--core-config` selects a different owner configuration. `--check-config` validates the Core composition without connecting to platforms. `--install-url` and `--status` remain available on the legacy Discord command.

The Core CLI also accepts `--once` for a bounded plugin pass and one processing tick, then exits. A successful one-shot run does not establish complete platform history or full collection coverage.

The installation URL is locked to this guild. It requests message/history/thread access, channel management, Connect/Move Members, and `MANAGE_ROLES`, without Administrator. Discord requires `MANAGE_ROLES` for channel permission overwrite endpoints used to close tickets and manage ticket participants; the bot uses it only for those channel overwrites and does not create, edit, or assign guild roles. Developer/Moderator role assignments remain manual. The runner accepts either `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`, rejecting simultaneous configuration.

On the friend PC, place the stopped archive and token first. Run the explicit `--setup` command to resolve existing roles/categories, provision the ticket entry/private category/voice lobby, register guild commands, and publish bilingual panels. It backfills those setup messages before reporting completion. Stop an existing bot before rerunning setup; resource creation reconciles previous uncertain attempts.

The default Core run continuously collects the configured public Discord and Steam sources and runs ordinary M1 admission for those public standard-policy sources. The checked-in configuration does not run model analysis; set `analysis.enabled` to true and provide `SA_LLM_BASE_URL` and `SA_LLM_MODEL` to enable the in-process M3 service over the same Runtime. `githubWrite` is false by default and requires the explicit Core setting plus repository credentials to permit writes. The private ticket source remains archive-only and isolated. Legacy `--status` is read-only/token-free and expects a live controller lease, recent heartbeat and Gateway readiness. After the first connection, a new privacy notice supersedes the earlier preparation notice; owner-authored history is retained.

## Tickets

- Bug/Suggestion/Help buttons open a short bilingual form. Immediate processing is separate from receipt: the original fields commit to the private Source Host before confirmation/channel creation.
- One open ticket per member. Its channel allows the requester, bot, owner and configured staff roles, while denying everyone else. Members cannot create child threads or operate another person's ticket.
- Conversations, observed edits/deletions and original form fields stay private. Lifecycle state contains evidence references and IDs; interaction tokens remain transient. Long submissions are shown in full across Discord-sized messages.
- Staff commands: `/ticket claim`, `close`, `reopen`, `add`, `remove`, `delete`; requesters also have their own Close button. Closing makes the request read-only. Deletion requires a completed archive flush and does not erase archived evidence.
- Private project/source policy blocks admission, forced replay and model evidence access. Public AI/search/GitHub cannot consume private tickets. There is no automatic archive purge or private export/AI promotion in this version.

## Voice rooms

The live server now has the prepared creator lobby1567192297181814804. It is visible but Connect is paused while the bot is offline. Updated --setup adopts this same ID and explicitly enables View/Connect, preserving the ordinary party room. The latest follow-up records preparation, not a successful live auto-room test.

Join **➕・创建房间-create-room** to create a four-place room and move into it. Multiple parties get independent rooms. Hosts use `/room rename` and `/room capacity` from the room text chat or existing LFG controls channel; `/room transfer` selects an occupant. The longest-present remaining member takes over when a host leaves.

Only managed rooms expire, after 60 seconds empty and a successful text-history flush. Startup cleanup waits for a fresh guild voice snapshot and rechecks occupancy after the flush. No voice audio is captured.

## Architecture and recovery

Public discovery covers public message channels and active/archived public threads, with resumable bounded pagination. Staff/private areas, protected categories and registered ticket channels are excluded independently of bot visibility. Permission changes invalidate public caches. Private tickets use a separate resolver and private project within the same file.

Gateway checkpoints retain only pending dispatch identity/time before split commits; sequence advances after all routed archives and lifecycle intents commit. Replayed deletions retain their first-observation time. Tokens and raw private interaction payloads never enter public checkpoints. Unresumable/offline deletions and intermediate edits remain explicit gaps; coverage stays partial.

Controller leases fence old writers. Ticket/room lifecycle records reconcile uncertain Discord effects before retry; HTTP429 follows the platform delay. No new frozen job/external-operation kinds, additional database, generic job queue or Agent Runtime are introduced. Existing QQ/M3 business behavior remains separate. The durable source policy also protects private data if somebody starts an ordinary worker against this archive.

## Verification and live checklist

Earlier integration validation recorded 295 Node tests, six Python suites, build/typecheck, package boundaries and the 45-file freeze, including Host ticket replay/isolation, Gateway ordering/replay, permission recovery, lifecycle races, lease fencing and WAL-safe backups. Treat that as historical evidence; it does not verify this Core ownership revision or live Discord operation. See [PR integration review](PR-INTEGRATION-REVIEW.md).

Ambiguous channel creation can require operator reconciliation if a marker lookup finds no channel, including a crash after persisting `creating` but before sending POST. The bot preserves archived submissions and avoids an unsafe duplicate create; it does not promise automatic completion of an unknown external outcome.

Before live acceptance, verify the actual bot's intent/permissions, use two ordinary accounts to test ticket isolation, create two voice parties, test host departure/empty cleanup, and restart the actual process to check archive recovery. Record live results separately. The friend PC must remain awake and connected.
