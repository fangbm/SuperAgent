import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordCommunity, DiscordREST } from '../../packages/discord-community/dist/index.js';
import { validateContract } from '@superagent/contract-validation';

const ids = { guild: '100', owner: '101', bot: '102', staff: '103', category: '200', panel: '201', voiceCategory: '300', lobby: '301', controls: '202' };
const config = {
  guildId: ids.guild, ownerId: ids.owner, botUserId: ids.bot, staffRoleIds: [ids.staff],
  ticketCategoryId: ids.category, ticketPanelChannelId: ids.panel,
  voiceCategoryId: ids.voiceCategory, voiceLobbyChannelId: ids.lobby, roomControlsChannelId: ids.controls,
};
const jsonClone = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const db = new Map(); const events = []; const calls = []; let now = '2026-11-03T00:00:00.000Z'; let next = 500;
  const state = {
    async get(key) { return db.has(key) ? jsonClone(db.get(key)) : null; },
    async set(key, value) { db.set(key, jsonClone(value)); },
    async update(key, reducer) { const value = reducer(db.has(key) ? jsonClone(db.get(key)) : null); db.set(key, jsonClone(value)); return jsonClone(value); },
    async list(prefix) { return [...db].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: jsonClone(value) })); },
  };
  const archive = {
    projectId: 'idle-abyss-princesses-private', sourceId: 'discord-community-private',
    async commitBatch(input) { events.push(...jsonClone(input)); return { refs: input.map((_, index) => ({ eventId: `private-event-${events.length - input.length + index + 1}` })) }; },
  };
  const channels = new Map(); const messages = new Map(); let registeredCommands = []; let flushWait; let canManageRoles = true;
  const api = {
    async request(method, route, body) {
      calls.push({ method, route, body: body && jsonClone(body) });
      if (route.includes('/interactions/') && route.endsWith('/callback')) return undefined;
      if (route.includes('/webhooks/')) return { id: 'done' };
      if (method === 'GET' && route === '/oauth2/applications/@me') return { id: ids.bot };
      if (method === 'GET' && route === `/applications/${ids.bot}/guilds/${ids.guild}/commands`) return jsonClone(registeredCommands);
      if (method === 'PUT' && route === `/applications/${ids.bot}/guilds/${ids.guild}/commands`) { registeredCommands = jsonClone(body); return jsonClone(body); }
      if (method === 'GET' && route === `/guilds/${ids.guild}/channels`) return [...channels.values()].map(jsonClone);
      if (method === 'POST' && route === `/guilds/${ids.guild}/channels`) {
        const channel = { ...jsonClone(body), id: String(++next), guild_id: ids.guild, position: next };
        channels.set(channel.id, channel); return jsonClone(channel);
      }
      if (route.startsWith('/channels/') && method === 'GET' && route.includes('/messages')) return jsonClone(messages.get(route.split('/')[2]) ?? []);
      if (route.startsWith('/channels/') && method === 'GET') {
        const channel = channels.get(route.split('/')[2]); if (!channel) throw new Error('NOT_FOUND'); return jsonClone(channel);
      }
      if (route.startsWith('/channels/') && method === 'POST' && route.endsWith('/messages')) {
        const channelId = route.split('/')[2]; const list = messages.get(channelId) ?? [];
        const item = { id: String(++next), content: body.content, author: { id: ids.bot }, ...(body.components ? { components: body.components } : {}), ...(body.message_reference ? { message_reference: body.message_reference } : {}) };
        list.unshift(item); messages.set(channelId, list); return jsonClone(item);
      }
      if (route.startsWith('/channels/') && route.includes('/permissions/')) {
        if (!canManageRoles) throw new Error('PERMISSION_DENIED');
        const [, , channelId, , userId] = route.split('/');
        const channel = channels.get(channelId);
        channel.permission_overwrites = channel.permission_overwrites.filter(item => !(item.id === userId && Number(item.type) === 1));
        if (method !== 'DELETE') channel.permission_overwrites.push(jsonClone(body));
        return undefined;
      }
      if (method === 'PATCH' && new RegExp(`^/guilds/${ids.guild}/members/\\d+$`).test(route)) return undefined;
      if (route.startsWith('/channels/') && method === 'PATCH') { const channel = channels.get(route.split('/')[2]); Object.assign(channel, body); return jsonClone(channel); }
      if (route.startsWith('/channels/') && method === 'DELETE') { channels.delete(route.split('/')[2]); return undefined; }
      throw new Error(`unexpected ${method} ${route}`);
    },
  };
  const host = {
    publicArchive: { projectId: 'idle-abyss-princesses', sourceId: 'discord-public' },
    privateArchive: archive, state,
    async getPrivateEvent(eventId) { const index = Number(eventId.slice('private-event-'.length)) - 1; return events[index] ?? null; },
    async submitTicket(event) {
      const id = event.data.attributes.interactionId; const userId = event.data.actor.opaqueId;
      const prior = await state.get(`interaction:${id}`);
      if (prior) {
        if (JSON.stringify(events.find(item => item.id === event.id)) !== JSON.stringify(event)) throw new Error('COMMUNITY_INTERACTION_IDENTITY_CONFLICT');
        return { status: 'replayed', ticketId: prior.ticketId, eventId: prior.eventId };
      }
      events.push(jsonClone(event)); const eventId = `private-event-${events.length}`;
      const open = await state.get(`ticket:open:${userId}`);
      if (open && await state.get(`ticket:${open}`)) {
        await state.set(`interaction:${id}`, { status: 'archived', ticketId: open, eventId });
        return { status: 'existing', ticketId: open, eventId };
      }
      await state.set(`ticket:${id}`, { version: 1, id, userId, kind: event.data.attributes.ticketKind, status: 'pending_create', evidenceEventId: eventId, createdAt: event.time, createMarker: `superagent-ticket:${id}` });
      await state.set(`ticket:open:${userId}`, id);
      await state.set(`interaction:${id}`, { status: 'archived', ticketId: id, eventId });
      return { status: 'created', ticketId: id, eventId };
    },
    async flushChannel(channelId) { calls.push({ method: 'FLUSH', route: channelId }); if (flushWait) await flushWait(); },
    now() { return now; },
  };
  const community = new DiscordCommunity(config, host, api);
  t.after(() => { db.clear(); events.length = 0; });
  return { community, host, state, events, calls, channels, messages, setNow(value) { now = value; }, setFlushWait(value) { flushWait = value; },
    setCanManageRoles(value) { canManageRoles = value; }, api };
}

const packet = (interaction, sequence = 1) => ({ type: 'INTERACTION_CREATE', sequence, sessionId: 'session', receivedAt: '2026-11-03T00:00:00.000Z', data: interaction });
const modal = (id, actor, body = 'The game crashes after using this build.') => ({
  id, application_id: '102', token: 'private-interaction-token', type: 5, guild_id: ids.guild, channel_id: ids.panel,
  member: { user: { id: actor }, roles: [] }, data: { custom_id: 'ticket:submit:bug', components: [
    { type: 18, component: { custom_id: 'title', value: 'Crash report' } },
    { type: 18, component: { custom_id: 'body', value: body } },
  ] },
});

test('ticket submission is privately archived before durable intent and channel creation; body/token stay out of lifecycle state', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const interaction = modal('9001', '700', '  A reproducible crash while changing equipment.  ');
  await f.community.acknowledge(packet(interaction));
  await f.community.handleDispatch(packet(interaction), signal);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].data.content.text, '[bug] Crash report\n\n  A reproducible crash while changing equipment.  ');
  assert.equal(f.events[0].data.attributes.native.body, '  A reproducible crash while changing equipment.  ');
  assert.equal(validateContract('normalized-event-v1', f.events[0]).valid, true);
  const ticket = await f.state.get('ticket:9001');
  assert.equal(ticket.status, 'pending_create');
  assert.equal(ticket.evidenceEventId, 'private-event-1');
  const serializedState = JSON.stringify(await f.state.list(''));
  assert.doesNotMatch(serializedState, /A reproducible crash|private-interaction-token/);
  assert.equal(f.calls.some(call => call.method === 'POST' && call.route === `/guilds/${ids.guild}/channels`), false);
  await f.community.tick(signal);
  const created = await f.state.get('ticket:9001');
  assert.equal(created.status, 'open'); assert.equal(created.channelId, '501');
  const creation = f.calls.find(call => call.method === 'POST' && call.route === `/guilds/${ids.guild}/channels`);
  assert.equal(creation.body.parent_id, ids.category);
  const everyoneOverwrite = creation.body.permission_overwrites.find(row => row.id === ids.guild);
  assert.ok((BigInt(everyoneOverwrite.deny) & 1024n) !== 0n);
  assert.ok((BigInt(everyoneOverwrite.deny) & (1n << 35n)) !== 0n);
  const requesterOverwrite = creation.body.permission_overwrites.find(row => row.id === '700');
  assert.ok((BigInt(requesterOverwrite.deny) & (1n << 35n)) !== 0n);
  assert.ok((BigInt(requesterOverwrite.deny) & (1n << 36n)) !== 0n);
  assert.equal(creation.body.permission_overwrites.some(row => row.allow === 'Administrator'), false);
  assert.match(f.messages.get('501')[0].content, /A reproducible crash/);
  assert.equal(f.calls.some(call => call.method === 'PATCH' && call.route.includes('/webhooks/')), true);
});

test('one-open-ticket archival and staff role checks guard ticket lifecycle actions', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const first = modal('9101', '701'); const second = modal('9102', '701', 'Another report with enough detail.');
  await f.community.acknowledge(packet(first)); await f.community.handleDispatch(packet(first), signal);
  await f.community.acknowledge(packet(second, 2)); await f.community.handleDispatch(packet(second, 2), signal);
  assert.equal(f.events.length, 2);
  assert.equal((await f.state.get('interaction:9102')).status, 'archived');
  assert.equal((await f.state.get('interaction:9102')).ticketId, '9101');
  await f.community.tick(signal);
  const ticket = await f.state.get('ticket:9101');
  const forgedClose = { id: '9103', application_id: '102', token: 't3', type: 3, guild_id: ids.guild, channel_id: ticket.channelId,
    member: { user: { id: '799' }, roles: [] }, data: { custom_id: `ticket:close:${ticket.id}` } };
  await f.community.acknowledge(packet(forgedClose, 3)); await f.community.handleDispatch(packet(forgedClose, 3), signal);
  assert.equal((await f.state.get('ticket:9101')).status, 'open');
  const staffClose = { ...forgedClose, id: '9104', token: 't4', member: { user: { id: ids.staff }, roles: [ids.staff] } };
  await f.community.acknowledge(packet(staffClose, 4)); await f.community.handleDispatch(packet(staffClose, 4), signal);
  assert.equal((await f.state.get('ticket:9101')).status, 'closed');
  await f.community.tick(signal);
  const closePermission = f.calls.find(call => call.method === 'PUT' && call.route.endsWith('/permissions/701'));
  assert.ok((BigInt(closePermission.body.deny) & 2048n) !== 0n);
  assert.ok((BigInt(closePermission.body.deny) & (1n << 35n)) !== 0n);
});

test('ticket overwrite 403s leave close/add/remove operations retryable after MANAGE_ROLES is restored', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  await f.community.handleDispatch(packet(modal('9111', '701')), signal); await f.community.tick(signal);
  const ticket = await f.state.get('ticket:9111');
  const command = (id, name, member) => ({ id, application_id: ids.bot, token: `token-${id}`, type: 2, guild_id: ids.guild, channel_id: ticket.channelId,
    member: { user: { id: ids.staff }, roles: [ids.staff] }, data: { name: 'ticket', options: [{ type: 1, name,
      ...(member ? { options: [{ type: 6, name: 'member', value: member }] } : {}) }] } });
  const requesterOverwrite = () => f.channels.get(ticket.channelId).permission_overwrites.find(item => item.id === '701');

  f.setCanManageRoles(false);
  await f.community.handleDispatch(packet(command('9112', 'close')), signal);
  await assert.rejects(f.community.tick(signal), /PERMISSION_DENIED/);
  assert.equal((await f.state.get('ticket:9111')).status, 'closed');
  assert.ok(BigInt(requesterOverwrite().allow) & 2048n, 'failed close did not apply its overwrite');
  f.setCanManageRoles(true); await f.community.tick(signal);
  assert.equal(BigInt(requesterOverwrite().allow) & 2048n, 0n);
  assert.ok(BigInt(requesterOverwrite().deny) & 2048n);

  f.setCanManageRoles(false);
  await f.community.handleDispatch(packet(command('9113', 'add', '716')), signal);
  await assert.rejects(f.community.tick(signal), /PERMISSION_DENIED/);
  assert.equal((await f.state.get('ticket:9111')).pendingAccess[0].action, 'add');
  f.setCanManageRoles(true); await f.community.tick(signal);
  assert.ok(f.channels.get(ticket.channelId).permission_overwrites.some(item => item.id === '716'));

  f.setCanManageRoles(false);
  await f.community.handleDispatch(packet(command('9114', 'remove', '716')), signal);
  await assert.rejects(f.community.tick(signal), /PERMISSION_DENIED/);
  assert.equal((await f.state.get('ticket:9111')).pendingAccess[0].action, 'remove');
  f.setCanManageRoles(true); await f.community.tick(signal);
  assert.equal(f.channels.get(ticket.channelId).permission_overwrites.some(item => item.id === '716'), false);
});

test('ticket deletion checks existence before final flush and recovers accepted unknown delete without flushing a missing channel', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const submission = modal('9151', '715');
  await f.community.acknowledge(packet(submission)); await f.community.handleDispatch(packet(submission), signal); await f.community.tick(signal);
  const channelId = (await f.state.get('ticket:9151')).channelId;
  const staffCommand = (id, name) => ({ id, application_id: ids.bot, token: `token-${id}`, type: 2, guild_id: ids.guild, channel_id: channelId,
    member: { user: { id: ids.staff }, roles: [ids.staff] }, data: { name: 'ticket', options: [{ type: 1, name }] } });
  const close = staffCommand('9152', 'close'); await f.community.acknowledge(packet(close, 2)); await f.community.handleDispatch(packet(close, 2), signal); await f.community.tick(signal);
  const remove = staffCommand('9153', 'delete'); await f.community.acknowledge(packet(remove, 3)); await f.community.handleDispatch(packet(remove, 3), signal);
  const actual = f.api.request; let firstDelete = true;
  f.api.request = async (method, route, body, abort) => {
    if (method === 'DELETE' && route === `/channels/${channelId}` && firstDelete) {
      firstDelete = false; await actual(method, route, body, abort); throw new Error('OUTCOME_UNKNOWN');
    }
    return actual(method, route, body, abort);
  };
  await f.community.tick(signal);
  assert.equal((await f.state.get('ticket:9151')).status, 'unknown_delete');
  assert.equal((await f.state.get('ticket:9151')).finalFlushComplete, true);
  f.api.request = actual; await f.community.tick(signal);
  assert.equal((await f.state.get('ticket:9151')).status, 'deleted');
  assert.equal(f.calls.filter(call => call.method === 'FLUSH' && call.route === channelId).length, 1);
});

test('closing locks invited participants too, and staff cannot remove the archive bot or requester', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  await f.community.handleDispatch(packet(modal('9160', '715')), signal); await f.community.tick(signal);
  const ticket = await f.state.get('ticket:9160');
  const command = (id, name, member) => ({ id, application_id: ids.bot, token: 'synthetic', type: 2, guild_id: ids.guild, channel_id: ticket.channelId,
    member: { user: { id: ids.staff }, roles: [ids.staff] }, data: { name: 'ticket', options: [{ type: 1, name,
      ...(member ? { options: [{ type: 6, name: 'member', value: member }] } : {}) }] } });
  await f.community.handleDispatch(packet(command('9161', 'add', '716')), signal); await f.community.tick(signal);
  await f.community.handleDispatch(packet(command('9162', 'close')), signal); await f.community.tick(signal);
  await f.community.handleDispatch(packet(command('9165', 'add', '717')), signal); await f.community.tick(signal);
  for (const user of ['715', '716', '717']) {
    const overwrite = f.channels.get(ticket.channelId).permission_overwrites.find(item => item.id === user);
    assert.ok(BigInt(overwrite.allow) & 1024n);
    assert.equal(BigInt(overwrite.allow) & 2048n, 0n);
    assert.ok(BigInt(overwrite.deny) & 2048n);
  }
  const deletes = f.calls.filter(call => call.method === 'DELETE').length;
  await f.community.handleDispatch(packet(command('9163', 'remove', ids.bot)), signal);
  await f.community.handleDispatch(packet(command('9164', 'remove', '715')), signal); await f.community.tick(signal);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, deletes);
});

test('ambiguous ticket channel creation is reconciled by marker and never blindly repeated', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const interaction = modal('9201', '702');
  await f.community.acknowledge(packet(interaction)); await f.community.handleDispatch(packet(interaction), signal);
  const realRequest = f.api.request;
  let postCount = 0;
  f.api.request = async (method, route, body, abort) => {
    if (method === 'POST' && route === `/guilds/${ids.guild}/channels`) { postCount++; throw new Error('OUTCOME_UNKNOWN'); }
    return realRequest(method, route, body, abort);
  };
  await f.community.tick(signal);
  assert.equal((await f.state.get('ticket:9201')).status, 'unknown_create');
  assert.equal(postCount, 1);
  f.channels.set('777', { id: '777', type: 0, parent_id: ids.category, topic: 'superagent-ticket:9201' });
  f.api.request = realRequest;
  await f.community.tick(signal);
  assert.equal((await f.state.get('ticket:9201')).channelId, '777');
  assert.equal(postCount, 1);
});

test('ticket control post waits for successful history lookup and ignores a forged marker author', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const interaction = modal('9251', '716');
  await f.community.acknowledge(packet(interaction)); await f.community.handleDispatch(packet(interaction), signal);
  const actual = f.api.request; let historyReads = 0;
  f.api.request = async (method, route, body, abort) => {
    if (method === 'GET' && route.endsWith('/messages?limit=50')) { historyReads++; throw new Error('TEMPORARY_HISTORY_FAILURE'); }
    return actual(method, route, body, abort);
  };
  await assert.rejects(f.community.tick(signal), /TEMPORARY_HISTORY_FAILURE/);
  const ticket = await f.state.get('ticket:9251');
  assert.equal(ticket.status, 'open');
  assert.equal(f.calls.some(call => call.method === 'POST' && call.route.endsWith('/messages')), false);
  f.api.request = actual;
  f.messages.set(ticket.channelId, [{ id: '490', content: `community-ticket-controls:${ticket.id}`, author: { id: '999' } }]);
  await f.community.tick(signal);
  const botMessages = f.messages.get(ticket.channelId).filter(message => message.author.id === ids.bot);
  assert.equal(botMessages.length, 1);
  assert.ok(botMessages[0].components.some(row => row.components.some(component => component.custom_id === `ticket:close:${ticket.id}`)));
  assert.doesNotMatch(botMessages[0].content, /community-ticket-controls|private-event-/);
  assert.equal(historyReads, 1);
});

test('ambiguous ticket-control post is reconciled from bot-authored component IDs before another send', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const interaction = modal('9253', '718');
  await f.community.acknowledge(packet(interaction)); await f.community.handleDispatch(packet(interaction), signal);
  const actual = f.api.request; let failed = false;
  f.api.request = async (method, route, body, abort) => {
    if (!failed && method === 'POST' && route.endsWith('/messages')) {
      failed = true; await actual(method, route, body, abort); throw new Error('OUTCOME_UNKNOWN');
    }
    return actual(method, route, body, abort);
  };
  await f.community.tick(signal);
  const ticket = await f.state.get('ticket:9253');
  assert.ok(ticket.controlsPostingAt);
  assert.equal(f.messages.get(ticket.channelId).length, 1);
  await f.community.tick(signal);
  assert.equal(f.messages.get(ticket.channelId).length, 1, 'recent ambiguous write is not repeated');
  f.setNow('2026-11-03T00:01:01.000Z'); f.api.request = actual;
  await f.community.tick(signal);
  assert.equal(f.messages.get(ticket.channelId).length, 1, 'history lookup finds the original bot control message');
  assert.ok((await f.state.get('ticket:9253')).controlsMessageId);
});

test('long ticket submissions are fully shown across Discord-safe message parts without leaking archive IDs', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  const submitted = '详情 '.repeat(700);
  const interaction = modal('9252', '717', submitted);
  await f.community.acknowledge(packet(interaction)); await f.community.handleDispatch(packet(interaction), signal); await f.community.tick(signal);
  const ticket = await f.state.get('ticket:9252');
  const botMessages = f.messages.get(ticket.channelId).filter(message => message.author.id === ids.bot);
  const controls = botMessages.find(message => Array.isArray(message.components));
  const tail = botMessages.filter(message => message.message_reference?.message_id === controls.id).reverse();
  assert.equal(controls.content + tail.map(message => message.content).join(''), f.events[0].data.content.text);
  assert.ok(botMessages.every(message => message.content.length <= 1900));
  assert.ok(botMessages.every(message => !/private-event-|community-ticket-controls|discord-community:/.test(message.content)));
});

test('temporary room reconciliation uses the type 2 deterministic name marker, not topic', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 1, sessionId: 's', receivedAt: '2026-11-03T00:00:00Z', data: { guild_id: ids.guild, user_id: '711', channel_id: ids.lobby } }, signal);
  await f.community.handleDispatch({ type: 'GUILD_CREATE', sequence: 2, sessionId: 's', receivedAt: '2026-11-03T00:00:01Z', data: { id: ids.guild, voice_states: [{ user_id: '711', channel_id: ids.lobby }] } }, signal);
  const realRequest = f.api.request; let creates = 0; let createdName;
  f.api.request = async (method, route, body, abort) => {
    if (method === 'POST' && route === `/guilds/${ids.guild}/channels`) { creates++; createdName = body.name; assert.equal(body.topic, undefined); throw new Error('OUTCOME_UNKNOWN'); }
    return realRequest(method, route, body, abort);
  };
  await f.community.tick(signal);
  assert.equal((await f.state.get('room:voice-711')).status, 'unknown_create');
  f.channels.set('778', { id: '778', type: 2, parent_id: ids.voiceCategory, name: createdName, topic: 'unrelated topic' });
  f.api.request = realRequest;
  await f.community.tick(signal);
  const room = await f.state.get('room:voice-711');
  assert.equal(room.channelId, '778'); assert.equal(room.status, 'active'); assert.equal(creates, 1);
});

test('voice lobby creates a four-place room, controls are host-bound, and deletion follows final flush after 60 seconds', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 1, sessionId: 's', receivedAt: '2026-11-03T00:00:00Z', data: { guild_id: ids.guild, user_id: '710', channel_id: ids.lobby } }, signal);
  await f.community.handleDispatch({ type: 'GUILD_CREATE', sequence: 2, sessionId: 's', receivedAt: '2026-11-03T00:00:01Z', data: { id: ids.guild, voice_states: [{ user_id: '710', channel_id: ids.lobby }] } }, signal);
  await f.community.tick(signal);
  let room = await f.state.get('room:voice-710');
  assert.equal(room.status, 'active'); assert.equal(room.limit, 4); assert.equal(room.channelId, '501');
  const create = f.calls.find(call => call.method === 'POST' && call.route === `/guilds/${ids.guild}/channels`);
  assert.equal(create.body.user_limit, 4);
  assert.equal(create.body.type, 2);
  assert.match(create.body.name, /^🎮 冒险小队 · [a-f0-9]{12}$/);
  await f.community.handleDispatch(packet({ id: '9400', application_id: ids.bot, token: 'synthetic', type: 2, guild_id: ids.guild,
    channel_id: ids.controls, member: { user: { id: '710' }, roles: [] }, data: { name: 'room', options: [
      { type: 1, name: 'rename', options: [{ type: 3, name: 'name', value: '晚间组队' }] },
    ] } }), signal);
  await f.community.tick(signal);
  assert.equal(f.channels.get('501').name, '晚间组队');
  assert.equal(f.calls.some(call => call.method === 'PATCH' && call.route === `/guilds/${ids.guild}/members/710`), true);
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 2, sessionId: 's', receivedAt: '2026-11-03T00:00:10Z', data: { guild_id: ids.guild, user_id: '710', channel_id: null } }, signal);
  await f.community.handleDispatch({ type: 'READY', sequence: 3, sessionId: 's2', receivedAt: '2026-11-03T00:01:10Z', data: { guilds: [] } }, signal);
  f.setNow('2026-11-03T00:00:11.000Z'); await f.community.tick(signal);
  assert.equal(f.calls.some(call => call.method === 'DELETE' && call.route === '/channels/501'), false);
  f.setNow('2026-11-03T00:01:11.000Z'); await f.community.tick(signal);
  assert.equal(f.calls.some(call => call.method === 'DELETE' && call.route === '/channels/501'), false, 'cleanup waits for a full voice snapshot');
  await f.community.handleDispatch({ type: 'GUILD_CREATE', sequence: 4, sessionId: 's2', receivedAt: '2026-11-03T00:01:12Z', data: { id: ids.guild, voice_states: [] } }, signal);
  await f.community.tick(signal);
  room = await f.state.get('room:voice-710');
  assert.equal(room.lastError, 'expired-room-deleted');
  const flush = f.calls.findIndex(call => call.method === 'FLUSH' && call.route === '501');
  const deletion = f.calls.findIndex(call => call.method === 'DELETE' && call.route === '/channels/501');
  assert.ok(flush >= 0 && deletion > flush);
});

test('a voice event repairs a missing owner index without overwriting an active room entity', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  f.channels.set('779', { id: '779', type: 2, guild_id: ids.guild, parent_id: ids.voiceCategory, name: 'party-710-sa-room-710', user_limit: 4, permission_overwrites: [] });
  await f.state.set('room:voice-710', { version: 1, id: 'voice-710', ownerId: '710', channelId: '779', status: 'active',
    createMarker: 'superagent-room:710', createdAt: '2026-11-03T00:00:00.000Z', limit: 4,
    occupants: [{ userId: '710', joinedAt: '2026-11-03T00:00:00.000Z' }] });
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 1, sessionId: 's', receivedAt: '2026-11-03T00:00:01Z',
    data: { guild_id: ids.guild, user_id: '710', channel_id: ids.lobby } }, signal);
  assert.equal(await f.state.get('room:owner:710'), 'voice-710');
  assert.equal((await f.state.get('room:voice-710')).channelId, '779');
  assert.equal(f.calls.some(call => call.method === 'POST' && call.route === `/guilds/${ids.guild}/channels`), false);
});

test('a member joining during the final voice-history flush cancels deletion after the fresh occupancy check', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 1, sessionId: 's', receivedAt: '2026-11-03T00:00:00Z', data: { guild_id: ids.guild, user_id: '712', channel_id: ids.lobby } }, signal);
  await f.community.handleDispatch({ type: 'GUILD_CREATE', sequence: 2, sessionId: 's', receivedAt: '2026-11-03T00:00:01Z', data: { id: ids.guild, voice_states: [{ user_id: '712', channel_id: ids.lobby }] } }, signal);
  await f.community.tick(signal);
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 3, sessionId: 's', receivedAt: '2026-11-03T00:00:10Z', data: { guild_id: ids.guild, user_id: '712', channel_id: null } }, signal);
  f.setNow('2026-11-03T00:01:11.000Z');
  let enteredFlush; const entered = new Promise(resolve => { enteredFlush = resolve; });
  let releaseFlush; const wait = new Promise(resolve => { releaseFlush = resolve; });
  f.setFlushWait(async () => { enteredFlush(); await wait; });
  const cleanup = f.community.tick(signal);
  await entered;
  await f.community.handleDispatch({ type: 'VOICE_STATE_UPDATE', sequence: 4, sessionId: 's', receivedAt: '2026-11-03T00:01:12Z', data: { guild_id: ids.guild, user_id: '713', channel_id: '501' } }, signal);
  releaseFlush(); await cleanup;
  const room = await f.state.get('room:voice-712');
  assert.equal(room.status, 'active'); assert.ok(room.occupants.some(occupant => occupant.userId === '713'));
  assert.equal(f.calls.some(call => call.method === 'DELETE' && call.route === '/channels/501'), false);
});

test('DiscordREST retries GETs and definitive 429s, but reports ambiguous mutating failures', async () => {
  let gets = 0;
  const getRest = new DiscordREST('test-token', { maxRetries: 2, sleep: async () => {}, fetch: async () => {
    gets++; return gets === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await getRest.request('GET', '/channels/1'), { ok: true }); assert.equal(gets, 2);
  let mutations = 0;
  const mutationRest = new DiscordREST('test-token', { sleep: async () => {}, fetch: async () => { mutations++; throw new Error('socket reset'); } });
  await assert.rejects(mutationRest.request('POST', '/channels/1/messages', { content: 'x' }), /OUTCOME_UNKNOWN/);
  assert.equal(mutations, 1);
  const malformedMutation = new DiscordREST('test-token', { fetch: async () => new Response('not-json', { status: 201 }) });
  await assert.rejects(malformedMutation.request('POST', '/guilds/1/channels', { name: 'room' }), /OUTCOME_UNKNOWN/);
  let throttled = 0;
  const rateRest = new DiscordREST('test-token', { sleep: async () => {}, fetch: async () => ++throttled === 1
    ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429, headers: { 'content-type': 'application/json' } })
    : new Response(null, { status: 204 }) });
  assert.equal(await rateRest.request('DELETE', '/channels/1'), undefined); assert.equal(throttled, 2);
  const waits = []; let slowRate = 0;
  const longRate = new DiscordREST('test-token', { sleep: async milliseconds => { waits.push(milliseconds); }, fetch: async () => ++slowRate === 1
    ? new Response(JSON.stringify({ retry_after: 121 }), { status: 429, headers: { 'content-type': 'application/json' } })
    : new Response(null, { status: 204 }) });
  await longRate.request('GET', '/channels/1');
  assert.equal(waits.reduce((sum, value) => sum + value, 0), 121_000);
});

test('panels and guild commands publish bilingual safe entry points idempotently', async t => {
  const f = fixture(t); const signal = new AbortController().signal;
  f.messages.set(ids.panel, [{ id: '490', content: 'community-panel:ticket:v1 forged', author: { id: '999' } }]);
  await f.community.publishPanels(signal); await f.community.publishPanels(signal);
  const panelPosts = f.calls.filter(call => call.method === 'POST' && call.route.endsWith('/messages'));
  assert.equal(panelPosts.length, 2);
  assert.match(panelPosts[0].body.content, /Private community help · 私密社区求助/);
  assert.doesNotMatch(panelPosts[0].body.content, /community-panel:/);
  assert.doesNotMatch(panelPosts[0].body.content, /@everyone|@here/);
  assert.match(panelPosts[1].body.content, /Temporary voice rooms · 临时语音房/);
  assert.doesNotMatch(panelPosts[1].body.content, /community-panel:/);
  await f.community.registerCommands(signal); await f.community.registerCommands(signal);
  const commandPuts = f.calls.filter(call => call.method === 'PUT' && call.route.endsWith('/commands'));
  assert.equal(commandPuts.length, 1);
  assert.deepEqual(commandPuts[0].body.map(item => item.name), ['ticket', 'room']);
});
