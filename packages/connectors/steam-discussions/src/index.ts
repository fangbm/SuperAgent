import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, FeedbackEventV1, JSONValue, PluginManifestV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';
import { PublicDiscussionsCollector, type PublicOptions } from './public.js';

export interface SteamDiscussionsConfig {
  sourceUri: string; appId: number; mode?: 'unavailable' | 'snapshot' | 'public'; snapshotPath?: string; pollIntervalMs?: number;
  forumIds?: string[]; requestIntervalMs?: number; maxRequestsPerSync?: number; rescanIntervalMs?: number;
}
export const steamDiscussionsConfigSchema = {
  type: 'object', additionalProperties: false, required: ['sourceUri', 'appId'],
  properties: { sourceUri: { type: 'string', format: 'uri' }, appId: { type: 'integer', minimum: 1, maximum: 4294967295 },
    mode: { enum: ['unavailable', 'snapshot', 'public'] }, snapshotPath: { type: 'string', minLength: 1 },
    pollIntervalMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
    forumIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: '^\\d{1,24}$' } },
    requestIntervalMs: { type: 'integer', minimum: 2000, maximum: 86400000 }, maxRequestsPerSync: { type: 'integer', minimum: 1, maximum: 25 },
    rescanIntervalMs: { type: 'integer', minimum: 2000, maximum: 31536000000 } },
  allOf: [{ if: { properties: { mode: { const: 'snapshot' } }, required: ['mode'] }, then: { required: ['snapshotPath'] } },
    { if: { properties: { mode: { const: 'public' } }, required: ['mode'] }, then: { properties: { pollIntervalMs: { type: 'integer', minimum: 2000 } } } }],
};
export interface DiscussionRecord {
  kind: 'thread' | 'comment'; id: string; threadId: string; parentCommentId?: string;
  title?: string; body?: string; authorId?: string; createdAt: string; updatedAt?: string; deletedAt?: string; permalink?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function record(input: unknown): DiscussionRecord {
  const fields = ['kind', 'id', 'threadId', 'parentCommentId', 'title', 'body', 'authorId', 'createdAt', 'updatedAt', 'deletedAt', 'permalink'];
  if (!object(input) || Object.keys(input).some(key => !fields.includes(key)) || !['thread', 'comment'].includes(String(input.kind))
    || typeof input.id !== 'string' || !/^\d+$/.test(input.id) || typeof input.threadId !== 'string' || !/^\d+$/.test(input.threadId)
    || !date(input.createdAt) || ['updatedAt', 'deletedAt'].some(key => input[key] !== undefined && (!date(input[key]) || Date.parse(String(input[key])) < Date.parse(String(input.createdAt))))) throw new Error('INVALID_EVENT: discussion record');
  for (const key of ['title', 'body', 'authorId', 'parentCommentId', 'permalink']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('INVALID_EVENT: discussion field');
  if (input.kind === 'thread' && (input.threadId !== input.id || typeof input.title !== 'string' || input.parentCommentId !== undefined)) throw new Error('INVALID_EVENT: thread relation');
  if (input.parentCommentId !== undefined && (!/^\d+$/.test(String(input.parentCommentId)) || input.parentCommentId === input.id)) throw new Error('INVALID_EVENT: reply relation');
  if (!input.deletedAt && typeof input.body !== 'string') throw new Error('INVALID_EVENT: missing body');
  if (input.deletedAt && input.updatedAt && Date.parse(String(input.deletedAt)) < Date.parse(String(input.updatedAt))) throw new Error('INVALID_EVENT: deletion precedes edit');
  if (input.permalink !== undefined) {
    const url = new URL(String(input.permalink));
    if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.username || url.password) throw new Error('INVALID_EVENT: permalink');
  }
  return input as unknown as DiscussionRecord;
}
export function normalizeDiscussion(input: unknown, config: SteamDiscussionsConfig, scope: { projectId: string; sourceId: string }): FeedbackEventV1 {
  const item = record(input);
  const revision = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  const action = item.deletedAt ? 'deleted' : item.updatedAt ? 'updated' : 'created';
  const externalId = item.kind + ':' + item.id;
  const data = { schemaVersion: '1.0' as const, projectId: scope.projectId, sourceId: scope.sourceId, platform: 'steam-discussions',
    object: { kind: item.kind, externalId, revision,
      threadExternalId: 'thread:' + item.threadId,
      ...(item.kind === 'comment' ? { parentExternalId: item.parentCommentId ? 'comment:' + item.parentCommentId : 'thread:' + item.threadId } : {}) },
    content: { text: item.deletedAt ? null : item.body! },
    ...(item.authorId ? { actor: { opaqueId: item.authorId } } : {}),
    ...(item.permalink ? { origin: { permalink: item.permalink } } : {}),
    attributes: { appId: config.appId, ingestionMode: 'operator-snapshot', title: item.title ?? null, createdAt: item.createdAt,
      updatedAt: item.updatedAt ?? null, deletedAt: item.deletedAt ?? null },
  };
  return { specversion: '1.0', id: externalId + ':' + revision, source: config.sourceUri,
    type: 'com.superagent.feedback.' + item.kind + '.' + action + '.v1',
    time: new Date(item.deletedAt ?? item.updatedAt ?? item.createdAt).toISOString(), datacontenttype: 'application/json', data } as FeedbackEventV1;
}

export class SteamDiscussionsConnector implements SourcePluginV1 {
  readonly manifest: PluginManifestV1;
  private readonly controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private readonly publicCollector?: PublicDiscussionsCollector;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly config: SteamDiscussionsConfig, options: PublicOptions = {}) {
    const injectedTiming = options.sleep !== undefined;
    new URL(config.sourceUri);
    if (Object.keys(config).some(key => !Object.hasOwn(steamDiscussionsConfigSchema.properties, key))
      || !Number.isInteger(config.appId) || config.appId < 1 || config.appId > 4294967295
      || (config.mode !== undefined && !['unavailable', 'snapshot', 'public'].includes(config.mode))
      || (config.snapshotPath !== undefined && (typeof config.snapshotPath !== 'string' || !config.snapshotPath.trim()))
      || (config.mode === 'snapshot' && !config.snapshotPath)
      || (config.pollIntervalMs !== undefined && (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < (config.mode === 'public' && !injectedTiming ? 2000 : 1) || config.pollIntervalMs > 86400000))
      || (config.forumIds !== undefined && (!Array.isArray(config.forumIds) || !config.forumIds.length || config.forumIds.length > 32 || new Set(config.forumIds).size !== config.forumIds.length || config.forumIds.some(id => !/^\d{1,24}$/.test(id))))
      || (config.requestIntervalMs !== undefined && (!Number.isInteger(config.requestIntervalMs) || config.requestIntervalMs < (injectedTiming ? 1 : 2000) || config.requestIntervalMs > 86400000))
      || (config.maxRequestsPerSync !== undefined && (!Number.isInteger(config.maxRequestsPerSync) || config.maxRequestsPerSync < 1 || config.maxRequestsPerSync > 25))
      || (config.rescanIntervalMs !== undefined && (!Number.isInteger(config.rescanIntervalMs) || config.rescanIntervalMs < (injectedTiming ? 1 : 2000) || config.rescanIntervalMs > 31536000000))) throw new Error('INVALID_CONFIG');
    this.pause = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    if (config.mode === 'public') this.publicCollector = new PublicDiscussionsCollector({ sourceUri: config.sourceUri, appId: config.appId,
      forumIds: config.forumIds ?? ['0'], pollIntervalMs: config.pollIntervalMs ?? 600000, requestIntervalMs: config.requestIntervalMs ?? 2000,
      maxRequestsPerSync: config.maxRequestsPerSync ?? 25, rescanIntervalMs: config.rescanIntervalMs ?? 86400000 }, options);
    this.manifest = { apiVersion: 'superagent.io/plugin/v1', id: 'superagent.steam-discussions', version: '0.1.0', displayName: config.mode === 'public' ? 'Steam Discussions' : 'Steam Discussions (snapshot fallback)', kind: 'source', engine: { sdk: '^0.1.0' },
      permissions: { networkHosts: config.mode === 'public' ? ['steamcommunity.com'] : [], secretKeys: [], eventPublish: true }, configSchema: steamDiscussionsConfigSchema };
  }
  private async records(signal: AbortSignal): Promise<DiscussionRecord[]> {
    signal.throwIfAborted();
    const filename = this.config.snapshotPath!;
    if ((await stat(filename)).size > 10485760) throw new Error('INVALID_EVENT: snapshot exceeds 10 MiB');
    let body: unknown;
    try { body = JSON.parse(await readFile(filename, { encoding: 'utf8', signal })); }
    catch { signal.throwIfAborted(); throw new Error('INVALID_EVENT: snapshot JSON unavailable or malformed'); }
    if (!object(body) || body.schemaVersion !== '1.0' || body.appId !== this.config.appId || !Array.isArray(body.records) || body.records.length > 10000
      || Object.keys(body).some(key => !['schemaVersion', 'appId', 'records'].includes(key))) throw new Error('INVALID_EVENT: snapshot envelope');
    const items = body.records.map(record);
    const keys = items.map(item => item.kind + ':' + item.id);
    if (new Set(keys).size !== keys.length) throw new Error('INVALID_EVENT: duplicate snapshot object');
    const threads = new Map(items.filter(item => item.kind === 'comment').map(item => [item.id, item.threadId]));
    for (const item of items) if (item.parentCommentId && threads.has(item.parentCommentId) && threads.get(item.parentCommentId) !== item.threadId) throw new Error('INVALID_EVENT: cross-thread parent');
    return items;
  }
  async probe(): Promise<ConnectorCapabilityV1> {
    if (this.publicCollector) {
      const job = this.tail.then(() => this.publicCollector!.probe(this.controller.signal));
      this.tail = job.then(() => {}, () => {});
      return job;
    }
    if (this.config.mode !== 'snapshot') return { connection: 'poll', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false,
      reason: 'No verified documented Steam Discussions read API; automatic collection is disabled; operator-provided snapshot is an explicit fallback' };
    try {
      await this.records(AbortSignal.timeout(10000));
      return { connection: 'poll', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: false,
        reason: 'Local operator snapshot only; no Steam API access or complete history verified; absence never implies deletion' };
    } catch { return { connection: 'poll', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'Snapshot unavailable or invalid' }; }
  }
  sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    const job = this.tail.then(async () => {
      const combined = AbortSignal.any([signal, this.controller.signal]);
      combined.throwIfAborted();
      if (this.config.mode !== 'snapshot') {
        if (this.publicCollector) {
          await this.publicCollector.sync(host, combined);
          return;
        }
        await host.reportHealth({ coverage: 'unavailable', reason: (await this.probe()).reason!, checkedAt: new Date().toISOString() }); return;
      }
      try {
        const records = await this.records(combined);
        const input = await host.getCheckpoint();
        const filename = resolve(this.config.snapshotPath!);
        if (input !== null && (!object(input) || input.version !== 1 || input.appId !== this.config.appId || input.snapshotPath !== filename
          || !object(input.revisions) || Object.entries(input.revisions).some(([id, revision]) => !/^(thread|comment):\d+$/.test(id) || typeof revision !== 'string'))) throw new Error('INVALID_CHECKPOINT');
        const revisions: Record<string, string> = input === null ? {} : { ...(input as { revisions: Record<string, string> }).revisions };
        const events: FeedbackEventV1[] = [];
        for (const item of records) {
          const event = normalizeDiscussion(item, this.config, host);
          if (revisions[event.data.object.externalId] !== event.data.object.revision) {
            if (revisions[event.data.object.externalId] && !item.updatedAt && !item.deletedAt) throw new Error('INVALID_EVENT: changed snapshot requires updatedAt');
            events.push(event); revisions[event.data.object.externalId] = event.data.object.revision;
          }
        }
        combined.throwIfAborted();
        await host.commitBatch(events, { sourceId: host.sourceId, cursor: { version: 1, appId: this.config.appId, snapshotPath: filename, revisions } });
        await host.reportHealth({ coverage: 'partial', reason: 'Operator snapshot committed; remote coverage unknown; missing objects and intermediate edits cannot be recovered', checkedAt: new Date().toISOString() });
      } catch (error) {
        if (!combined.aborted) await host.reportHealth({ coverage: 'unavailable', reason: 'Snapshot sync failed; committed checkpoint retained', checkedAt: new Date().toISOString() });
        throw error;
      }
    });
    this.tail = job.catch(() => {}); return job;
  }
  async start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    try {
      if (this.publicCollector) {
        while (!combined.aborted) {
          try { await this.sync(host, combined); }
          catch (error) {
            if (combined.aborted) break;
            if (error instanceof Error && /^(INVALID_CHECKPOINT|INVALID_CONFIG|REQUEST_URL_REJECTED)/.test(error.message)) throw error;
            await this.pause(this.config.pollIntervalMs ?? 600000, combined);
            continue;
          }
          await this.pause(this.config.pollIntervalMs ?? 600000, combined);
        }
        return;
      }
      do {
        await this.sync(host, combined);
        if (this.config.mode !== 'snapshot' && this.config.mode !== 'public') return;
        await this.pause(this.config.pollIntervalMs ?? (this.config.mode === 'public' ? 600000 : 60000), combined);
      } while (!combined.aborted);
    } catch (error) { if (!combined.aborted) throw error; }
  }
  async stop(): Promise<void> { this.controller.abort(); await this.tail; }
}
