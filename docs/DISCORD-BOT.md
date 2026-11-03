# SuperAgent Discord community bot

The bot lives in this private monorepo: existing Discord Source Plugin, SDK-only community features, trusted plugin-host lifecycle state, and the same M1 SQLite archive. Public/private collection and community features share one Gateway. No model worker or GitHub writer starts with it.

## Delivery status

Implemented and locally verified for guild `1567099916126527530`, 深渊放置姬 · Idle Abyss Princesses. **The live application/token and friend-PC deployment are not activated.** Tests use actual file-backed Source Hosts with injected Discord transport; they do not establish live permissions. Docker is absent here, so container build/run remains unverified.

The original `.artifacts/idle-abyss-princesses/archive.sqlite` remains authoritative until cutover. An integrity-checked 148-record backup is prepared at `.artifacts/discord-bot/data/archive.sqlite`. This is an offline handoff copy. Keep raw databases out of Git; use the [deployment guide](DISCORD-BOT-DEPLOYMENT.md).

## Application and startup

Create a dedicated application named **深渊放置姬 Community** on the server owner's Discord Developer Portal account. Use the original Steam capsule artwork in the community assets as its icon. Enable Message Content Intent and save its bot token to the ignored secret file in the deployment guide. Do not paste tokens into chat, configuration or Git.

```powershell
pnpm build
pnpm discord:bot --config community/idle-abyss-princesses/bot-config.json --check-config
pnpm discord:bot --config community/idle-abyss-princesses/bot-config.json --install-url --application-id YOUR_APPLICATION_ID
```

The installation URL is locked to this guild. It requests message/history/thread access, channel management and Connect/Move Members, without Administrator or role management. Developer/Moderator role assignments remain manual. The runner accepts either `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE`, rejecting simultaneous configuration.

On the friend PC, place the stopped archive and token first. Run the explicit `--setup` command to resolve existing roles/categories, provision the ticket entry/private category/voice lobby, register guild commands, and publish bilingual panels. It backfills those setup messages before reporting completion. Stop an existing bot before rerunning setup; resource creation reconciles previous uncertain attempts.

The default run starts continuous archive-only collection, including the existing Steam reviews source. `--status` is read-only/token-free and expects a live controller lease, recent heartbeat and Gateway readiness. After the first connection, a new privacy notice supersedes the earlier preparation notice; owner-authored history is retained.

## Tickets

- Bug/Suggestion/Help buttons open a short bilingual form. Immediate processing is separate from receipt: the original fields commit to the private Source Host before confirmation/channel creation.
- One open ticket per member. Its channel allows the requester, bot, owner and configured staff roles, while denying everyone else. Members cannot create child threads or operate another person's ticket.
- Conversations, observed edits/deletions and original form fields stay private. Lifecycle state contains evidence references and IDs; interaction tokens remain transient. Long submissions are shown in full across Discord-sized messages.
- Staff commands: `/ticket claim`, `close`, `reopen`, `add`, `remove`, `delete`; requesters also have their own Close button. Closing makes the request read-only. Deletion requires a completed archive flush and does not erase archived evidence.
- Private project/source policy blocks admission, forced replay and model evidence access. Public AI/search/GitHub cannot consume private tickets. There is no automatic archive purge or private export/AI promotion in this version.

## Voice rooms

Join **➕・创建房间-create-room** to create a four-place room and move into it. Multiple parties get independent rooms. Hosts use `/room rename` and `/room capacity` from the room text chat or existing LFG controls channel; `/room transfer` selects an occupant. The longest-present remaining member takes over when a host leaves.

Only managed rooms expire, after 60 seconds empty and a successful text-history flush. Startup cleanup waits for a fresh guild voice snapshot and rechecks occupancy after the flush. No voice audio is captured.

## Architecture and recovery

Public discovery covers public message channels and active/archived public threads, with resumable bounded pagination. Staff/private areas, protected categories and registered ticket channels are excluded independently of bot visibility. Permission changes invalidate public caches. Private tickets use a separate resolver and private project within the same file.

Gateway checkpoints retain only pending dispatch identity/time before split commits; sequence advances after all routed archives and lifecycle intents commit. Replayed deletions retain their first-observation time. Tokens and raw private interaction payloads never enter public checkpoints. Unresumable/offline deletions and intermediate edits remain explicit gaps; coverage stays partial.

Controller leases fence old writers. Ticket/room lifecycle records reconcile uncertain Discord effects before retry; HTTP429 follows the platform delay. No new frozen job/external-operation kinds, additional database, generic job queue or Agent Runtime are introduced. Existing QQ/M3 business behavior remains separate. The durable source policy also protects private data if somebody starts an ordinary worker against this archive.

## Verification and live checklist

Frozen install and `pnpm check` pass: **208 Node tests, six Python suites**, build/typecheck, package boundaries and the 45-file freeze. Coverage includes real Host ticket replay/isolation, shared Gateway ACK ordering/split replay, dynamic private capture, permission changes, lifecycle races, unknown outcomes, lease fencing and WAL-safe backups.

Before live acceptance, verify the actual bot's intent/permissions, use two ordinary accounts to test ticket isolation, create two voice parties, test host departure/empty cleanup, and restart the actual process to check archive recovery. Record live results separately. The friend PC must remain awake and connected.
