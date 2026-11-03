import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createArchiveBackup } from '../../scripts/archive-backup.mjs';
import { event, fixture, scope } from './helpers.mjs';

test('online backup includes committed WAL data, verifies integrity, and leaves source untouched', async t => {
  const f = fixture(t);
  const receipt = f.runtime.ingress.commitBatch(scope, [event('backup-in-wal')]);
  const source = f.runtime.store;
  const output = path.join(f.directory, 'handoff.sqlite');
  assert.equal(source.get('PRAGMA journal_mode').journal_mode, 'wal');
  const walPath = `${f.filename}-wal`;
  assert.ok(existsSync(walPath), 'source WAL exists before backup');
  const originalBytes = readFileSync(f.filename);
  const originalWalBytes = readFileSync(walPath);
  const sourceEvents = source.get('SELECT count(*) count FROM source_events').count;
  const migrations = source.get('SELECT count(*) count FROM schema_migrations').count;

  const manifest = await createArchiveBackup(f.filename, output, { clock: f.clock });
  assert.deepEqual(manifest, {
    ok: true,
    createdAt: f.clock(),
    output: 'handoff.sqlite',
    sourceIntegrity: 'ok',
    backupIntegrity: 'ok',
    sourceEventCount: sourceEvents,
    includedCommittedWal: true,
    migrationsApplied: false,
  });
  assert.deepEqual(readFileSync(f.filename), originalBytes);
  assert.deepEqual(readFileSync(walPath), originalWalBytes);
  assert.equal(source.get('SELECT count(*) count FROM source_events').count, sourceEvents);
  assert.equal(source.get('SELECT count(*) count FROM schema_migrations').count, migrations);

  const backupDb = new DatabaseSync(output, { readOnly: true });
  try {
    const copiedEvents = backupDb.prepare('SELECT event_id,payload_json FROM source_events').all()
      .map(row => ({ event_id: row.event_id, payload_json: row.payload_json }));
    assert.deepEqual(copiedEvents, [
      { event_id: receipt.refs[0].eventId, payload_json: source.get('SELECT payload_json FROM source_events').payload_json },
    ]);
    assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backupDb.prepare('SELECT count(*) count FROM schema_migrations').get().count, migrations);
  } finally { backupDb.close(); }
});

test('backup rejects source as target and every existing output path', async t => {
  const f = fixture(t);
  await assert.rejects(createArchiveBackup(f.filename, f.filename), /BACKUP_OUTPUT_IS_SOURCE/);
  const existing = path.join(f.directory, 'existing.sqlite');
  writeFileSync(existing, 'keep');
  await assert.rejects(createArchiveBackup(f.filename, existing), /BACKUP_TARGET_ALREADY_EXISTS/);
  assert.equal(readFileSync(existing, 'utf8'), 'keep');
});

test('backup refuses an active controller lease and leaves source and target untouched', async t => {
  const f = fixture(t);
  f.runtime.store.run('INSERT INTO community_leases(namespace,owner,lease_until,generation,updated_at) VALUES(?,?,?,?,?)',
    'guild:live', 'controller', '2026-11-02T00:01:00.000Z', 1, '2026-11-02T00:00:00.000Z');
  const before = f.runtime.store.get('SELECT count(*) count FROM schema_migrations').count;
  const output = path.join(f.directory, 'must-not-exist.sqlite');
  await assert.rejects(createArchiveBackup(f.filename, output, { clock: f.clock }), /ACTIVE_COMMUNITY_LEASE/);
  assert.equal(existsSync(output), false);
  assert.equal(f.runtime.store.get('SELECT count(*) count FROM schema_migrations').count, before);
});

test('expired leases do not block backup handoff', async t => {
  const f = fixture(t);
  f.runtime.store.run('INSERT INTO community_leases(namespace,owner,lease_until,generation,updated_at) VALUES(?,?,?,?,?)',
    'guild:expired', 'old-controller', '2026-11-01T23:59:59.000Z', 1, '2026-11-01T23:59:00.000Z');
  const output = path.join(f.directory, 'expired-lease-backup.sqlite');
  const result = await createArchiveBackup(f.filename, output, { clock: f.clock });
  assert.equal(result.ok, true);
  assert.equal(existsSync(output), true);
});
