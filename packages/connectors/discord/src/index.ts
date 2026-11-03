import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, FeedbackEventV1, JSONValue, PluginManifestV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';

export interface DiscordConfig {
  sourceUri: string; guildId: string; channelIds: string[]; threadIds?: string[]; discovery?: 'public';
  tokenSecret?: string; historyPagesPerSync?: number; historyPollMs?: number;
}
export const discordConfigSchema = {
  type: 'object', additionalProperties: false, required: ['sourceUri', 'guildId', 'channelIds'],
  properties: { sourceUri: { type: 'string', format: 'uri' }, guildId: { type: 'string', pattern: '^[0-9]+$' },
    channelIds: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 0, uniqueItems: true },
    threadIds: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, uniqueItems: true },
    discovery: { enum: ['public'] },
    tokenSecret: { type: 'string', minLength: 1 }, historyPagesPerSync: { type: 'integer', minimum: 1, maximum: 10000 },
    historyPollMs: { type: 'integer', minimum: 1000, maximum: 86400000 } },
};
export interface DiscordDispatch { type: string; data: Record<string, JSONValue>; sequence: number; sessionId: string; receivedAt: string }
type Native = Record<string, JSONValue>;
const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
const snowflake = (input: unknown): input is string => typeof input === 'string' && /^[0-9]+$/.test(input);
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const iso = (input: unknown): input is string => typeof input === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input) && Number.isFinite(Date.parse(input));
export function normalizeDiscordMessage(input: unknown, action: 'created' | 'updated' | 'deleted',
  config: DiscordConfig, scope: { projectId: string; sourceId: string }, context: { eventKey: string; receivedAt: string; threadId?: string }): FeedbackEventV1 {
  if (!object(input) || !snowflake(input.id) || !snowflake(input.channel_id) || (input.guild_id !== undefined && input.guild_id !== config.guildId)
    || !iso(context.receivedAt) || !context.eventKey || (input.content !== undefined && typeof input.content !== 'string')
    || (input.timestamp !== undefined && !iso(input.timestamp)) || (input.edited_timestamp !== undefined && input.edited_timestamp !== null && !iso(input.edited_timestamp))) throw new Error('INVALID_EVENT: discord message');
  if (action === 'created' && (!iso(input.timestamp) || typeof input.content !== 'string' || !object(input.author) || !snowflake(input.author.id))) throw new Error('INVALID_EVENT: discord creation');
  const native = input as Native;
  const revision = context.eventKey + ':' + hash(native);
  const time = action === 'deleted' ? context.receivedAt : action === 'updated' ? input.edited_timestamp ?? context.receivedAt : input.timestamp;
  const reference = object(input.message_reference) && snowflake(input.message_reference.message_id) ? input.message_reference.message_id : undefined;
  const attachments = input.attachments;
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some(item => !object(item) || typeof item.url !== 'string' || !URL.canParse(item.url)))) throw new Error('INVALID_EVENT: discord attachments');
  return {
    specversion: '1.0', id: 'discord:' + context.eventKey + ':' + input.id, source: config.sourceUri,
    type: 'com.superagent.feedback.message.' + action + '.v1' as 'com.superagent.feedback.message.created.v1' | 'com.superagent.feedback.message.updated.v1' | 'com.superagent.feedback.message.deleted.v1',
    time: new Date(String(time)).toISOString(), datacontenttype: 'application/json',
    data: { schemaVersion: '1.0', projectId: scope.projectId, sourceId: scope.sourceId, platform: 'discord',
      object: { kind: 'message', externalId: input.id, revision, ...(reference ? { parentExternalId: reference } : {}), ...(context.threadId ? { threadExternalId: context.threadId } : {}) },
      ...(object(input.author) && snowflake(input.author.id) ? { actor: { opaqueId: input.author.id, ...(typeof input.author.bot === 'boolean' ? { isBot: input.author.bot } : {}) } } : {}),
      ...(action === 'deleted' ? { content: { text: null } } : typeof input.content === 'string' ? { content: { text: input.content,
        ...(Array.isArray(attachments) ? { attachments: attachments.map(item => {
          const attachment = item as Record<string, unknown>;
          const mime = typeof attachment.content_type === 'string' ? attachment.content_type : undefined;
          return { kind: mime?.startsWith('image/') ? 'image' as const : mime?.startsWith('video/') ? 'video' as const : 'file' as const,
            url: String(attachment.url), ...(mime ? { mimeType: mime } : {}) };
        }) } : {}) } } : {}),
      origin: { permalink: 'https://discord.com/channels/' + config.guildId + '/' + input.channel_id + '/' + input.id },
      attributes: { guildId: config.guildId, channelId: input.channel_id, partialUpdate: action === 'updated' && input.content === undefined, native },
    },
  };
}
interface Role { id: string; permissions: string }
interface Overwrite { id: string; type: number; allow: string; deny: string }
/** Discord's everyone -> combined roles -> member overwrite order. */
export function discordPermissions(guildId: string, userId: string, roleIds: string[], roles: Role[], overwrites: Overwrite[]): bigint {
  const everyone = roles.find(role => role.id === guildId);
  if (!everyone) throw new Error('INVALID_EVENT: missing everyone role');
  let bits = roles.filter(role => role.id === guildId || roleIds.includes(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
  if ((bits & 8n) !== 0n) return (1n << 64n) - 1n;
  const apply = (items: Overwrite[]) => {
    const deny = items.reduce((value, item) => value | BigInt(item.deny), 0n);
    const allow = items.reduce((value, item) => value | BigInt(item.allow), 0n);
    bits = (bits & ~deny) | allow;
  };
  apply(overwrites.filter(item => item.id === guildId));
  apply(overwrites.filter(item => item.type === 0 && item.id !== guildId && roleIds.includes(item.id)));
  apply(overwrites.filter(item => item.type === 1 && item.id === userId));
  return bits;
}
interface Channel { id: string; guild_id: string; type: number; parent_id?: string; permission_overwrites?: Overwrite[]; thread_metadata?: { archive_timestamp?: string } }
interface History { after: string; before: string | null; high: string }
interface Gateway { sessionId: string; resumeUrl: string; sequence: number }
interface ArchiveScan { initialized: boolean; before: string | null; cutoff: string | null; lastSeen: string | null }
interface PendingDispatch { sessionId: string; sequence: number; type: string; receivedAt: string }
interface State { version: 1; signature: string; gateway: Gateway | null; history: Record<string, History>; gap: boolean;
  pendingDispatch?: PendingDispatch; discoveredChannels?: string[]; discoveredThreads?: Record<string, { parentId: string; type: number }>;
  archivedThreads?: Record<string, ArchiveScan>; archiveParentCursor?: string; deletedThreads?: string[];
  observedMessages?: Record<string, Record<string, string>> }
export interface DiscordOptions {
  fetch?: typeof fetch; webSocket?: (url: string) => WebSocket; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onDispatch?: (packet: DiscordDispatch, signal: AbortSignal) => Promise<void>;
  onDispatchImmediate?: (packet: DiscordDispatch) => Promise<void>;
  additionalIntents?: number; channelResolver?: () => Promise<string[]>;
  channelExcluder?: (channel: { id: string; parent_id?: string }) => boolean | Promise<boolean>;
}
export class DiscordConnector implements SourcePluginV1 {
  readonly manifest: PluginManifestV1;
  private readonly staticIds: string[];
  private ids: string[];
  private readonly signature: string;
  private readonly fetcher: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly onDispatch: DiscordOptions['onDispatch'];
  private readonly onDispatchImmediate: DiscordOptions['onDispatchImmediate'];
  private readonly additionalIntents: number;
  private readonly channelResolver: DiscordOptions['channelResolver'];
  private readonly channelExcluder: DiscordOptions['channelExcluder'];
  private readonly controller = new AbortController();
  private host: SourcePluginHostV1 | undefined;
  private token: string | undefined;
  private channels = new Map<string, Channel>();
  private publicParents = new Map<string, Channel>();
  private permissionRoles: Role[] = [];
  private botUserId = '';
  private botRoleIds: string[] = [];
  private inspectedAt = 0;
  private permissionsDirty = false;
  private tail: Promise<void> = Promise.resolve();
  private socket: WebSocket | undefined;
  private running: Promise<void> | undefined;
  private lastIdentifyAt = 0;
  private readonly immediateInFlight = new Set<string>();
  constructor(private readonly config: DiscordConfig, options: DiscordOptions = {}) {
    new URL(config.sourceUri);
    if (Object.keys(config).some(key => !Object.hasOwn(discordConfigSchema.properties, key)) || !snowflake(config.guildId)
      || !Array.isArray(config.channelIds) || config.channelIds.some(id => !snowflake(id))
      || (config.threadIds !== undefined && (!Array.isArray(config.threadIds) || config.threadIds.some(id => !snowflake(id))))
      || (config.discovery !== undefined && config.discovery !== 'public')
      || (config.tokenSecret !== undefined && (typeof config.tokenSecret !== 'string' || !config.tokenSecret.trim()))) throw new Error('INVALID_CONFIG');
    this.staticIds = [...config.channelIds, ...(config.threadIds ?? [])]; this.ids = [...this.staticIds];
    if (new Set(this.staticIds).size !== this.staticIds.length) throw new Error('INVALID_CONFIG: duplicate channel');
    if (!this.staticIds.length && config.discovery !== 'public' && !options.channelResolver) throw new Error('INVALID_CONFIG: no channels');
    if (config.discovery === 'public' && options.channelResolver) throw new Error('INVALID_CONFIG: public discovery cannot use a private resolver');
    if (options.additionalIntents !== undefined && (!Number.isSafeInteger(options.additionalIntents) || options.additionalIntents < 0 || options.additionalIntents > 0x7fffffff)) throw new Error('INVALID_CONFIG: additionalIntents');
    for (const [value, max] of [[config.historyPagesPerSync ?? 10, 10000], [config.historyPollMs ?? 60000, 86400000]]) if (!Number.isInteger(value) || value! < 1 || value! > max!) throw new Error('INVALID_CONFIG');
    if ((config.historyPollMs ?? 60000) < 1000) throw new Error('INVALID_CONFIG');
    const scope = config.discovery === 'public' ? 'public' : options.channelResolver ? 'resolver' : 'static';
    this.signature = scope === 'static' ? hash({ guild: config.guildId, channels: [...this.staticIds].sort(), source: config.sourceUri })
      : hash({ guild: config.guildId, channels: [...this.staticIds].sort(), source: config.sourceUri, policy: scope });
    this.fetcher = options.fetch ?? fetch;
    this.socketFactory = options.webSocket ?? (url => new WebSocket(url));
    this.pause = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    this.onDispatch = options.onDispatch; this.onDispatchImmediate = options.onDispatchImmediate;
    this.additionalIntents = options.additionalIntents ?? 0; this.channelResolver = options.channelResolver; this.channelExcluder = options.channelExcluder;
    this.manifest = { apiVersion: 'superagent.io/plugin/v1', id: 'superagent.discord', version: '0.1.0', displayName: 'Discord Gateway', kind: 'source', engine: { sdk: '^0.1.0' },
      permissions: { networkHosts: ['discord.com', 'gateway.discord.gg', '*.discord.gg'], secretKeys: [config.tokenSecret ?? 'DISCORD_BOT_TOKEN'], eventPublish: true }, configSchema: discordConfigSchema };
  }
  private async bind(host: SourcePluginHostV1): Promise<void> {
    if (this.host && (this.host.sourceId !== host.sourceId || this.host.projectId !== host.projectId)) throw new Error('SOURCE_IDENTITY_CONFLICT');
    this.host = host;
    if (this.token) return;
    this.token = await host.getSecret(this.config.tokenSecret ?? 'DISCORD_BOT_TOKEN');
    if (!this.token.trim()) throw new Error('UNAUTHORIZED');
  }
  private serial(work: () => Promise<void>): Promise<void> {
    const job = this.tail.then(work); this.tail = job.catch(() => {}); return job;
  }
  private async state(host: SourcePluginHostV1): Promise<State> {
    const input = await host.getCheckpoint();
    if (input === null) return { version: 1, signature: this.signature, gateway: null, history: {}, gap: true, observedMessages: {} };
    const dynamic = this.config.discovery === 'public' || !!this.channelResolver;
    if (!object(input) || input.version !== 1 || input.signature !== this.signature || typeof input.gap !== 'boolean' || !object(input.history)
      || (input.gateway !== null && (!object(input.gateway) || typeof input.gateway.sessionId !== 'string' || !Number.isSafeInteger(input.gateway.sequence) || Number(input.gateway.sequence) < 0 || typeof input.gateway.resumeUrl !== 'string'))
      || Object.entries(input.history).some(([id, item]) => !(dynamic ? snowflake(id) : this.staticIds.includes(id)) || !object(item) || !snowflake(item.after) || !snowflake(item.high) || (item.before !== null && !snowflake(item.before)))
      || (input.pendingDispatch !== undefined && (!object(input.pendingDispatch) || typeof input.pendingDispatch.sessionId !== 'string'
        || !Number.isSafeInteger(input.pendingDispatch.sequence) || Number(input.pendingDispatch.sequence) < 0 || typeof input.pendingDispatch.type !== 'string' || !iso(input.pendingDispatch.receivedAt)))
      || (input.discoveredChannels !== undefined && (!Array.isArray(input.discoveredChannels) || input.discoveredChannels.some(id => !snowflake(id))))
      || (input.discoveredThreads !== undefined && (!object(input.discoveredThreads) || Object.entries(input.discoveredThreads).some(([id, value]) => !snowflake(id)
        || !object(value) || !snowflake(value.parentId) || ![10, 11].includes(Number(value.type)))))
      || (input.archivedThreads !== undefined && (!object(input.archivedThreads) || Object.entries(input.archivedThreads).some(([id, value]) => !snowflake(id)
        || !object(value) || typeof value.initialized !== 'boolean' || (value.before !== null && !iso(value.before))
        || (value.cutoff !== null && !iso(value.cutoff)) || (value.lastSeen !== null && !iso(value.lastSeen)))))
      || (input.archiveParentCursor !== undefined && !snowflake(input.archiveParentCursor))
      || (input.deletedThreads !== undefined && (!Array.isArray(input.deletedThreads) || input.deletedThreads.some(id => !snowflake(id))))
      || (input.observedMessages !== undefined && (!object(input.observedMessages) || Object.entries(input.observedMessages).some(([channelId, messages]) => !(dynamic ? snowflake(channelId) : this.staticIds.includes(channelId))
        || !object(messages) || Object.entries(messages).some(([messageId, revision]) => !snowflake(messageId) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))))) throw new Error('INVALID_CHECKPOINT');
    const state = structuredClone(input) as unknown as State;
    state.observedMessages ??= {};
    return state;
  }
  private fullMessageRevision(input: unknown): string | undefined {
    if (!object(input) || !snowflake(input.id) || !snowflake(input.channel_id) || !iso(input.timestamp) || typeof input.content !== 'string'
      || !object(input.author) || !snowflake(input.author.id)) return undefined;
    const comparable = { ...input };
    delete comparable.guild_id;
    delete comparable.member;
    delete comparable.nonce;
    if (Array.isArray(comparable.mentions)) comparable.mentions = comparable.mentions.map(mention => {
      if (!object(mention)) return mention;
      const normalized = { ...mention };
      delete normalized.member;
      return normalized;
    });
    return hash(comparable);
  }
  private rememberMessage(state: State, message: Native): void {
    const revision = this.fullMessageRevision(message);
    if (revision) {
      const channelId = String(message.channel_id);
      state.observedMessages ??= {};
      (state.observedMessages[channelId] ??= {})[String(message.id)] = revision;
    }
  }
  private trimObservedMessages(state: State, channelId: string): void {
    const messages = state.observedMessages?.[channelId];
    if (!messages) return;
    for (const id of Object.keys(messages).sort((a, b) => BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0).slice(100)) delete messages[id];
  }
  private async get(route: string, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try { response = await this.fetcher('https://discord.com/api/v10' + route, { headers: { Authorization: 'Bot ' + this.token }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) }); }
      catch { signal.throwIfAborted(); if (attempt === 3) throw new Error('TRANSIENT_NETWORK'); await this.pause(1000 * 2 ** attempt, signal); continue; }
      if (response.status === 429) {
        const body: unknown = await response.json().catch(() => null);
        if (attempt === 3) throw new Error('RATE_LIMITED');
        const seconds = object(body) && typeof body.retry_after === 'number' ? body.retry_after : Number(response.headers.get('retry-after'));
        await this.pause(Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt), signal); continue;
      }
      if (response.status >= 500) { await response.body?.cancel(); if (attempt === 3) throw new Error('PLATFORM_UNAVAILABLE'); await this.pause(1000 * 2 ** attempt, signal); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 || response.status === 404 ? 'PERMISSION_DENIED' : 'PLATFORM_UNAVAILABLE'); }
      try { return await response.json(); } catch { throw new Error('INVALID_EVENT: discord JSON'); }
    }
  }
  private async loadPermissions(signal: AbortSignal): Promise<void> {
    const application = await this.get('/oauth2/applications/@me', signal);
    if (!object(application) || typeof application.flags !== 'number') throw new Error('INVALID_EVENT: application');
    if ((application.flags & ((1 << 18) | (1 << 19))) === 0) throw new Error('PERMISSION_DENIED: Message Content Intent not enabled/approved');
    const user = await this.get('/users/@me', signal);
    if (!object(user) || !snowflake(user.id)) throw new Error('INVALID_EVENT: current bot');
    const member = await this.get('/guilds/' + this.config.guildId + '/members/' + user.id, signal);
    const roles = await this.get('/guilds/' + this.config.guildId + '/roles', signal);
    if (!object(member) || !object(member.user) || !snowflake(member.user.id) || !Array.isArray(member.roles) || member.roles.some(id => !snowflake(id))
      || !Array.isArray(roles) || roles.some(role => !object(role) || !snowflake(role.id) || !snowflake(role.permissions))) throw new Error('INVALID_EVENT: permissions');
    this.botUserId = member.user.id; this.botRoleIds = member.roles as string[]; this.permissionRoles = roles as Role[];
  }
  private channel(value: unknown, expectedId?: string): Channel {
    if (!object(value) || !snowflake(value.id) || (expectedId !== undefined && value.id !== expectedId) || value.guild_id !== this.config.guildId
      || !Number.isInteger(value.type)) throw new Error('PERMISSION_DENIED: channel identity/type');
    return value as unknown as Channel;
  }
  private overwrites(channel: Channel): Overwrite[] {
    if (channel.permission_overwrites === undefined) return [];
    if (!Array.isArray(channel.permission_overwrites) || channel.permission_overwrites.some(item => !object(item) || !snowflake(item.id)
      || ![0, 1].includes(Number(item.type)) || !snowflake(item.allow) || !snowflake(item.deny))) throw new Error('INVALID_EVENT: channel permissions');
    return channel.permission_overwrites;
  }
  private async ensureBotPermissions(channel: Channel, signal: AbortSignal): Promise<void> {
    const parent = [10, 11, 12].includes(channel.type) ? this.publicParents.get(channel.parent_id ?? '')
      ?? this.channel(await this.get('/channels/' + channel.parent_id, signal)) : channel;
    const bits = discordPermissions(this.config.guildId, this.botUserId, this.botRoleIds, this.permissionRoles, this.overwrites(parent));
    if ((bits & 1024n) === 0n || (bits & 65536n) === 0n) throw new Error('PERMISSION_DENIED: VIEW_CHANNEL/READ_MESSAGE_HISTORY');
    if (channel.type === 12 && (bits & (1n << 34n)) === 0n) await this.get('/channels/' + channel.id + '/thread-members/@me', signal);
  }
  private async fetchChannel(id: string, signal: AbortSignal): Promise<Channel> {
    const channel = this.channel(await this.get('/channels/' + id, signal), id);
    if (![0, 2, 4, 5, 10, 11, 12, 13, 15, 16].includes(channel.type)) throw new Error('PERMISSION_DENIED: channel identity/type');
    await this.ensureBotPermissions(channel, signal);
    return channel;
  }
  private async everyoneCanView(channel: Channel): Promise<boolean> {
    return (discordPermissions(this.config.guildId, this.config.guildId, [], this.permissionRoles, this.overwrites(channel)) & 1024n) !== 0n;
  }
  private async excluded(channel: Channel): Promise<boolean> { return this.channelExcluder ? !!(await this.channelExcluder({ id: channel.id, ...(channel.parent_id ? { parent_id: channel.parent_id } : {}) })) : false; }
  private async resolvedIds(): Promise<string[]> {
    const extra = this.channelResolver ? await this.channelResolver() : [];
    if (!Array.isArray(extra) || extra.some(id => !snowflake(id))) throw new Error('INVALID_CONFIG: resolved channel IDs');
    return [...new Set([...this.staticIds, ...extra])];
  }
  private async inspect(signal: AbortSignal, saved?: State): Promise<ConnectorCapabilityV1> {
    await this.loadPermissions(signal);
    const channels = new Map<string, Channel>();
    if (this.config.discovery === 'public') {
      const list = await this.get('/guilds/' + this.config.guildId + '/channels', signal);
      if (!Array.isArray(list)) throw new Error('INVALID_EVENT: guild channels');
      const parents = new Map<string, Channel>();
      for (const item of list) {
        const channel = this.channel(item);
        if (![0, 5, 15, 16].includes(channel.type) || !(await this.everyoneCanView(channel)) || await this.excluded(channel)) continue;
        await this.ensureBotPermissions(channel, signal);
        parents.set(channel.id, channel);
        if ([0, 5].includes(channel.type)) channels.set(channel.id, channel);
      }
      for (const item of list) {
        const channel = this.channel(item);
        if (![2, 13].includes(channel.type) || !(await this.everyoneCanView(channel)) || await this.excluded(channel)) continue;
        await this.ensureBotPermissions(channel, signal); channels.set(channel.id, channel);
      }
      const active = await this.get('/guilds/' + this.config.guildId + '/threads/active', signal);
      if (!object(active) || !Array.isArray(active.threads)) throw new Error('INVALID_EVENT: active threads');
      const known = { ...(saved?.discoveredThreads ?? {}) };
      const deleted = new Set(saved?.deletedThreads ?? []);
      for (const item of active.threads) {
        if (!object(item) || !snowflake(item.id) || !snowflake(item.parent_id) || item.guild_id !== this.config.guildId || ![10, 11].includes(Number(item.type))
          || !parents.has(item.parent_id) || await this.excluded(item as unknown as Channel) || await this.excluded(parents.get(item.parent_id)!)) continue;
        known[item.id] = { parentId: item.parent_id, type: Number(item.type) };
        channels.set(item.id, item as unknown as Channel);
      }
      for (const [id, thread] of Object.entries(known)) {
        if (deleted.has(id) || !parents.has(thread.parentId) || channels.has(id)) continue;
        const channel = { id, guild_id: this.config.guildId, type: thread.type, parent_id: thread.parentId };
        if (await this.excluded(channel) || await this.excluded(parents.get(thread.parentId)!)) continue;
        channels.set(id, channel);
      }
      for (const id of this.staticIds) {
        if (channels.has(id) || parents.has(id)) continue;
        const channel = await this.fetchChannel(id, signal);
        if (![10, 11].includes(channel.type) || !channel.parent_id || !parents.has(channel.parent_id)
          || await this.excluded(channel) || await this.excluded(parents.get(channel.parent_id)!)) throw new Error('PERMISSION_DENIED: public channel policy');
        channels.set(id, channel); known[id] = { parentId: channel.parent_id, type: channel.type };
      }
      this.publicParents = parents;
      this.channels = channels;
      this.ids = [...channels.keys()];
      if (saved) saved.discoveredThreads = known;
      this.permissionsDirty = false;
      this.inspectedAt = Date.now();
      return { connection: 'hybrid', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: true,
        reason: 'Public visible channels and public threads only; archived-thread discovery is resumable and bounded; offline deletes and intermediate edits may be unavailable' };
    }
    const ids = await this.resolvedIds();
    for (const id of ids) channels.set(id, await this.fetchChannel(id, signal));
    this.publicParents.clear(); this.channels = channels; this.ids = ids; this.permissionsDirty = false; this.inspectedAt = Date.now();
    return { connection: 'hybrid', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: true,
      reason: this.channelResolver ? 'Only configured/resolved channels; private channels are resolved dynamically; unresumable gaps remain' : 'Configured channels/threads only; REST cannot recover offline deletes or intermediate/old edits after an unresumable session' };
  }
  private async discoverArchivedThreads(host: SourcePluginHostV1, state: State, signal: AbortSignal): Promise<State> {
    if (this.config.discovery !== 'public') return state;
    const parents = [...this.publicParents.values()].filter(channel => [0, 5, 15, 16].includes(channel.type)).sort((a, b) => a.id.localeCompare(b.id));
    if (!parents.length) return state;
    state.archivedThreads ??= {}; state.discoveredThreads ??= {};
    const maxPages = this.config.historyPagesPerSync ?? 10;
    let start = 0;
    if (state.archiveParentCursor) {
      const previous = parents.findIndex(parent => parent.id === state.archiveParentCursor);
      if (previous >= 0) start = (previous + 1) % parents.length;
    }
    const ordered = [...parents.slice(start), ...parents.slice(0, start)];
    for (const parent of ordered.slice(0, maxPages)) {
      signal.throwIfAborted();
      let scan = state.archivedThreads[parent.id] ?? { initialized: false, before: null, cutoff: null, lastSeen: null };
      if (scan.initialized && scan.before === null && scan.cutoff === null) scan = { ...scan, before: null, cutoff: scan.lastSeen };
      const url = new URL('https://discord.com/api/v10/channels/' + parent.id + '/threads/archived/public');
      url.searchParams.set('limit', '100'); if (scan.before) url.searchParams.set('before', scan.before);
      const response = await this.get(url.pathname + url.search, signal);
      if (!object(response) || !Array.isArray(response.threads) || typeof response.has_more !== 'boolean') throw new Error('INVALID_EVENT: archived threads');
      const threads: Channel[] = [];
      let oldest: string | null = null; let newest = scan.lastSeen;
      let foundOlderThanCutoff = false;
      for (const item of response.threads) {
        const thread = this.channel(item);
        if (thread.parent_id !== parent.id || ![10, 11].includes(thread.type) || !object(thread.thread_metadata)
          || !iso(thread.thread_metadata.archive_timestamp)) throw new Error('INVALID_EVENT: public archived thread');
        const archivedAt = thread.thread_metadata.archive_timestamp;
        if (oldest === null || Date.parse(archivedAt) < Date.parse(oldest)) oldest = archivedAt;
        if (newest === null || Date.parse(archivedAt) > Date.parse(newest)) newest = archivedAt;
        if (scan.cutoff !== null && Date.parse(archivedAt) < Date.parse(scan.cutoff)) foundOlderThanCutoff = true;
        if ((scan.cutoff === null || Date.parse(archivedAt) >= Date.parse(scan.cutoff))
          && !(await this.excluded(thread)) && !(await this.excluded(parent))) threads.push(thread);
      }
      if (response.has_more && !response.threads.length) throw new Error('INVALID_EVENT: empty archived page with has_more');
      if (response.has_more && oldest === null) throw new Error('INVALID_EVENT: missing archived thread timestamp');
      for (const thread of threads) {
        state.discoveredThreads[thread.id] = { parentId: parent.id, type: thread.type };
        this.channels.set(thread.id, thread);
        if (!this.ids.includes(thread.id)) this.ids.push(thread.id);
      }
      const complete = !response.has_more || foundOlderThanCutoff;
      state.archivedThreads[parent.id] = complete
        ? { initialized: true, before: null, cutoff: null, lastSeen: newest }
        : { initialized: true, before: oldest, cutoff: scan.cutoff, lastSeen: newest };
      state.archiveParentCursor = parent.id;
      await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
    }
    return state;
  }
  private async publicParent(id: string, signal: AbortSignal): Promise<Channel | undefined> {
    const cached = this.publicParents.get(id);
    if (cached) return await this.excluded(cached) ? undefined : cached;
    let channel: Channel;
    try { channel = await this.fetchChannel(id, signal); }
    catch (error) { if (error instanceof Error && error.message.startsWith('PERMISSION_DENIED')) return undefined; throw error; }
    if (![0, 5, 15, 16].includes(channel.type) || !(await this.everyoneCanView(channel)) || await this.excluded(channel)) return undefined;
    this.publicParents.set(id, channel);
    if ([0, 5].includes(channel.type)) { this.channels.set(id, channel); if (!this.ids.includes(id)) this.ids.push(id); }
    return channel;
  }
  private async dispatchChannel(channelId: string, state: State, signal: AbortSignal): Promise<Channel | undefined> {
    if (!snowflake(channelId)) return undefined;
    if (this.config.discovery !== 'public') {
      if (!(await this.resolvedIds()).includes(channelId)) return undefined;
      const cached = this.channels.get(channelId); if (cached) return cached;
      const channel = await this.fetchChannel(channelId, signal);
      this.channels.set(channelId, channel); this.ids.push(channelId); return channel;
    }
    if (this.permissionsDirty) await this.inspect(signal, state);
    const cached = this.channels.get(channelId);
    if (cached) {
      if (await this.excluded(cached) || (cached.parent_id && !(await this.publicParent(cached.parent_id, signal)))) {
        this.channels.delete(channelId); this.ids = this.ids.filter(id => id !== channelId); return undefined;
      }
      return cached;
    }
    let channel: Channel;
    try { channel = await this.fetchChannel(channelId, signal); }
    catch (error) { if (error instanceof Error && error.message.startsWith('PERMISSION_DENIED')) return undefined; throw error; }
    if ([0, 2, 5, 13].includes(channel.type)) {
      if (!(await this.everyoneCanView(channel)) || await this.excluded(channel)) return undefined;
      if ([0, 5].includes(channel.type)) this.publicParents.set(channel.id, channel);
      this.channels.set(channel.id, channel); this.ids.push(channel.id);
      state.discoveredChannels ??= []; if (!state.discoveredChannels.includes(channel.id)) state.discoveredChannels.push(channel.id);
      return channel;
    }
    if (![10, 11].includes(channel.type) || !channel.parent_id) return undefined;
    const parent = await this.publicParent(channel.parent_id, signal);
    if (!parent || await this.excluded(channel)) return undefined;
    await this.ensureBotPermissions(channel, signal);
    state.discoveredThreads ??= {}; state.discoveredThreads[channel.id] = { parentId: parent.id, type: channel.type };
    this.channels.set(channel.id, channel); this.ids.push(channel.id); return channel;
  }
  private async rememberPublicChannelEvent(type: string, data: Native, state: State, signal: AbortSignal): Promise<void> {
    if (this.config.discovery !== 'public' || data.guild_id !== this.config.guildId) return;
    if (['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'CHANNEL_UPDATE'].includes(type)) { this.permissionsDirty = true; return; }
    if (!snowflake(data.id)) return;
    const id = data.id;
    if (type === 'THREAD_DELETE') {
      if (this.channels.get(id) && [10, 11].includes(this.channels.get(id)!.type)) {
        state.deletedThreads ??= []; if (!state.deletedThreads.includes(id)) state.deletedThreads.push(id);
        delete state.discoveredThreads?.[id]; this.channels.delete(id); this.ids = this.ids.filter(value => value !== id);
      }
      return;
    }
    if (type === 'CHANNEL_DELETE') {
      this.channels.delete(id); this.publicParents.delete(id);
      for (const [threadId, thread] of Object.entries(state.discoveredThreads ?? {})) if (thread.parentId === id) {
        state.deletedThreads ??= []; if (!state.deletedThreads.includes(threadId)) state.deletedThreads.push(threadId);
        this.channels.delete(threadId);
      }
      this.ids = this.ids.filter(value => value !== id && this.channels.has(value));
      return;
    }
    if (!['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE'].includes(type)) return;
    let channel: Channel;
    try { channel = await this.fetchChannel(id, signal); }
    catch (error) {
      if (!(error instanceof Error && error.message.startsWith('PERMISSION_DENIED'))) throw error;
      this.channels.delete(id); this.publicParents.delete(id); this.ids = this.ids.filter(value => value !== id); return;
    }
    if ([10, 11].includes(channel.type)) {
      const parent = channel.parent_id ? await this.publicParent(channel.parent_id, signal) : undefined;
      if (!parent || await this.excluded(channel)) { this.channels.delete(id); this.ids = this.ids.filter(value => value !== id); return; }
      state.discoveredThreads ??= {}; state.discoveredThreads[id] = { parentId: parent.id, type: channel.type };
    } else if ([0, 2, 5, 13].includes(channel.type)) {
      if (!(await this.everyoneCanView(channel)) || await this.excluded(channel)) {
        this.channels.delete(id); this.publicParents.delete(id);
        for (const [threadId, thread] of Object.entries(state.discoveredThreads ?? {})) if (thread.parentId === id) {
          state.deletedThreads ??= []; if (!state.deletedThreads.includes(threadId)) state.deletedThreads.push(threadId);
          this.channels.delete(threadId);
        }
        this.ids = this.ids.filter(value => value !== id && this.channels.has(value)); return;
      }
      if ([0, 5].includes(channel.type)) this.publicParents.set(id, channel);
      state.discoveredChannels ??= []; if (!state.discoveredChannels.includes(id)) state.discoveredChannels.push(id);
    } else { this.channels.delete(id); this.ids = this.ids.filter(value => value !== id); return; }
    this.channels.set(id, channel); if (!this.ids.includes(id)) this.ids.push(id);
  }
  private async dispatchEvents(host: SourcePluginHostV1, packet: DiscordDispatch, state: State, signal: AbortSignal): Promise<FeedbackEventV1[]> {
    const { type, data } = packet;
    await this.rememberPublicChannelEvent(type, data as Native, state, signal);
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK'].includes(type)
      || data.guild_id !== this.config.guildId || !snowflake(data.channel_id)) return [];
    const channel = await this.dispatchChannel(data.channel_id, state, signal);
    if (!channel || ![0, 2, 5, 10, 11, 12, 13].includes(channel.type)) return [];
    const context = { eventKey: packet.sessionId + ':' + packet.sequence, receivedAt: packet.receivedAt,
      ...([10, 11, 12].includes(channel.type) ? { threadId: channel.id } : {}) };
    const events: FeedbackEventV1[] = [];
    if (type === 'MESSAGE_DELETE_BULK') {
      if (!Array.isArray(data.ids) || data.ids.some(id => !snowflake(id))) throw new Error('INVALID_EVENT: bulk delete');
      for (const id of data.ids) events.push(normalizeDiscordMessage({ id, guild_id: data.guild_id, channel_id: data.channel_id }, 'deleted', this.config, host, context));
    } else {
      events.push(normalizeDiscordMessage(data, type === 'MESSAGE_CREATE' ? 'created' : type === 'MESSAGE_UPDATE' ? 'updated' : 'deleted', this.config, host, context));
      if (type === 'MESSAGE_CREATE' || type === 'MESSAGE_UPDATE') this.rememberMessage(state, data);
    }
    return events;
  }
  async probe(): Promise<ConnectorCapabilityV1> {
    if (!this.host) return { connection: 'hybrid', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'Host not bound; bot credentials and permissions have not been checked' };
    try { return await this.inspect(AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)])); }
    catch (error) { return { connection: 'hybrid', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false,
      reason: error instanceof Error && /^(PERMISSION_DENIED|UNAUTHORIZED|INVALID_EVENT|RATE_LIMITED|TRANSIENT_NETWORK|PLATFORM_UNAVAILABLE)/.test(error.message) ? error.message : 'PLATFORM_UNAVAILABLE' }; }
  }
  sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    return this.serial(async () => {
      const combined = AbortSignal.any([signal, this.controller.signal]);
      try {
        await this.bind(host);
        let state = await this.state(host);
        await this.inspect(combined, state);
        if (this.config.discovery === 'public') {
          // Persist discovered active threads before bounded archived-thread pagination or history reads.
          state.discoveredThreads ??= {};
          await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
          state = await this.discoverArchivedThreads(host, state, combined);
        }
        for (const channelId of this.ids) {
          const channel = this.channels.get(channelId);
          if (!channel || ![0, 2, 5, 10, 11, 12, 13].includes(channel.type)) continue;
          for (let page = 0; page < (this.config.historyPagesPerSync ?? 10); page++) {
            combined.throwIfAborted();
            const progress = state.history[channelId] ?? { after: '0', before: null, high: '0' };
            const result = await this.get('/channels/' + channelId + '/messages?limit=100' + (progress.before ? '&before=' + progress.before : ''), combined);
            if (!Array.isArray(result) || result.some(item => !object(item) || !snowflake(item.id) || item.channel_id !== channelId)) throw new Error('INVALID_EVENT: discord history');
            const messages = result as Native[];
            if (progress.before && messages.some(item => BigInt(String(item.id)) >= BigInt(progress.before!))) throw new Error('INVALID_EVENT: non-advancing history');
            const high = messages.reduce((a, item) => BigInt(String(item.id)) > BigInt(a) ? String(item.id) : a, progress.high);
            const newer = messages.filter(item => BigInt(String(item.id)) > BigInt(progress.after));
            // Re-read the latest page for edits to existing IDs; deeper offline edits remain an explicit gap.
            const selected = progress.before === null ? messages : newer;
            const complete = messages.length < 100 || newer.length !== messages.length;
            const next = structuredClone(state);
            const oldest = messages.reduce((a, item) => a === '0' || BigInt(String(item.id)) < BigInt(a) ? String(item.id) : a, '0');
            next.history[channelId] = complete ? { after: high, before: null, high } : { after: progress.after, before: oldest, high };
            const events: FeedbackEventV1[] = [];
            for (const item of selected) {
              const revision = this.fullMessageRevision(item);
              const messageId = String(item.id);
              const observed = state.observedMessages?.[channelId]?.[messageId];
              if (revision && observed === revision) {
                if (progress.before) delete next.observedMessages?.[channelId]?.[messageId];
                continue;
              }
              events.push(normalizeDiscordMessage(item, item.edited_timestamp ? 'updated' : 'created', this.config, host,
                { eventKey: 'snapshot:' + hash(item), receivedAt: String(item.edited_timestamp ?? item.timestamp),
                  ...([10, 11, 12].includes(this.channels.get(channelId)!.type) ? { threadId: channelId } : {}) }));
              if (observed || progress.before) delete next.observedMessages?.[channelId]?.[messageId];
            }
            if (complete) this.trimObservedMessages(next, channelId);
            await host.commitBatch(events, { sourceId: host.sourceId, cursor: next as unknown as JSONValue }); state = next;
            if (complete) break;
          }
        }
        await host.reportHealth({ coverage: 'partial', checkedAt: new Date().toISOString(), reason: this.config.discovery === 'public'
          ? 'Public channel/thread discovery and history are resumable; private channels are excluded; offline deletions and older edits are not reconstructible'
          : 'Configured/resolved channel history synced/resumable; offline deletions and old edits are not reconstructible; unfinished pages remain in checkpoint' });
      } catch (error) {
        if (!combined.aborted) await host.reportHealth({ coverage: 'unavailable', checkedAt: new Date().toISOString(), reason: 'Discord sync failed; committed checkpoint retained; inspect bot permissions and connectivity' });
        throw error;
      }
    });
  }
  /** Archive a shared Gateway packet into this source without opening a second Gateway connection. */
  consumeDispatch(host: SourcePluginHostV1, packet: DiscordDispatch, signal: AbortSignal): Promise<void> {
    return this.serial(async () => {
      const combined = AbortSignal.any([signal, this.controller.signal]);
      if (typeof packet.type !== 'string' || !packet.type || !object(packet.data) || !Number.isSafeInteger(packet.sequence)
        || packet.sequence < 0 || typeof packet.sessionId !== 'string' || !packet.sessionId || !iso(packet.receivedAt)) throw new Error('INVALID_EVENT: dispatch');
      await this.bind(host);
      if (!this.inspectedAt || Date.now() - this.inspectedAt > 60_000) await this.inspect(combined, await this.state(host));
      const state = await this.state(host);
      const events = await this.dispatchEvents(host, packet, state, combined);
      if (events.length) await host.commitBatch(events, { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
    });
  }
  private gatewayUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !(url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg')) || url.username || url.password || url.port) throw new Error('INVALID_EVENT: gateway URL');
    url.search = '?v=10&encoding=json'; return url.href;
  }
  private async connection(host: SourcePluginHostV1, signal: AbortSignal): Promise<'resume' | 'identify'> {
    const saved = await this.state(host);
    const gateway = saved.gateway;
    const discovered = gateway ? null : await this.get('/gateway/bot', signal);
    if (!gateway && (!object(discovered) || typeof discovered.url !== 'string')) throw new Error('INVALID_EVENT: gateway discovery');
    if (!gateway) {
      const limits = object(discovered) ? discovered.session_start_limit : undefined;
      if (object(limits) && limits.remaining === 0) {
        await this.pause(Math.max(1000, Number(limits.reset_after) || 60000), signal);
        throw new Error('RATE_LIMITED: Gateway session budget exhausted');
      }
      if (object(discovered) && typeof discovered.shards === 'number' && discovered.shards > 1) throw new Error('UNSUPPORTED_CAPABILITY: sharded bots require a shard coordinator');
      if (this.lastIdentifyAt > 0) await this.pause(Math.max(0, 5000 - (Date.now() - this.lastIdentifyAt)), signal);
    }
    const socket = this.socketFactory(this.gatewayUrl(gateway?.resumeUrl ?? String((discovered as Record<string, unknown>).url)));
    this.socket = socket;
    let session = gateway;
    let dispatchSessionId = gateway?.sessionId;
    let lastCommittedSequence = gateway?.sequence ?? -1;
    let receivedSequence: number | null = gateway?.sequence ?? null;
    let pending = 0;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;
    let acked = true;
    let failure: unknown;
    let next: 'resume' | 'identify' = 'resume';
    const send = (op: number, data: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify({ op, d: data })); };
    const beat = (interval: number) => {
      if (!acked) { socket.close(4000, 'Heartbeat timeout'); return; }
      acked = false; send(1, receivedSequence); heartbeat = setTimeout(() => beat(interval), interval);
    };
    const abort = () => socket.close(1000, 'Stopped');
    try {
      await new Promise<void>((resolve, reject) => {
        helloTimer = setTimeout(() => { failure = new Error('TRANSIENT_NETWORK: Gateway hello timeout'); socket.close(4000); }, 30000);
        socket.addEventListener('message', event => {
          try {
            const packet: unknown = JSON.parse(String(event.data));
            if (!object(packet) || !Number.isInteger(packet.op)) throw new Error('INVALID_EVENT: gateway packet');
            if (packet.op === 10) {
              if (heartbeat) throw new Error('INVALID_EVENT: repeated hello');
              clearTimeout(helloTimer);
              if (!object(packet.d) || !Number.isFinite(packet.d.heartbeat_interval) || Number(packet.d.heartbeat_interval) < 1) throw new Error('INVALID_EVENT: heartbeat interval');
              const interval = Number(packet.d.heartbeat_interval);
              heartbeat = setTimeout(() => beat(interval), interval * Math.random());
              if (gateway) send(6, { token: this.token, session_id: gateway.sessionId, seq: gateway.sequence });
              else { this.lastIdentifyAt = Date.now(); send(2, { token: this.token, intents: 1 | 512 | 32768 | this.additionalIntents, properties: { os: process.platform, browser: 'superagent', device: 'superagent' } }); }
            } else if (packet.op === 11) acked = true;
            else if (packet.op === 1) send(1, receivedSequence);
            else if (packet.op === 7) socket.close(4000, 'Reconnect');
            else if (packet.op === 9) { next = packet.d === true ? 'resume' : 'identify'; socket.close(4000, 'Invalid session'); }
            else if (packet.op === 0) {
              if (!Number.isSafeInteger(packet.s) || Number(packet.s) < 0 || typeof packet.t !== 'string' || !object(packet.d)) throw new Error('INVALID_EVENT: dispatch');
              if (pending >= 512) { socket.close(4000, 'Backpressure; resume from durable sequence'); return; }
              receivedSequence = Number(packet.s); pending++;
              const payload = packet.d as Native;
              const sequence = Number(packet.s);
              const type = packet.t;
              const receivedAt = new Date().toISOString();
              if (type === 'READY' && typeof payload.session_id === 'string') dispatchSessionId = payload.session_id;
              const sessionId = type === 'READY' && typeof payload.session_id === 'string' ? payload.session_id : dispatchSessionId;
              const provisional: DiscordDispatch | undefined = sessionId ? { type, data: structuredClone(payload), sequence, sessionId: sessionId!, receivedAt } : undefined;
              const dispatchKey = sessionId ? sessionId + ':' + sequence : '';
              let immediate: Promise<void> | undefined;
              if (type === 'INTERACTION_CREATE' && provisional && this.onDispatchImmediate
                && !(sessionId === session?.sessionId && sequence <= lastCommittedSequence) && !this.immediateInFlight.has(dispatchKey)) {
                this.immediateInFlight.add(dispatchKey);
                try {
                  immediate = Promise.resolve(this.onDispatchImmediate(provisional)).catch(error => {
                    host.logger.warn('Discord immediate interaction acknowledgement failed', { code: error instanceof Error ? error.message.split(':')[0] ?? 'UNKNOWN' : 'UNKNOWN' });
                  }).finally(() => this.immediateInFlight.delete(dispatchKey));
                } catch (error) {
                  host.logger.warn('Discord immediate interaction acknowledgement failed', { code: error instanceof Error ? error.message.split(':')[0] ?? 'UNKNOWN' : 'UNKNOWN' });
                  this.immediateInFlight.delete(dispatchKey);
                }
              }
              void this.serial(async () => {
                if (failure) throw failure;
                const state = await this.state(host);
                if (type === 'READY') {
                  if (typeof payload.session_id !== 'string' || typeof payload.resume_gateway_url !== 'string') throw new Error('INVALID_EVENT: READY');
                  this.gatewayUrl(payload.resume_gateway_url);
                  session = { sessionId: payload.session_id, resumeUrl: payload.resume_gateway_url, sequence };
                }
                if (!session) throw new Error('INVALID_EVENT: dispatch before READY');
                const pendingMatches = state.pendingDispatch?.sessionId === session.sessionId && state.pendingDispatch.sequence === sequence && state.pendingDispatch.type === type;
                if (state.pendingDispatch && !pendingMatches && !(type === 'READY' && state.gateway === null)) throw new Error('DISPATCH_PENDING_MISMATCH');
                if (state.gateway?.sessionId === session.sessionId && sequence <= state.gateway.sequence && !pendingMatches) return;
                if (type === 'READY' && state.gateway === null && state.pendingDispatch && !pendingMatches) {
                  delete state.pendingDispatch; state.gap = true;
                }
                const stableReceivedAt = pendingMatches ? state.pendingDispatch!.receivedAt : receivedAt;
                const durablePacket: DiscordDispatch = { type, data: structuredClone(payload), sequence, sessionId: session.sessionId, receivedAt: stableReceivedAt };
                if (!pendingMatches) {
                  state.pendingDispatch = { sessionId: session.sessionId, sequence, type, receivedAt: stableReceivedAt };
                  await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
                }
                const events = await this.dispatchEvents(host, durablePacket, state, signal);
                await host.commitBatch(events, { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
                // The ACK starts outside this serial queue; wait here so handlers can safely finish a deferred response.
                if (immediate) await immediate;
                if (this.onDispatch) await this.onDispatch(durablePacket, signal);
                state.gateway = { ...session, sequence };
                delete state.pendingDispatch;
                await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
                session = state.gateway; dispatchSessionId = session.sessionId; lastCommittedSequence = sequence;
              }).catch(error => { failure ??= error; socket.close(4000, 'Host commit failed'); }).finally(() => { pending--; });
            }
          } catch (error) { failure = error; socket.close(4000, 'Invalid payload'); }
        });
        socket.addEventListener('close', event => {
          if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) { failure = new Error('PERMISSION_DENIED: Gateway close ' + event.code); }
          if ([4007, 4009].includes(event.code)) next = 'identify';
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => { socket.close(4000); resolve(); }, { once: true });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      await this.tail;
      if (failure) throw failure;
      return next;
    } finally { clearTimeout(heartbeat); clearTimeout(helloTimer); signal.removeEventListener('abort', abort); this.socket = undefined; }
  }
  start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('ALREADY_RUNNING');
    if (this.channelResolver && !this.config.discovery) throw new Error('UNSUPPORTED_CAPABILITY: shared-Gateway collectors use consumeDispatch');
    this.running = this.run(host, signal); return this.running;
  }
  private async run(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const historyController = new AbortController();
    const historySignal = AbortSignal.any([combined, historyController.signal]);
    let background: Promise<void> | undefined;
    let backgroundError: unknown;
    try {
      await this.sync(host, combined);
      background = (async () => {
        try { while (!historySignal.aborted) { await this.pause(this.config.historyPollMs ?? 60000, historySignal); await this.sync(host, historySignal); } }
        catch (error) { if (!historySignal.aborted) { backgroundError = error; this.controller.abort(); } }
      })();
      let reconnects = 0;
      while (!combined.aborted) {
        let next: 'resume' | 'identify';
        try { next = await this.connection(host, combined); }
        catch (error) {
          if (combined.aborted) break;
          if (error instanceof Error && /^(TRANSIENT_NETWORK|PLATFORM_UNAVAILABLE|RATE_LIMITED)/.test(error.message)) next = 'resume'; else throw error;
        }
        if (combined.aborted) break;
        await host.reportHealth({ coverage: 'partial', checkedAt: new Date().toISOString(), reason: next === 'identify' ? 'Gateway session lost; offline deletes and intermediate edits may be unrecoverable; REST backfill will run' : 'Gateway disconnected; resuming only from committed sequence' });
        if (next === 'identify') {
          await this.serial(async () => { const state = await this.state(host); state.gateway = null; state.gap = true;
            await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue }); });
          await this.sync(host, combined);
        }
        await this.pause(Math.min(30000, 1000 * 2 ** Math.min(reconnects++, 5)), combined);
      }
      if (backgroundError) throw backgroundError;
    } catch (error) {
      if (!combined.aborted || backgroundError) {
        await host.reportHealth({ coverage: 'unavailable', checkedAt: new Date().toISOString(), reason: 'Discord stopped after an error; committed checkpoint retained; check permissions/host before restart' });
        throw backgroundError ?? error;
      }
    } finally { historyController.abort(); await background; await this.tail; }
  }
  async stop(): Promise<void> { this.controller.abort(); this.socket?.close(1000, 'Stopped'); await this.running?.catch(() => {}); await this.tail; }
}
