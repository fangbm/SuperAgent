# Discord bot: friend-PC deployment and archive care

This is a deployment guide, not activation. It uses the existing SuperAgent runtime and one SQLite archive. Do not run the bot or setup command until the server configuration has been reviewed and the archive cutover is ready. The machine must remain awake and connected to the internet while collecting Discord events.

## Files and safety

- Compose builds from the repository root with Node 24 and pnpm 11.0.8. The bot has no inbound port; it makes an outbound Discord Gateway connection.
- The only persistent database mount is `.artifacts/discord-bot/data` → `/data`, with SQLite at `/data/archive.sqlite`.
- `DISCORD_BOT_TOKEN_FILE` points to a local Compose secret under `.artifacts/discord-bot/secrets/`. The token is not part of `bot-config.json`, Compose environment values, image layers, or command arguments.
- `.artifacts/`, SQLite files, and secret paths are excluded from Git by the repo ignore rules and Docker context rules. Keep copied archives private and transfer them over an encrypted channel. Never attach raw archives or tokens to tickets, chat, or Git.
- Use one writer. Stop the old collector before starting this bot; do not run old and new collectors against the same Discord channels at once.

## Windows setup

From the repository root in PowerShell, create local directories and the token file:

```powershell
New-Item -ItemType Directory -Force .artifacts\discord-bot\data, .artifacts\discord-bot\secrets | Out-Null
notepad .artifacts\discord-bot\secrets\discord_token.txt
```

Paste the bot token into the editor, save, close it, and restrict the file to your Windows account:

```powershell
icacls .artifacts\discord-bot\secrets\discord_token.txt /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

Do not put the token in a shell command, `bot-config.json`, or `.env`. Keep the token file only in `.artifacts/discord-bot/secrets/`.

If transferring an existing archive, place the **validated stopped backup** at `.artifacts/discord-bot/data/archive.sqlite` before starting Compose. Do not overwrite an archive while the bot is running.

## Linux setup

From the repository root in Bash:

```bash
install -d -m 700 .artifacts/discord-bot/data .artifacts/discord-bot/secrets
read -r -s -p 'Discord bot token: ' DISCORD_TOKEN
printf '%s' "$DISCORD_TOKEN" > .artifacts/discord-bot/secrets/discord_token.txt
unset DISCORD_TOKEN
chmod 600 .artifacts/discord-bot/secrets/discord_token.txt
```

The container runs as UID/GID `1000:1000`. Make the data directory and archive writable by that account, and the secret readable by that account, without making the secret public. For example, on a single-user friend PC:

```sh
sudo chown -R 1000:1000 .artifacts/discord-bot/data
sudo chown 1000:1000 .artifacts/discord-bot/secrets/discord_token.txt
```

Place a validated stopped backup at `.artifacts/discord-bot/data/archive.sqlite` before startup. Never copy the live database file or its `-wal`/`-shm` files by hand.

## Validate, set up, run, inspect, stop

Run these from the repository root. Compose uses `deploy/discord/compose.yaml`:

```sh
docker compose -f deploy/discord/compose.yaml build
docker compose -f deploy/discord/compose.yaml run --rm --no-deps bot --check-config
```

`--check-config` is an offline configuration check. Review its output before provisioning. To provision the already-created server, stop any running collector first, then run the explicit setup command:

```sh
docker compose -f deploy/discord/compose.yaml run --rm --no-deps bot --setup
```

Start the single persistent bot process:

```sh
docker compose -f deploy/discord/compose.yaml up -d
docker compose -f deploy/discord/compose.yaml ps
docker compose -f deploy/discord/compose.yaml logs --tail 100 bot
```

The Compose healthcheck runs the read-only `--status` command and expects a live controller lease and recent heartbeat. Status output contains no token. Stop gracefully before backup or maintenance:

```sh
docker compose -f deploy/discord/compose.yaml stop bot
```

Wait for the controller lease to be released or expire before creating a handoff backup. `archive-backup.mjs` refuses a live lease and rechecks source activity during backup.

## Preserve and transfer the existing archive

The following export command runs on the current archive machine; a friend PC receiving the prepared backup does not need the original source path. The canonical local archive is `.artifacts/idle-abyss-princesses/archive.sqlite` and currently contains 148 real Steam records. Keep it as the source of truth. Do not recreate, migrate, or copy its live SQLite file. Stop its current writer, then create a new output with the SQLite online backup tool:

```sh
node scripts/archive-backup.mjs --database .artifacts/idle-abyss-princesses/archive.sqlite --output .artifacts/discord-bot/data/archive.sqlite
```

The output path must not already exist. The tool opens the source read-only, backs up committed WAL data through SQLite's backup API, verifies integrity and record count, checks for a live community controller lease, and prints a sanitized JSON manifest. It applies no migrations and never deletes the source. Confirm the manifest reports `sourceEventCount: 148` before treating the backup as the expected handoff copy. If the source has changed or a lease is live, it removes its incomplete output and exits with an error; stop the writer and retry with a new nonexisting target.

Transfer `archive.sqlite` privately to the friend PC's `.artifacts/discord-bot/data/` directory. Do not commit, email in plain text, or upload it to a public file host. Verify the transfer with a trusted file hash shared over the same private channel.

### Import dry run

Before startup, run the backup verifier against the imported file, writing to a separate temporary output. This opens the imported source read-only, checks integrity, record count and live leases, and creates an integrity-checked SQLite copy without migrations:

```sh
node scripts/archive-backup.mjs --database .artifacts/discord-bot/data/archive.sqlite --output .artifacts/discord-bot/data/import-check.sqlite
```

Confirm the manifest's event count matches the expected archive, then remove only the temporary `import-check.sqlite` file. If the check refuses due to a live lease, do not delete lease rows manually; wait for the former controller lease to expire or restore a clean stopped backup.

After the import check, run `--check-config`, then `docker compose ... up -d`. The new bot must be the sole writer. Do not leave the old collector running against the same archive or Discord channels.

## Backups and rollback

Stop the bot before each handoff backup. Use a new output filename each time; the tool deliberately refuses to overwrite an existing path. Keep at least one prior validated backup in private storage, separate from the active data directory. Record the sanitized manifest and file hash, not message bodies.

For rollback, stop the new bot, wait for its lease to release/expire, create a validated backup of the current archive to a new filename, and restore the last known-good validated backup only while no process is writing. Keep the failed/current archive and the original 148-record Steam archive untouched until recovery is confirmed. Start only one writer after the restore check passes.

A verified offline 148-record backup has been prepared at the documented data path. The original archive has not been moved or activated on another PC. Setup and continuous operation still require the owner application/token and friend-PC startup. See DISCORD-BOT.md for the guild installation URL command and live acceptance checklist.
