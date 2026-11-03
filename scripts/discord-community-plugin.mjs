import { setTimeout as delay } from 'node:timers/promises';
import { DiscordConnector } from '@superagent/connector-discord';
import { DiscordCommunity, DiscordREST } from '@superagent/discord-community';
import { provisionCommunity, publishArchiveNotice } from './discord-bot-setup.mjs';

function validateSetup(setup, config) {
  if (!setup || setup.guildId !== config.guildId || !Array.isArray(setup.staffRoleIds) || !setup.staffRoleIds.length
    || ['ownerId', 'botUserId', 'applicationId', 'ticketCategoryId', 'ticketPanelChannelId', 'voiceCategoryId', 'voiceLobbyChannelId', 'roomControlsChannelId']
      .some(key => typeof setup[key] !== 'string' || !/^\d+$/.test(setup[key]))) throw new Error('RUN_SETUP_FIRST');
  return setup;
}

/** Discord transport and server interactions. Persistence and processing are injected Core capabilities. */
export function createDiscordCommunityPlugin(config, host, options = {}) {
  const controller = new AbortController();
  let publicCollector, privateCollector, community;
  let tasks = [];
  const { state, publicArchive, privateArchive } = host;
  const stop = async () => {
    controller.abort();
    await Promise.allSettled([publicCollector?.stop(), privateCollector?.stop(), ...tasks]);
  };
  const start = async (signal, { setupOnly = false, once = false } = {}) => {
    const combined = AbortSignal.any([signal, controller.signal]);
    const rest = options.api ?? new DiscordREST(await publicArchive.getSecret(config.tokenSecret));
    const api = { request: async (method, route, body, requestSignal) => {
      host.assertActive();
      const response = await rest.request(method, route, body, requestSignal ? AbortSignal.any([combined, requestSignal]) : combined);
      host.assertActive({ allowStopping: true });
      return response;
    } };
    const setup = setupOnly ? await provisionCommunity(config, state, api, combined) : validateSetup(await state.get('setup'), config);
    if (!setupOnly) {
      const [guild, bot] = await Promise.all([api.request('GET', '/guilds/' + config.guildId), api.request('GET', '/users/@me')]);
      if (guild?.id !== config.guildId || guild.owner_id !== setup.ownerId || bot?.id !== setup.botUserId) throw new Error('SETUP_IDENTITY_CHANGED');
    }
    const { applicationId: _application, privacyNoticeChannelId: _notice, excludedCategoryIds: _categories, excludedChannelIds: _channels, ...featureSetup } = setup;
    const flushChannel = async (channelId, abort) => {
      const ticketIds = await community.managedTicketChannelIds();
      const collector = ticketIds.includes(channelId) ? privateCollector : publicCollector;
      const archive = ticketIds.includes(channelId) ? privateArchive : publicArchive;
      if (!collector) throw new Error('COLLECTOR_NOT_READY');
      for (let pass = 0; pass < 10000; pass++) {
        abort.throwIfAborted();
        await collector.sync(archive, abort);
        const progress = (await archive.getCheckpoint())?.history?.[channelId];
        if (progress?.before === null) return;
        if (!progress) throw new Error('CHANNEL_NOT_ARCHIVED');
      }
      throw new Error('ARCHIVE_INCOMPLETE');
    };
    community = new DiscordCommunity({ ...featureSetup, emptyRoomMs: config.emptyRoomMs, defaultRoomLimit: config.defaultRoomLimit }, {
      publicArchive, privateArchive, state, flushChannel, now: host.now,
      getPrivateEvent: host.getPrivateEvent, submitTicket: host.submitTicket,
    }, api);
    privateCollector = new DiscordConnector({ sourceUri: host.privateBinding.sourceUri, guildId: config.guildId, channelIds: [], tokenSecret: config.tokenSecret,
      historyPagesPerSync: config.historyPagesPerSync, historyPollMs: config.historyPollMs }, {
      ...options.connectorOptions, channelResolver: () => community.managedTicketChannelIds(),
    });
    publicCollector = new DiscordConnector({ sourceUri: host.publicBinding.sourceUri, guildId: config.guildId, channelIds: [], discovery: 'public', tokenSecret: config.tokenSecret,
      historyPagesPerSync: config.historyPagesPerSync, historyPollMs: config.historyPollMs }, {
      ...options.connectorOptions, additionalIntents: 1 << 7,
      channelExcluder: async channel => {
        const tickets = await community.managedTicketChannelIds();
        return channel.id === setup.ticketCategoryId || channel.parent_id === setup.ticketCategoryId
          || (setup.excludedCategoryIds ?? []).includes(channel.id) || (setup.excludedCategoryIds ?? []).includes(channel.parent_id)
          || (setup.excludedChannelIds ?? []).includes(channel.id) || tickets.includes(channel.id) || tickets.includes(channel.parent_id);
      },
      onDispatchImmediate: packet => community.acknowledge(packet),
      onDispatch: async (packet, abort) => {
        await privateCollector.consumeDispatch(privateArchive, packet, abort);
        await community.handleDispatch(packet, abort);
        if (packet.type === 'READY' || packet.type === 'RESUMED') await host.connectionReady(true);
      },
    });
    if (setupOnly) {
      await community.registerCommands(combined); await community.publishPanels(combined);
      await publicCollector.sync(publicArchive, combined); await privateCollector.sync(privateArchive, combined);
      await state.set('setup:published', { checkedAt: host.now(), applicationId: setup.applicationId });
      return { state: 'configured', guildId: config.guildId, ticketPanelChannelId: setup.ticketPanelChannelId, voiceLobbyChannelId: setup.voiceLobbyChannelId, continuousCollection: false };
    }
    await privateCollector.sync(privateArchive, combined);
    if (!await state.get('setup:published')) throw new Error('RUN_SETUP_FIRST');
    if (once) { await publicCollector.sync(publicArchive, combined); return; }
    tasks = [publicCollector.start(publicArchive, combined), (async () => {
      let lastHistory = Date.now(), lastNotice = 0, noticePublished = false;
      while (!combined.aborted) {
        host.assertActive(); await community.tick(combined);
        if (host.isConnectionReady() && !noticePublished && Date.now() - lastNotice >= 60000) {
          noticePublished = await publishArchiveNotice(setup, state, api, combined); lastNotice = Date.now();
        }
        if (Date.now() - lastHistory >= config.historyPollMs) { await privateCollector.sync(privateArchive, combined); lastHistory = Date.now(); }
        await delay(1000, undefined, { signal: combined });
      }
    })()];
    await Promise.race(tasks);
  };
  return { start, stop };
}
