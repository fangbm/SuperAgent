import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SqliteStore, bundledMigrations } from '@superagent/persistence';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fixture, binding, scope, event, count } from './helpers.mjs';

test('file-backed store applies checksummed migrations once, enables WAL/FK and closes cleanly', t => {
  const f = fixture(t);
  const { store } = f.runtime;
  assert.equal(count(store, 'schema_migrations'), 6);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.get('PRAGMA busy_timeout').timeout, 5_000);
  f.runtime.close();
  assert.equal(count(f.open().store, 'schema_migrations'), 6);
});

test('production copies of frozen reference migrations remain identical', () => {
  for (const migration of bundledMigrations().slice(0, 5)) {
    assert.equal(migration.sql, readFileSync(new URL(`../../docs/reference/v0.9/migrations/${migration.name}`, import.meta.url), 'utf8'));
  }
});

test('an unmanaged database is rejected without rewriting its business tables', t => {
  const f = fixture(t);
  const filename = path.join(f.directory, 'unmanaged.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE preserved(id TEXT); INSERT INTO preserved VALUES('keep');");
  db.close();
  assert.throws(() => new SqliteStore(filename), /UNMANAGED_DATABASE_REQUIRES_EXPLICIT_MIGRATION/);
  const readonly = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(readonly.prepare('SELECT id FROM preserved').get().id, 'keep'); }
  finally { readonly.close(); }
});

test('failed migration rolls back both DDL and ledger; changed applied SQL is rejected', t => {
  const f = fixture(t);
  f.runtime.close();
  const migrations = bundledMigrations();
  assert.throws(() => new SqliteStore(f.filename, { migrations: [...migrations, { name: '007_failure.sql', sql: 'CREATE TABLE failed_marker(id TEXT); INSERT INTO nonexistent VALUES(1);' }] }));
  const reopened = f.open();
  assert.equal(reopened.store.get("SELECT name FROM sqlite_master WHERE name='failed_marker'"), undefined);
  assert.equal(count(reopened.store, 'schema_migrations'), 6);
  reopened.close();
  assert.throws(() => new SqliteStore(f.filename, { migrations: migrations.map((m, i) => i ? m : { ...m, sql: m.sql + '\n-- changed' }) }), /MIGRATION_HISTORY_MISMATCH/);
});

test('async transaction callbacks cannot leave writes committed', async t => {
  const { runtime } = fixture(t);
  assert.throws(() => runtime.store.transaction(() => {
    runtime.store.run("INSERT INTO projects VALUES('rolled-back')");
    return Promise.resolve();
  }), /ASYNC_SQLITE_TRANSACTION_FORBIDDEN/);
  assert.equal(runtime.store.get("SELECT * FROM projects WHERE project_id='rolled-back'"), undefined);
  let called = false;
  assert.throws(() => runtime.store.transaction(async () => {
    called = true;
    await Promise.resolve();
    runtime.store.run("INSERT INTO projects VALUES('escaped-async-write')");
  }), /ASYNC_SQLITE_TRANSACTION_FORBIDDEN/);
  await Promise.resolve();
  assert.equal(called, false);
});

test('source health is durable, scoped and preserves partial coverage in metrics', async t => {
  const f = fixture(t);
  const host = f.runtime.ingress.sourceHost(scope);
  await host.reportHealth({ coverage: 'partial', reason: 'history not authorized', checkedAt: '2026-11-02T00:02:00Z' });
  await host.reportHealth({ coverage: 'full', checkedAt: '2026-11-02T00:01:00Z' });
  f.runtime.close();
  const health = f.open().metrics().sources[0];
  assert.equal(health.coverage, 'partial');
  assert.equal(health.health_reason, 'history not authorized');
});

test('100 replays retain one event, projection, outbox and admission job with stable refs', async t => {
  const { runtime } = fixture(t);
  const host = runtime.ingress.sourceHost(scope);
  const first = await host.commitBatch([event('one')], { sourceId: scope.sourceId, cursor: { page: 1 } });
  for (let i = 0; i < 100; i++) {
    const replay = await host.commitBatch([event('one')], { sourceId: scope.sourceId, cursor: { page: 1 } });
    assert.equal(replay.accepted, 0);
    assert.equal(replay.duplicates, 1);
    assert.equal(replay.refs[0].eventId, first.refs[0].eventId);
    assert.equal(replay.refs[0].inserted, false);
  }
  assert.equal(count(runtime.store, 'source_events'), 1);
  assert.equal(count(runtime.store, 'source_objects'), 1);
  assert.equal(count(runtime.store, 'event_outbox'), 1);
  runtime.ingress.dispatchOutbox();
  await runtime.accept(first.refs[0].eventId);
  runtime.ingress.dispatchOutbox();
  assert.equal(count(runtime.store, 'jobs'), 1);
  assert.deepEqual(await host.getCheckpoint(), { page: 1 });
});

test('duplicates inside a batch preserve input order and key-order-insensitive identity', t => {
  const { runtime } = fixture(t);
  const a = event('a');
  const duplicate = { data: a.data, ...a };
  const result = runtime.ingress.commitBatch(scope, [a, event('b'), duplicate]);
  assert.equal(result.accepted, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.refs[0].eventId, result.refs[2].eventId);
  assert.equal(result.refs[2].inserted, false);
});

test('invalid/mixed-source events and cursor JSON fail the whole batch', t => {
  const { runtime } = fixture(t);
  const invalid = event('bad');
  invalid.data.object.kind = 'review';
  assert.throws(() => runtime.ingress.commitBatch(scope, [event('valid'), invalid], { sourceId: scope.sourceId, cursor: 'advanced' }));
  const wrong = event('wrong'); wrong.data.sourceId = 'other';
  assert.throws(() => runtime.ingress.commitBatch(scope, [event('valid'), wrong]));
  assert.throws(() => runtime.ingress.commitBatch(scope, [], { sourceId: 'other', cursor: 'bad' }));
  assert.throws(() => runtime.ingress.commitBatch(scope, [event('valid')], { sourceId: scope.sourceId, cursor: { invalid: undefined } }));
  assert.equal(count(runtime.store, 'source_events'), 0);
  assert.equal(count(runtime.store, 'event_outbox'), 0);
  assert.equal(count(runtime.store, 'source_objects'), 0);
  assert.equal(runtime.ingress.getCheckpoint(scope), null);
});

test('database failure after event writes rolls back events, outbox, projection and cursor', t => {
  const { runtime } = fixture(t);
  runtime.store.exec("CREATE TRIGGER fault_cursor BEFORE INSERT ON sync_cursors BEGIN SELECT RAISE(ABORT,'INJECTED_DB_FAILURE'); END;");
  assert.throws(() => runtime.ingress.commitBatch(scope, [event('a'), event('b')], { sourceId: scope.sourceId, cursor: 2 }), /INJECTED_DB_FAILURE/);
  for (const table of ['source_events', 'event_outbox', 'source_objects', 'sync_cursors']) assert.equal(count(runtime.store, table), 0);
  runtime.store.exec('DROP TRIGGER fault_cursor');
  runtime.ingress.commitBatch(scope, [event('a')], { sourceId: scope.sourceId, cursor: 1 });
  assert.equal(count(runtime.store, 'source_events'), 1);
});

test('same source identity with changed content aborts other new events and cursor', t => {
  const { runtime } = fixture(t);
  runtime.ingress.commitBatch(scope, [event('original')], { sourceId: scope.sourceId, cursor: 1 });
  assert.throws(() => runtime.ingress.commitBatch(scope, [event('new'), event('original', { text: 'different' })], { sourceId: scope.sourceId, cursor: 2 }), /EVENT_IDENTITY_CONFLICT/);
  assert.equal(count(runtime.store, 'source_events'), 1);
  assert.equal(runtime.ingress.getCheckpoint(scope), 1);
});

test('source namespace, project access and secret capabilities are scoped', async t => {
  const { runtime } = fixture(t);
  runtime.ingress.registerSource({ projectId: 'game-other', sourceId: 'dc-other', sourceUri: 'urn:source:other', platform: 'discord' });
  assert.throws(() => runtime.ingress.registerSource({ ...binding, projectId: 'game-other' }), /SOURCE_IDENTITY_CONFLICT/);
  assert.throws(() => runtime.ingress.sourceHost({ projectId: 'game-other', sourceId: scope.sourceId }), /SOURCE_NOT_AUTHORIZED/);
  const host = runtime.ingress.sourceHost(scope, { secretKeys: ['QQ_APP_ID'], getSecret: async () => 'approved-test-value' });
  await assert.rejects(host.getSecret('OTHER_SECRET'), /SECRET_NOT_AUTHORIZED/);
  assert.equal(await host.getSecret('QQ_APP_ID'), 'approved-test-value');
  const result = await host.commitBatch([event('same-external')]);
  assert.equal(runtime.ingress.getEvent('game-other', result.refs[0].eventId), undefined);
  assert.ok(Object.isFrozen(host));
});

test('updated/deleted projections survive late creates while all raw revisions remain', t => {
  const { runtime } = fixture(t);
  const newer = event('update', { objectId: 'object', action: 'updated', time: '2026-11-02T00:02:00Z', text: 'updated text' });
  runtime.ingress.commitBatch(scope, [newer]);
  runtime.ingress.commitBatch(scope, [event('create', { objectId: 'object' })]);
  assert.equal(runtime.store.get('SELECT action_rank FROM source_objects').action_rank, 1);
  runtime.ingress.commitBatch(scope, [event('delete', { objectId: 'object', action: 'deleted', time: '2026-11-02T00:03:00Z', text: null })]);
  runtime.ingress.commitBatch(scope, [event('late-update', { objectId: 'object', action: 'updated', time: '2026-11-02T00:01:00Z' })]);
  assert.equal(runtime.store.get('SELECT deleted FROM source_objects').deleted, 1);
  assert.equal(count(runtime.store, 'source_events'), 4);
  assert.equal(count(runtime.store, 'source_reconciliations'), 2);
});

test('outbox dispatch and job creation commit atomically', t => {
  const { runtime } = fixture(t);
  runtime.ingress.commitBatch(scope, [event('a')]);
  runtime.store.exec("CREATE TRIGGER fault_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'QUEUE_WRITE_FAILURE'); END;");
  assert.throws(() => runtime.ingress.dispatchOutbox(), /QUEUE_WRITE_FAILURE/);
  assert.equal(runtime.store.get('SELECT status FROM event_outbox').status, 'pending');
  assert.equal(count(runtime.store, 'jobs'), 0);
  runtime.store.exec('DROP TRIGGER fault_job');
  runtime.tick();
  assert.equal(count(runtime.store, 'admission_decisions'), 1);
});
