/**
 * Discord community lifecycle adapter. The composition runner supplies durable JSON state,
 * archive hosts, and a single shared Gateway dispatch stream. `handleDispatch` only archives
 * and records intents; `tick` performs Discord REST operations to avoid Gateway re-entrancy.
 * Interaction tokens are held only in memory between immediate acknowledgement and processing.
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { JSONValue, NormalizedEventV1, SourcePluginHostV1 } from '@superagent/plugin-sdk';

export interface DiscordDispatch {
  type: string;
  data: Record<string, JSONValue>;
  sequence: number;
  sessionId: string;
  receivedAt: string;
}

export interface CommunityConfig {
  guildId: string;
  ownerId: string;
  botUserId: string;
  staffRoleIds: string[];
  ticketCategoryId: string;
  ticketPanelChannelId: string;
  voiceCategoryId: string;
  voiceLobbyChannelId: string;
  roomControlsChannelId: string;
  emptyRoomMs?: number;
  defaultRoomLimit?: number;
}

export interface CommunityState {
  get(key: string): Promise<JSONValue | null>;
  set(key: string, value: JSONValue): Promise<void>;
  update(key: string, reducer: (old: JSONValue | null) => JSONValue): Promise<JSONValue>;
  list(prefix: string): Promise<Array<{ key: string; value: JSONValue }>>;
}

export interface CommunityHost {
  publicArchive: SourcePluginHostV1;
  privateArchive: SourcePluginHostV1;
  state: CommunityState;
  getPrivateEvent(eventId: string): Promise<NormalizedEventV1 | null>;
  flushChannel(channelId: string, signal: AbortSignal): Promise<void>;
  now(): string;
  submitTicket(event: NormalizedEventV1): Promise<{ status: 'created' | 'replayed' | 'existing'; ticketId: string; eventId: string }>;
}

export type DiscordMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface DiscordAPI {
  request(method: DiscordMethod, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface DiscordRESTOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
}

const API = 'https://discord.com/api/v10';
const VIEW = '1024';
const SEND = '2048';
const READ = '66560';
const ACCESS = String(1024n | 2048n | 65536n);
const CONNECT = '1048576';
const NO_THREADS = String((1n << 35n) | (1n << 36n));
const EVERYONE_TICKET_DENY = String(BigInt(VIEW) | BigInt(NO_THREADS));
const CLOSED_TICKET_DENY = String(BigInt(SEND) | BigInt(NO_THREADS));
const VOICE_ACCESS = String(BigInt(VIEW) | BigInt(CONNECT));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{1,22}$/.test(value);
const interactionTypes = { command: 2, component: 3, modal: 5 } as const;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const short = (value: string) => sha(value).slice(0, 12);
const isAbort = (signal?: AbortSignal) => !!signal?.aborted;

function validateConfig(c: CommunityConfig): void {
  const ids = [c.guildId, c.ownerId, c.botUserId, c.ticketCategoryId, c.ticketPanelChannelId,
    c.voiceCategoryId, c.voiceLobbyChannelId, c.roomControlsChannelId, ...c.staffRoleIds];
  if (ids.some(id => !snowflake(id)) || new Set(c.staffRoleIds).size !== c.staffRoleIds.length
    || c.staffRoleIds.includes(c.guildId) || c.staffRoleIds.includes(c.botUserId)
    || !Number.isInteger(c.emptyRoomMs ?? 60_000) || (c.emptyRoomMs ?? 60_000) < 1_000
    || !Number.isInteger(c.defaultRoomLimit ?? 4) || (c.defaultRoomLimit ?? 4) < 1 || (c.defaultRoomLimit ?? 4) > 99) {
    throw new Error('INVALID_CONFIG');
  }
}

/** Thin REST client: GET and definitive rate-limit responses may be retried. A mutation
 * network/5xx result is ambiguous and throws OUTCOME_UNKNOWN for reconciliation by caller. */
export class DiscordREST implements DiscordAPI {
  private readonly fetcher: typeof fetch;
  private readonly pause: NonNullable<DiscordRESTOptions['sleep']>;
  private readonly retries: number;
  constructor(private readonly token: string, options: DiscordRESTOptions = {}) {
    if (typeof token !== 'string' || !token.trim()) throw new Error('INVALID_CONFIG: token');
    this.fetcher = options.fetch ?? fetch;
    this.pause = options.sleep ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : undefined));
    this.retries = options.maxRetries ?? 3;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 8) throw new Error('INVALID_CONFIG: retries');
  }
  async request(method: DiscordMethod, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !route.startsWith('/') || route.startsWith('//')) throw new Error('INVALID_REQUEST');
    const safeRoute = API + route;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(safeRoute, {
          method,
          headers: { Authorization: 'Bot ' + this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
          ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) } : { signal: AbortSignal.timeout(20_000) }),
        });
      } catch {
        if (method !== 'GET') throw new Error('OUTCOME_UNKNOWN');
        if (isAbort(signal)) signal!.throwIfAborted();
        if (attempt >= this.retries) throw new Error('TRANSIENT_NETWORK');
        await this.pause(Math.min(30_000, 500 * 2 ** attempt), signal); continue;
      }
      if (response.status === 429) {
        const data: unknown = await response.json().catch(() => null);
        const retryAfter = object(data) && typeof data.retry_after === 'number' ? data.retry_after : Number(response.headers.get('retry-after'));
        if (attempt >= this.retries) throw new Error('RATE_LIMITED');
        let remaining = Math.max(250, (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1) * 1_000);
        while (remaining > 0) { const chunk = Math.min(60_000, remaining); await this.pause(chunk, signal); remaining -= chunk; }
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        if (method !== 'GET') throw new Error('OUTCOME_UNKNOWN');
        if (attempt >= this.retries) throw new Error('PLATFORM_UNAVAILABLE');
        await this.pause(Math.min(30_000, 500 * 2 ** attempt), signal); continue;
      }
      if (!response.ok) {
        const status = response.status; await response.body?.cancel().catch(() => {});
        throw new Error(status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : 'PLATFORM_REJECTED:' + status);
      }
      if (response.status === 204) return undefined;
      try { return await response.json(); }
      catch { throw new Error(method === 'GET' ? 'INVALID_RESPONSE' : 'OUTCOME_UNKNOWN'); }
    }
  }
}

interface TicketState {
  version: 1; id: string; userId: string; kind: 'bug' | 'suggestion' | 'help';
  status: 'pending_create' | 'creating' | 'unknown_create' | 'open' | 'closed' | 'blocked' | 'delete_pending' | 'deleting' | 'deleted' | 'unknown_delete';
  evidenceEventId: string; createdAt: string; channelId?: string; controlsMessageId?: string;
  controlsPostingAt?: string;
  claimedBy?: string; createMarker: string; lastError?: string;
  finalFlushComplete?: boolean;
  deleteAttemptAt?: string;
  pendingAccess?: Array<{ userId: string; action: 'add' | 'remove' }>;
}
interface RoomState {
  version: 1; id: string; ownerId: string; channelId?: string;
  status: 'pending_create' | 'creating' | 'unknown_create' | 'active' | 'blocked' | 'deleting' | 'unknown_delete';
  createMarker: string; createdAt: string; limit: number;
  occupants: Array<{ userId: string; joinedAt: string }>; emptyAt?: string; lastError?: string; desiredName?: string; pendingMove?: boolean; moveUnknown?: boolean;
  creatorPresent?: boolean; finalFlushComplete?: boolean; flushAttemptAt?: string; deleteAttemptAt?: string;
}
interface Interaction {
  id: string; application_id?: string; token?: string; type: number; guild_id?: string; locale?: string; guild_locale?: string;
  channel_id?: string; user?: { id?: string }; member?: { user?: { id?: string }; roles?: string[] };
  data?: { custom_id?: string; name?: string; options?: unknown[]; components?: unknown[]; resolved?: unknown };
}
const ticketKey = (id: string) => 'ticket:' + id;
const openKey = (id: string) => 'ticket:open:' + id;
const interactionKey = (id: string) => 'interaction:' + id;
const roomKey = (id: string) => 'room:' + id;
const roomOwnerKey = (id: string) => 'room:owner:' + id;
function asTicket(value: JSONValue | null): TicketState | null {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.userId !== 'string' || typeof value.kind !== 'string'
    || typeof value.status !== 'string' || typeof value.evidenceEventId !== 'string' || typeof value.createMarker !== 'string') return null;
  return value as unknown as TicketState;
}
function asRoom(value: JSONValue | null): RoomState | null {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.ownerId !== 'string' || typeof value.status !== 'string'
    || typeof value.createMarker !== 'string' || !Array.isArray(value.occupants)) return null;
  return value as unknown as RoomState;
}
function rawString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function interactionActor(i: Interaction): string | undefined {
  const id = i.member?.user?.id ?? i.user?.id; return snowflake(id) ? id : undefined;
}
function commandOptions(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  return input.filter(object).flatMap(item => [item, ...commandOptions(item.options)]);
}
function commandShape(input: unknown): string {
  const keys = ['type', 'name', 'description', 'required', 'min_length', 'max_length', 'min_value', 'max_value', 'options'] as const;
  const normalize = (value: unknown): unknown => {
    if (!object(value)) return value;
    const result: Record<string, unknown> = {};
    for (const key of keys) if (value[key] !== undefined) result[key] = key === 'options' && Array.isArray(value[key])
      ? value[key].map(normalize) : value[key];
    return result;
  };
  return JSON.stringify(Array.isArray(input) ? input.map(normalize) : []);
}
function fieldValues(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (node: unknown) => {
    if (!object(node)) return;
    if (typeof node.custom_id === 'string' && typeof node.value === 'string') result[node.custom_id] = node.value;
    if (node.component) visit(node.component);
    if (Array.isArray(node.components)) node.components.forEach(visit);
  };
  if (Array.isArray(input)) input.forEach(visit); return result;
}
function componentIds(message: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (!object(value)) return;
    if (typeof value.custom_id === 'string') found.push(value.custom_id);
    if (Array.isArray(value.components)) value.components.forEach(walk);
  };
  if (object(message) && Array.isArray(message.components)) message.components.forEach(walk);
  return found;
}
function splitDiscordText(value: string, maxUnits = 1900): string[] {
  const parts: string[] = []; let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + maxUnits);
    if (end < value.length && end > start && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    if (end < value.length) {
      const newline = value.lastIndexOf('\n', end - 1);
      if (newline > start + Math.floor(maxUnits / 2)) end = newline + 1;
    }
    if (end <= start) end = Math.min(value.length, start + maxUnits);
    parts.push(value.slice(start, end)); start = end;
  }
  return parts;
}

export class DiscordCommunity {
  private readonly emptyMs: number;
  private readonly roomLimit: number;
  private readonly volatileTokens = new Map<string, { applicationId: string; token: string }>();
  private readonly pendingReplies = new Map<string, string>();
  private readonly interactionLocks = new Set<string>();
  private voiceSnapshotReady = false;
  constructor(private readonly config: CommunityConfig, private readonly host: CommunityHost, private readonly api: DiscordAPI) {
    validateConfig(config); this.emptyMs = config.emptyRoomMs ?? 60_000; this.roomLimit = config.defaultRoomLimit ?? 4;
    if (host.publicArchive.projectId === host.privateArchive.projectId || host.publicArchive.sourceId === host.privateArchive.sourceId) {
      throw new Error('INVALID_CONFIG: public/private archive identities must be isolated');
    }
  }

  /** Immediate ACK only. Modal launch and deferred ephemeral processing never imply acceptance. */
  async acknowledge(packet: DiscordDispatch): Promise<void> {
    const i = this.parseInteraction(packet); if (!i || !i.token || !i.application_id || !this.authorizedGuild(i)) return;
    if (packet.type === 'INTERACTION_CREATE' && i.type === interactionTypes.component) {
      const custom = rawString(i.data?.custom_id);
      const kind = custom.startsWith('ticket:new:') ? custom.slice('ticket:new:'.length) : '';
      if (!['bug', 'suggestion', 'help'].includes(kind)) return;
      const isZh = this.isChinese(i);
      const modal = { title: isZh ? '提交社区请求 · Community request' : 'Community request · 社区请求',
        custom_id: 'ticket:submit:' + kind, components: [
          { type: 18, label: isZh ? '标题 · Title' : 'Title · 标题', component: { type: 4, custom_id: 'title', style: 1, min_length: 3, max_length: 120, required: true, placeholder: isZh ? '简短描述 · Short summary' : 'Short summary · 简短描述' } },
          { type: 18, label: isZh ? '详情 · Details' : 'Details · 详情', component: { type: 4, custom_id: 'body', style: 2, min_length: 10, max_length: 3500, required: true, placeholder: isZh ? '请描述情况，不要填写密码等敏感信息。' : 'Describe the issue. Do not include passwords or other secrets.' } },
        ] };
      await this.api.request('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 9, data: modal });
      return;
    }
    await this.api.request('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 5, data: { flags: 64 } });
    this.keepToken(i);
  }

  /** Archive submissions and record durable desired state. No Discord lifecycle REST calls here. */
  async handleDispatch(packet: DiscordDispatch, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (packet.type === 'READY') {
      this.voiceSnapshotReady = false;
      if (object(packet.data) && Array.isArray(packet.data.guilds)) {
        const guild = packet.data.guilds.find(value => object(value) && value.id === this.config.guildId);
        if (object(guild) && Array.isArray(guild.voice_states)) { await this.reconcileVoiceSnapshot(guild.voice_states, signal); this.voiceSnapshotReady = true; }
      }
      return;
    }
    if (packet.type === 'GUILD_CREATE' && object(packet.data) && packet.data.id === this.config.guildId && Array.isArray(packet.data.voice_states)) {
      await this.reconcileVoiceSnapshot(packet.data.voice_states, signal); this.voiceSnapshotReady = true; return;
    }
    if (packet.type === 'VOICE_STATE_UPDATE') { await this.handleVoiceState(packet); return; }
    if (packet.type !== 'INTERACTION_CREATE') return;
    const i = this.parseInteraction(packet); if (!i || !this.authorizedGuild(i)) return;
    const actor = interactionActor(i); if (!actor) return;
    const interactionId = rawString(i.id); if (!snowflake(interactionId)) return;
    if (this.interactionLocks.has(interactionId)) return;
    this.interactionLocks.add(interactionId);
    try {
      const prior = await this.host.state.get(interactionKey(interactionId));
      if (prior !== null) { await this.complete(i, 'This interaction was already processed. · 此交互已处理。'); return; }
      if (i.type === interactionTypes.modal && rawString(i.data?.custom_id).startsWith('ticket:submit:')) {
        await this.submitTicket(i, actor, packet.receivedAt, signal); return;
      }
      if (i.type === interactionTypes.command) { await this.recordCommand(i, actor); await this.complete(i, 'Request processed where authorized. · 已按权限处理请求。'); return; }
      if (i.type === interactionTypes.component) { await this.recordComponent(i, actor); await this.complete(i, 'Request processed where authorized. · 已按权限处理请求。'); return; }
    } finally { this.interactionLocks.delete(interactionId); }
  }

  /** Executes resumable Discord mutations, reconciliation, and empty-room cleanup. */
  async tick(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const tickets = await this.host.state.list('ticket:');
    for (const item of tickets) {
      signal.throwIfAborted();
      if (!item.key.startsWith('ticket:') || item.key.startsWith('ticket:open:')) continue;
      const ticket = asTicket(item.value); if (!ticket) continue;
      if (ticket.status === 'pending_create' || ticket.status === 'creating' || ticket.status === 'unknown_create') await this.ensureTicketChannel(ticket, signal);
      else if (ticket.channelId && ['open', 'closed'].includes(ticket.status)) { await this.postTicketIntro(ticket, signal); await this.applyTicketStatus(ticket, signal); await this.applyTicketAccess(ticket, signal); }
      else if (['delete_pending', 'deleting', 'unknown_delete'].includes(ticket.status) && ticket.channelId) await this.deleteTicketChannel(ticket, signal);
    }
    const rooms = await this.host.state.list('room:');
    for (const item of rooms) {
      signal.throwIfAborted();
      if (!item.key.startsWith('room:') || item.key.startsWith('room:owner:')) continue;
      if (!this.voiceSnapshotReady) continue;
      const room = asRoom(item.value); if (!room) continue;
      if (['pending_create', 'creating', 'unknown_create'].includes(room.status)) await this.ensureRoom(room, signal);
      else if (room.status === 'active') { await this.moveCreator(room, signal); await this.applyRoomSettings(room, signal); await this.cleanupRoomIfEmpty(room, signal); }
      else if (room.status === 'deleting' || room.status === 'unknown_delete') await this.reconcileRoomDelete(room, signal);
    }
    await this.finishDeferredReplies(signal);
  }

  /** Public collector may call this during its private channel allowlist refresh. */
  async managedTicketChannelIds(): Promise<string[]> {
    const rows = await this.host.state.list('ticket:');
    return rows.filter(row => row.key.startsWith('ticket:') && !row.key.startsWith('ticket:open:'))
      .map(row => asTicket(row.value)).filter((t): t is TicketState => !!t && !!t.channelId && t.status !== 'deleted').map(t => t.channelId!);
  }

  /** Creates bilingual ticket and voice-room entry panels; marker lookup makes reruns safe. */
  async publishPanels(signal: AbortSignal): Promise<void> {
    await this.ensurePanel(this.config.ticketPanelChannelId, 'ticket', signal);
    await this.ensurePanel(this.config.roomControlsChannelId, 'room', signal);
  }

  async registerCommands(signal: AbortSignal): Promise<void> {
    const commands = [
      { name: 'ticket', description: 'Manage your private support ticket · 管理私密求助', type: 1, options: [
        { type: 1, name: 'claim', description: 'Claim a ticket · 认领请求' }, { type: 1, name: 'close', description: 'Close a ticket · 关闭请求' },
        { type: 1, name: 'reopen', description: 'Reopen a ticket · 重新开启请求' },
        { type: 1, name: 'add', description: 'Add a member · 添加成员', options: [{ type: 6, name: 'member', description: 'Member · 成员', required: true }] },
        { type: 1, name: 'remove', description: 'Remove a member · 移除成员', options: [{ type: 6, name: 'member', description: 'Member · 成员', required: true }] },
        { type: 1, name: 'delete', description: 'Archive and delete a closed ticket · 归档并删除已关闭请求' },
      ] },
      { name: 'room', description: 'Manage your temporary voice room · 管理临时语音房', type: 1, options: [
        { type: 1, name: 'rename', description: 'Rename room · 重命名', options: [{ type: 3, name: 'name', description: 'Room name · 房间名称', required: true, min_length: 1, max_length: 80 }] },
        { type: 1, name: 'capacity', description: 'Set capacity · 设置人数', options: [{ type: 4, name: 'count', description: '1–99', required: true, min_value: 1, max_value: 99 }] },
        { type: 1, name: 'transfer', description: 'Transfer room ownership · 转让房主', options: [{ type: 6, name: 'member', description: 'Occupant · 房间成员', required: true }] },
      ] },
    ];
    let applicationId = this.config.botUserId;
    try {
      const application = await this.api.request('GET', '/oauth2/applications/@me', undefined, signal);
      if (object(application) && snowflake(application.id)) applicationId = String(application.id);
    } catch { /* bot user ID is the Discord application ID for bot accounts; preserve a useful fallback */ }
    const route = `/applications/${applicationId}/guilds/${this.config.guildId}/commands`;
    const current = await this.api.request('GET', route, undefined, signal);
    if (Array.isArray(current) && commandShape(current) === commandShape(commands)) return;
    await this.api.request('PUT', route, commands, signal);
  }

  private parseInteraction(packet: DiscordDispatch): Interaction | null {
    if (!object(packet.data) || !snowflake(packet.data.id) || typeof packet.data.token !== 'string' || !Number.isInteger(packet.data.type)) return null;
    return packet.data as unknown as Interaction;
  }
  private authorizedGuild(i: Interaction): boolean { return i.guild_id === this.config.guildId && !!interactionActor(i); }
  private isChinese(i: Interaction): boolean { return i.locale === 'zh-CN' || i.guild_locale === 'zh-CN'; }
  private keepToken(i: Interaction): void {
    if (i.id && i.application_id && i.token) this.volatileTokens.set(i.id, { applicationId: i.application_id, token: i.token });
  }
  private isStaff(i: Interaction): boolean {
    const id = interactionActor(i);
    return id === this.config.ownerId || (i.member?.roles ?? []).some(role => this.config.staffRoleIds.includes(role));
  }
  private async updateTicket(id: string, mutate: (current: TicketState) => TicketState): Promise<TicketState | null> {
    const result = await this.host.state.update(ticketKey(id), old => {
      const current = asTicket(old); return current ? mutate(current) as unknown as JSONValue : old ?? null;
    });
    return asTicket(result);
  }
  private async updateRoom(id: string, mutate: (current: RoomState) => RoomState): Promise<RoomState | null> {
    const result = await this.host.state.update(roomKey(id), old => {
      const current = asRoom(old); return current ? mutate(current) as unknown as JSONValue : old ?? null;
    });
    return asRoom(result);
  }

  private async submitTicket(i: Interaction, actor: string, receivedAt: string, signal: AbortSignal): Promise<void> {
    const kind = rawString(i.data?.custom_id).slice('ticket:submit:'.length);
    if (!['bug', 'suggestion', 'help'].includes(kind)) return;
    const fields = fieldValues(i.data?.components);
    const submittedTitle = fields.title ?? ''; const submittedBody = fields.body ?? '';
    const title = submittedTitle.trim(); const body = submittedBody.trim();
    if (!title || !body || submittedTitle.length > 120 || submittedBody.length > 3500) { await this.complete(i, '标题和详情均为必填项，请重新提交。 / Please provide a title and details.'); return; }
    const now = Number.isFinite(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : new Date(Number((BigInt(i.id!) >> 22n) + 1_420_070_400_000n)).toISOString();
    const event: NormalizedEventV1 = {
      specversion: '1.0', id: 'discord-community:' + i.id, source: `urn:superagent:source:discord:${this.config.guildId}:tickets`,
      type: 'com.superagent.feedback.message.created.v1', time: now, datacontenttype: 'application/json',
      data: { schemaVersion: '1.0', projectId: this.host.privateArchive.projectId, sourceId: this.host.privateArchive.sourceId,
        platform: 'discord', object: { kind: 'message', externalId: i.id!, revision: short(JSON.stringify({ title: submittedTitle, body: submittedBody, kind })) },
        actor: { opaqueId: actor }, content: { text: `[${kind}] ${submittedTitle}\n\n${submittedBody}` },
        origin: { permalink: `https://discord.com/channels/${this.config.guildId}/${i.channel_id ?? this.config.ticketPanelChannelId}` },
        // Preserve legacy event bytes for replay; this audit marker never controls Core source policy.
        attributes: { guildId: this.config.guildId, ticketKind: kind, interactionId: i.id!, archiveOnly: true,
          native: { title: submittedTitle, body: submittedBody, kind, interactionId: i.id!, channelId: i.channel_id ?? this.config.ticketPanelChannelId } } },
    } as NormalizedEventV1;
    signal.throwIfAborted();
    const result = await this.host.submitTicket(event);
    await this.complete(i, result.status === 'existing' ? '你已有一个未关闭的请求。 / You already have an open ticket.' : '已安全归档，正在创建私密请求频道。 / Archived safely; creating your private ticket.');
  }

  private async recordComponent(i: Interaction, actor: string): Promise<void> {
    const custom = rawString(i.data?.custom_id); const parts = custom.split(':');
    if (parts[0] !== 'ticket' || !['claim', 'close', 'reopen'].includes(parts[1] ?? '') || !snowflake(parts[2])) return;
    const ticket = asTicket(await this.host.state.get(ticketKey(parts[2]!)));
    if (!ticket || (ticket.userId !== actor && !this.isStaff(i))) return;
    const action = parts[1]!;
    if (action !== 'close' && !this.isStaff(i)) return;
    if (action === 'close') {
      if (ticket.status !== 'open') return;
      const changed = await this.updateTicket(ticket.id, current => current.status === 'open' ? { ...current, status: 'closed' } : current);
      if (changed?.status !== 'closed') return;
      await this.host.state.update(openKey(ticket.userId), old => old === ticket.id ? '' : (old ?? ''));
    } else if (action === 'reopen') {
      if (ticket.status !== 'closed' || ticket.finalFlushComplete) return;
      const reservation = await this.host.state.update(openKey(ticket.userId), old => old === null || old === '' ? ticket.id : old);
      if (reservation !== ticket.id) { await this.complete(i, 'Close the other open request before reopening this one. · 请先关闭其他未完成请求。'); return; }
      const changed = await this.updateTicket(ticket.id, current => current.status === 'closed' && !current.finalFlushComplete ? { ...current, status: 'open' } : current);
      if (changed?.status !== 'open') await this.host.state.update(openKey(ticket.userId), old => old === ticket.id ? '' : (old ?? ''));
      else await this.host.state.set(interactionKey(i.id!), { status: 'recorded', action, entityId: ticket.id });
      return;
    } else {
      await this.updateTicket(ticket.id, current => ['open', 'closed'].includes(current.status) ? { ...current, claimedBy: actor } : current);
    }
    await this.host.state.set(interactionKey(i.id!), { status: 'recorded', action, entityId: ticket.id });
  }

  private async recordCommand(i: Interaction, actor: string): Promise<void> {
    const name = rawString(i.data?.name); const options = commandOptions(i.data?.options);
    const sub = options.find(option => option.type === 1); const action = rawString(sub?.name);
    const option = (key: string) => options.find(value => value.name === key)?.value;
    if (name === 'ticket' && ['claim', 'close', 'reopen', 'add', 'remove', 'delete'].includes(action)) {
      const ticket = await this.ticketForChannel(rawString(i.channel_id)); if (!ticket) return;
      if (!this.isStaff(i)) return;
      if (action === 'claim') {
        await this.updateTicket(ticket.id, current => ['open', 'closed'].includes(current.status) ? { ...current, claimedBy: actor } : current);
      } else if (action === 'close') {
        if (ticket.status !== 'open') return;
        const changed = await this.updateTicket(ticket.id, current => current.status === 'open' ? { ...current, status: 'closed' } : current);
        if (changed?.status !== 'closed') return;
        await this.host.state.update(openKey(ticket.userId), old => old === ticket.id ? '' : (old ?? ''));
      } else if (action === 'reopen') {
        if (ticket.status !== 'closed' || ticket.finalFlushComplete) return;
        const reservation = await this.host.state.update(openKey(ticket.userId), old => old === null || old === '' ? ticket.id : old);
        if (reservation !== ticket.id) return;
        const changed = await this.updateTicket(ticket.id, current => current.status === 'closed' && !current.finalFlushComplete ? { ...current, status: 'open' } : current);
        if (changed?.status !== 'open') { await this.host.state.update(openKey(ticket.userId), old => old === ticket.id ? '' : (old ?? '')); return; }
      }
      else if (action === 'add' || action === 'remove') {
        const target = option('member'); if (!snowflake(target) || target === this.config.guildId) return;
        if (action === 'remove' && [ticket.userId, this.config.botUserId, this.config.ownerId].includes(target)) return;
        await this.updateTicket(ticket.id, current => ({ ...current, pendingAccess: [...(current.pendingAccess ?? []), { userId: target, action: action as 'add' | 'remove' }] }));
        await this.host.state.set(interactionKey(i.id!), { status: 'recorded', action, entityId: ticket.id }); return;
      } else if (action === 'delete') {
        if (ticket.status !== 'closed' || ticket.finalFlushComplete) return;
        const changed = await this.updateTicket(ticket.id, current => current.status === 'closed' && !current.finalFlushComplete ? { ...current, status: 'delete_pending' } : current);
        if (changed?.status !== 'delete_pending') return;
      }
      await this.host.state.set(interactionKey(i.id!), { status: 'recorded', action, entityId: ticket.id }); return;
    }
    if (name === 'room' && ['rename', 'capacity', 'transfer'].includes(action)) {
      let room = await this.roomForChannel(rawString(i.channel_id));
      if (!room && i.channel_id === this.config.roomControlsChannelId) {
        const owned = await this.host.state.get(roomOwnerKey(actor));
        if (typeof owned === 'string') room = asRoom(await this.host.state.get(roomKey(owned)));
      }
      if (!room) return;
      if (room.ownerId !== actor && !this.isStaff(i)) return;
      const value = action === 'rename' ? option('name') : action === 'capacity' ? option('count') : option('member');
      const target = action === 'transfer' ? value : undefined;
      let changed = false;
      const updated = await this.updateRoom(room.id, current => {
        if (current.channelId !== room.channelId || (current.ownerId !== actor && !this.isStaff(i))) return current;
        if (action === 'rename' && typeof value === 'string' && value.trim()) { changed = true; return { ...current, desiredName: value.trim().slice(0, 80) }; }
        if (action === 'capacity' && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99) { changed = true; return { ...current, limit: value }; }
        if (action === 'transfer' && snowflake(target) && current.occupants.some(o => o.userId === target)) { changed = true; return { ...current, ownerId: target }; }
        return current;
      });
      if (!updated || !changed) return;
      if (action === 'transfer' && updated.ownerId !== room.ownerId) {
        await this.host.state.update(roomOwnerKey(room.ownerId), old => old === room.id ? '' : (old ?? ''));
        const currentOwner = await this.host.state.get(roomOwnerKey(updated.ownerId));
        if (currentOwner === null || currentOwner === '' || currentOwner === room.id) await this.host.state.set(roomOwnerKey(updated.ownerId), room.id);
      }
      await this.host.state.set(interactionKey(i.id!), { status: 'recorded', action, entityId: room.id });
    }
  }

  private async handleVoiceState(packet: DiscordDispatch): Promise<void> {
    const d = packet.data; if (!object(d) || d.guild_id !== this.config.guildId || !snowflake(d.user_id)) return;
    const user = String(d.user_id); if (user === this.config.botUserId) return;
    const channel = snowflake(d.channel_id) ? String(d.channel_id) : null;
    const now = this.host.now();
    if (channel === this.config.voiceLobbyChannelId) {
      const key = roomOwnerKey(user); const existing = await this.host.state.get(key);
      if (existing === null || existing === '') {
        const id = 'voice-' + user;
        await this.host.state.update(roomKey(id), old => {
          const current = asRoom(old);
          if (current && ['pending_create', 'creating', 'unknown_create', 'active', 'deleting', 'unknown_delete'].includes(current.status)) return current as unknown as JSONValue;
          return { version: 1, id, ownerId: user, status: 'pending_create', createMarker: 'superagent-room:' + user,
            createdAt: now, limit: this.roomLimit, occupants: [{ userId: user, joinedAt: now }], creatorPresent: true } as unknown as JSONValue;
        });
        await this.host.state.set(key, id);
      }
    }
    const rooms = await this.host.state.list('room:');
    for (const row of rooms) {
      if (!row.key.startsWith('room:') || row.key.startsWith('room:owner:')) continue;
      const snapshot = asRoom(row.value); if (!snapshot) continue;
      let transferred: string | undefined; let previousOwner: string | undefined;
      await this.updateRoom(snapshot.id, room => {
        if (!room.channelId) {
          if (room.ownerId === user && channel !== this.config.voiceLobbyChannelId) {
            room.creatorPresent = false;
            if (room.status === 'pending_create') { room.status = 'blocked'; room.lastError = 'creator-left-lobby-before-room-create'; }
          }
          return room;
        }
        const wasPresent = room.occupants.some(entry => entry.userId === user);
        if (room.ownerId === user && (room.pendingMove || room.moveUnknown)) {
          if (channel === room.channelId) { delete room.pendingMove; delete room.moveUnknown; }
          else if (room.moveUnknown) {
            delete room.moveUnknown;
            if (room.creatorPresent !== false) room.pendingMove = true;
            else delete room.pendingMove;
          }
        }
        if (channel === room.channelId && !wasPresent) {
          room.occupants.push({ userId: user, joinedAt: now }); delete room.emptyAt; delete room.finalFlushComplete; delete room.deleteAttemptAt;
          if (room.status === 'deleting' || room.status === 'unknown_delete') room.status = 'active';
          if (!room.occupants.some(entry => entry.userId === room.ownerId)) {
            previousOwner = room.ownerId;
            transferred = [...room.occupants].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]!.userId;
            room.ownerId = transferred;
          }
        } else if (channel !== room.channelId && wasPresent) {
          room.occupants = room.occupants.filter(entry => entry.userId !== user);
          if (room.ownerId === user && room.occupants.length) {
            previousOwner = room.ownerId;
            transferred = [...room.occupants].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]!.userId;
            room.ownerId = transferred;
          }
          if (!room.occupants.length) room.emptyAt = now;
          else delete room.emptyAt;
        }
        return room;
      });
      const fresh = asRoom(await this.host.state.get(roomKey(snapshot.id)));
      if (transferred && fresh?.ownerId === transferred && previousOwner) {
        await this.host.state.update(roomOwnerKey(previousOwner), old => old === fresh.id ? '' : (old ?? ''));
        const current = await this.host.state.get(roomOwnerKey(transferred));
        if (current === null || current === '' || current === fresh.id) await this.host.state.set(roomOwnerKey(transferred), fresh.id);
      }
    }
    if (channel !== this.config.voiceLobbyChannelId) {
      const pending = await this.host.state.get(roomOwnerKey(user));
      if (typeof pending === 'string' && pending) {
        const updated = await this.updateRoom(pending, room => {
          if (!room.channelId && room.ownerId === user && ['pending_create', 'creating', 'unknown_create'].includes(room.status)) {
            room.creatorPresent = false;
            if (room.status === 'pending_create') { room.status = 'blocked'; room.lastError = 'creator-left-lobby-before-room-create'; }
          }
          return room;
        });
        if (updated?.status === 'blocked') await this.host.state.update(roomOwnerKey(user), old => old === pending ? '' : (old ?? ''));
      }
    }
  }

  private async reconcileVoiceSnapshot(snapshot: unknown[], signal: AbortSignal): Promise<void> {
    const present = new Map<string, string>();
    for (const value of snapshot) {
      signal.throwIfAborted();
      if (!object(value) || !snowflake(value.user_id)) continue;
      const channelId = snowflake(value.channel_id) ? String(value.channel_id) : '';
      present.set(String(value.user_id), channelId);
      await this.handleVoiceState({ type: 'VOICE_STATE_UPDATE', sequence: 0, sessionId: 'snapshot', receivedAt: this.host.now(),
        data: { ...value, guild_id: this.config.guildId } as Record<string, JSONValue> });
    }
    const rooms = await this.host.state.list('room:');
    for (const row of rooms) {
      if (!row.key.startsWith('room:') || row.key.startsWith('room:owner:')) continue;
      const room = asRoom(row.value); if (!room?.channelId) continue;
      let transferred: string | undefined; let previousOwner: string | undefined;
      const updated = await this.updateRoom(room.id, current => {
        if (!current.channelId) return current;
        const currentUsers = [...present].filter(([, channelId]) => channelId === current.channelId).map(([userId]) => userId);
        current.occupants = currentUsers.map(userId => ({ userId, joinedAt: current.occupants.find(user => user.userId === userId)?.joinedAt ?? this.host.now() }));
        if (current.occupants.length) {
          delete current.finalFlushComplete;
          if (!current.occupants.some(user => user.userId === current.ownerId)) {
            previousOwner = current.ownerId;
            transferred = [...current.occupants].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]!.userId;
            current.ownerId = transferred;
          }
          delete current.emptyAt;
        } else current.emptyAt ??= this.host.now();
        return current;
      });
      if (transferred && updated?.ownerId === transferred && previousOwner) {
        await this.host.state.set(roomOwnerKey(previousOwner), '');
        const current = await this.host.state.get(roomOwnerKey(transferred));
        if (current === null || current === '' || current === room.id) await this.host.state.set(roomOwnerKey(transferred), room.id);
      }
    }
  }

  private async ensureTicketChannel(ticket: TicketState, signal: AbortSignal): Promise<void> {
    if (ticket.status === 'unknown_create' || ticket.status === 'creating') {
      const found = await this.findChannelByTopic(this.config.ticketCategoryId, ticket.createMarker, signal);
      if (found) {
        const channelId = String(found.id);
        const saved = await this.updateTicket(ticket.id, current => ['pending_create', 'creating', 'unknown_create'].includes(current.status)
          ? { ...current, channelId, status: 'open' } : current);
        if (saved?.channelId === channelId && saved.status === 'open') await this.postTicketIntro(saved, signal);
      }
      return;
    }
    const current = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!current || current.status !== 'pending_create') return;
    let createClaimed = false;
    const creating = await this.updateTicket(ticket.id, latest => {
      if (latest.status !== 'pending_create') return latest;
      createClaimed = true; return { ...latest, status: 'creating' };
    });
    if (!createClaimed || !creating || creating.status !== 'creating') return;
    const overwrites = this.ticketOverwrites(creating.userId);
    let created: unknown;
    try {
      created = await this.api.request('POST', '/guilds/' + this.config.guildId + '/channels', {
        name: `ticket-${creating.userId.slice(-8)}-${creating.id.slice(-6)}`, type: 0, parent_id: this.config.ticketCategoryId,
        topic: creating.createMarker, permission_overwrites: overwrites,
      }, signal);
    } catch (error) {
      await this.updateTicket(creating.id, latest => ['creating', 'unknown_create'].includes(latest.status) ? {
        ...latest, status: error instanceof Error && error.message === 'OUTCOME_UNKNOWN' ? 'unknown_create' : 'blocked',
        lastError: error instanceof Error && error.message === 'OUTCOME_UNKNOWN' ? 'creation-outcome-unknown' : error instanceof Error ? error.message.slice(0, 120) : 'creation-failed',
      } : latest);
      return;
    }
    if (!object(created) || !snowflake(created.id)) {
      await this.updateTicket(creating.id, latest => ['creating', 'unknown_create'].includes(latest.status)
        ? { ...latest, status: 'unknown_create', lastError: 'create-response-unrecognized' } : latest); return;
    }
    const channelId = String(created.id);
    const saved = await this.updateTicket(creating.id, latest => ['creating', 'unknown_create'].includes(latest.status)
      ? { ...latest, channelId, status: 'open' } : latest);
    if (saved?.channelId === channelId && saved.status === 'open') await this.postTicketIntro(saved, signal);
  }

  private ticketOverwrites(requester: string): Array<Record<string, unknown>> {
    const entries = new Map<string, Record<string, unknown>>();
    entries.set(this.config.guildId, { id: this.config.guildId, type: 0, allow: '0', deny: EVERYONE_TICKET_DENY });
    for (const id of new Set([requester, this.config.ownerId, this.config.botUserId])) entries.set(id, { id, type: 1, allow: ACCESS, deny: id === requester ? NO_THREADS : '0' });
    for (const id of this.config.staffRoleIds) entries.set(id, { id, type: 0, allow: ACCESS, deny: '0' });
    return [...entries.values()];
  }

  private async postTicketIntro(ticket: TicketState, signal: AbortSignal): Promise<void> {
    let latest = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!latest?.channelId || !['open', 'closed'].includes(latest.status)) return;
    if (latest.controlsPostingAt && Date.parse(this.host.now()) - Date.parse(latest.controlsPostingAt) < 60_000) return;
    const channelId = latest.channelId;
    let claimed = false;
    latest = await this.updateTicket(ticket.id, current => {
      const stale = !current.controlsPostingAt || Date.parse(this.host.now()) - Date.parse(current.controlsPostingAt) >= 60_000;
      if (current.channelId !== channelId || !['open', 'closed'].includes(current.status) || !stale) return current;
      claimed = true; return { ...current, controlsPostingAt: this.host.now() };
    });
    if (!claimed || !latest) return;
    const release = async () => this.updateTicket(ticket.id, current => {
      const next = { ...current }; delete next.controlsPostingAt; return next;
    });
    let messages: unknown;
    try { messages = await this.api.request('GET', `/channels/${channelId}/messages?limit=50`, undefined, signal); }
    catch (error) { await release(); throw error; }
    if (!Array.isArray(messages)) { await release(); throw new Error('INVALID_RESPONSE'); }
    const claimId = `ticket:claim:${ticket.id}`; const closeId = `ticket:close:${ticket.id}`;
    let controls = messages.find(message => object(message) && object(message.author) && message.author.id === this.config.botUserId
      && componentIds(message).includes(claimId) && componentIds(message).includes(closeId));
    let controlsMessageId: string | undefined = object(controls) && snowflake(controls.id) ? String(controls.id) : undefined;
    const event = await this.host.getPrivateEvent(latest.evidenceEventId);
    const text = event && 'data' in event && event.data && 'content' in event.data ? event.data.content?.text : null;
    if (typeof text !== 'string') { await release(); throw new Error('PRIVATE_ARCHIVE_EVENT_MISSING'); }
    const parts = splitDiscordText(text);
    if (!controlsMessageId) {
      const beforePost = asTicket(await this.host.state.get(ticketKey(ticket.id)));
      if (!beforePost?.channelId || beforePost.channelId !== channelId || !['open', 'closed'].includes(beforePost.status)) { await release(); return; }
      try {
        const sent = await this.api.request('POST', `/channels/${channelId}/messages`, {
          content: parts[0] ?? '', allowed_mentions: { parse: [] }, components: [{ type: 1, components: [
            { type: 2, style: 2, label: 'Claim · 认领', custom_id: claimId },
            { type: 2, style: 4, label: 'Close · 关闭', custom_id: closeId },
          ] }],
        }, signal);
        if (!object(sent) || !snowflake(sent.id)) return;
        const sentId = String(sent.id); controlsMessageId = sentId; controls = sent; messages.unshift(sent);
        await this.updateTicket(ticket.id, current => current.channelId === channelId && ['open', 'closed'].includes(current.status)
          ? { ...current, controlsMessageId: sentId } : current);
      } catch (error) {
        if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') return;
        await release(); throw error;
      }
    } else {
      const existingId = controlsMessageId;
      await this.updateTicket(ticket.id, current => current.channelId === channelId && ['open', 'closed'].includes(current.status)
        ? { ...current, controlsMessageId: existingId } : current);
    }

    if (!controlsMessageId) return;
    const finalControlsMessageId = controlsMessageId;
    for (const part of parts.slice(1)) {
      const prior = messages.find(message => object(message) && object(message.author) && message.author.id === this.config.botUserId
        && object(message.message_reference) && message.message_reference.message_id === finalControlsMessageId && message.content === part);
      if (prior) continue;
      const current = asTicket(await this.host.state.get(ticketKey(ticket.id)));
      if (!current?.channelId || current.channelId !== channelId || !['open', 'closed'].includes(current.status)) return;
      try {
        const sent = await this.api.request('POST', `/channels/${channelId}/messages`, {
          content: part, message_reference: { message_id: finalControlsMessageId, fail_if_not_exists: true }, allowed_mentions: { parse: [] },
        }, signal);
        if (!object(sent) || !snowflake(sent.id)) return;
        messages.unshift(sent);
      } catch (error) {
        if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') return;
        await release(); throw error;
      }
    }
    await release();
  }

  private async applyTicketStatus(ticket: TicketState, signal: AbortSignal): Promise<void> {
    const expectedStatus = ticket.status; const expectedChannel = ticket.channelId;
    if (!expectedChannel || !['open', 'closed'].includes(expectedStatus)) return;
    const channel = await this.api.request('GET', `/channels/${expectedChannel}`, undefined, signal);
    if (!object(channel) || !Array.isArray(channel.permission_overwrites)) throw new Error('INVALID_RESPONSE');
    const latest = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!latest || latest.status !== expectedStatus || latest.channelId !== expectedChannel) return;
    const allow = expectedStatus === 'closed' ? READ : ACCESS;
    const deny = expectedStatus === 'closed' ? CLOSED_TICKET_DENY : NO_THREADS;
    const lock = 'ticket:applied:' + latest.id + ':' + expectedStatus;
    const participants = new Set([latest.userId]);
    for (const item of channel.permission_overwrites) {
      if (object(item) && Number(item.type) === 1 && snowflake(item.id) && typeof item.allow === 'string' && /^\d+$/.test(item.allow)
        && (BigInt(item.allow) & BigInt(VIEW)) !== 0n && ![this.config.botUserId, this.config.ownerId].includes(item.id)) participants.add(item.id);
    }
    for (const userId of participants) {
      const existing = channel.permission_overwrites.find(item => object(item) && item.id === userId && Number(item.type) === 1);
      if (object(existing) && existing.allow === allow && existing.deny === deny) continue;
      const beforeWrite = asTicket(await this.host.state.get(ticketKey(ticket.id)));
      if (!beforeWrite || beforeWrite.status !== expectedStatus || beforeWrite.channelId !== expectedChannel) return;
      try { await this.api.request('PUT', `/channels/${expectedChannel}/permissions/${userId}`, { id: userId, type: 1, allow, deny }, signal); }
      catch (error) { if (!(error instanceof Error && error.message === 'OUTCOME_UNKNOWN')) throw error; return; }
    }
    const afterWrite = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (afterWrite?.status === expectedStatus && afterWrite.channelId === expectedChannel) await this.host.state.set(lock, true);
  }

  private async applyTicketAccess(ticket: TicketState, signal: AbortSignal): Promise<void> {
    const expectedChannel = ticket.channelId; const pending = ticket.pendingAccess?.[0];
    if (!pending || !expectedChannel) return;
    const channel = await this.api.request('GET', `/channels/${expectedChannel}`, undefined, signal);
    if (!object(channel) || !Array.isArray(channel.permission_overwrites)) throw new Error('INVALID_RESPONSE');
    const current = channel.permission_overwrites.find(item => object(item) && item.id === pending.userId && Number(item.type) === 1);
    const latest = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    const samePending = (value: TicketState | null) => !!value && value.channelId === expectedChannel
      && value.pendingAccess?.[0]?.userId === pending.userId && value.pendingAccess?.[0]?.action === pending.action;
    if (!samePending(latest)) return;
    const allow = latest?.status === 'closed' ? READ : ACCESS;
    const deny = latest?.status === 'closed' ? CLOSED_TICKET_DENY : NO_THREADS;
    if ((pending.action === 'remove' && !current)
      || (pending.action === 'add' && object(current) && current.allow === allow && current.deny === deny)) {
      await this.updateTicket(ticket.id, fresh => samePending(fresh) ? { ...fresh, pendingAccess: (fresh.pendingAccess ?? []).slice(1) } : fresh); return;
    }
    const beforeWrite = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!samePending(beforeWrite)) return;
    try {
      if (pending.action === 'add') await this.api.request('PUT', `/channels/${expectedChannel}/permissions/${pending.userId}`,
        { id: pending.userId, type: 1, allow, deny }, signal);
      else await this.api.request('DELETE', `/channels/${expectedChannel}/permissions/${pending.userId}`, undefined, signal);
      await this.updateTicket(ticket.id, fresh => samePending(fresh) ? { ...fresh, pendingAccess: (fresh.pendingAccess ?? []).slice(1) } : fresh);
    } catch (error) { if (!(error instanceof Error && error.message === 'OUTCOME_UNKNOWN')) throw error; }
  }

  private async deleteTicketChannel(ticket: TicketState, signal: AbortSignal): Promise<void> {
    const channelId = ticket.channelId; if (!channelId) return;
    try { await this.api.request('GET', `/channels/${channelId}`, undefined, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') {
        const fresh = asTicket(await this.host.state.get(ticketKey(ticket.id)));
        if (fresh?.channelId === channelId && fresh.finalFlushComplete) await this.markTicketDeleted(fresh);
        else if (fresh?.channelId === channelId) await this.updateTicket(ticket.id, current => ({ ...current, status: 'blocked', lastError: 'channel-missing-before-final-flush' }));
        return;
      }
      throw error;
    }
    let fresh = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!fresh || fresh.channelId !== channelId || !['delete_pending', 'deleting', 'unknown_delete'].includes(fresh.status)) return;
    if (fresh.status === 'deleting' && fresh.deleteAttemptAt && Date.parse(this.host.now()) - Date.parse(fresh.deleteAttemptAt) < 30_000) return;
    if (!fresh.finalFlushComplete) {
      await this.host.flushChannel(channelId, signal);
      fresh = await this.updateTicket(ticket.id, current => current.channelId === channelId && ['delete_pending', 'deleting', 'unknown_delete'].includes(current.status)
        ? { ...current, finalFlushComplete: true } : current);
      if (!fresh || !fresh.finalFlushComplete) return;
    }
    const deleteAttemptAt = this.host.now(); let deleteClaimed = false;
    fresh = await this.updateTicket(ticket.id, current => {
      const attemptExpired = !current.deleteAttemptAt || Date.parse(deleteAttemptAt) - Date.parse(current.deleteAttemptAt) >= 30_000;
      if (current.channelId !== channelId || !['delete_pending', 'deleting', 'unknown_delete'].includes(current.status)
        || !current.finalFlushComplete || !attemptExpired) return current;
      deleteClaimed = true; return { ...current, status: 'deleting', deleteAttemptAt };
    });
    if (!deleteClaimed || !fresh || fresh.status !== 'deleting') return;
    const beforeDelete = asTicket(await this.host.state.get(ticketKey(ticket.id)));
    if (!beforeDelete || beforeDelete.channelId !== channelId || beforeDelete.status !== 'deleting'
      || beforeDelete.deleteAttemptAt !== deleteAttemptAt || !beforeDelete.finalFlushComplete) return;
    try { await this.api.request('DELETE', `/channels/${channelId}`, undefined, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') { await this.markTicketDeleted(beforeDelete); return; }
      if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') {
        await this.updateTicket(ticket.id, current => {
          if (current.channelId !== channelId || current.status !== 'deleting' || current.deleteAttemptAt !== deleteAttemptAt) return current;
          const next = { ...current, status: 'unknown_delete' as const }; delete next.deleteAttemptAt; return next;
        }); return;
      }
      throw error;
    }
    await this.markTicketDeleted(beforeDelete);
  }

  private async markTicketDeleted(ticket: TicketState): Promise<void> {
    await this.updateTicket(ticket.id, current => {
      if (current.channelId !== ticket.channelId || !current.finalFlushComplete) return current;
      const next = { ...current, status: 'deleted' as const }; delete next.deleteAttemptAt; return next;
    });
  }

  private async ensureRoom(room: RoomState, signal: AbortSignal): Promise<void> {
    if (room.status === 'unknown_create' || room.status === 'creating') {
      const found = await this.findRoomByName(this.config.voiceCategoryId, ` · ${short(room.id)}`, signal);
      if (found) {
        const channelId = String(found.id);
        const saved = await this.updateRoom(room.id, current => ['creating', 'unknown_create'].includes(current.status) ? {
          ...current, channelId, status: 'active', pendingMove: current.creatorPresent !== false,
          ...(!current.occupants.length && !current.emptyAt ? { emptyAt: this.host.now() } : {}),
        } : current);
        if (saved?.status === 'active') await this.moveCreator(saved, signal);
      }
      return;
    }
    let fresh = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!fresh || fresh.status !== 'pending_create') return;
    if (fresh.creatorPresent === false) {
      await this.updateRoom(room.id, current => current.status === 'pending_create' ? { ...current, status: 'blocked', lastError: 'creator-left-lobby-before-room-create' } : current);
      await this.host.state.update(roomOwnerKey(fresh.ownerId), old => old === fresh!.id ? '' : (old ?? '')); return;
    }
    let createClaimed = false;
    const creating = await this.updateRoom(room.id, current => {
      if (current.status !== 'pending_create') return current;
      createClaimed = true; return { ...current, status: 'creating' };
    });
    if (!createClaimed || !creating || creating.status !== 'creating') return;
    try {
      const created = await this.api.request('POST', `/guilds/${this.config.guildId}/channels`, {
        name: `🎮 冒险小队 · ${short(creating.id)}`, type: 2, parent_id: this.config.voiceCategoryId,
        user_limit: creating.limit, permission_overwrites: [
          { id: this.config.guildId, type: 0, allow: VOICE_ACCESS, deny: '0' },
          { id: creating.ownerId, type: 1, allow: VOICE_ACCESS, deny: '0' },
          { id: this.config.botUserId, type: 1, allow: VIEW, deny: '0' },
        ],
      }, signal);
      if (!object(created) || !snowflake(created.id)) {
        await this.updateRoom(creating.id, current => ['creating', 'unknown_create'].includes(current.status)
          ? { ...current, status: 'unknown_create', lastError: 'create-response-unrecognized' } : current); return;
      }
      const channelId = String(created.id);
      fresh = await this.updateRoom(creating.id, current => ['creating', 'unknown_create'].includes(current.status) ? {
        ...current, channelId, status: 'active', pendingMove: current.creatorPresent !== false,
        ...(!current.occupants.length && !current.emptyAt ? { emptyAt: this.host.now() } : {}),
      } : current);
      if (fresh?.status === 'active') await this.host.state.set(roomOwnerKey(fresh.ownerId), fresh.id);
    } catch (error) {
      const status = error instanceof Error && error.message === 'OUTCOME_UNKNOWN' ? 'unknown_create' : 'blocked';
      fresh = await this.updateRoom(creating.id, current => ['creating', 'unknown_create'].includes(current.status)
        ? { ...current, status, lastError: status === 'unknown_create' ? 'creation-outcome-unknown' : error instanceof Error ? error.message.slice(0, 120) : 'creation-failed' } : current);
      if (fresh?.status === 'blocked') await this.host.state.update(roomOwnerKey(fresh.ownerId), old => old === fresh!.id ? '' : (old ?? ''));
    }
    if (fresh?.status === 'active') await this.moveCreator(fresh, signal);
  }

  private async moveCreator(room: RoomState, signal: AbortSignal): Promise<void> {
    const channelId = room.channelId; if (!channelId || !room.pendingMove || room.creatorPresent === false) return;
    let moveClaimed = false;
    const intent = await this.updateRoom(room.id, current => {
      if (current.channelId !== channelId || !current.pendingMove || current.creatorPresent === false) return current;
      moveClaimed = true; const next = { ...current, moveUnknown: true }; delete next.pendingMove; return next;
    });
    if (!moveClaimed || !intent?.moveUnknown || intent.channelId !== channelId) return;
    try {
      await this.api.request('PATCH', `/guilds/${this.config.guildId}/members/${intent.ownerId}`, { channel_id: channelId }, signal);
      await this.updateRoom(room.id, current => {
        if (current.channelId !== channelId || current.ownerId !== intent.ownerId) return current;
        const next = { ...current }; delete next.moveUnknown; delete next.pendingMove; return next;
      });
    }
    catch (error) {
      if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') return;
      await this.updateRoom(room.id, current => {
        if (current.channelId !== channelId || current.ownerId !== intent.ownerId) return current;
        const next = { ...current, lastError: error instanceof Error ? `move:${error.message.slice(0, 80)}` : 'move-failed' }; delete next.moveUnknown; return next;
      });
      throw error;
    }
  }

  private async cleanupRoomIfEmpty(room: RoomState, signal: AbortSignal): Promise<void> {
    if (!this.voiceSnapshotReady) return;
    let current = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!current || current.status !== 'active' || !current.channelId) return;
    if (current.occupants.length) { if (current.emptyAt) await this.updateRoom(current.id, fresh => { const next = { ...fresh }; delete next.emptyAt; return next; }); return; }
    if (!current.emptyAt) { await this.updateRoom(current.id, fresh => fresh.status === 'active' && !fresh.occupants.length ? { ...fresh, emptyAt: this.host.now() } : fresh); return; }
    if (Date.parse(this.host.now()) - Date.parse(current.emptyAt) < this.emptyMs) return;
    const channelId = current.channelId;
    const flushAttemptAt = this.host.now(); let flushClaimed = false;
    current = await this.updateRoom(current.id, fresh => {
      const stale = !fresh.flushAttemptAt || Date.parse(flushAttemptAt) - Date.parse(fresh.flushAttemptAt) >= 600_000;
      if (fresh.status !== 'active' || fresh.channelId !== channelId || fresh.occupants.length || !fresh.emptyAt
        || Date.parse(this.host.now()) - Date.parse(fresh.emptyAt) < this.emptyMs || !stale) return fresh;
      flushClaimed = true; return { ...fresh, flushAttemptAt };
    });
    if (!flushClaimed || !current) return;
    try { await this.host.flushChannel(channelId, signal); }
    catch (error) {
      await this.updateRoom(room.id, fresh => {
        if (fresh.channelId !== channelId || fresh.flushAttemptAt !== flushAttemptAt) return fresh;
        const next = { ...fresh }; delete next.flushAttemptAt; return next;
      }); throw error;
    }
    current = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!this.voiceSnapshotReady || !current || current.status !== 'active' || current.channelId !== channelId || current.occupants.length
      || !current.emptyAt || Date.parse(this.host.now()) - Date.parse(current.emptyAt) < this.emptyMs) {
      await this.updateRoom(room.id, fresh => {
        if (fresh.channelId !== channelId || fresh.flushAttemptAt !== flushAttemptAt) return fresh;
        const next = { ...fresh }; delete next.flushAttemptAt; return next;
      }); return;
    }
    let flushProofClaimed = false;
    const deleting = await this.updateRoom(current.id, fresh => {
      if (fresh.status !== 'active' || fresh.channelId !== channelId || fresh.occupants.length || !fresh.emptyAt
        || fresh.flushAttemptAt !== flushAttemptAt || Date.parse(this.host.now()) - Date.parse(fresh.emptyAt) < this.emptyMs) return fresh;
      flushProofClaimed = true; const next = { ...fresh, status: 'deleting' as const, finalFlushComplete: true }; delete next.flushAttemptAt; return next;
    });
    if (!flushProofClaimed || deleting?.status !== 'deleting' || !deleting.finalFlushComplete) return;
    const beforeDelete = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!this.voiceSnapshotReady || !beforeDelete || beforeDelete.status !== 'deleting' || beforeDelete.channelId !== channelId
      || beforeDelete.occupants.length || !beforeDelete.finalFlushComplete) {
      await this.updateRoom(room.id, fresh => {
        if (fresh.status !== 'deleting' || fresh.channelId !== channelId || !fresh.occupants.length) return fresh;
        const next = { ...fresh, status: 'active' as const }; delete next.finalFlushComplete; return next;
      }); return;
    }
    const deleteAttemptAt = this.host.now(); let deleteClaimed = false;
    const deleteIntent = await this.updateRoom(room.id, fresh => {
      const stale = !fresh.deleteAttemptAt || Date.parse(deleteAttemptAt) - Date.parse(fresh.deleteAttemptAt) >= 30_000;
      if (fresh.status !== 'deleting' || fresh.channelId !== channelId || fresh.occupants.length || !fresh.finalFlushComplete || !stale) return fresh;
      deleteClaimed = true; return { ...fresh, deleteAttemptAt };
    });
    if (!deleteClaimed || deleteIntent?.deleteAttemptAt !== deleteAttemptAt) return;
    try { await this.api.request('DELETE', `/channels/${channelId}`, undefined, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') {
        await this.updateRoom(room.id, fresh => {
          if (fresh.status !== 'deleting' || fresh.channelId !== channelId || fresh.deleteAttemptAt !== deleteAttemptAt) return fresh;
          const next = { ...fresh, status: 'unknown_delete' as const }; delete next.deleteAttemptAt; return next;
        }); return;
      }
      if (!(error instanceof Error && error.message === 'NOT_FOUND')) throw error;
    }
    await this.finishRoomDelete(room.id, channelId);
  }

  private async reconcileRoomDelete(room: RoomState, signal: AbortSignal): Promise<void> {
    if (!this.voiceSnapshotReady || !room.channelId) return;
    const channelId = room.channelId;
    try { await this.api.request('GET', `/channels/${channelId}`, undefined, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') {
        await this.finishRoomDelete(room.id, channelId); return;
      }
      throw error;
    }
    let fresh = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!fresh || fresh.channelId !== channelId || !['deleting', 'unknown_delete'].includes(fresh.status)) return;
    if (fresh.status === 'deleting' && fresh.deleteAttemptAt && Date.parse(this.host.now()) - Date.parse(fresh.deleteAttemptAt) < 30_000) return;
    if (fresh.occupants.length) {
      await this.updateRoom(room.id, current => {
        if (current.channelId !== channelId || !['deleting', 'unknown_delete'].includes(current.status)) return current;
        const next = { ...current, status: 'active' as const }; delete next.finalFlushComplete; delete next.emptyAt; return next;
      }); return;
    }
    if (fresh.emptyAt && Date.parse(this.host.now()) - Date.parse(fresh.emptyAt) < this.emptyMs) {
      await this.updateRoom(room.id, current => {
        if (current.channelId !== channelId || !['deleting', 'unknown_delete'].includes(current.status)) return current;
        const next = { ...current, status: 'active' as const }; delete next.finalFlushComplete; return next;
      }); return;
    }
    if (!fresh.finalFlushComplete) {
      await this.host.flushChannel(channelId, signal);
      fresh = await this.updateRoom(room.id, current => current.channelId === channelId && ['deleting', 'unknown_delete'].includes(current.status) && !current.occupants.length
        ? { ...current, finalFlushComplete: true, status: 'deleting' } : current);
      if (!fresh?.finalFlushComplete) return;
    }
    const deleteAttemptAt = this.host.now(); let deleteClaimed = false;
    const deleteIntent = await this.updateRoom(room.id, current => {
      const stale = !current.deleteAttemptAt || Date.parse(deleteAttemptAt) - Date.parse(current.deleteAttemptAt) >= 30_000;
      if (!this.voiceSnapshotReady || current.channelId !== channelId || !['deleting', 'unknown_delete'].includes(current.status)
        || current.occupants.length || !current.finalFlushComplete || !stale) return current;
      deleteClaimed = true; return { ...current, status: 'deleting', deleteAttemptAt };
    });
    if (!deleteClaimed || deleteIntent?.deleteAttemptAt !== deleteAttemptAt) return;
    try { await this.api.request('DELETE', `/channels/${channelId}`, undefined, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') { await this.finishRoomDelete(room.id, channelId); return; }
      if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') {
        await this.updateRoom(room.id, current => {
          if (current.channelId !== channelId || current.status !== 'deleting' || current.deleteAttemptAt !== deleteAttemptAt) return current;
          const next = { ...current, status: 'unknown_delete' as const }; delete next.deleteAttemptAt; return next;
        }); return;
      }
      throw error;
    }
    await this.finishRoomDelete(room.id, channelId);
  }

  private async finishRoomDelete(id: string, channelId: string): Promise<void> {
    const updated = await this.updateRoom(id, current => {
      if (current.channelId !== channelId) return current;
      const next = { ...current, status: 'blocked' as const, lastError: 'expired-room-deleted', finalFlushComplete: true };
      delete next.deleteAttemptAt; delete next.flushAttemptAt; return next;
    });
    if (updated) await this.host.state.update(roomOwnerKey(updated.ownerId), old => old === updated.id ? '' : (old ?? ''));
  }

  private async applyRoomSettings(room: RoomState, signal: AbortSignal): Promise<void> {
    const channelId = room.channelId; if (!channelId) return;
    const native = await this.api.request('GET', `/channels/${channelId}`, undefined, signal);
    if (!object(native)) throw new Error('INVALID_RESPONSE');
    const latest = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!latest || latest.status !== 'active' || latest.channelId !== channelId) return;
    const desiredName = latest.desiredName;
    const desiredLimit = latest.limit;
    const nameChanged = desiredName !== undefined && native.name !== desiredName;
    const limitChanged = native.user_limit !== desiredLimit;
    if (!nameChanged && !limitChanged) {
      if (desiredName !== undefined) await this.updateRoom(room.id, current => {
        if (current.desiredName !== desiredName) return current;
        const next = { ...current }; delete next.desiredName; return next;
      });
      return;
    }
    const beforeWrite = asRoom(await this.host.state.get(roomKey(room.id)));
    if (!beforeWrite || beforeWrite.status !== 'active' || beforeWrite.channelId !== channelId
      || beforeWrite.desiredName !== desiredName || beforeWrite.limit !== desiredLimit) return;
    try {
      await this.api.request('PATCH', `/channels/${channelId}`, {
        ...(nameChanged ? { name: desiredName } : {}), ...(limitChanged ? { user_limit: desiredLimit } : {}),
      }, signal);
      if (desiredName !== undefined) await this.updateRoom(room.id, current => {
        if (current.channelId !== channelId || current.desiredName !== desiredName) return current;
        const next = { ...current }; delete next.desiredName; return next;
      });
    } catch (error) { if (!(error instanceof Error && error.message === 'OUTCOME_UNKNOWN')) throw error; }
  }

  private async findChannelByTopic(categoryId: string, topic: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const channels = await this.api.request('GET', `/guilds/${this.config.guildId}/channels`, undefined, signal);
    if (!Array.isArray(channels)) throw new Error('INVALID_RESPONSE');
    const found = channels.filter(channel => object(channel) && Number(channel.type) === 0 && channel.parent_id === categoryId && channel.topic === topic);
    if (found.length > 1) throw new Error('MARKER_COLLISION');
    return object(found[0]) && snowflake(found[0].id) ? found[0] : null;
  }

  private async findRoomByName(categoryId: string, markerSuffix: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const channels = await this.api.request('GET', `/guilds/${this.config.guildId}/channels`, undefined, signal);
    if (!Array.isArray(channels)) throw new Error('INVALID_RESPONSE');
    const found = channels.filter(channel => object(channel) && Number(channel.type) === 2 && channel.parent_id === categoryId
      && typeof channel.name === 'string' && channel.name.endsWith(markerSuffix));
    if (found.length > 1) throw new Error('MARKER_COLLISION');
    return object(found[0]) && snowflake(found[0].id) ? found[0] : null;
  }

  private async ensurePanel(channelId: string, kind: 'ticket' | 'room', signal: AbortSignal): Promise<void> {
    const messages = await this.api.request('GET', `/channels/${channelId}/messages?limit=100`, undefined, signal);
    if (!Array.isArray(messages)) throw new Error('INVALID_RESPONSE');
    const existing = messages.some(message => {
      if (!object(message) || !object(message.author) || message.author.id !== this.config.botUserId) return false;
      if (kind === 'ticket') return ['ticket:new:bug', 'ticket:new:suggestion', 'ticket:new:help'].every(id => componentIds(message).includes(id));
      return typeof message.content === 'string' && message.content.includes('Temporary voice rooms · 临时语音房');
    });
    if (existing) return;
    const attemptKey = `panel:${kind}:posting-at`;
    let claimed = false;
    await this.host.state.update(attemptKey, old => {
      const stale = typeof old !== 'string' || Date.parse(this.host.now()) - Date.parse(old) >= 60_000;
      if (!stale) return old;
      claimed = true; return this.host.now();
    });
    if (!claimed) return;
    const body = kind === 'ticket' ? {
      content: `**Private community help · 私密社区求助**\nChoose a request type below. Your submission is archived before a private channel is created. Do not include passwords or account credentials.\n\n选择下方类型。内容会先归档再创建私密频道。请勿填写密码或账号凭据。`,
      components: [{ type: 1, components: [
        { type: 2, style: 1, label: 'Bug · 问题', custom_id: 'ticket:new:bug' },
        { type: 2, style: 2, label: 'Suggestion · 建议', custom_id: 'ticket:new:suggestion' },
        { type: 2, style: 2, label: 'Help · 求助', custom_id: 'ticket:new:help' },
      ] }], allowed_mentions: { parse: [] },
    } : {
      content: `**Temporary voice rooms · 临时语音房**\nJoin the configured voice lobby to create a temporary four-place room. It is removed after everyone leaves and the final history flush completes. Use /room rename, /room capacity, or /room transfer while in your room.\n\n加入指定语音大厅即可创建临时四人房。所有人离开并完成最后归档后会自动删除。可在房间内使用 /room rename、/room capacity 或 /room transfer。`,
      allowed_mentions: { parse: [] },
    };
    try { await this.api.request('POST', `/channels/${channelId}/messages`, body, signal); await this.host.state.set(attemptKey, ''); }
    catch (error) { if (error instanceof Error && error.message === 'OUTCOME_UNKNOWN') return; await this.host.state.set(attemptKey, ''); throw error; }
  }

  private async ticketForChannel(channelId: string): Promise<TicketState | null> {
    for (const { value } of await this.host.state.list('ticket:')) { const ticket = asTicket(value); if (ticket?.channelId === channelId) return ticket; }
    return null;
  }
  private async roomForChannel(channelId: string): Promise<RoomState | null> {
    for (const { value } of await this.host.state.list('room:')) { const room = asRoom(value); if (room?.channelId === channelId) return room; }
    return null;
  }

  private async complete(i: Interaction, content: string): Promise<void> {
    if (!i.id) return;
    if (this.volatileTokens.has(i.id)) this.pendingReplies.set(i.id, content);
  }

  private async finishDeferredReplies(signal: AbortSignal): Promise<void> {
    // Tokens are volatile and intentionally not recoverable after restart. No token is persisted.
    for (const [id, content] of this.pendingReplies) {
      signal.throwIfAborted();
      const token = this.volatileTokens.get(id);
      this.pendingReplies.delete(id); this.volatileTokens.delete(id);
      if (!token) continue;
      try { await this.api.request('PATCH', `/webhooks/${token.applicationId}/${token.token}/messages/@original`, { content, allowed_mentions: { parse: [] } }, signal); }
      catch { signal.throwIfAborted(); /* expired webhook tokens do not roll back archived work */ }
    }
  }
}

export type { JSONValue, NormalizedEventV1, SourcePluginHostV1 } from '@superagent/plugin-sdk';
