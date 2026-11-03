import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { SqliteStore, bundledMigrations, canonicalJSON } from '@superagent/persistence';
import { IngressService } from '@superagent/ingress';
import { DurableJobQueue } from '@superagent/job-queue';
import { DurableCommunityState } from '@superagent/plugin-host';
import { fixture, event, binding, scope } from './helpers.mjs';

for (const prefix of [8, 11]) test(`M4 migration from schema ${prefix} preserves archive, cursors and earlier migration checksums`, async t => {
  const f = fixture(t);
  const filename = path.join(f.directory, `before-m4-${prefix}.sqlite`);
  const migrations = bundledMigrations();
  let db = new SqliteStore(filename, { migrations: migrations.slice(0, prefix) });
  const input = event('before-m4');
  const internalId = '11111111-1111-4111-8111-111111111111';
  let events, cursors, ledger, outbox;
  try {
    db.run('INSERT INTO projects(project_id) VALUES(?)', binding.projectId);
    db.run('INSERT INTO sources(source_id,project_id,source_uri,platform) VALUES(?,?,?,?)', binding.sourceId, binding.projectId, binding.sourceUri, binding.platform);
    db.run('INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)',
      internalId, input.source, input.id, binding.projectId, binding.sourceId, input.type, canonicalJSON(input), f.clock());
    db.run("INSERT INTO event_outbox(event_id,handler_version,status) VALUES(?,'admission-v1','pending')", internalId);
    db.run('INSERT INTO sync_cursors(source_id,cursor_json,updated_at) VALUES(?,?,?)', binding.sourceId, '{"sequence":123}', f.clock());
    events = db.all('SELECT * FROM source_events');
    cursors = db.all('SELECT * FROM sync_cursors');
    ledger = db.all('SELECT * FROM schema_migrations ORDER BY name');
    outbox = db.all('SELECT * FROM event_outbox');
  } finally { db.close(); }
  db = new SqliteStore(filename);
  try {
    assert.deepEqual(db.all('SELECT * FROM source_events'), events);
    assert.deepEqual(db.all('SELECT * FROM sync_cursors'), cursors);
    assert.deepEqual(db.all('SELECT * FROM event_outbox'), outbox);
    assert.deepEqual(db.all('SELECT * FROM schema_migrations ORDER BY name').slice(0, prefix), ledger);
    assert.equal(db.get('SELECT count(*) n FROM schema_migrations').n, 13);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    const ingress = new IngressService(db, new DurableJobQueue(db), f.clock);
    const replay = ingress.commitBatch(scope, [input]);
    assert.equal(replay.duplicates, 1);
    assert.equal(replay.refs[0].eventId, internalId);
    assert.deepEqual(ingress.getCheckpoint(scope), { sequence: 123 });
    const state = new DurableCommunityState(db, 'migration-smoke', { clock: f.clock });
    assert.equal(state.acquireLease('controller', 45_000), true);
    await state.set('ticket:one', { eventId: internalId });
    assert.deepEqual(await state.get('ticket:one'), { eventId: internalId });
    state.releaseLease('controller');
  } finally { db.close(); }
});
