import assert from 'node:assert/strict';
import test from 'node:test';
import { QQSource, qqSignature, verifyQQSignature } from '@superagent/qq-official';
import { m3Fixture } from './m3-helpers.mjs';
import { binding, scope, count } from './helpers.mjs';
import { qqEvent, qqFixture, qqSecrets, readSecret, signed } from './qq-helpers.mjs';

test('QQ Ed25519 derivation matches the published official validation vector', () => {
  assert.equal(qqSignature('DG5g3B4j9X2KOErG', '1725442341', 'Arq0D5A61EgUu4OxUvOp'), '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706');
  assert.equal(verifyQQSignature('DG5g3B4j9X2KOErG', '1725442341', Buffer.from('Arq0D5A61EgUu4OxUvOp'), '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706'), true);
});
test('signed scoped callback commits before ACK and duplicates survive restart and alternate event type', async t => {
  const f = await qqFixture(t); const payload = qqEvent();
  assert.equal((await f.receive(payload)).statusCode, 200);
  assert.deepEqual((await f.receive({ ...payload, t: 'GROUP_MESSAGE_CREATE', id: 'another-transport-id' })).body, { op: 12, d: 0 });
  assert.equal(count(f.runtime.store, 'source_events'), 1); assert.equal(count(f.runtime.store, 'event_outbox'), 1);
  await f.source.stop();
  const other = new QQSource({ kind: 'group', sourceUri: binding.sourceUri, now: () => Date.parse(f.clock()) });
  await other.start(f.host, new AbortController().signal);
  try { assert.equal((await other.handleWebhook(...signed(payload, f.clock))).statusCode, 200); assert.equal(f.runtime.store.get('SELECT coverage FROM sources WHERE source_id=?', binding.sourceId).coverage, 'partial'); } finally { await other.stop(); }
  assert.equal(count(f.runtime.store, 'source_events'), 1);
  assert.equal(f.runtime.store.get('SELECT coverage FROM sources WHERE source_id=?', binding.sourceId).coverage, 'unavailable');
});
test('forged, modified, stale or wrong-app callbacks cannot change the database', async t => {
  const f = await qqFixture(t); const [headers, raw] = signed(qqEvent(), f.clock);
  assert.equal((await f.source.handleWebhook(headers, Buffer.concat([raw, Buffer.from(' ')]))).statusCode, 401);
  assert.equal((await f.receive(qqEvent(), { 'x-signature-ed25519': '00'.repeat(64) })).statusCode, 401);
  assert.equal((await f.receive(qqEvent(), { 'x-bot-appid': 'wrong' })).statusCode, 401);
  f.advance(301_000); assert.equal((await f.source.handleWebhook(headers, raw)).statusCode, 401);
  assert.equal(count(f.runtime.store, 'source_events'), 0);
});
test('challenge response is signed, bounded and app-scoped without treating it as feedback', async t => {
  const f = await qqFixture(t); const ts = String(Date.parse(f.clock()) / 1000); const payload = Buffer.from(JSON.stringify({ op: 13, d: { plain_token: 'fixture-challenge', event_ts: ts } }));
  const result = await f.source.handleWebhook({ 'x-bot-appid': qqSecrets.QQ_APP_ID }, payload);
  assert.equal(result.body.signature, qqSignature(qqSecrets.QQ_APP_SECRET, ts, 'fixture-challenge'));
  assert.equal(count(f.runtime.store, 'source_events'), 0);
  assert.equal((await f.source.handleWebhook({ 'x-bot-appid': 'wrong' }, payload)).statusCode, 401);
  assert.equal((await f.source.handleWebhook({}, Buffer.alloc(1_000_001))).statusCode, 413);
});
test('unbound groups, C2C control messages, bot echoes and unrelated event types are ignored', async t => {
  const f = await qqFixture(t);
  for (const event of [qqEvent('other', { scope: 'unbound' }), qqEvent('dm', { type: 'C2C_MESSAGE_CREATE' }), qqEvent('bot', { data: { author: { bot: true } } }), { op: 0, t: 'READY', d: 'opaque-session' }]) assert.equal((await f.receive(event)).statusCode, 200);
  assert.equal(count(f.runtime.store, 'source_events'), 0);
});
test('raw QQ identifiers, auth tokens and signed attachment URLs do not enter Core', async t => {
  const f = await qqFixture(t);
  await f.receive(qqEvent('private-message', { text: '你好 <@player-private>', data: { attachments: [{ url: 'https://cdn.invalid/file?rkey=attachment-secret', content_type: 'image/png' }], message_scene: { ext: ['msg_idx=private-index', 'auth_token=event-auth-secret'] } } }));
  const raw = f.runtime.store.get('SELECT payload_json FROM source_events').payload_json;
  for (const secret of ['player-private', qqSecrets.QQ_SCOPE_ID, 'private-message', 'private-index', 'event-auth-secret', 'attachment-secret']) assert.equal(raw.includes(secret), false);
  const event = JSON.parse(raw); assert.match(event.data.actor.opaqueId, /^qq-actor-/); assert.equal(event.data.content.attachments[0].url, undefined);
});
test('callback retries after a failed Host transaction and never acknowledges a lost event', async t => {
  const f = await qqFixture(t); const commit = f.runtime.ingress.commitBatch.bind(f.runtime.ingress);
  f.runtime.ingress.commitBatch = () => { throw new Error('fixture-database-failure'); };
  const checkpoint = f.runtime.ingress.getCheckpoint(scope);
  assert.equal((await f.receive(qqEvent())).statusCode, 503); assert.deepEqual(f.runtime.ingress.getCheckpoint(scope), checkpoint);
  f.runtime.ingress.commitBatch = commit; assert.equal((await f.receive(qqEvent())).statusCode, 200); assert.equal(count(f.runtime.store, 'source_events'), 1);
});
test('distinct C2C message indexes remain distinct and source rebinding requires a new identity', async t => {
  const f = await qqFixture(t, { kind: 'c2c' });
  for (const index of ['first', 'second']) await f.receive(qqEvent('same-provider-id', { type: 'C2C_MESSAGE_CREATE', data: { message_scene: { ext: [`msg_idx=${index}`] } } }));
  assert.equal(count(f.runtime.store, 'source_objects'), 2);
  await f.source.stop();
  const channel = new QQSource({ kind: 'channel', sourceUri: binding.sourceUri, now: () => Date.parse(f.clock()) });
  await assert.rejects(channel.start(f.host, new AbortController().signal), /QQ_SOURCE_BINDING_CHANGED/);
});
test('channel deletion updates visibility and preserves immutable history', async t => {
  const f = await qqFixture(t, { kind: 'channel' }); const channel = f.source;
  const message = { id: 'channel-message', channel_id: qqSecrets.QQ_SCOPE_ID, content: 'crash', timestamp: f.clock(), author: { id: 'channel-author' } };
  try {
    assert.equal((await channel.handleWebhook(...signed({ op: 0, t: 'MESSAGE_CREATE', d: message }, f.clock))).statusCode, 200);
    assert.equal((await channel.handleWebhook(...signed({ op: 0, t: 'MESSAGE_DELETE', d: { message, op_timestamp: f.clock() } }, f.clock))).statusCode, 200);
    assert.equal(count(f.runtime.store, 'source_events'), 2);
    assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_objects WHERE deleted=1').n, 1);
  } finally { await channel.stop(); }
});
test('authenticated QQ callbacks feed the existing M1 and M3 analysis chain through SDK Host only', async t => {
  const f = await m3Fixture(t); const source = new QQSource({ kind: 'group', sourceUri: binding.sourceUri, now: () => Date.parse(f.clock()) });
  const host = f.runtime.ingress.sourceHost(scope, { secretKeys: source.manifest.permissions.secretKeys, getSecret: readSecret });
  await source.start(host, new AbortController().signal);
  try {
    assert.equal((await source.handleWebhook(...signed(qqEvent(), f.clock))).statusCode, 200);
    f.runtime.tick(); for (const s of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'")) f.runtime.buffer.flushSync(s.segment_id, 'replay');
    assert.equal((await f.worker.tick()).status, 'succeeded'); assert.equal(count(f.runtime.store, 'issues'), 1); assert.equal(count(f.runtime.store, 'suggestions'), 1);
  } finally { await source.stop(); }
});
test('probe separates authentication from event entitlement, mentions from full messages, and cancellation', async t => {
  const f = await qqFixture(t, { source: { api: { fetch: async url => Response.json(String(url).endsWith('/app/getAppAccessToken') ? { access_token: 'fixture-token', expires_in: 7200 } : { id: 'fixture-bot' }) } } });
  assert.equal((await f.source.probe()).coverage, 'unknown'); assert.equal((await f.source.probe()).readMessages, false);
  await f.receive(qqEvent()); const mentioned = await f.source.probe(); assert.equal(mentioned.coverage, 'partial'); assert.match(mentioned.reason, /MENTIONS_ONLY/);
  await f.receive(qqEvent('second', { type: 'GROUP_MESSAGE_CREATE' })); const all = await f.source.probe(); assert.equal(all.coverage, 'partial'); assert.match(all.reason, /ALL_MESSAGES_OBSERVED/); assert.equal(all.readHistory, false); assert.equal(all.readEdits, false);
  assert.equal(f.source.manifest.permissions.deliverySend, undefined);
  f.controller.abort(); assert.equal((await f.receive(qqEvent('after-cancel'))).statusCode, 503);
});

test('QQ probe preserves permanent platform rejection versus transient network failure for supervisor recovery',async t=>{
  let status=401;
  const f=await qqFixture(t,{source:{api:{fetch:async url=>String(url).endsWith('/app/getAppAccessToken')?Response.json({access_token:'fixture-token',expires_in:7200}):Response.json({}, {status})}}});
  const rejected=await f.source.probe();assert.equal(rejected.coverage,'unavailable');assert.equal(rejected.reason,'PLATFORM_BLOCKED:QQ_HTTP_401');
  status=503;const transient=await f.source.probe();assert.equal(transient.coverage,'unavailable');assert.equal(transient.reason,'QQ_HTTP_503');
});
