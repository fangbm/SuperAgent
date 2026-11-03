import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DurableCommunityState } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';
import { parseBotConfig, readBotSecret, botInstallUrl } from '../../scripts/discord-bot-config.mjs';
import { provisionCommunity, archiveNotice, publishArchiveNotice } from '../../scripts/discord-bot-setup.mjs';
import { botStatus, runBot } from '../../scripts/discord-bot.mjs';

const config = () => ({ ...JSON.parse(readFileSync('community/idle-abyss-princesses/bot-config.json', 'utf8')), guildId: '100' });
function apiFixture(c, { unknownCreate = false, accepted = false } = {}) {
  const channels = [{ id: '40', guild_id: '100', name: c.voiceCategoryName, type: 4 }, { id: '50', guild_id: '100', name: '🛠 FEEDBACK', type: 4 },
    { id: '60', guild_id: '100', name: c.roomControlsChannelName, type: 0 }, { id: '70', guild_id: '100', name: '📚・入门-faq', type: 0 }];
  const calls = [];
  let next = 1000;
  let failed = false;
  return { calls, channels, api: { request: async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === '/guilds/100' && method === 'GET') return { id: '100', owner_id: '888' };
    if (route === '/users/@me') return { id: '999' };
    if (route === '/oauth2/applications/@me') return { id: '999', flags: 1 << 18 };
    if (route === '/guilds/100/roles') return [{ id: '100', name: '@everyone' }, ...c.staffRoleNames.map((name, i) => ({ id: String(i + 11), name }))];
    if (route === '/guilds/100/channels' && method === 'GET') return structuredClone(channels);
    if (route === '/guilds/100/channels' && method === 'POST') {
      const channel = { id: String(++next), guild_id: '100', ...body };
      if (unknownCreate && !failed) { failed = true; if (accepted) channels.push(channel); throw new Error('OUTCOME_UNKNOWN'); }
      channels.push(channel); return structuredClone(channel);
    }
    if (route.startsWith('/channels/') && method === 'PATCH') return {};
    throw new Error('Unexpected fixture request: ' + method + ' ' + route);
  } } };
}

test('bot config and installation link are offline, scoped and never request Administrator', () => {
  const c = parseBotConfig(config());
  assert.equal(c.defaultRoomLimit, 4);
  assert.throws(() => parseBotConfig({ ...c, privateProjectId: c.projectId }), /INVALID_CONFIG/);
  assert.throws(() => parseBotConfig({ ...c, guildId: '../other' }), /INVALID_CONFIG/);
  assert.throws(() => parseBotConfig({ ...c, token: 'should-not-be-config' }), /INVALID_CONFIG/);
  assert.throws(() => readBotSecret('DISCORD_BOT_TOKEN', {}), /MISSING_SECRET/);
  assert.throws(() => readBotSecret('DISCORD_BOT_TOKEN', { DISCORD_BOT_TOKEN: 'x', DISCORD_BOT_TOKEN_FILE: 'y' }), /AMBIGUOUS_SECRET/);
  const url = new URL(botInstallUrl('999', c.guildId));
  assert.equal(url.searchParams.get('guild_id'), c.guildId);
  assert.equal(url.searchParams.get('disable_guild_select'), 'true');
  assert.equal(BigInt(url.searchParams.get('permissions')) & 8n, 0n);
  assert.ok(BigInt(url.searchParams.get('permissions')) & (1n << 28n), 'channel overwrite endpoints require MANAGE_ROLES');
});

test('missing bot credentials do not create or migrate an archive', async t => {
  const f = fixture(t);
  const filename = path.join(f.directory, 'not-created.sqlite');
  await assert.rejects(runBot(config(), filename, { env: {} }), /MISSING_SECRET/);
  assert.equal(existsSync(filename), false);
});

test('bot status is token-free and reads live lease/heartbeat without changing archive counts', async t => {
  const f = fixture(t);
  const c = config();
  const state = new DurableCommunityState(f.runtime.store, 'discord-community:' + c.guildId);
  assert.equal(botStatus(f.filename, c).healthy, false);
  state.acquireLease('status-test', 45000);
  await state.set('runtime:health', { mode: 'run', checkedAt: new Date().toISOString() });
  assert.equal(botStatus(f.filename, c).healthy, true);
  assert.equal(f.runtime.metrics().sourceEventsIngested, 0);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM jobs').n, 0);
  state.releaseLease('status-test');
  assert.equal(botStatus(f.filename, c).healthy, false);
});

test('setup uses current roles/categories, creates private resources with overwrites, and reruns without duplicates', async t => {
  const f = fixture(t);
  const c = config();
  const state = new DurableCommunityState(f.runtime.store, 'setup-test');
  const a = apiFixture(c);
  const setup = await provisionCommunity(c, state, a.api, new AbortController().signal);
  assert.equal(setup.ownerId, '888');
  assert.deepEqual(setup.staffRoleIds, ['11', '12']);
  assert.equal(a.calls.filter(call => call.method === 'POST').length, 3);
  const category = a.channels.find(channel => channel.id === setup.ticketCategoryId);
  assert.ok(BigInt(category.permission_overwrites.find(overwrite => overwrite.id === c.guildId).deny) & 1024n);
  assert.equal(category.permission_overwrites.some(overwrite => overwrite.id === '888'), false);
  const before = a.channels.map(channel => channel.id);
  assert.deepEqual(await provisionCommunity(c, state, a.api, new AbortController().signal), setup);
  assert.deepEqual(a.channels.map(channel => channel.id), before);
  assert.equal(a.calls.filter(call => call.method === 'POST').length, 3);
});

test('setup reconciles an accepted unknown create and refuses to retry an unresolved one', async t => {
  for (const accepted of [false, true]) {
    const f = fixture(t);
    const c = config();
    const state = new DurableCommunityState(f.runtime.store, 'unknown-' + accepted);
    const a = apiFixture(c, { unknownCreate: true, accepted });
    await assert.rejects(provisionCommunity(c, state, a.api, new AbortController().signal), /OUTCOME_UNKNOWN/);
    if (accepted) await provisionCommunity(c, state, a.api, new AbortController().signal);
    else await assert.rejects(provisionCommunity(c, state, a.api, new AbortController().signal), /SETUP_RECONCILIATION_REQUIRED/);
    assert.equal(a.calls.filter(call => call.method === 'POST' && call.body?.type === 4).length, 1);
  }
});

test('setup reuses and enables a prepared paused voice creator instead of duplicating it', async t => {
  const f = fixture(t);
  const c = config();
  const state = new DurableCommunityState(f.runtime.store, 'paused-voice');
  const a = apiFixture(c);
  a.channels.push({ id: '80', guild_id: c.guildId, type: 2, parent_id: '40', name: c.voiceLobbyName, user_limit: 4,
    permission_overwrites: [{ id: c.guildId, type: 0, allow: '1024', deny: String(1n << 20n) }] });
  const result = await provisionCommunity(c, state, a.api, new AbortController().signal);
  assert.equal(result.voiceLobbyChannelId, '80');
  assert.equal(a.calls.some(call => call.method === 'POST' && call.body?.name === c.voiceLobbyName), false);
  const activation = a.calls.find(call => call.method === 'PATCH' && call.route === '/channels/80');
  assert.equal(activation.body.user_limit, 0);
  const everyone = activation.body.permission_overwrites.find(item => item.id === c.guildId);
  assert.ok(BigInt(everyone.allow) & (1n << 20n));
  assert.ok(BigInt(everyone.allow) & 1024n);
  assert.equal(BigInt(everyone.deny) & (1n << 20n), 0n);
});

test('activation privacy notice is bounded, bot-owned and reconciles unknown sends without resending', async t => {
  const f = fixture(t);
  const state = new DurableCommunityState(f.runtime.store, 'notice-test');
  const setup = { botUserId: '999', privacyNoticeChannelId: '70' };
  assert.ok(archiveNotice.length <= 1900);
  const messages = [];
  let posts = 0;
  const api = { request: async method => {
    if (method === 'GET') return messages;
    posts++; throw new Error('OUTCOME_UNKNOWN');
  } };
  const signal = new AbortController().signal;
  assert.equal(await publishArchiveNotice(setup, state, api, signal), false);
  messages.push({ id: '90', author: { id: 'someone-else' }, content: archiveNotice });
  assert.equal(await publishArchiveNotice(setup, state, api, signal), false);
  assert.equal(posts, 1);
  messages.push({ id: '91', author: { id: setup.botUserId }, content: archiveNotice });
  assert.equal(await publishArchiveNotice(setup, state, api, signal), true);
  assert.equal((await state.get('notice:privacy')).messageId, '91');
  assert.equal(posts, 1);
});
