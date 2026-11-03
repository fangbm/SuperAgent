const snowflake = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const VIEW = 1024n, SEND = 2048n, HISTORY = 65536n, THREAD_SEND = 1n << 38n;
const CREATE_THREADS = (1n << 35n) | (1n << 36n);
const CONNECT = 1n << 20n;
const overwrite = (id, type, allow, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });

/** Only explicit --setup calls this; discovery/run never provisions channels. */
export async function provisionCommunity(config, state, api, signal) {
  const [guild, bot, roles, application] = await Promise.all([
    api.request('GET', '/guilds/' + config.guildId, undefined, signal),
    api.request('GET', '/users/@me', undefined, signal),
    api.request('GET', '/guilds/' + config.guildId + '/roles', undefined, signal),
    api.request('GET', '/oauth2/applications/@me', undefined, signal),
  ]);
  if (guild?.id !== config.guildId || !snowflake(guild.owner_id) || !snowflake(bot?.id) || !snowflake(application?.id)
    || !Array.isArray(roles)) throw new Error('INVALID_DISCORD_IDENTITY');
  if ((Number(application.flags) & ((1 << 18) | (1 << 19))) === 0) throw new Error('MESSAGE_CONTENT_INTENT_REQUIRED');
  const staffRoleIds = config.staffRoleIds ?? config.staffRoleNames.map(name => {
    const matches = roles.filter(role => role.name === name);
    if (matches.length !== 1) throw new Error('STAFF_ROLE_AMBIGUOUS_OR_MISSING');
    return matches[0].id;
  });
  if (staffRoleIds.some(id => !snowflake(id) || id === config.guildId || !roles.some(role => role.id === id))) throw new Error('INVALID_STAFF_ROLE');
  let channels = await api.request('GET', '/guilds/' + config.guildId + '/channels', undefined, signal);
  if (!Array.isArray(channels)) throw new Error('INVALID_DISCORD_CHANNELS');
  const privateOverwrites = [overwrite(config.guildId, 0, 0n, VIEW | CREATE_THREADS), overwrite(bot.id, 1, VIEW | SEND | HISTORY | THREAD_SEND),
    ...staffRoleIds.map(id => overwrite(id, 0, VIEW | SEND | HISTORY | THREAD_SEND))];
  const publicOverwrites = [overwrite(config.guildId, 0, VIEW | HISTORY, SEND | THREAD_SEND | CREATE_THREADS), overwrite(bot.id, 1, VIEW | SEND | HISTORY | THREAD_SEND)];
  const ensure = async (key, body, { existingOnly = false, enforcePermissions = false } = {}) => {
    const saved = await state.get('setup:resource:' + key);
    const matches = channels.filter(channel => channel.type === body.type && channel.name === body.name
      && (body.parent_id === undefined || channel.parent_id === body.parent_id));
    let channel = saved?.channelId ? channels.find(channel => channel.id === saved.channelId) : undefined;
    if (channel && (channel.type !== body.type || (body.parent_id !== undefined && channel.parent_id !== body.parent_id))) throw new Error('SETUP_CHANNEL_IDENTITY_CONFLICT');
    if (!channel) {
      if (matches.length > 1) throw new Error('SETUP_CHANNEL_AMBIGUOUS');
      channel = matches[0];
    }
    if (!channel) {
      if (existingOnly) throw new Error('SETUP_EXISTING_CHANNEL_MISSING');
      if (['in_flight', 'unknown'].includes(saved?.phase)) throw new Error('SETUP_RECONCILIATION_REQUIRED');
      await state.set('setup:resource:' + key, { phase: 'in_flight', name: body.name });
      try { channel = await api.request('POST', '/guilds/' + config.guildId + '/channels', body, signal); }
      catch (error) { await state.set('setup:resource:' + key, { phase: 'unknown', name: body.name }); throw error; }
      if (!snowflake(channel?.id) || channel.type !== body.type) throw new Error('SETUP_UNKNOWN_RESPONSE');
      channels.push(channel);
    }
    if (enforcePermissions) await api.request('PATCH', '/channels/' + channel.id, { permission_overwrites: body.permission_overwrites,
      ...(body.type === 2 ? { user_limit: body.user_limit } : {}) }, signal);
    await state.set('setup:resource:' + key, { phase: 'ready', channelId: channel.id, name: body.name });
    return channel.id;
  };
  const ticketCategoryId = await ensure('tickets', { name: config.ticketCategoryName, type: 4, permission_overwrites: privateOverwrites }, { enforcePermissions: true });
  const voiceCategoryId = await ensure('voice', { name: config.voiceCategoryName, type: 4 }, { existingOnly: true });
  const controls = channels.filter(channel => channel.name === config.roomControlsChannelName && channel.type === 0);
  if (controls.length !== 1) throw new Error('ROOM_CONTROLS_CHANNEL_AMBIGUOUS_OR_MISSING');
  const feedback = channels.filter(channel => channel.type === 4 && channel.name.includes('FEEDBACK'));
  if (feedback.length !== 1) throw new Error('FEEDBACK_CATEGORY_AMBIGUOUS_OR_MISSING');
  const faq = channels.filter(channel => channel.type === 0 && channel.name.endsWith('入门-faq'));
  if (faq.length !== 1) throw new Error('FAQ_CHANNEL_AMBIGUOUS_OR_MISSING');
  const ticketPanelChannelId = await ensure('ticket-panel', { name: config.ticketPanelName, type: 0, parent_id: feedback[0].id,
    topic: '私密工单入口 · Private ticket entry. Ticket contents are visible only to the requester and authorized staff.', permission_overwrites: publicOverwrites }, { enforcePermissions: true });
  const voiceLobbyChannelId = await ensure('voice-lobby', { name: config.voiceLobbyName, type: 2, parent_id: voiceCategoryId, user_limit: 0,
    permission_overwrites: [overwrite(config.guildId, 0, VIEW | CONNECT), overwrite(bot.id, 1, VIEW | CONNECT | SEND | HISTORY)] }, { enforcePermissions: true });
  const result = { guildId: config.guildId, ownerId: guild.owner_id, botUserId: bot.id, applicationId: application.id, staffRoleIds,
    ticketCategoryId, ticketPanelChannelId, voiceCategoryId, voiceLobbyChannelId, roomControlsChannelId: controls[0].id,
    privacyNoticeChannelId: faq[0].id,
    excludedCategoryIds: [ticketCategoryId, ...channels.filter(channel => channel.type === 4 && channel.name === '🔒 制作组营地 · STAFF').map(channel => channel.id)],
    excludedChannelIds: channels.filter(channel => channel.name.endsWith('私密求助-private-help')).map(channel => channel.id),
    emptyRoomMs: config.emptyRoomMs, defaultRoomLimit: config.defaultRoomLimit };
  await state.set('setup', result);
  return result;
}

export const archiveNotice = `**消息归档与私密工单 · Archiving & private help**

本通知替代早期“归档尚未启用”的准备说明。机器人在线连接时，会先归档公开文字频道、论坛和主题串的原文、编辑及删除记录，再供后续处理读取。普通工作人员私密区及私信不在采集范围内。

私密工单会单独保存，仅请求人和授权工作人员可在 Discord 中查看；工单原文不用于公开 AI 分析或 GitHub 同步。目前 AI 处理保持关闭。关闭工单不删除归档；没有自动清理期限，需服主明确处理。Discord 中删除消息不会自动抹除已有归档。请勿提交密码、令牌或不必要的个人信息。

This replaces the earlier setup notice. While connected, the bot archives public messages, edits and deletion records first. Ordinary staff areas and DMs are excluded. Private tickets are archived separately, visible in Discord only to their participants and authorized staff, and excluded from public AI processing and GitHub. AI is currently off.

Closing a ticket or deleting a Discord message does not erase its archive. Records remain until owner-directed removal. Avoid passwords, tokens and unnecessary personal data. Offline deletions and intermediate edits may be unrecoverable; coverage remains partial.`;

/** Called only after a real Gateway READY; this is never posted by offline preparation. */
export async function publishArchiveNotice(setup, state, api, signal) {
  if (!setup.privacyNoticeChannelId) throw new Error('RUN_SETUP_FIRST');
  const saved = await state.get('notice:privacy');
  if (saved?.phase === 'posted') return true;
  const messages = await api.request('GET', '/channels/' + setup.privacyNoticeChannelId + '/messages?limit=100', undefined, signal);
  if (!Array.isArray(messages)) throw new Error('INVALID_DISCORD_MESSAGES');
  const found = messages.find(message => message.author?.id === setup.botUserId && message.content === archiveNotice);
  if (found?.id) { await state.set('notice:privacy', { phase: 'posted', messageId: found.id }); return true; }
  if (saved?.phase === 'unknown' || saved?.phase === 'in_flight') return false;
  await state.set('notice:privacy', { phase: 'in_flight' });
  try {
    const message = await api.request('POST', '/channels/' + setup.privacyNoticeChannelId + '/messages',
      { content: archiveNotice, allowed_mentions: { parse: [] } }, signal);
    if (!snowflake(message?.id)) throw new Error('OUTCOME_UNKNOWN');
    await state.set('notice:privacy', { phase: 'posted', messageId: message.id }); return true;
  } catch (error) {
    await state.set('notice:privacy', { phase: 'unknown' });
    if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') return false;
    throw error;
  }
}
