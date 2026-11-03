import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, lstatSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isSamePath(left, right) {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function resolvePaths(database, output) {
  if (!database || !output) throw fail('BACKUP_ARGUMENTS_REQUIRED');
  let source;
  let parent;
  try {
    source = realpathSync(path.resolve(database));
    parent = realpathSync(path.dirname(path.resolve(output)));
  } catch { throw fail('BACKUP_SOURCE_OR_OUTPUT_DIRECTORY_NOT_FOUND'); }
  try { if (!statSync(source).isFile()) throw fail('BACKUP_SOURCE_NOT_FILE'); }
  catch (error) { if (error?.code === 'BACKUP_SOURCE_NOT_FILE') throw error; throw fail('BACKUP_SOURCE_NOT_FOUND'); }
  const target = path.join(parent, path.basename(path.resolve(output)));
  if (isSamePath(source, target)) throw fail('BACKUP_OUTPUT_IS_SOURCE');
  for (const candidate of [target, `${target}-wal`, `${target}-shm`]) {
    try { lstatSync(candidate); throw fail('BACKUP_TARGET_ALREADY_EXISTS'); }
    catch (error) { if (error?.code === 'BACKUP_TARGET_ALREADY_EXISTS') throw error; if (error?.code !== 'ENOENT') throw fail('BACKUP_TARGET_UNAVAILABLE'); }
  }
  return { source, target };
}

function integrityCheck(database) {
  const rows = database.prepare('PRAGMA integrity_check').all();
  return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
}

function liveLeaseExists(database, now) {
  const table = database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='community_leases'").get();
  if (!table) return false;
  return Boolean(database.prepare('SELECT 1 present FROM community_leases WHERE lease_until>? LIMIT 1').get(now));
}

function sourceEventCount(database) {
  const table = database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='source_events'").get();
  return table ? Number(database.prepare('SELECT count(*) count FROM source_events').get().count) : null;
}

function cleanupTarget(target) {
  for (const candidate of [target, `${target}-wal`, `${target}-shm`]) {
    try { rmSync(candidate, { force: true }); } catch { /* Best-effort cleanup of files created by this run. */ }
  }
}

/** Create an integrity-checked online backup without migrating or modifying the source DB. */
export async function createArchiveBackup(databasePath, outputPath, { clock = () => new Date().toISOString() } = {}) {
  const { source, target } = resolvePaths(databasePath, outputPath);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  let outputCreated = false;
  try {
    const now = new Date(clock()).toISOString();
    if (!integrityCheck(sourceDb)) throw fail('BACKUP_SOURCE_INTEGRITY_FAILED');
    if (liveLeaseExists(sourceDb, now)) throw fail('ACTIVE_COMMUNITY_LEASE');
    const beforeVersion = Number(sourceDb.prepare('PRAGMA data_version').get().data_version);
    const recordsBefore = sourceEventCount(sourceDb);

    let reserved;
    try { reserved = openSync(target, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw fail('BACKUP_TARGET_ALREADY_EXISTS');
      throw fail('BACKUP_TARGET_UNAVAILABLE');
    }
    closeSync(reserved);
    outputCreated = true;
    await backup(sourceDb, target);

    const recordsAfter = sourceEventCount(sourceDb);
    const afterVersion = Number(sourceDb.prepare('PRAGMA data_version').get().data_version);
    if (afterVersion !== beforeVersion || recordsAfter !== recordsBefore) throw fail('SOURCE_CHANGED_DURING_BACKUP');
    if (liveLeaseExists(sourceDb, new Date(clock()).toISOString())) throw fail('ACTIVE_COMMUNITY_LEASE');

    const backupDb = new DatabaseSync(target, { readOnly: true });
    try {
      if (!integrityCheck(backupDb)) throw fail('BACKUP_OUTPUT_INTEGRITY_FAILED');
      if (sourceEventCount(backupDb) !== recordsBefore) throw fail('BACKUP_RECORD_COUNT_MISMATCH');
      if (backupDb.prepare('PRAGMA foreign_key_check').all().length > 0) throw fail('BACKUP_FOREIGN_KEY_CHECK_FAILED');
    } finally { backupDb.close(); }

    return {
      ok: true,
      createdAt: new Date(clock()).toISOString(),
      output: path.basename(target),
      sourceIntegrity: 'ok',
      backupIntegrity: 'ok',
      sourceEventCount: recordsBefore,
      includedCommittedWal: true,
      migrationsApplied: false,
    };
  } catch (error) {
    if (outputCreated) cleanupTarget(target);
    if (error?.code) throw error;
    throw fail('ARCHIVE_BACKUP_FAILED');
  } finally { sourceDb.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('Usage: node scripts/archive-backup.mjs --database <source.sqlite> --output <new-backup.sqlite>\n');
    return;
  }
  try {
    const manifest = await createArchiveBackup(values.database, values.output);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code ?? 'ARCHIVE_BACKUP_FAILED' })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
