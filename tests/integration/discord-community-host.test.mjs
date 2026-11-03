import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordCommunity } from '../../packages/discord-community/dist/index.js';
import { DomainService } from '@superagent/domain';
import { HybridMemory } from '@superagent/memory';
import { DurableCommunityState } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';

const ids = { guild: '100', owner: '101', bot: '102', staff: '103', category: '200', panel: '201', voiceCategory: '300', lobby: '301', controls: '202' };
const privateBinding = {
  projectId: 'idle-abyss-princesses-private', sourceId: 'discord-100-tickets',
  sourceUri: 'urn:superagent:source:discord:100:tickets', platform: 'discord',
};
const publicBinding = {
  projectId: 'idle-abyss-princesses', sourceId: 'discord-100-public',
  sourceUri: 'urn:superagent:source:discord:100:public', platform: 'discord',
};
const scopeOf = ({ projectId, sourceId }) => ({ projectId, sourceId });
const privateScope = scopeOf(privateBinding);
const publicScope = scopeOf(publicBinding);
const config = {
  guildId: ids.guild, ownerId: ids.owner, botUserId: ids.bot, staffRoleIds: [ids.staff],
  ticketCategoryId: ids.category, ticketPanelChannelId: ids.panel,
  voiceCategoryId: ids.voiceCategory, voiceLobbyChannelId: ids.lobby, roomControlsChannelId: ids.controls,
};
const clone = value => JSON.parse(JSON.stringify(value));

function channelApi() {
  const channels = new Map();
  const messages = new Map();
  const calls = [];
  let nextId = 500;
  return {
    channels, messages, calls,
    async request(method, route, body) {
      calls.push({ method, route, ...(body === undefined ? {} : { body: clone(body) }) });
      if (method === 'POST' && route.startsWith('/interactions/') && route.endsWith('/callback')) return undefined;
      if (method === 'GET' && route === `/guilds/${ids.guild}/channels`) return [...channels.values()].map(clone);
      if (method === 'POST' && route === `/guilds/${ids.guild}/channels`) {
        const channel = { ...clone(body), id: String(++nextId), guild_id: ids.guild, permission_overwrites: clone(body.permission_overwrites ?? []) };
        channels.set(channel.id, channel); return clone(channel);
      }
      const messageRoute = route.match(/^\/channels\/(\d+)\/messages(?:\?.*)?$/);
      if (messageRoute && method === 'GET') return (messages.get(messageRoute[1]) ?? []).map(clone);
      if (messageRoute && method === 'POST') {
        const list = messages.get(messageRoute[1]) ?? [];
        const sent = { id: String(++nextId), channel_id: messageRoute[1], content: body.content };
        list.unshift(sent); messages.set(messageRoute[1], list); return clone(sent);
      }
      const permissionRoute = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/);
      if (permissionRoute && method === 'PUT') {
        const channel = channels.get(permissionRoute[1]);
        channel.permission_overwrites = channel.permission_overwrites.filter(row => row.id !== permissionRoute[2]);
        channel.permission_overwrites.push(clone(body)); return undefined;
      }
      const channelRoute = route.match(/^\/channels\/(\d+)$/);
      if (channelRoute && method === 'GET') {
        const channel = channels.get(channelRoute[1]); if (!channel) throw new Error('NOT_FOUND'); return clone(channel);
      }
      throw new Error(`UNEXPECTED_TEST_REST_ROUTE:${method}:${route}`);
    },
  };
}

function openBoundRuntime(runtime, clock, owner) {
  runtime.ingress.registerSource(publicBinding);
  runtime.ingress.setSourcePolicy(publicScope, { visibility: 'public', processingMode: 'archive_only' });
  runtime.ingress.registerSource(privateBinding);
  runtime.ingress.setSourcePolicy(privateScope, { visibility: 'staff', processingMode: 'archive_only' });
  const state = new DurableCommunityState(runtime.store, `discord-community:${ids.guild}`, { clock, leaseOwner: owner });
  assert.equal(state.acquireLease(owner, 45_000), true);
  return {
    state,
    publicArchive: runtime.ingress.sourceHost(publicScope),
    privateArchive: runtime.ingress.sourceHost(privateScope),
  };
}

function makeCommunity(runtime, clock, owner, api, stateOverride) {
  const bound = openBoundRuntime(runtime, clock, owner);
  const state = stateOverride?.(bound.state) ?? bound.state;
  const publicArchive = runtime.ingress.sourceHost(publicScope);
  const privateArchive = runtime.ingress.sourceHost(privateScope);
  const community = new DiscordCommunity(config, {
    publicArchive,
    privateArchive,
    state,
    async getPrivateEvent(eventId) {
      const record = runtime.ingress.getEvent(privateScope.projectId, eventId);
      return record?.event.data.sourceId === privateBinding.sourceId ? record.event : null;
    },
    async flushChannel() {},
    now: clock,
  }, api);
  return { community, state, baseState: bound.state, publicArchive, privateArchive };
}

const ticketPacket = (interactionId, userId, title, body, receivedAt = '2026-11-03T00:00:00.000Z') => ({
  type: 'INTERACTION_CREATE', sequence: 1, sessionId: 'host-test-session', receivedAt,
  data: {
    id: interactionId, application_id: ids.bot, token: `token-${interactionId}`, type: 5, guild_id: ids.guild,
    channel_id: ids.panel, member: { user: { id: userId }, roles: [] },
    data: { custom_id: 'ticket:submit:bug', components: [
      { type: 18, component: { custom_id: 'title', value: title } },
      { type: 18, component: { custom_id: 'body', value: body } },
    ] },
  },
});

function count(store, table, where = '', ...params) {
  return Number(store.get(`SELECT count(*) count FROM ${table}${where}`, ...params).count);
}

test('real archive replay survives ticket-state failure with private isolation and least-access ticket channels', async t => {
  const f = fixture(t);
  const api = channelApi();
  const first = makeCommunity(f.runtime, f.clock, 'controller-one', api, baseState => {
    let fail = true;
    return {
      get: key => baseState.get(key),
      async set(key, value) {
        if (fail && key === 'ticket:9301') { fail = false; throw new Error('INJECTED_TICKET_STATE_FAILURE'); }
        return baseState.set(key, value);
      },
      update: (key, reducer) => baseState.update(key, reducer),
      list: prefix => baseState.list(prefix),
    };
  });
  const packet = ticketPacket('9301', '700', 'Crash after equipment change', 'The game closes while changing gear. PRIVATE-BODY-SENTINEL.');
  const signal = new AbortController().signal;

  await assert.rejects(first.community.handleDispatch(packet, signal), /INJECTED_TICKET_STATE_FAILURE/);
  const archivedBeforeRestart = f.runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE project_id=? AND source_id=?',
    privateScope.projectId, privateScope.sourceId);
  assert.ok(archivedBeforeRestart);
  const firstHostId = archivedBeforeRestart.event_id;
  assert.equal(count(f.runtime.store, 'source_events', ' WHERE project_id=? AND source_id=?', privateScope.projectId, privateScope.sourceId), 1);
  assert.equal(await first.baseState.get('ticket:9301'), null);

  f.runtime.close();
  f.advance(45_001);
  const reopened = f.open();
  const afterRestart = makeCommunity(reopened, f.clock, 'controller-two', api);
  await afterRestart.community.handleDispatch(packet, new AbortController().signal);

  const ticket = await afterRestart.state.get('ticket:9301');
  assert.equal(ticket.status, 'pending_create');
  assert.equal(ticket.evidenceEventId, firstHostId);
  const replayed = reopened.store.get('SELECT event_id,payload_json FROM source_events WHERE project_id=? AND source_id=?',
    privateScope.projectId, privateScope.sourceId);
  assert.equal(replayed.event_id, firstHostId);
  assert.equal(JSON.parse(replayed.payload_json).time, packet.receivedAt);
  assert.equal(count(reopened.store, 'source_events', ' WHERE project_id=? AND source_id=?', privateScope.projectId, privateScope.sourceId), 1);
  assert.doesNotMatch(JSON.stringify(await afterRestart.state.list('')), /PRIVATE-BODY-SENTINEL|token-9301/);

  assert.equal(reopened.tick().admitted, 0);
  await assert.rejects(reopened.accept(firstHostId), /SOURCE_ARCHIVE_ONLY/);
  assert.throws(() => reopened.buffer.admitSync(firstHostId), /SOURCE_ARCHIVE_ONLY/);
  assert.throws(() => reopened.buffer.admitSync(firstHostId, reopened.buffer.policy, true), /SOURCE_ARCHIVE_ONLY/);
  assert.equal(count(reopened.store, 'admission_decisions'), 0);
  assert.equal(count(reopened.store, 'jobs'), 0);
  assert.equal(count(reopened.store, 'event_outbox', ' WHERE status=?', 'pending'), 1);

  const memory = new HybridMemory(reopened.store);
  const domain = new DomainService(reopened.store, memory);
  assert.equal(domain.evidence(privateScope.projectId, firstHostId), undefined);
  assert.equal(domain.evidence(publicScope.projectId, firstHostId), undefined);
  assert.ok(reopened.ingress.getEvent(privateScope.projectId, firstHostId).event.data.content.text.includes('PRIVATE-BODY-SENTINEL'));
  assert.equal(reopened.ingress.getEvent(publicScope.projectId, firstHostId), undefined);

  await afterRestart.community.tick(new AbortController().signal);
  const secondPacket = ticketPacket('9302', '701', 'Second report', 'Another user submitted an independent report.');
  await afterRestart.community.handleDispatch(secondPacket, new AbortController().signal);
  await afterRestart.community.tick(new AbortController().signal);
  const firstTicket = await afterRestart.state.get('ticket:9301');
  const secondTicket = await afterRestart.state.get('ticket:9302');
  assert.equal(firstTicket.status, 'open');
  assert.equal(secondTicket.status, 'open');

  const firstChannel = api.channels.get(firstTicket.channelId);
  const secondChannel = api.channels.get(secondTicket.channelId);
  assert.ok(firstChannel && secondChannel && firstChannel.id !== secondChannel.id);
  const everybody = firstChannel.permission_overwrites.find(row => row.id === ids.guild && Number(row.type) === 0);
  const requester = firstChannel.permission_overwrites.find(row => row.id === '700' && Number(row.type) === 1);
  const staff = firstChannel.permission_overwrites.find(row => row.id === ids.staff && Number(row.type) === 0);
  assert.ok((BigInt(everybody.deny) & 1024n) !== 0n, 'everyone cannot view the ticket');
  assert.ok((BigInt(requester.allow) & 1024n) !== 0n, `requester can view their ticket (allow=${requester.allow})`);
  assert.ok((BigInt(staff.allow) & 1024n) !== 0n, 'staff can view the ticket');
  assert.equal(firstChannel.permission_overwrites.some(row => row.id === '701'), false, 'another requester has no overwrite for this ticket');
  const otherRequester = secondChannel.permission_overwrites.find(row => row.id === '701' && Number(row.type) === 1);
  assert.ok(otherRequester);
  assert.ok((BigInt(otherRequester.allow) & 1024n) !== 0n, 'second requester can view their own ticket');
  assert.equal(secondChannel.permission_overwrites.some(row => row.id === '700'), false, 'first requester has no overwrite for the other ticket');

  const unauthorizedClose = {
    type: 'INTERACTION_CREATE', sequence: 2, sessionId: 'host-test-session', receivedAt: f.clock(),
    data: { id: '9401', application_id: ids.bot, token: 'token-9401', type: 3, guild_id: ids.guild,
      channel_id: firstTicket.channelId, member: { user: { id: '701' }, roles: [] },
      data: { custom_id: 'ticket:close:9301' } },
  };
  await afterRestart.community.handleDispatch(unauthorizedClose, new AbortController().signal);
  assert.equal((await afterRestart.state.get('ticket:9301')).status, 'open');
});
