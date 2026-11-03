import { readFileSync } from 'node:fs';

const id = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const keys = ['schemaVersion', 'guildId', 'projectId', 'privateProjectId', 'tokenSecret', 'staffRoleNames', 'staffRoleIds',
  'ticketPanelName', 'ticketCategoryName', 'voiceCategoryName', 'voiceLobbyName', 'roomControlsChannelName',
  'historyPagesPerSync', 'historyPollMs', 'emptyRoomMs', 'defaultRoomLimit', 'steamReviewsConfig'];

export function parseBotConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || input.schemaVersion !== 1 || !id(input.guildId)) throw new Error('INVALID_CONFIG');
  for (const key of ['projectId', 'privateProjectId', 'tokenSecret', 'ticketPanelName', 'ticketCategoryName', 'voiceCategoryName', 'voiceLobbyName', 'roomControlsChannelName']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 100 || /[\r\n\0]/.test(input[key])) throw new Error('INVALID_CONFIG: ' + key);
  }
  if (input.projectId === input.privateProjectId || !/^[A-Z][A-Z0-9_]*$/.test(input.tokenSecret)) throw new Error('INVALID_CONFIG');
  if (!Array.isArray(input.staffRoleNames) || !input.staffRoleNames.length || input.staffRoleNames.some(name => typeof name !== 'string' || !name.trim())
    || new Set(input.staffRoleNames).size !== input.staffRoleNames.length) throw new Error('INVALID_CONFIG: staff roles');
  if (input.staffRoleIds !== undefined && (!Array.isArray(input.staffRoleIds) || !input.staffRoleIds.length || input.staffRoleIds.some(role => !id(role))
    || new Set(input.staffRoleIds).size !== input.staffRoleIds.length)) throw new Error('INVALID_CONFIG: staff IDs');
  const config = { historyPagesPerSync: 10, historyPollMs: 60000, emptyRoomMs: 60000, defaultRoomLimit: 4, ...input };
  for (const [key, min, max] of [['historyPagesPerSync', 1, 10000], ['historyPollMs', 1000, 86400000], ['emptyRoomMs', 1000, 86400000], ['defaultRoomLimit', 1, 99]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error('INVALID_CONFIG: ' + key);
  }
  if (config.steamReviewsConfig !== undefined && (typeof config.steamReviewsConfig !== 'string' || !config.steamReviewsConfig.trim())) throw new Error('INVALID_CONFIG: steam config');
  return config;
}

export const readBotConfig = filename => parseBotConfig(JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')));
export function readBotSecret(name, env = process.env) {
  const inline = env[name]?.trim();
  const filename = env[name + '_FILE'];
  if (inline && filename) throw new Error('AMBIGUOUS_SECRET');
  const value = inline || (filename ? readFileSync(filename, 'utf8').trim() : '');
  if (!value || /\s/.test(value)) throw new Error('MISSING_SECRET: ' + name);
  return value;
}

export function botInstallUrl(applicationId, guildId) {
  if (!id(applicationId) || !id(guildId)) throw new Error('INVALID_CONFIG: application/guild ID');
  // No Administrator, role management, audio capture or direct-message permissions.
  const permissions = 16n | 1024n | 2048n | 16384n | 65536n | (1n << 20n) | (1n << 24n) | (1n << 34n) | (1n << 38n);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: applicationId, scope: 'bot applications.commands', permissions: permissions.toString(),
    guild_id: guildId, disable_guild_select: 'true' }).toString();
  return url.href;
}
