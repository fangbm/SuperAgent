import { createHmac } from 'node:crypto';
import type { ConnectorCapabilityV1, NormalizedEventV1, PluginManifestV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';
import { object, QQAPI, QQError, qqSignature, text, verifyQQSignature } from './protocol.js';
import type { QQAPIOptions, QQObject } from './protocol.js';
import { QQGateway } from './gateway.js';
import type { QQGatewayOptions, QQSession } from './gateway.js';

export const sourceManifest: PluginManifestV1 = {
  apiVersion: 'superagent.io/plugin/v1', id: 'qq-official-source', version: '0.1.0', displayName: 'QQ Official Source', kind: 'source', engine: { sdk: '^0.1.0' },
  permissions: { networkHosts: ['api.bot.qq.com', 'api.sgroup.qq.com'], secretKeys: ['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_SCOPE_ID', 'QQ_PSEUDONYM_KEY'], eventPublish: true },
  configSchema: { type: 'object', additionalProperties: false, properties: { kind: { enum: ['group', 'channel', 'c2c'] }, sourceUri: { type: 'string', format: 'uri' }, transport: { enum: ['webhook', 'websocket'] } }, required: ['kind', 'sourceUri'] },
};
export interface QQSourceOptions {
  kind: 'group' | 'channel' | 'c2c';
  sourceUri: string;
  transport?: 'webhook' | 'websocket';
  gateway?: Pick<QQGatewayOptions, 'createSocket' | 'backoffMs' | 'maxFailures'>;
  api?: QQAPIOptions;
  now?: () => number;
  maxClockSkewMs?: number;
}
export interface WebhookResponse { statusCode: number; body: object }
function coverageReason(eventType: unknown): string {
  if (eventType === 'GROUP_MESSAGE_CREATE' || eventType === 'MESSAGE_CREATE') return 'QQ_ALL_MESSAGES_OBSERVED_NO_HISTORY_OR_EDIT_RECONCILIATION';
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'AT_MESSAGE_CREATE') return 'QQ_MENTIONS_ONLY_OBSERVED_NO_HISTORY_OR_EDITS';
  return 'QQ_PUSH_ONLY_NO_HISTORY_OR_EDIT_RECONCILIATION';
}
export class QQSource implements SourcePluginV1 {
  readonly manifest = sourceManifest;
  private active: { host: SourcePluginHostV1; signal: AbortSignal; appId: string; secret: string; scopeId: string; pseudonymKey: string; binding: string; api: QQAPI } | undefined;
  private gatewayController: AbortController | undefined;
  private gatewayTask: Promise<void> | undefined;
  constructor(private readonly options: QQSourceOptions) {
    const uri = new URL(options.sourceUri);
    if (!['urn:', 'https:'].includes(uri.protocol) || !['group', 'channel', 'c2c'].includes(options.kind)) throw new QQError('QQ_INVALID_SOURCE_CONFIG', 'blocked');
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  async start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    if (this.active) throw new QQError('QQ_SOURCE_ALREADY_STARTED', 'blocked');
    signal.throwIfAborted();
    const [appId, secret, scopeId, pseudonymKey] = await Promise.all(['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_SCOPE_ID', 'QQ_PSEUDONYM_KEY'].map(key => host.getSecret(key)));
    if (!appId || !secret || !scopeId || !pseudonymKey || Buffer.byteLength(pseudonymKey) < 32) throw new QQError('QQ_SOURCE_SECRETS_REQUIRED', 'blocked');
    const binding = createHmac('sha256', pseudonymKey).update(JSON.stringify([host.projectId, host.sourceId, this.options.kind, appId, scopeId])).digest('hex');
    this.gatewayController = new AbortController();
    const activeSignal = AbortSignal.any([signal, this.gatewayController.signal]);
    this.active = { host, signal: activeSignal, appId, secret, scopeId, pseudonymKey, binding, api: new QQAPI(key => host.getSecret(key), this.options.api) };
    try {
      const cp = await host.getCheckpoint(); signal.throwIfAborted();
      if (cp !== null && (typeof cp !== 'object' || Array.isArray(cp) || cp.kind !== 'qq-webhook-v1' || cp.binding !== binding)) throw new QQError('QQ_SOURCE_BINDING_CHANGED', 'blocked');
      if (cp === null) await host.commitBatch([], { sourceId: host.sourceId, cursor: { kind: 'qq-webhook-v1', binding, observed: false } });
      await this.sync(host, signal);
      if (this.options.transport === 'websocket') {
        const gateway = new QQGateway(this.active.api, {
          ...this.options.gateway,
          intents: this.options.kind === 'channel' ? (1 << 9) | (1 << 30) : 1 << 25,
          loadSession: async () => {
            const cp = await host.getCheckpoint();
            if (!cp || typeof cp !== 'object' || Array.isArray(cp) || !cp.gateway || typeof cp.gateway !== 'object' || Array.isArray(cp.gateway)) return null;
            return typeof cp.gateway.sessionId === 'string' && Number.isSafeInteger(cp.gateway.seq) ? { sessionId: cp.gateway.sessionId, seq: Number(cp.gateway.seq) } : null;
          },
          dispatch: (payload, session) => this.commitDispatch(payload, session),
          invalidateSession: async () => {
            const cp = await host.getCheckpoint();
            const previous = cp && typeof cp === 'object' && !Array.isArray(cp) ? cp : {};
            await host.commitBatch([], { sourceId: host.sourceId, cursor: { ...previous, gateway: null } });
          },
          health: async reason => {
            if (reason.startsWith('QQ_GATEWAY_DISCONNECTED_COVERAGE_GAP')) await host.reportHealth({ coverage: 'unavailable', reason, checkedAt: new Date(this.now()).toISOString() });
          },
        });
        this.gatewayTask = gateway.run(activeSignal).catch(async error => {
          if (!activeSignal.aborted) await host.reportHealth({ coverage: 'unavailable', reason: error instanceof QQError ? error.code : 'QQ_GATEWAY_FAILED', checkedAt: new Date(this.now()).toISOString() });
        }).catch(() => {});
      }
    } catch (error) { this.active = undefined; throw error; }
  }
  async stop(): Promise<void> {
    const previous = this.active; this.gatewayController?.abort(); await this.gatewayTask;
    this.active = undefined; this.gatewayController = undefined; this.gatewayTask = undefined;
    if (previous) await previous.host.reportHealth({ coverage: 'unavailable', reason: 'QQ_SOURCE_STOPPED', checkedAt: new Date(this.now()).toISOString() }).catch(() => {});
  }
  async sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.active || this.active.host !== host) throw new QQError('QQ_SOURCE_NOT_STARTED', 'blocked');
    const checkpoint = await host.getCheckpoint();
    const observed = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) && checkpoint.kind === 'qq-webhook-v1' && checkpoint.observed === true;
    await host.reportHealth({ coverage: observed ? 'partial' : 'unknown', reason: observed ? coverageReason(checkpoint.observedEventType) : 'QQ_WAITING_FOR_AUTHENTICATED_CALLBACK', checkedAt: new Date(this.now()).toISOString() });
  }
  async probe(): Promise<ConnectorCapabilityV1> {
    const state = this.active;
    const result: ConnectorCapabilityV1 = { connection: 'push', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'QQ_NOT_STARTED' };
    if (!state) return result;
    try { await state.api.identity(state.signal); } catch { return { ...result, coverage: 'unavailable', reason: 'QQ_AUTH_PROBE_FAILED' }; }
    const cp = await state.host.getCheckpoint();
    const observed = cp && typeof cp === 'object' && !Array.isArray(cp) && cp.kind === 'qq-webhook-v1' && cp.observed === true;
    return { ...result, coverage: observed ? 'partial' : 'unknown', readMessages: Boolean(observed), reason: observed ? coverageReason(cp.observedEventType) : 'QQ_AUTHENTICATED_EVENT_PERMISSION_UNVERIFIED' };
  }
  private normalize(type: string, raw: unknown): NormalizedEventV1 | null {
    const state = this.active!;
    const group = ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type);
    const channel = ['AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'MESSAGE_DELETE', 'PUBLIC_MESSAGE_DELETE'].includes(type);
    const c2c = type === 'C2C_MESSAGE_CREATE';
    if (!(this.options.kind === 'group' && group || this.options.kind === 'channel' && channel || this.options.kind === 'c2c' && c2c)) return null;
    const data = object(raw);
    const deleted = type.endsWith('_DELETE');
    const message = deleted ? object(data.message) : data;
    const author = message.author ? object(message.author) : {};
    const scopeId = group ? message.group_openid : channel ? message.channel_id : author.user_openid;
    if (scopeId !== state.scopeId || author.bot === true) return null;
    const pseudonym = (kind: string, value: string) => `qq-${kind}-${createHmac('sha256', state.pseudonymKey).update(JSON.stringify([state.host.projectId, state.host.sourceId, kind, value])).digest('hex')}`;
    const ext = message.message_scene ? object(message.message_scene).ext : undefined;
    const index = Array.isArray(ext) ? ext.find((v): v is string => typeof v === 'string' && v.startsWith('msg_idx='))?.slice(8) : undefined;
    const reference = Array.isArray(ext) ? ext.find((v): v is string => typeof v === 'string' && v.startsWith('ref_msg_idx='))?.slice(12) : undefined;
    const externalId = pseudonym('message', channel ? text(message.id) : index || text(message.id));
    const time = deleted ? text(data.op_timestamp) : text(message.timestamp);
    if (!Number.isFinite(Date.parse(time)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) throw new QQError('QQ_INVALID_EVENT_TIME', 'rejected');
    const normalizedTime = new Date(time).toISOString();
    const actorId = author.member_openid ?? author.user_openid ?? author.id;
    const content = typeof message.content === 'string' ? message.content.replace(/<@!?([^>]+)>/g, (_match, id: string) => id === 'all' ? '<@all>' : `<@${pseudonym('actor', id)}>`): null;
    const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 20).map(value => {
      const a = object(value); const mime = typeof a.content_type === 'string' ? a.content_type : 'application/octet-stream';
      // Signed CDN URLs and auth_token are deliberately not copied to Core/LLM.
      return { kind: (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file') as 'image' | 'video' | 'file', mimeType: mime, assetRef: pseudonym('attachment', JSON.stringify([externalId, a.filename ?? '', a.url ?? ''])) };
    }) : [];
    const parent = reference ? pseudonym('message', reference) : undefined;
    return {
      specversion: '1.0', id: `${externalId}:${deleted ? 'deleted:' + normalizedTime : 'created'}`, source: this.options.sourceUri,
      type: deleted ? 'com.superagent.feedback.message.deleted.v1' : 'com.superagent.feedback.message.created.v1', time: normalizedTime, datacontenttype: 'application/json',
      data: { schemaVersion: '1.0', projectId: state.host.projectId, sourceId: state.host.sourceId, platform: 'qq-official',
        object: { kind: 'message', externalId, revision: deleted ? normalizedTime : 'original', ...(parent ? { parentExternalId: parent } : {}), threadExternalId: pseudonym('conversation', state.scopeId) },
        ...(typeof actorId === 'string' ? { actor: { opaqueId: pseudonym('actor', actorId), isBot: false } } : {}),
        ...(!deleted ? { content: { text: content, attachments } } : {}), attributes: { qqScope: this.options.kind, attachmentsOmitted: Array.isArray(message.attachments) && message.attachments.length > 20, structuredContentUnsupported: !deleted && message.message_type !== undefined && message.message_type !== 0 },
      },
    };
  }
  private async commitDispatch(payload: QQObject, gateway?: QQSession): Promise<void> {
    const state = this.active;
    if (!state || state.signal.aborted) throw new QQError('QQ_SOURCE_UNAVAILABLE');
    const event = this.normalize(String(payload.t), payload.d);
    const old = await state.host.getCheckpoint();
    const previous = old && typeof old === 'object' && !Array.isArray(old) ? old : {};
    state.signal.throwIfAborted();
    await state.host.commitBatch(event ? [event] : [], { sourceId: state.host.sourceId, cursor: {
      ...previous, kind: 'qq-webhook-v1', binding: state.binding,
      ...(event ? { observed: true, lastEventId: event.id, lastEventAt: event.time, lastCallbackAt: new Date(this.now()).toISOString(), observedEventType: String(payload.t) } : {}),
      ...(gateway ? { gateway: { sessionId: gateway.sessionId, seq: gateway.seq } } : {}),
    } });
    if (event) await state.host.reportHealth({ coverage: 'partial', reason: coverageReason(payload.t), checkedAt: new Date(this.now()).toISOString() }).catch(() => {});
  }
  async handleWebhook(headers: Record<string, string | undefined>, rawBody: Uint8Array): Promise<WebhookResponse> {
    const state = this.active;
    if (!state || state.signal.aborted) return { statusCode: 503, body: { error: 'QQ_SOURCE_UNAVAILABLE' } };
    if (this.options.transport === 'websocket') return { statusCode: 403, body: { error: 'QQ_WEBHOOK_DISABLED' } };
    if (rawBody.byteLength > 1_000_000) return { statusCode: 413, body: { error: 'QQ_BODY_LIMIT' } };
    if (headers['x-bot-appid'] !== state.appId) return { statusCode: 401, body: { error: 'QQ_APP_MISMATCH' } };
    let payload: QQObject;
    try { payload = object(JSON.parse(Buffer.from(rawBody).toString('utf8'))); } catch { return { statusCode: 400, body: { error: 'QQ_INVALID_JSON' } }; }
    if (payload.op === 13) {
      try {
        const d = object(payload.d); const plain = text(d.plain_token, 256); const ts = text(d.event_ts, 12);
        if (!/^\d+$/.test(ts) || Math.abs(this.now() - Number(ts) * 1000) > (this.options.maxClockSkewMs ?? 300_000)) throw new QQError('QQ_STALE_CHALLENGE');
        return { statusCode: 200, body: { plain_token: plain, signature: qqSignature(state.secret, ts, plain) } };
      } catch { return { statusCode: 400, body: { error: 'QQ_INVALID_CHALLENGE' } }; }
    }
    const ts = headers['x-signature-timestamp'] ?? '', signature = headers['x-signature-ed25519'] ?? '';
    if (!verifyQQSignature(state.secret, ts, rawBody, signature) || Math.abs(this.now() - Number(ts) * 1000) > (this.options.maxClockSkewMs ?? 300_000)) return { statusCode: 401, body: { error: 'QQ_SIGNATURE_INVALID' } };
    if (payload.op !== 0 || typeof payload.t !== 'string') return { statusCode: 400, body: { error: 'QQ_UNSUPPORTED_OPCODE' } };
    try {
      await this.commitDispatch(payload);
      return { statusCode: 200, body: { op: 12, d: 0 } };
    } catch (error) {
      return { statusCode: error instanceof QQError && error.outcome === 'rejected' ? 400 : 503, body: { error: error instanceof QQError ? error.code : 'QQ_COMMIT_FAILED' } };
    }
  }
}
