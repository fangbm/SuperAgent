import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscordConnector, normalizeDiscordMessage, discordPermissions } from '@superagent/connector-discord';
import { validateContract } from '@superagent/contract-validation';
import { connectorFixture, nativeFixture, signal } from './m4-helpers.mjs';
const config = f => ({ sourceUri: f.binding.sourceUri, guildId: '100', channelIds: ['200'], threadIds: ['300'] });
const native = () => nativeFixture('discord-message');
function discordFetch(options = {}) {
  return async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bot test-bot-secret');
    const route = new URL(url).pathname;
    if (options.fail) return new Response('', { status: options.fail });
    if (route.endsWith('/oauth2/applications/@me')) return Response.json({ flags: options.noContent ? 0 : 1 << 19 });
    if (route.endsWith('/users/@me')) return Response.json({ id: '999' });
    if (route.endsWith('/members/999')) return Response.json({ user: { id: '999' }, roles: [] });
    if (route.endsWith('/roles')) return Response.json([{ id: '100', permissions: options.noHistory ? '1024' : '66560' }]);
    if (route.endsWith('/messages')) return Response.json(options.messages?.(new URL(url)) ?? []);
    if (route.endsWith('/channels/200')) return Response.json({ id: '200', guild_id: '100', type: 0, permission_overwrites: [] });
    if (route.endsWith('/channels/300')) return Response.json({ id: '300', guild_id: '100', type: 11, parent_id: '200' });
    if (route.endsWith('/gateway/bot')) return Response.json({ url: 'wss://gateway.discord.gg/' });
    throw new Error('Unexpected Discord route: ' + route);
  };
}
class FakeSocket extends EventTarget {
  readyState = 1;
  constructor(onSend, heartbeatInterval = 10000) { super(); this.onSend = onSend; queueMicrotask(() => this.receive({ op: 10, d: { heartbeat_interval: heartbeatInterval } })); }
  receive(packet) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }
  send(data) { this.onSend(JSON.parse(data), this); }
  close(code = 1000) {
    if (this.readyState === 3) return; this.readyState = 3;
    const event = new Event('close'); Object.defineProperty(event, 'code', { value: code });
    queueMicrotask(() => this.dispatchEvent(event));
  }
}
const dispatch = (socket, type, sequence, data) => socket.receive({ op: 0, t: type, s: sequence, d: data });
const ready = socket => dispatch(socket, 'READY', 1, { session_id: 'session-one', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg/' });
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  assert.fail('Timed out waiting for connector state');
}

test('Discord native create/edit/delete map to frozen schemas, original text, references and thread topology', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const create = normalizeDiscordMessage(native(), 'created', config(f), f.scope, { eventKey: 'session:1', receivedAt: '2026-11-02T00:00:00Z', threadId: '300' });
  const edit = normalizeDiscordMessage({ ...native(), content: '补充：切换服务器也会崩溃。', edited_timestamp: '2026-11-02T00:01:00Z' }, 'updated', config(f), f.scope, { eventKey: 'session:2', receivedAt: '2026-11-02T00:01:00Z', threadId: '300' });
  const deleted = normalizeDiscordMessage({ id: native().id, channel_id: '300', guild_id: '100' }, 'deleted', config(f), f.scope, { eventKey: 'session:3', receivedAt: '2026-11-02T00:02:00Z', threadId: '300' });
  for (const event of [create, edit, deleted]) assert.equal(validateContract('normalized-event-v1', event).valid, true);
  const receipt = await f.host.commitBatch([create, edit, deleted]);
  const replay = await f.host.commitBatch([create, edit, deleted]);
  assert.deepEqual(replay.refs.map(item => item.eventId), receipt.refs.map(item => item.eventId));
  assert.equal(new Set(f.events(f.runtime).map(item => item.id)).size, 3);
  assert.equal(create.data.object.parentExternalId, native().message_reference.message_id);
  assert.equal(create.data.object.threadExternalId, '300');
  assert.equal(create.data.content.attachments[0].kind, 'image');
  assert.equal(create.data.origin.permalink, 'https://discord.com/channels/100/300/' + native().id);
  assert.equal(f.runtime.store.get('SELECT deleted FROM source_objects WHERE source_id=?', f.scope.sourceId).deleted, 1);
  assert.equal(f.events(f.runtime)[0].data.content.text, native().content);
  const partial = normalizeDiscordMessage({ id: native().id, channel_id: '300', guild_id: '100' }, 'updated', config(f), f.scope, { eventKey: 'session:4', receivedAt: '2026-11-02T00:03:00Z' });
  assert.equal(Object.hasOwn(partial.data, 'content'), false);
  assert.equal(partial.data.attributes.partialUpdate, true);
});

test('Discord probes are unknown before host binding and reject missing intent/history/permissions without advancing', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const initial = new DiscordConnector(config(f), { fetch: discordFetch() });
  assert.equal((await initial.probe()).coverage, 'unknown');
  for (const options of [{ noContent: true }, { noHistory: true }, { fail: 403 }]) {
    const connector = new DiscordConnector(config(f), { fetch: discordFetch(options) });
    await assert.rejects(connector.sync(f.host, signal()), /PERMISSION_DENIED/);
    assert.equal((await connector.probe()).coverage, 'unavailable');
    assert.equal(await f.host.getCheckpoint(), null);
  }
  await initial.sync(f.host, signal());
  assert.equal((await initial.probe()).coverage, 'partial');
});

test('Discord permission resolution applies everyone, combined role and member overwrites in order', () => {
  const roles = [{ id: '100', permissions: '66560' }, { id: '11', permissions: '0' }, { id: '12', permissions: '0' }];
  const overwrites = [{ id: '100', type: 0, allow: '0', deny: '1024' }, { id: '11', type: 0, allow: '1024', deny: '0' }, { id: '12', type: 0, allow: '0', deny: '65536' }, { id: '999', type: 1, allow: '65536', deny: '0' }];
  assert.equal(discordPermissions('100', '999', ['11', '12'], roles, overwrites), 66560n);
  assert.equal(discordPermissions('100', '998', ['11', '12'], roles, overwrites), 1024n);
});

test('Discord Gateway reconnect resumes committed sequence, skips replay, and retains edit and bulk delete history', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const controller = new AbortController(); t.after(() => controller.abort());
  const sent = []; let connections = 0;
  const connector = new DiscordConnector(config(f), { fetch: discordFetch(), sleep: async (_ms, abort) => { await delay(1, undefined, { signal: abort }); }, webSocket: () => {
    const connection = ++connections;
    return new FakeSocket((packet, socket) => {
      sent.push(packet);
      if (packet.op === 1) socket.receive({ op: 11 });
      if (connection === 1 && packet.op === 2) {
        ready(socket); dispatch(socket, 'MESSAGE_CREATE', 2, native()); socket.receive({ op: 7 });
      }
      if (connection === 2 && packet.op === 6) {
        assert.equal(packet.d.seq, 2); assert.equal(packet.d.session_id, 'session-one');
        dispatch(socket, 'MESSAGE_CREATE', 2, native());
        dispatch(socket, 'MESSAGE_UPDATE', 3, { ...native(), content: '已补充日志', edited_timestamp: '2026-11-02T00:01:00Z' });
        dispatch(socket, 'MESSAGE_DELETE_BULK', 4, { guild_id: '100', channel_id: '300', ids: [native().id, '1434510000000000002'] });
      }
    });
  } });
  const run = connector.start(f.host, controller.signal);
  await eventually(() => f.events(f.runtime).length === 4);
  controller.abort(); await run; await connector.stop();
  assert.equal(connections, 2);
  assert.equal(sent.some(item => item.op === 6), true);
  assert.equal((await f.host.getCheckpoint()).gateway.sequence, 4);
  assert.equal(f.events(f.runtime).filter(item => item.type.endsWith('.deleted.v1')).length, 2);
});

test('Discord Gateway failed commit cannot let later queued dispatches advance over the failed event', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const failing = { ...f.host, commitBatch: async (events, cursor) => { if (events.length) throw new Error('Injected disk failure'); return f.host.commitBatch(events, cursor); } };
  const connector = new DiscordConnector(config(f), { fetch: discordFetch(), webSocket: () => new FakeSocket((packet, socket) => {
    if (packet.op === 2) { ready(socket); dispatch(socket, 'MESSAGE_CREATE', 2, native()); dispatch(socket, 'MESSAGE_CREATE', 3, { ...native(), id: '1434510000000000002' }); }
  }) });
  await assert.rejects(connector.start(failing, signal()), /Injected disk failure/);
  assert.equal((await f.host.getCheckpoint()).gateway.sequence, 1);
  assert.equal(f.events(f.runtime).length, 0);
  await connector.stop();
});

test('Discord invalid session performs REST recovery and re-identifies while preserving explicit gap status', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const controller = new AbortController(); t.after(() => controller.abort());
  let connections = 0; let modes = [];
  const connector = new DiscordConnector(config(f), { fetch: discordFetch(), sleep: async (_ms, abort) => delay(1, undefined, { signal: abort }), webSocket: () => {
    const connection = ++connections;
    return new FakeSocket((packet, socket) => {
      if (packet.op === 1) socket.receive({ op: 11 });
      if ([2, 6].includes(packet.op)) modes.push(packet.op);
      if (connection === 1 && packet.op === 2) { ready(socket); socket.receive({ op: 9, d: false }); }
      if (connection === 2 && packet.op === 2) { dispatch(socket, 'READY', 1, { session_id: 'session-two', resume_gateway_url: 'wss://gateway.discord.gg/' }); controller.abort(); }
    });
  } });
  await connector.start(f.host, controller.signal);
  assert.deepEqual(modes, [2, 2]);
  assert.equal((await f.host.getCheckpoint()).gap, true);
  assert.equal(f.runtime.store.get('SELECT coverage FROM sources WHERE source_id=?', f.scope.sourceId).coverage, 'partial');
});

test('Discord history pagination resumes after process restart and preserves separate channel/thread routes', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...native(), id: String(1000 + i) }));
  const connector = new DiscordConnector({ ...config(f), historyPagesPerSync: 1 }, { fetch: discordFetch({ messages: url => url.pathname.includes('/300/') ? hundred : [] }) });
  await connector.sync(f.host, signal());
  assert.equal((await f.host.getCheckpoint()).history['300'].before, '1000');
  f.runtime.close(); const reopened = f.open(); const host = f.getHost(reopened);
  const next = new DiscordConnector(config(f), { fetch: discordFetch({ messages: url => {
    if (url.pathname.includes('/300/')) { assert.equal(url.searchParams.get('before'), '1000'); return [{ ...native(), id: '999' }]; }
    return [{ ...native(), id: '777', channel_id: '200', message_reference: undefined }];
  } }) });
  await next.sync(host, signal());
  assert.equal(f.events(reopened).length, 102);
  assert.equal((await host.getCheckpoint()).history['300'].after, '1099');
  assert.equal(reopened.store.all('SELECT DISTINCT conversation_key FROM source_event_routes WHERE source_id=?', f.scope.sourceId).length, 2);
});

test('Discord rate limits and network failures retry without losing the durable cursor', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const real = discordFetch(); let calls = 0; const waits = [];
  const connector = new DiscordConnector(config(f), { fetch: async (url, init) => {
    if (++calls === 1) return Response.json({ retry_after: 3 }, { status: 429 });
    if (calls === 2) throw new TypeError('network'); return real(url, init);
  }, sleep: async ms => { waits.push(ms); } });
  await connector.sync(f.host, signal()); assert.deepEqual(waits, [3000, 2000]);
  const checkpoint = await f.host.getCheckpoint();
  const failed = new DiscordConnector(config(f), { fetch: discordFetch({ fail: 503 }), sleep: async () => {} });
  await assert.rejects(failed.sync(f.host, signal()), /PLATFORM_UNAVAILABLE/);
  assert.deepEqual(await f.host.getCheckpoint(), checkpoint);
});

test('Discord missing heartbeat ACK closes the stale socket and resumes from durable sequence', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const controller = new AbortController(); t.after(() => controller.abort());
  let connections = 0; let heartbeats = 0;
  const connector = new DiscordConnector({ ...config(f), historyPollMs: 60000 }, { fetch: discordFetch(),
    sleep: async (_ms, abort) => delay(1, undefined, { signal: abort }), webSocket: () => {
      const connection = ++connections;
      return new FakeSocket((packet, socket) => {
        if (packet.op === 2) ready(socket);
        if (packet.op === 1) heartbeats++;
        if (connection === 2 && packet.op === 6) { assert.equal(packet.d.seq, 1); controller.abort(); }
      }, 5);
    } });
  await connector.start(f.host, controller.signal);
  assert.equal(connections, 2); assert.ok(heartbeats > 0);
});

test('Discord a fresh instance restores Gateway session and sequence from the restarted Host', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const firstAbort = new AbortController(); t.after(() => firstAbort.abort());
  const first = new DiscordConnector(config(f), { fetch: discordFetch(), webSocket: () => new FakeSocket((packet, socket) => {
    if (packet.op === 2) { ready(socket); dispatch(socket, 'MESSAGE_CREATE', 2, native()); }
    if (packet.op === 1) socket.receive({ op: 11 });
  }) });
  const firstRun = first.start(f.host, firstAbort.signal);
  await eventually(() => f.events(f.runtime).length === 1); firstAbort.abort(); await firstRun;
  f.runtime.close(); const reopened = f.open(); const host = f.getHost(reopened);
  const secondAbort = new AbortController(); t.after(() => secondAbort.abort()); let resumed = false;
  const second = new DiscordConnector(config(f), { fetch: discordFetch(), webSocket: () => new FakeSocket((packet, socket) => {
    if (packet.op === 6) { assert.equal(packet.d.seq, 2); resumed = true; dispatch(socket, 'MESSAGE_UPDATE', 3, { ...native(), content: '补充日志', edited_timestamp: '2026-11-02T00:01:00Z' }); }
    if (packet.op === 1) socket.receive({ op: 11 });
  }) });
  const secondRun = second.start(host, secondAbort.signal);
  await eventually(() => f.events(reopened).length === 2); secondAbort.abort(); await secondRun;
  assert.equal(resumed, true); assert.equal((await host.getCheckpoint()).gateway.sequence, 3);
});

test('Discord refuses an untrusted resume endpoint before sending the bot token', async t => {
  const f = connectorFixture(t, 'discord', ['DISCORD_BOT_TOKEN']);
  const connector = new DiscordConnector(config(f), { fetch: discordFetch(), webSocket: () => { assert.fail('token must not leave Discord'); } });
  await connector.sync(f.host, signal());
  const checkpoint = await f.host.getCheckpoint(); checkpoint.gateway = { sessionId: 'session', sequence: 1, resumeUrl: 'wss://attacker.example/' };
  await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: checkpoint });
  await assert.rejects(connector.start(f.host, signal()), /gateway URL/);
});
