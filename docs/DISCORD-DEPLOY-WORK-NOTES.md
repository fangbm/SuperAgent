# Discord Bot Deployment & Backup — Work Notes

## Scope
Prepare friend-PC deployment and archive backup support only in:
- `deploy/discord/**`
- `scripts/archive-backup.mjs`
- `tests/integration/archive-backup.test.mjs`
- `docs/DISCORD-BOT-DEPLOYMENT.md`
- `.dockerignore` only if none exists

Do not edit root package/config files, `.gitignore`, Discord runtime/connector code, raw archive data, or secrets. Do not activate Discord, run setup, deploy, commit, or create extra database/queue/runtime. Preserve the existing 148 real Steam records and document one-writer cutover.

## Intended work
1. Inspect root's CLI/runtime config conventions, dependencies and current archive path, existing Docker files, `.dockerignore`, existing backup scripts, SQLite backup API support and test helpers.
2. Coordinate assumptions with root for `scripts/discord-bot.mjs`: `--config <json> --database <sqlite>`, `--setup`, `--check-config`, `--status`, and default run; token via `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE` only.
3. Build a Node 24 / pnpm 11 Docker Compose deployment with root build context, single persistent archive bind mount, no exposed ports, secret-file template, ignored local secrets/raw-data safeguards, restart policy and a status-based healthcheck if its CLI behavior is suitable.
4. Implement `scripts/archive-backup.mjs` using Node's `node:sqlite` backup/read-only APIs. Refuse same/existing target; validate source integrity; use SQLite online backup rather than copying a live WAL file; verify resulting backup; refuse handoff while any live `community_leases` row exists; retain source and run no migrations.
5. Add meaningful temporary-SQLite integration tests for WAL data consistency, unchanged source, existing/equal targets, integrity and active lease refusal.
6. Write operations docs for Windows/Linux secret setup, setup/check/status/run/stop, one-writer cutover and preserving 148 records, validated backup transfer/import checks, rollback, and keeping PC/network available.

## Verification plan
Run the requested focused archive backup integration test with Node 24. Verify Docker/compose text references root context, one mounted archive path, no exposed ports, and does not include a token. Never invoke live Discord setup or migration. Ensure generated manifests/logs do not contain record bodies or secrets.

## Status
Started after root assigned the deployment task; inspection and implementation pending.

## Implementation completed (2026-11-03)
- Added root-context Docker deployment under `deploy/discord/`: Node `24-bookworm-slim`, pnpm `11.0.8`, build-and-run Dockerfile, Compose service with one `.artifacts/discord-bot/data` → `/data` mount, `/data/archive.sqlite`, `restart: unless-stopped`, no published ports, file-based token secret, and read-only `--status` healthcheck. Added a safe token-file template.
- Added root `.dockerignore` because none existed. It excludes `.artifacts`, databases/WAL sidecars, secrets, environment files, raw evidence, and unrelated research/artwork/content from the container build context. Git secret/database safeguards use existing `.gitignore` rules; that file was not edited.
- Added `scripts/archive-backup.mjs`: Node 24 `node:sqlite` online `backup()` from a read-only source; requires new output and existing parent directory; rejects same/existing target/sidecars; checks source/output integrity, FK constraints, event count, `PRAGMA data_version`, and active community leases; cleans only its newly-created output on failure; never migrates or logs archive bodies/secrets. CLI prints a sanitized JSON manifest.
- Added `tests/integration/archive-backup.test.mjs`: verifies committed WAL data inclusion and unchanged source DB/WAL/migration ledger, source/output path safety, refusal for a live lease, and acceptance of expired lease state.
- Added `docs/DISCORD-BOT-DEPLOYMENT.md` with Windows/Linux token setup, check/setup/run/status/stop instructions, one-writer cutover preserving the 148-record Steam archive, online backup and private transfer, import dry-run, rollback, and host availability requirements.
- Verification: `node --check scripts/archive-backup.mjs`, CLI `--help`, and `node --test tests/integration/archive-backup.test.mjs` passed (4/4). Tests ran on Node 24.11.1 with the standard experimental SQLite warning.
- Docker is not installed in this environment, so Compose parsing/image build could not be exercised. At the time of completion, root's `scripts/discord-bot.mjs` runner was not yet present; Compose's entrypoint matches the shared CLI contract and bot-config.json. Recheck/build after that runner lands.
- No archive was copied/moved; no token or live Discord action was used. No root package files, `.gitignore`, runner, connector, or other agents' files were edited, and no commit was made.

## Handoff
Root owns the runner/config and final checks. The Dockerfile expects `scripts/discord-bot.mjs` to exist, while Compose appends `--setup`, `--check-config`, and other one-off flags to its base config/database arguments. Confirm this matches the final runner before deployment. Docker healthcheck requires read-only `--status` exit 0 only for a live lease plus recent heartbeat.
