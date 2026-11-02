import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SteamDiscussionsConnector, normalizeDiscussion } from '@superagent/connector-steam-discussions';
import { validateContract } from '@superagent/contract-validation';
import { connectorFixture, nativeFixture, signal } from './m4-helpers.mjs';
function setup(t) {
  const f = connectorFixture(t, 'steam-discussions');
  const snapshotPath = path.join(f.directory, 'snapshot.json');
  const write = data => writeFileSync(snapshotPath, JSON.stringify(data));
  const snapshot = nativeFixture('discussions'); write(snapshot);
  const config = { appId: 570, sourceUri: f.binding.sourceUri, mode: 'snapshot', snapshotPath };
  return { ...f, config, snapshot, write };
}
test('Steam Discussions default honestly reports unavailable without touching cursor', async t => {
  const f = setup(t);
  const connector = new SteamDiscussionsConnector({ appId: 570, sourceUri: f.binding.sourceUri });
  assert.equal((await connector.probe()).coverage, 'unavailable');
  await connector.sync(f.host, signal());
  assert.equal(await f.host.getCheckpoint(), null);
  assert.equal(f.events(f.runtime).length, 0);
});
test('Discussion snapshot fallback preserves titles, reply trees and independent threads in real Source Host', async t => {
  const f = setup(t);
  const events = f.snapshot.records.map(item => normalizeDiscussion(item, f.config, f.scope));
  for (const event of events) assert.equal(validateContract('normalized-event-v1', event).valid, true);
  const first = await f.host.commitBatch(events);
  const duplicate = await f.host.commitBatch(events);
  assert.deepEqual(first.refs.map(ref => ref.eventId), duplicate.refs.map(ref => ref.eventId));
  const connector = new SteamDiscussionsConnector(f.config);
  await connector.sync(f.host, signal());
  assert.equal((await connector.probe()).coverage, 'partial');
  assert.equal(f.events(f.runtime).length, 4);
  assert.equal(events[0].data.attributes.title, '联机崩溃');
  assert.equal(events[2].data.object.parentExternalId, 'comment:2001');
  assert.equal(events[2].data.object.threadExternalId, 'thread:1001');
  assert.equal(f.runtime.store.all('SELECT DISTINCT conversation_key FROM source_event_routes WHERE source_id=?', f.scope.sourceId).length, 2);
});
test('Discussion restart resumes revisions; edits/deletions retain immutable history and missing objects stay intact', async t => {
  const f = setup(t); await new SteamDiscussionsConnector(f.config).sync(f.host, signal());
  f.runtime.close(); const reopened = f.open(); const host = f.getHost(reopened);
  f.snapshot.records[0].body = '新增崩溃日志'; f.snapshot.records[0].updatedAt = '2026-11-02T00:05:00Z';
  f.snapshot.records[1].deletedAt = '2026-11-02T00:06:00Z';
  f.snapshot.records.pop(); f.write(f.snapshot);
  const connector = new SteamDiscussionsConnector(f.config);
  await connector.sync(host, signal()); await connector.sync(host, signal());
  const events = f.events(reopened);
  assert.equal(events.length, 6);
  assert.equal(events[4].type, 'com.superagent.feedback.thread.updated.v1');
  assert.equal(events[5].type, 'com.superagent.feedback.comment.deleted.v1');
  assert.equal(reopened.store.get('SELECT deleted FROM source_objects WHERE source_id=? AND external_id=?', f.scope.sourceId, 'thread:1002').deleted, 0);
  assert.equal(events[0].data.content.text, '加载到 90% 时崩溃。');
});
test('Invalid/cross-thread snapshots and failed commits retain the prior checkpoint', async t => {
  const f = setup(t);
  await new SteamDiscussionsConnector(f.config).sync(f.host, signal()); const checkpoint = await f.host.getCheckpoint();
  f.snapshot.records[2].threadId = '1002'; f.write(f.snapshot);
  await assert.rejects(new SteamDiscussionsConnector(f.config).sync(f.host, signal()), /cross-thread/);
  assert.deepEqual(await f.host.getCheckpoint(), checkpoint);
  f.snapshot.records[2].threadId = '1001'; f.snapshot.records[0].updatedAt = '2026-11-02T00:05:00Z'; f.snapshot.records[0].body = 'edited'; f.write(f.snapshot);
  const failed = { ...f.host, commitBatch: async () => { throw new Error('disk failure'); } };
  await assert.rejects(new SteamDiscussionsConnector(f.config).sync(failed, signal()), /disk failure/);
  assert.deepEqual(await f.host.getCheckpoint(), checkpoint);
  assert.equal(f.events(f.runtime).length, 4);
  await new SteamDiscussionsConnector(f.config).sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 5);
});
