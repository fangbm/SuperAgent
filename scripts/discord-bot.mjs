import { parseArgs } from 'node:util';
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { M1Runtime } from '@superagent/agent-core';
import { DiscordConnector } from '@superagent/connector-discord';
import { DiscordCommunity, DiscordREST } from '@superagent/discord-community';
import { DurableCommunityState } from '@superagent/plugin-host';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { readBotConfig, readBotSecret, botInstallUrl } from './discord-bot-config.mjs';
import { provisionCommunity, publishArchiveNotice } from './discord-bot-setup.mjs';

const namespaceFor = guildId => 'discord-community:' + guildId;
const now = () => new Date().toISOString();
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Read-only and credential-free, including before the first deployment. */
export function botStatus(database, config) {
  if (!existsSync(database)) return { healthy: false, state: 'archive_missing' };
  const store = new DatabaseSync(path.resolve(database), { readOnly: true });
  try {
    if (!store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_leases'").get()) return { healthy: false, state: 'not_configured' };
    const namespace = namespaceFor(config.guildId);
    const lease = store.prepare('SELECT lease_until FROM community_leases WHERE namespace=?').get(namespace);
    const row = store.prepare("SELECT value_json FROM community_state WHERE namespace=? AND state_key='runtime:health'").get(namespace);
    const health = row ? JSON.parse(row.value_json) : null;
    const healthy = !!lease && lease.lease_until > now() && health?.mode === 'run' && Number.isFinite(Date.parse(health.checkedAt))
      && Date.now() - Date.parse(health.checkedAt) < 45000;
    return { healthy, state: healthy ? 'running' : 'stopped_or_starting', guildId: config.guildId, analysis: 'disabled',
      events: store.prepare('SELECT count(*) count FROM source_events WHERE project_id IN (?,?)').get(config.projectId, config.privateProjectId).count,
      sources: store.prepare('SELECT source_id,coverage FROM sources WHERE project_id IN (?,?) ORDER BY source_id').all(config.projectId, config.privateProjectId) };
  } finally { store.close(); }
}

function validateSetup(setup, config) {
  if (!isObject(setup) || setup.guildId !== config.guildId || !Array.isArray(setup.staffRoleIds) || !setup.staffRoleIds.length
    || ['ownerId', 'botUserId', 'applicationId', 'ticketCategoryId', 'ticketPanelChannelId', 'voiceCategoryId', 'voiceLobbyChannelId', 'roomControlsChannelId']
      .some(key => typeof setup[key] !== 'string' || !/^\d+$/.test(setup[key]))) throw new Error('RUN_SETUP_FIRST');
  return setup;
}

export async function runBot(config, database, { setupOnly = false, signal, env = process.env } = {}) {
  // Resolve secrets before opening/migrating any archive.
  const token = readBotSecret(config.tokenSecret, env);
  process.umask(0o077);
  mkdirSync(path.dirname(path.resolve(database)), { recursive: true, mode: 0o700 });
  const policy = JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
  const runtime = new M1Runtime(path.resolve(database), { policy });
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const owner = randomUUID();
  const namespace = namespaceFor(config.guildId);
  const state = new DurableCommunityState(runtime.store, namespace, { leaseOwner: owner });
  let leaseHeld = false;
  let heartbeat;
  let heartbeatWrite = Promise.resolve();
  let publicCollector;
  let privateCollector;
  let steam;
  let connectionReady = false;
  const tasks = [];
  let failure;
  const fail = error => { failure ??= error; controller.abort(); };
  const assertLease = ({ allowStopping = false } = {}) => {
    if (combined.aborted && !allowStopping) throw new Error('BOT_STOPPED');
    if (!runtime.store.get('SELECT 1 FROM community_leases WHERE namespace=? AND owner=? AND lease_until>?', namespace, owner, now())) throw new Error('COMMUNITY_LEASE_LOST');
  };
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const file of [database, database + '-wal', database + '-shm']) if (existsSync(file)) chmodSync(file, 0o600);
    if (!state.acquireLease(owner, 45000)) throw new Error('BOT_ALREADY_RUNNING');
    leaseHeld = true;
    const mode = setupOnly ? 'setup' : 'run';
    await state.set('runtime:health', { mode: 'starting', checkedAt: now() });
    heartbeat = setInterval(() => {
      try {
        if (!state.renewLease(owner, 45000)) throw new Error('COMMUNITY_LEASE_LOST');
        heartbeatWrite = heartbeatWrite.then(() => state.set('runtime:health', { mode: setupOnly ? mode : connectionReady ? 'run' : 'starting', checkedAt: now() })).catch(fail);
      } catch (error) { fail(error); }
    }, 10000);
    const rest = new DiscordREST(token);
    const api = { request: async (method, route, body, requestSignal) => {
      assertLease();
      const abort = requestSignal ? AbortSignal.any([combined, requestSignal]) : combined;
      const response = await rest.request(method, route, body, abort);
      // An accepted response must be persisted during graceful shutdown while we still own the lease.
      assertLease({ allowStopping: true });
      return response;
    } };
    const source = (projectId, sourceId, sourceUri, visibility = 'public', secretKeys = [config.tokenSecret]) => {
      const scope = { projectId, sourceId };
      runtime.ingress.registerSource({ ...scope, sourceUri, platform: 'discord' });
      runtime.ingress.setSourcePolicy(scope, { visibility, processingMode: 'archive_only' });
      const base = runtime.ingress.sourceHost(scope, { secretKeys, getSecret: async key => readBotSecret(key, env) });
      return { ...base, commitBatch: async (events, checkpoint) => runtime.store.transaction(() => {
        assertLease(); return runtime.ingress.commitBatch(scope, events, checkpoint);
      }), getCheckpoint: async () => { assertLease(); return runtime.ingress.getCheckpoint(scope); },
      reportHealth: async info => runtime.store.transaction(() => {
        assertLease();
        if (sourceId.endsWith('-public') && /disconnect|session lost/i.test(info.reason ?? '')) connectionReady = false;
        runtime.ingress.reportHealth(scope, info);
      }) };
    };
    const publicSourceId = 'discord-' + config.guildId + '-public';
    const privateSourceId = 'discord-' + config.guildId + '-tickets';
    const publicUri = 'urn:superagent:source:discord:' + config.guildId + ':public';
    const privateUri = 'urn:superagent:source:discord:' + config.guildId + ':tickets';
    const publicArchive = source(config.projectId, publicSourceId, publicUri);
    const privateArchive = source(config.privateProjectId, privateSourceId, privateUri, 'staff');
    let setup = setupOnly ? await provisionCommunity(config, state, api, combined) : validateSetup(await state.get('setup'), config);
    if (!setupOnly) {
      const [guild, bot] = await Promise.all([api.request('GET', '/guilds/' + config.guildId, undefined, combined), api.request('GET', '/users/@me', undefined, combined)]);
      if (guild?.id !== config.guildId || guild.owner_id !== setup.ownerId || bot?.id !== setup.botUserId) throw new Error('SETUP_IDENTITY_CHANGED');
    }
    // Separate projects plus source policies protect private evidence even if another worker is started.
    for (const row of runtime.store.all('SELECT source_id FROM sources WHERE project_id=?', config.projectId)) {
      runtime.ingress.setSourcePolicy({ projectId: config.projectId, sourceId: row.source_id }, { visibility: 'public', processingMode: 'archive_only' });
    }
    const { applicationId: _applicationId, privacyNoticeChannelId: _noticeChannel, excludedCategoryIds: _categories, excludedChannelIds: _channels, ...featureSetup } = setup;
    const communityConfig = { ...featureSetup, emptyRoomMs: config.emptyRoomMs, defaultRoomLimit: config.defaultRoomLimit };
    let community;
    const flushChannel = async (channelId, abort) => {
      const privateIds = await community.managedTicketChannelIds();
      const collector = privateIds.includes(channelId) ? privateCollector : publicCollector;
      const archive = privateIds.includes(channelId) ? privateArchive : publicArchive;
      if (!collector) throw new Error('COLLECTOR_NOT_READY');
      for (let pass = 0; pass < 10000; pass++) {
        abort.throwIfAborted();
        await collector.sync(archive, abort);
        const checkpoint = await archive.getCheckpoint();
        const progress = checkpoint?.history?.[channelId];
        if (progress?.before === null) return;
        if (!progress) throw new Error('CHANNEL_NOT_ARCHIVED');
      }
      throw new Error('ARCHIVE_INCOMPLETE');
    };
    community = new DiscordCommunity(communityConfig, { publicArchive, privateArchive, state, now, flushChannel,
      getPrivateEvent: async eventId => {
        assertLease();
        const record = runtime.ingress.getEvent(config.privateProjectId, eventId);
        return record?.event.data.sourceId === privateSourceId ? record.event : null;
      } }, api);
    privateCollector = new DiscordConnector({ sourceUri: privateUri, guildId: config.guildId, channelIds: [], tokenSecret: config.tokenSecret,
      historyPagesPerSync: config.historyPagesPerSync, historyPollMs: config.historyPollMs }, { channelResolver: () => community.managedTicketChannelIds() });
    publicCollector = new DiscordConnector({ sourceUri: publicUri, guildId: config.guildId, channelIds: [], discovery: 'public', tokenSecret: config.tokenSecret,
      historyPagesPerSync: config.historyPagesPerSync, historyPollMs: config.historyPollMs }, {
      additionalIntents: 1 << 7,
      channelExcluder: async channel => {
        const tickets = await community.managedTicketChannelIds();
        return channel.id === setup.ticketCategoryId || channel.parent_id === setup.ticketCategoryId
          || (setup.excludedCategoryIds ?? []).includes(channel.parent_id) || (setup.excludedCategoryIds ?? []).includes(channel.id)
          || (setup.excludedChannelIds ?? []).includes(channel.id)
          || tickets.includes(channel.id) || tickets.includes(channel.parent_id);
      },
      onDispatchImmediate: packet => community.acknowledge(packet),
      onDispatch: async (packet, abort) => {
        await privateCollector.consumeDispatch(privateArchive, packet, abort);
        await community.handleDispatch(packet, abort);
        if (packet.type === 'READY' || packet.type === 'RESUMED') connectionReady = true;
      },
    });
    if (setupOnly) {
      await community.registerCommands(combined);
      await community.publishPanels(combined);
      await publicCollector.sync(publicArchive, combined);
      await privateCollector.sync(privateArchive, combined);
      await state.set('setup:published', { checkedAt: now(), applicationId: setup.applicationId });
      console.log(JSON.stringify({ state: 'configured', guildId: config.guildId, ticketPanelChannelId: setup.ticketPanelChannelId,
        voiceLobbyChannelId: setup.voiceLobbyChannelId, continuousCollection: false, analysis: 'disabled' }));
      return;
    }
    // Verify the bound token/permissions before opening the one shared Gateway.
    await privateCollector.sync(privateArchive, combined);
    if (!await state.get('setup:published')) throw new Error('RUN_SETUP_FIRST');
    tasks.push(publicCollector.start(publicArchive, combined));
    tasks.push((async () => {
      let lastHistory = Date.now();
      let lastNotice = 0, noticePublished = false;
      while (!combined.aborted) {
        assertLease();
        await community.tick(combined);
        if (connectionReady && !noticePublished && Date.now() - lastNotice >= 60000) {
          noticePublished = await publishArchiveNotice(setup, state, api, combined); lastNotice = Date.now();
        }
        if (Date.now() - lastHistory >= config.historyPollMs) {
          await privateCollector.sync(privateArchive, combined); lastHistory = Date.now();
        }
        await delay(1000, undefined, { signal: combined });
      }
    })());
    if (config.steamReviewsConfig) {
      const steamConfig = JSON.parse(readFileSync(config.steamReviewsConfig, 'utf8'));
      if (steamConfig.appId !== 5335850 || steamConfig.reviewScope !== 'all') throw new Error('INVALID_STEAM_ARCHIVE_CONFIG');
      steam = new SteamReviewsConnector(steamConfig);
      const steamScope = { projectId: config.projectId, sourceId: 'steam-5335850-reviews-all' };
      runtime.ingress.registerSource({ ...steamScope, sourceUri: steamConfig.sourceUri, platform: 'steam-reviews' });
      runtime.ingress.setSourcePolicy(steamScope, { visibility: 'public', processingMode: 'archive_only' });
      const host = runtime.ingress.sourceHost(steamScope, { secretKeys: steam.manifest.permissions.secretKeys, getSecret: async key => readBotSecret(key, env) });
      const guarded = { ...host, commitBatch: async (events, checkpoint) => runtime.store.transaction(() => {
        assertLease(); return runtime.ingress.commitBatch(steamScope, events, checkpoint);
      }) };
      tasks.push(steam.start(guarded, combined));
    }
    await state.set('runtime:health', { mode: connectionReady ? 'run' : 'starting', checkedAt: now() });
    console.log(JSON.stringify({ state: 'starting', guildId: config.guildId, mode: 'archive_only', database: path.resolve(database) }));
    await Promise.race(tasks);
    if (failure) throw failure;
  } catch (error) {
    if (!combined.aborted || failure) throw failure ?? error;
  } finally {
    controller.abort(); clearInterval(heartbeat);
    await Promise.allSettled([publicCollector?.stop(), privateCollector?.stop(), steam?.stop(), ...tasks, heartbeatWrite]);
    if (leaseHeld) state.releaseLease(owner);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    runtime.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, database: { type: 'string' }, setup: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false }, 'check-config': { type: 'boolean', default: false }, 'install-url': { type: 'boolean', default: false }, 'application-id': { type: 'string' } } });
  if (!values.config || [values.setup, values.status, values['check-config'], values['install-url']].filter(Boolean).length > 1) throw new Error('INVALID_ARGUMENTS');
  const config = readBotConfig(values.config);
  if (values['check-config']) { console.log(JSON.stringify({ valid: true, guildId: config.guildId, publicProject: config.projectId, privateProject: config.privateProjectId })); return; }
  if (values['install-url']) { console.log(botInstallUrl(values['application-id'], config.guildId)); return; }
  if (!values.database) throw new Error('DATABASE_REQUIRED');
  if (values.status) { const status = botStatus(values.database, config); console.log(JSON.stringify(status)); process.exitCode = status.healthy ? 0 : 1; return; }
  await runBot(config, values.database, { setupOnly: values.setup });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    // Platform bodies, interaction tokens, player messages and credentials never reach logs.
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DISCORD_BOT_FAILED');
    process.exitCode = 1;
  }
}
