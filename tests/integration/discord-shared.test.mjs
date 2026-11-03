import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorFixture, nativeFixture, signal } from './m4-helpers.mjs';
import { DiscordConnector } from '@superagent/connector-discord';
import { setTimeout as delay } from 'node:timers/promises';

const config = f => ({ sourceUri: f.binding.sourceUri, guildId: '100', channelIds: [], discovery: 'public', historyPagesPerSync: 1 });
const parent = () => ({ id: '200', guild_id: '100', type: 0, permission_overwrites: [] });
const thread = (id, timestamp) => ({ id, guild_id: '100', parent_id: '200', type: 11, thread_metadata: { archive_timestamp: timestamp } });
function publicFetch({ archived, everyoneVisible = () => true } = {}) {
  return async url => {
    const u = new URL(url); const route = u.pathname;
    if (route.endsWith('/oauth2/applications/@me')) return Response.json({ flags: 1 << 19 });
    if (route.endsWith('/users/@me')) return Response.json({ id: '999' });
    if (route.endsWith('/members/999')) return Response.json({ user: { id: '999' }, roles: [] });
    if (route.endsWith('/roles')) return Response.json([{ id: '100', permissions: '66560' }]);
    if (route === '/api/v10/guilds/100/channels') return Response.json([{ ...parent(), permission_overwrites: everyoneVisible() ? [] : [{ id: '100', type: 0, allow: '0', deny: '1024' }] }]);
    if (route.endsWith('/threads/active')) return Response.json({ threads: [] });
    if (route.endsWith('/threads/archived/public')) return Response.json(await archived(u));
    if (route.endsWith('/messages')) return Response.json([]);
    if (route === '/api/v10/channels/200') return Response.json({ ...parent(), permission_overwrites: everyoneVisible() ? [] : [{ id: '100', type: 0, allow: '0', deny: '1024' }] });
    throw new Error('Unexpected Discord route: ' + route);
  };
}

test('public discovery resumes a bounded initial archived-thread scan after restart', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const requests = [];
  const archived = async url => {
    requests.push(url.searchParams.get('before'));
    if (requests.length === 1) return { threads: [thread('301', '2026-11-02T12:00:00.000Z')], has_more: true };
    return { threads: [thread('302', '2026-11-01T12:00:00.000Z')], has_more: false };
  };
  const first = new DiscordConnector(config(f), { fetch: publicFetch({ archived }) });
  await first.sync(f.host, signal());
  assert.equal((await f.host.getCheckpoint()).archivedThreads['200'].before, '2026-11-02T12:00:00.000Z');
  f.runtime.close();
  const reopened = f.open(); const host = f.getHost(reopened);
  const second = new DiscordConnector(config(f), { fetch: publicFetch({ archived }) });
  await second.sync(host, signal());
  assert.deepEqual(requests, [null, '2026-11-02T12:00:00.000Z']);
  const state = await host.getCheckpoint();
  assert.deepEqual(Object.keys(state.discoveredThreads).sort(), ['301', '302']);
  assert.equal(state.archivedThreads['200'].before, null);
});

test('public cached channel is rechecked after permission updates and the excluder blocks an allowed channel', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  let visible = true; let managed = false;
  const connector = new DiscordConnector(config(f), { fetch: publicFetch({ archived: async () => ({ threads: [], has_more: false }), everyoneVisible: () => visible }),
    channelExcluder: channel => channel.parent_id === '400' || (channel.id === '200' && managed) });
  await connector.sync(f.host, signal());
  const packet = (type, sequence, data) => ({ type, sequence, sessionId: 'shared-session', receivedAt: '2026-11-03T00:00:00.000Z', data });
  const message = { ...nativeFixture('discord-message'), guild_id: '100', channel_id: '200' };
  await connector.consumeDispatch(f.host, packet('MESSAGE_CREATE', 0, message), signal());
  assert.equal(f.events(f.runtime).length, 1, 'public positive control must archive before privacy changes');
  visible = false;
  await connector.consumeDispatch(f.host, packet('GUILD_ROLE_UPDATE', 1, { guild_id: '100', id: '100' }), signal());
  await connector.consumeDispatch(f.host, packet('MESSAGE_CREATE', 2, { ...message, id: '1434510000000000003' }), signal());
  assert.equal(f.events(f.runtime).length, 1, 'role permission change should force a fresh public visibility check');
  visible = true; managed = true;
  await connector.consumeDispatch(f.host, packet('MESSAGE_CREATE', 3, { ...message, id: '1434510000000000002' }), signal());
  assert.equal(f.events(f.runtime).length, 1, 'channelExcluder must apply even when @everyone can view');
});

class Socket extends EventTarget {
  readyState = 1;
  constructor(send) { super(); this.onSend = send; queueMicrotask(() => this.receive({ op: 10, d: { heartbeat_interval: 10000 } })); }
  receive(packet) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }
  send(text) { this.onSend(JSON.parse(text), this); }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event('close'); Object.defineProperty(event, 'code', { value: code });
    queueMicrotask(() => this.dispatchEvent(event));
  }
}
const dispatch = (socket, type, sequence, data) => socket.receive({ op: 0, t: type, s: sequence, d: data });
const ready = socket => dispatch(socket, 'READY', 1, { session_id: 'shared', resume_gateway_url: 'wss://gateway.discord.gg/' });
const transportFetch = async url => new URL(url).pathname.endsWith('/gateway/bot')
  ? Response.json({ url: 'wss://gateway.discord.gg/' }) : publicFetch()(url);
async function eventually(check) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); }
  assert.fail('Shared Gateway condition did not complete');
}

test('one Gateway requests voice intent and acknowledges interactions while an archive commit is blocked', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const controller = new AbortController(); t.after(() => controller.abort());
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let waiting = false, acknowledged = false, delivered = false, sockets = 0;
  const host = { ...f.host, commitBatch: async (events, checkpoint) => {
    if (events.length) { waiting = true; await blocked; }
    return f.host.commitBatch(events, checkpoint);
  } };
  const connector = new DiscordConnector({ sourceUri: f.binding.sourceUri, guildId: '100', channelIds: ['200'] }, {
    fetch: transportFetch, additionalIntents: 1 << 7,
    onDispatchImmediate: async packet => { if (packet.type === 'INTERACTION_CREATE') acknowledged = true; },
    onDispatch: async packet => { if (packet.type === 'INTERACTION_CREATE') delivered = true; },
    webSocket: () => { sockets++; return new Socket((packet, socket) => {
      if (packet.op === 1) socket.receive({ op: 11 });
      if (packet.op === 2) {
        assert.ok(packet.d.intents & (1 << 7)); ready(socket);
        dispatch(socket, 'MESSAGE_CREATE', 2, { ...nativeFixture('discord-message'), channel_id: '200' });
        dispatch(socket, 'INTERACTION_CREATE', 3, { id: '1234', guild_id: '100', token: 'must-never-enter-checkpoint', type: 5 });
      }
    }); },
  });
  const run = connector.start(host, controller.signal);
  try {
    await eventually(() => waiting && acknowledged);
    assert.equal(delivered, false);
    assert.equal(f.events(f.runtime).length, 0);
    assert.doesNotMatch(JSON.stringify(await f.host.getCheckpoint()), /must-never-enter-checkpoint/);
    release();
    await eventually(async () => (await f.host.getCheckpoint())?.gateway?.sequence === 3);
    assert.equal(delivered, true); assert.equal(sockets, 1);
  } finally { release(); controller.abort(); await run; await connector.stop(); }
});

test('split-commit failure replays a deletion after restart with its original time and Host mapping', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const c = { sourceUri: f.binding.sourceUri, guildId: '100', channelIds: ['200'] };
  const deletion = { guild_id: '100', channel_id: '200', id: '1434510000000000001' };
  const first = new DiscordConnector(c, { fetch: transportFetch,
    onDispatch: async packet => { if (packet.type === 'MESSAGE_DELETE') throw new Error('INJECTED_PRIVATE_COMMIT_FAILURE'); },
    webSocket: () => new Socket((packet, socket) => {
      if (packet.op === 2) { ready(socket); dispatch(socket, 'MESSAGE_DELETE', 2, deletion); }
      if (packet.op === 1) socket.receive({ op: 11 });
    }),
  });
  await assert.rejects(first.start(f.host, signal()), /INJECTED_PRIVATE_COMMIT_FAILURE/);
  const saved = await f.host.getCheckpoint();
  assert.equal(saved.gateway.sequence, 1); assert.equal(saved.pendingDispatch.sequence, 2);
  const original = f.runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE source_id=?', f.scope.sourceId);
  await first.stop(); f.runtime.close();
  const reopened = f.open(); const host = f.getHost(reopened);
  const controller = new AbortController(); t.after(() => controller.abort());
  let receivedAt;
  const second = new DiscordConnector(c, { fetch: transportFetch,
    onDispatch: async packet => { if (packet.type === 'MESSAGE_DELETE') receivedAt = packet.receivedAt; },
    webSocket: () => new Socket((packet, socket) => {
      if (packet.op === 6) { assert.equal(packet.d.seq, 1); dispatch(socket, 'MESSAGE_DELETE', 2, deletion); }
      if (packet.op === 1) socket.receive({ op: 11 });
    }),
  });
  const run = second.start(host, controller.signal);
  try { await eventually(async () => (await host.getCheckpoint())?.gateway?.sequence === 2); }
  finally { controller.abort(); await run; await second.stop(); }
  assert.equal(receivedAt, saved.pendingDispatch.receivedAt);
  assert.deepEqual(reopened.store.all('SELECT event_id,payload_json FROM source_events WHERE source_id=?', f.scope.sourceId), [original]);
  assert.equal((await host.getCheckpoint()).pendingDispatch, undefined);
});

test('private channel resolution archives only registered tickets without a second Gateway', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const binding = { projectId: 'shared-private', sourceId: 'shared-private', sourceUri: 'urn:shared-private', platform: 'discord' };
  const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
  f.runtime.ingress.registerSource(binding);
  f.runtime.ingress.setSourcePolicy(scope, { visibility: 'staff', processingMode: 'archive_only' });
  const host = f.runtime.ingress.sourceHost(scope, { secretKeys: ['DISCORD_BOT_TOKEN'], getSecret: async () => 'synthetic-token' });
  let ids = [];
  const fetch = async url => {
    if (new URL(url).pathname === '/api/v10/channels/400') return Response.json({ id: '400', guild_id: '100', type: 0,
      permission_overwrites: [{ id: '100', type: 0, allow: '0', deny: '1024' }, { id: '999', type: 1, allow: '66560', deny: '0' }] });
    return publicFetch()(url);
  };
  const connector = new DiscordConnector({ sourceUri: binding.sourceUri, guildId: '100', channelIds: [] }, {
    channelResolver: async () => ids, fetch, webSocket: () => { assert.fail('Private collector must not open Gateway'); },
  });
  await connector.sync(host, signal());
  ids = ['400'];
  const packet = { type: 'MESSAGE_CREATE', sequence: 2, sessionId: 'shared', receivedAt: '2026-11-03T00:00:00.000Z',
    data: { ...nativeFixture('discord-message'), channel_id: '400' } };
  await connector.consumeDispatch(host, packet, signal()); await connector.consumeDispatch(host, packet, signal());
  await connector.consumeDispatch(host, { ...packet, sequence: 3, data: { ...packet.data, channel_id: '500' } }, signal());
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?', scope.sourceId).n, 1);
  assert.equal(f.events(f.runtime).length, 0);
  assert.equal(f.runtime.tick().admitted, 0);
  assert.throws(() => connector.start(host, signal()), /UNSUPPORTED_CAPABILITY/);
  await connector.stop();
});
