import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, FeedbackEventV1, JSONValue, SourcePluginHostV1 } from '@superagent/plugin-sdk';

const { parseHTML } = createRequire(import.meta.url)('linkedom') as { parseHTML(html: string): { document: Document } };

export interface PublicConfig {
  sourceUri: string; appId: number; forumIds: string[]; pollIntervalMs: number; requestIntervalMs: number;
  maxRequestsPerSync: number; rescanIntervalMs: number;
}
export interface PublicOptions { fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; clock?: () => Date; passiveProbe?: boolean }
type Forum = { owner: string; type: string; feature: string; gidforum: string; appid: number };
type Topic = { forumId: string; gid: string; revision?: string; lastChecked?: number; retryAt?: number; gap?: string; start: number; total: number; activityHash?: string; refreshThread?: boolean; extendedData?: string; commentOwner?: string; commentFeature?: string };
type State = { version: 2; mode: 'public'; appId: number; sourceUri: string; forumIds: string[]; forums: Record<string, Forum>; topics: Record<string, Topic>; comments: Record<string, { revision?: string; count?: number }>;
  phase: 'head' | 'lists' | 'topics'; topicQueue: string[]; headForumIndex: number; backgroundForumIndex: number; backgroundStart: number; backgroundActive: boolean; backgroundDueAt: number;
  turn: 'head' | 'backfill'; backfillTurn: 'list' | 'topics'; headError?: string; listError?: string; retryAfter?: number };
type RequestBudget = { used: number; limit: number };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digits = (value: unknown): value is string => typeof value === 'string' && /^\d{1,24}$/.test(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (seconds: string | undefined): string | null => seconds && /^\d{1,12}$/.test(seconds) && Number(seconds) > 0
  ? new Date(Number(seconds) * 1000).toISOString() : null;
function jsonAfterCall(html: string, name: string): unknown {
  const at = html.indexOf(name + '('); if (at < 0) throw new Error('INVALID_EVENT: missing ' + name);
  let start = -1, depth = 0, quote = '', escaped = false;
  for (let i = at + name.length + 1; i < html.length; i++) {
    const c = html[i]!;
    if (start < 0) { if (c === '{') { start = i; depth = 1; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { throw new Error('INVALID_EVENT: initialization JSON'); } }
  }
  throw new Error('INVALID_EVENT: incomplete ' + name);
}
function document(html: string) { return parseHTML('<html><body>' + html + '</body></html>').document; }
function plainText(root: Element): string {
  const blocks = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element; const tag = element.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
    if (['SCRIPT', 'STYLE', 'IFRAME', 'FORM', 'INPUT', 'BUTTON'].includes(tag)) return '';
    const value = Array.from(element.childNodes).map(walk).join('');
    return blocks.has(tag) ? value + '\n' : value;
  };
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function safeLink(value: string, appId: number, forumId?: string, topicId?: string): string {
  let url: URL; try { url = new URL(value, 'https://steamcommunity.com'); } catch { throw new Error('INVALID_EVENT: permalink'); }
  if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.username || url.password || !url.pathname.startsWith('/app/' + appId + '/discussions/')) throw new Error('INVALID_EVENT: permalink host/app');
  if (forumId && !url.pathname.startsWith('/app/' + appId + '/discussions/' + forumId + '/')) throw new Error('INVALID_EVENT: permalink forum');
  if (topicId && !url.pathname.includes('/' + topicId + '/')) throw new Error('INVALID_EVENT: permalink topic');
  return url.href;
}
function stateFrom(raw: JSONValue | null, config: PublicConfig, now: number): State {
  if (raw === null) return { version: 2, mode: 'public', appId: config.appId, sourceUri: config.sourceUri, forumIds: [...config.forumIds], forums: {}, topics: {}, comments: {}, phase: 'head', topicQueue: [], headForumIndex: 0,
    backgroundForumIndex: 0, backgroundStart: 0, backgroundActive: true, backgroundDueAt: 0, turn: 'head', backfillTurn: 'list' };
  if (!object(raw)) throw new Error('INVALID_CHECKPOINT');
  let input: Record<string, unknown> = raw;
  if (input.version === 1 && input.mode === 'public') {
    if (input.appId !== config.appId || input.sourceUri !== config.sourceUri || JSON.stringify(input.forumIds) !== JSON.stringify(config.forumIds)
      || !object(input.forums) || !object(input.topics) || (input.comments !== undefined && !object(input.comments)) || !['head', 'lists', 'topics'].includes(String(input.phase))
      || !Array.isArray(input.topicQueue)) throw new Error('INVALID_CHECKPOINT');
    const phase = input.phase;
    const topics = structuredClone(input.topics);
    for (const topic of Object.values(topics)) if (object(topic) && topic.extendedData !== undefined && (!topic.commentOwner || !topic.commentFeature)) {
      // Re-fetch old initialization metadata while preserving the committed reply offset and revisions.
      delete topic.extendedData;
    }
    input = { version: 2, mode: 'public', appId: input.appId, sourceUri: input.sourceUri, forumIds: input.forumIds, forums: input.forums, topics: input.topics, comments: input.comments ?? {},
      phase: phase === 'lists' ? 'lists' : phase === 'topics' ? 'topics' : 'head', topicQueue: input.topicQueue, headForumIndex: input.headForumIndex ?? 0,
      backgroundForumIndex: phase === 'lists' ? input.forumIndex ?? 0 : 0, backgroundStart: phase === 'lists' ? input.listStart ?? 0 : 0,
      backgroundActive: phase !== 'topics', backgroundDueAt: phase === 'topics' ? now + config.rescanIntervalMs : 0, turn: 'head', backfillTurn: 'list' };
    input.topics = topics;
  }
  if (input.version !== 2 || input.mode !== 'public' || input.appId !== config.appId || input.sourceUri !== config.sourceUri || JSON.stringify(input.forumIds) !== JSON.stringify(config.forumIds)
    || !object(input.forums) || !object(input.topics) || !object(input.comments) || !['head', 'lists', 'topics'].includes(String(input.phase))
    || !Array.isArray(input.topicQueue) || input.topicQueue.some(id => typeof id !== 'string' || !digits(id))
    || !Number.isSafeInteger(input.headForumIndex) || Number(input.headForumIndex) < 0 || Number(input.headForumIndex) >= config.forumIds.length
    || !Number.isSafeInteger(input.backgroundForumIndex) || Number(input.backgroundForumIndex) < 0 || Number(input.backgroundForumIndex) > config.forumIds.length
    || !Number.isSafeInteger(input.backgroundStart) || Number(input.backgroundStart) < 0 || typeof input.backgroundActive !== 'boolean'
    || !Number.isSafeInteger(input.backgroundDueAt) || Number(input.backgroundDueAt) < 0 || !['head', 'backfill'].includes(String(input.turn))
    || !['list', 'topics'].includes(String(input.backfillTurn)) || (input.headError !== undefined && typeof input.headError !== 'string') || (input.listError !== undefined && typeof input.listError !== 'string')
    || (input.retryAfter !== undefined && (!Number.isSafeInteger(input.retryAfter) || Number(input.retryAfter) < 0))) throw new Error('INVALID_CHECKPOINT');
  const stateKeys = ['version', 'mode', 'appId', 'sourceUri', 'forumIds', 'forums', 'topics', 'comments', 'phase', 'topicQueue', 'headForumIndex', 'backgroundForumIndex', 'backgroundStart', 'backgroundActive', 'backgroundDueAt', 'turn', 'backfillTurn', 'headError', 'listError', 'retryAfter'];
  if (Object.keys(input).some(key => !stateKeys.includes(key))) throw new Error('INVALID_CHECKPOINT');
  for (const [id, topic] of Object.entries(input.topics)) if (!digits(id) || !object(topic) || typeof topic.forumId !== 'string' || !config.forumIds.includes(topic.forumId)
    || topic.gid !== id || !Number.isSafeInteger(topic.start) || Number(topic.start) < 0 || !Number.isSafeInteger(topic.total) || Number(topic.total) < 0
    || (topic.revision !== undefined && (typeof topic.revision !== 'string' || !/^\d+:[a-f0-9]{64}$/.test(topic.revision)))
    || (topic.lastChecked !== undefined && (!Number.isSafeInteger(topic.lastChecked) || Number(topic.lastChecked) < 0))
    || (topic.retryAt !== undefined && (!Number.isSafeInteger(topic.retryAt) || Number(topic.retryAt) < 0)) || (topic.gap !== undefined && typeof topic.gap !== 'string')
    || (topic.activityHash !== undefined && (typeof topic.activityHash !== 'string' || !/^[a-f0-9]{64}$/.test(topic.activityHash)))
    || (topic.refreshThread !== undefined && typeof topic.refreshThread !== 'boolean')
    || (topic.extendedData !== undefined && typeof topic.extendedData !== 'string') || (topic.commentOwner !== undefined && !digits(topic.commentOwner))
    || (topic.commentFeature !== undefined && !digits(topic.commentFeature))
    || Object.keys(topic).some(key => !['forumId', 'gid', 'revision', 'lastChecked', 'retryAt', 'gap', 'start', 'total', 'activityHash', 'refreshThread', 'extendedData', 'commentOwner', 'commentFeature'].includes(key))
    || (topic.extendedData !== undefined) !== (topic.commentOwner !== undefined && topic.commentFeature !== undefined)
    || (topic.gap !== undefined && topic.retryAt === undefined)) throw new Error('INVALID_CHECKPOINT');
  for (const [id, forum] of Object.entries(input.forums)) if (!config.forumIds.includes(id) || !object(forum) || !digits(forum.owner) || !digits(forum.gidforum)
    || Object.keys(forum).some(key => !['owner', 'type', 'feature', 'gidforum', 'appid'].includes(key))
    || forum.feature !== id || !['General', 'Trading', 'Screenshots', 'Artwork', 'Videos', 'Workshop', 'Guides', 'Greenlight'].includes(String(forum.type)) || forum.appid !== config.appId) throw new Error('INVALID_CHECKPOINT');
  if (input.topicQueue.some(id => typeof id !== 'string' || !Object.hasOwn(input.topics as Record<string, unknown>, id)) || new Set(input.topicQueue).size !== input.topicQueue.length) throw new Error('INVALID_CHECKPOINT');
  if (input.comments !== undefined) for (const [key, value] of Object.entries(input.comments)) if (!/^\d{1,24}:\d{1,24}$/.test(key) || !object(value)
    || (value.revision !== undefined && (typeof value.revision !== 'string' || !/^\d+:[a-f0-9]{64}$/.test(value.revision)))
    || (value.count !== undefined && (!Number.isSafeInteger(value.count) || Number(value.count) < 1))) throw new Error('INVALID_CHECKPOINT');
  return { comments: {}, ...structuredClone(input) } as unknown as State;
}
function event(config: PublicConfig, host: SourcePluginHostV1, externalId: string, kind: 'thread' | 'comment', action: 'created' | 'updated', revision: string, createdAt: string | null,
  body: string, html: string, observed: Date, permalink: string, authorId?: string, parentId?: string, title?: string): FeedbackEventV1 {
  const comment = kind === 'comment';
  const data = { schemaVersion: '1.0' as const, projectId: host.projectId, sourceId: host.sourceId, platform: 'steam-discussions',
    object: { kind, externalId, revision, threadExternalId: 'thread:' + (comment ? externalId.split(':')[1] : externalId.split(':')[1]),
      ...(comment ? { parentExternalId: parentId ? 'comment:' + externalId.split(':')[1] + ':' + parentId : 'thread:' + externalId.split(':')[1] } : {}) },
    content: { text: body }, ...(authorId ? { actor: { opaqueId: authorId } } : {}), origin: { permalink },
    attributes: { appId: config.appId, title: title ?? null, createdAt, observedAt: observed.toISOString(), nativeHtml: html } };
  return { specversion: '1.0', id: externalId + ':' + revision, source: config.sourceUri,
    type: 'com.superagent.feedback.' + kind + '.' + action + '.v1', time: observed.toISOString(), datacontenttype: 'application/json', data } as FeedbackEventV1;
}

export class PublicDiscussionsCollector {
  private readonly fetcher: typeof fetch;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  private lastRequestAt: number | undefined;
  private deferUntil = 0;
  private readonly passiveProbe: boolean;
  private capability: ConnectorCapabilityV1 = { connection: 'poll', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'Public forum access not yet verified through a bound Host' };
  constructor(private readonly config: PublicConfig, options: PublicOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.pause = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }); this.now = options.clock ?? (() => new Date()); this.passiveProbe = options.passiveProbe === true;
  }
  private async request(url: URL, signal: AbortSignal, budget: RequestBudget): Promise<string> {
    if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.username || url.password
      || !new RegExp('^/app/' + this.config.appId + '/discussions/\\d{1,24}/?$').test(url.pathname)
        && !new RegExp('^/app/' + this.config.appId + '/discussions/\\d{1,24}/\\d{1,24}/?$').test(url.pathname)
        && !/^\/forum\/\d{1,24}\/[A-Za-z]+\/render\/\d{1,24}\/$/.test(url.pathname)
        && !/^\/comment\/ForumTopic\/render\/\d{1,24}\/\d{1,24}\/$/.test(url.pathname)) throw new Error('REQUEST_URL_REJECTED: ' + url.pathname);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted(); if (budget.used >= budget.limit) throw new Error('REQUEST_BUDGET');
      // A second request in the same sync must not sleep across a 429 deadline:
      // surface the cooldown immediately so sync() can persist it atomically.
      if (this.deferUntil > this.now().getTime()) throw new Error('RATE_LIMITED');
      if (this.lastRequestAt !== undefined) await this.pause(Math.max(0, this.lastRequestAt + this.config.requestIntervalMs - this.now().getTime()), signal);
      budget.used++;
      this.lastRequestAt = this.now().getTime();
      let response: Response;
      try { response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error' }); }
      catch { signal.throwIfAborted(); if (attempt >= 3) throw new Error('TRANSIENT_NETWORK'); await this.pause(1000 * 2 ** attempt, signal); continue; }
      if (response.status === 429 || response.status >= 500) {
        const header = response.headers.get('retry-after'); await response.body?.cancel();
        const seconds = header === null ? NaN : Number(header); const dateWait = header && !Number.isFinite(seconds) ? Date.parse(header) - this.now().getTime() : 0;
        const wait = Math.max(this.config.requestIntervalMs, 1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateWait) ? dateWait : 0);
        if (response.status === 429) {
          // Do not let Retry-After sleep overrun probe timeout; sync() commits
          // the cooldown so a fresh supervised instance cannot probe early.
          this.deferUntil = Math.max(this.deferUntil, this.now().getTime() + wait);
          throw new Error('RATE_LIMITED');
        }
        if (attempt >= 3) throw new Error('PLATFORM_UNAVAILABLE');
        await this.pause(wait, signal); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : response.status === 404 ? 'UNAVAILABLE_OR_PRIVATE' : 'PLATFORM_UNAVAILABLE'); }
      this.deferUntil = 0;
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > 5 * 1024 * 1024) { await response.body?.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
      if (!response.body) return '';
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const output = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(output);
    }
  }
  async probe(stopSignal?: AbortSignal): Promise<ConnectorCapabilityV1> {
    if (this.passiveProbe) return { ...this.capability };
    const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(stopSignal ? [stopSignal] : [])]); const budget = { used: 0, limit: this.config.maxRequestsPerSync };
    try {
      if (this.deferUntil > this.now().getTime()) throw new Error('RATE_LIMITED');
      const html = await this.request(new URL('https://steamcommunity.com/app/' + this.config.appId + '/discussions/' + this.config.forumIds[0] + '/'), signal, budget);
      this.forum(html, this.config.forumIds[0]!);
      return { connection: 'poll', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: false, reason: 'Anonymous public Steam Discussions pages only; private topics, deletions and intermediate edits are unavailable' };
    } catch (error) { return { connection: 'poll', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: error instanceof Error ? error.message : 'PLATFORM_UNAVAILABLE' }; }
  }
  private forum(html: string, id: string): Forum {
    const value = jsonAfterCall(html, 'InitializeForum');
    if (!object(value) || value.feature !== id || !digits(value.owner) || !digits(value.gidforum) || value.appid !== this.config.appId
      || !['General', 'Trading', 'Screenshots', 'Artwork', 'Videos', 'Workshop', 'Guides', 'Greenlight'].includes(String(value.type))) throw new Error('INVALID_EVENT: forum initialization does not match app/forum');
    return { owner: value.owner, type: value.type as string, feature: id, gidforum: value.gidforum, appid: this.config.appId };
  }
  private topicPage(html: string, appId: number, forumId: string, start: number): { total: number; topics: Array<{ id: string; href: string; activityHash: string }> } {
    let body: unknown; try { body = JSON.parse(html); } catch { throw new Error('INVALID_EVENT: forum page JSON'); }
    if (!object(body) || body.success !== 1 || body.start !== start || !Number.isSafeInteger(body.start) || !Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0 || typeof body.topics_html !== 'string') throw new Error('INVALID_EVENT: forum page shape');
    const doc = document(body.topics_html); const topics = Array.from(doc.querySelectorAll('a.forum_topic_overlay')).map(a => {
      const id = a.getAttribute('data-gidforumtopic') ?? a.closest('[data-gidforumtopic]')?.getAttribute('data-gidforumtopic');
      if (!digits(id)) throw new Error('INVALID_EVENT: topic id');
      const row = a.closest('.forum_topic') ?? a.closest('[data-gidforumtopic]') ?? a.parentElement ?? a;
      const title = row.querySelector('.forum_topic_name')?.textContent?.trim() || a.getAttribute('title')?.trim() || a.textContent?.trim() || '';
      const replies = row.querySelector('.forum_topic_reply_count')?.textContent?.trim() ?? null;
      return { id, href: safeLink(a.getAttribute('href') ?? '', appId, forumId, id), activityHash: hash({ title, replies }) };
    });
    if (new Set(topics.map(topic => topic.id)).size !== topics.length) throw new Error('INVALID_EVENT: duplicate topic id');
    const expected = Math.max(0, Math.min(15, Number(body.total_count) - start));
    if (topics.length !== expected) throw new Error('INVALID_EVENT: incomplete topic page');
    if (topics.length === 0 && Number(body.start) < Number(body.total_count)) throw new Error('INVALID_EVENT: empty topic page');
    return { total: Number(body.total_count), topics };
  }
  private observeTopics(state: State, forumId: string, items: Array<{ id: string; activityHash: string }>, now: number, refreshQuiet = false, prioritize = true): void {
    for (const item of items) {
      const topic = state.topics[item.id] ??= { forumId, gid: item.id, start: 0, total: 0 };
      const changed = topic.activityHash !== item.activityHash;
      topic.activityHash = item.activityHash;
      const due = topic.retryAt !== undefined ? topic.retryAt <= now : !topic.lastChecked || now - topic.lastChecked >= this.config.rescanIntervalMs;
      if (changed || (refreshQuiet && due)) {
        if (changed && (topic.extendedData || topic.refreshThread)) topic.refreshThread = true;
        else if (refreshQuiet && due && topic.extendedData) topic.refreshThread = true;
        if (topic.retryAt && topic.retryAt > now && !changed) continue;
        delete topic.retryAt; delete topic.gap;
        this.enqueue(state, item.id, prioritize);
      } else if (due && (!topic.retryAt || topic.retryAt <= now) && !state.topicQueue.includes(item.id)) state.topicQueue.push(item.id);
    }
  }
  private enqueue(state: State, id: string, front = false): void {
    const current = state.topicQueue.indexOf(id);
    if (current >= 0) { if (!front) return; state.topicQueue.splice(current, 1); }
    if (front) state.topicQueue.unshift(id); else state.topicQueue.push(id);
  }
  private async ensureForum(state: State, id: string, host: SourcePluginHostV1, signal: AbortSignal, budget: RequestBudget): Promise<void> {
    if (state.forums[id]) return;
    const html = await this.request(new URL(`https://steamcommunity.com/app/${this.config.appId}/discussions/${id}/`), signal, budget);
    state.forums[id] = this.forum(html, id);
    await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
  }
  private advanceBackground(state: State, total: number): void {
    if (state.backgroundStart + 15 < total) state.backgroundStart += 15;
    else { state.backgroundForumIndex++; state.backgroundStart = 0; }
    if (state.backgroundForumIndex >= this.config.forumIds.length) {
      state.backgroundActive = false; state.backgroundForumIndex = 0; state.backgroundDueAt = this.now().getTime() + this.config.rescanIntervalMs;
    }
  }
  private async backgroundPage(state: State, host: SourcePluginHostV1, signal: AbortSignal, budget: RequestBudget): Promise<boolean> {
    if (!state.backgroundActive) return false;
    const forumId = this.config.forumIds[state.backgroundForumIndex]; if (!forumId) throw new Error('INVALID_CHECKPOINT');
    await this.ensureForum(state, forumId, host, signal, budget);
    const forum = state.forums[forumId]!;
    const url = new URL(`https://steamcommunity.com/forum/${forum.owner}/${forum.type}/render/${forum.feature}/`);
    url.searchParams.set('start', String(state.backgroundStart)); url.searchParams.set('count', '15');
    const page = this.topicPage(await this.request(url, signal, budget), this.config.appId, forumId, state.backgroundStart);
    this.observeTopics(state, forumId, page.topics, this.now().getTime(), true, false);
    this.advanceBackground(state, page.total); delete state.listError;
    await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
    return true;
  }
  private async processOneTopic(state: State, host: SourcePluginHostV1, signal: AbortSignal, budget: RequestBudget): Promise<boolean> {
    const gid = state.topicQueue[0]; if (!gid) return false;
    const topic = state.topics[gid]!; const forum = state.forums[topic.forumId]!;
    if (!topic.extendedData || topic.refreshThread) {
      const url = new URL(`https://steamcommunity.com/app/${this.config.appId}/discussions/${topic.forumId}/${gid}/`);
      let parsed: ReturnType<PublicDiscussionsCollector['parseTopic']>;
      try { parsed = this.parseTopic(await this.request(url, signal, budget), this.config.appId, topic.forumId, gid, forum); }
      catch (error) {
        if (!this.isTopicGap(error)) throw error;
        topic.gap = error instanceof Error ? error.message : 'TOPIC_UNAVAILABLE'; topic.lastChecked = this.now().getTime(); topic.retryAt = topic.lastChecked + this.config.pollIntervalMs; state.topicQueue.shift();
        await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue }); return true;
      }
      topic.extendedData = parsed.extended; topic.commentOwner = parsed.owner; topic.commentFeature = parsed.feature;
      topic.total = parsed.replies; delete topic.refreshThread;
      const revision = hash({ title: parsed.title, body: parsed.body, html: parsed.html, author: parsed.author ?? null });
      const previous = topic.revision; const seq = Number(previous?.split(':')[0] ?? 0) + (previous?.split(':')[1] === revision ? 0 : 1);
      if (!previous || previous.split(':')[1] !== revision) {
        const rev = seq + ':' + revision; const item = event(this.config, host, 'thread:' + gid, 'thread', previous ? 'updated' : 'created', rev, parsed.created, parsed.body, parsed.html, this.now(), parsed.permalink, parsed.author, undefined, parsed.title);
        topic.revision = rev; await host.commitBatch([item], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
      } else await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
      return true;
    }
    const url = new URL(`https://steamcommunity.com/comment/ForumTopic/render/${topic.commentOwner}/${topic.commentFeature}/`);
    url.searchParams.set('feature2', gid); url.searchParams.set('start', String(topic.start)); url.searchParams.set('count', '15'); url.searchParams.set('oldestfirst', 'true'); url.searchParams.set('extended_data', topic.extendedData);
    let page: ReturnType<PublicDiscussionsCollector['replies']>;
    try { page = this.replies(await this.request(url, signal, budget), topic.start, topic); }
    catch (error) {
      if (!this.isTopicGap(error)) throw error;
      topic.gap = error instanceof Error ? error.message : 'TOPIC_UNAVAILABLE'; topic.lastChecked = this.now().getTime(); topic.retryAt = topic.lastChecked + this.config.pollIntervalMs; state.topicQueue.shift();
      await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue }); return true;
    }
    const events: FeedbackEventV1[] = []; const seenIds = new Set<string>();
    for (const item of page.comments) {
      if (seenIds.has(item.id)) throw new Error('INVALID_EVENT: duplicate reply id'); seenIds.add(item.id);
      const id = 'comment:' + gid + ':' + item.id; const revision = hash({ body: item.body, html: item.html, author: item.author ?? null, parent: item.parent ?? null });
      const previous = state.comments[gid + ':' + item.id]?.revision; const seq = Number(previous?.split(':')[0] ?? 0) + (previous?.split(':')[1] === revision ? 0 : 1);
      if (!previous || previous.split(':')[1] !== revision) {
        const rev = seq + ':' + revision; const parent = item.parent;
        events.push(event(this.config, host, id, 'comment', previous ? 'updated' : 'created', rev, iso(item.timestamp), item.body, item.html, this.now(), safeLink(`https://steamcommunity.com/app/${this.config.appId}/discussions/${topic.forumId}/${gid}/#c${item.id}`, this.config.appId, topic.forumId, gid), item.author, parent));
        state.comments[gid + ':' + item.id] = { revision: rev, count: seq };
      }
    }
    topic.total = page.total;
    if (topic.start + 15 < page.total) topic.start += 15;
    else { topic.start = 0; topic.lastChecked = this.now().getTime(); delete topic.retryAt; delete topic.gap; delete topic.extendedData; delete topic.commentOwner; delete topic.commentFeature; }
    if (topic.start === 0) state.topicQueue.shift();
    await host.commitBatch(events, { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
    return true;
  }
  private parseTopic(html: string, appId: number, forumId: string, gid: string, forum: Forum): { title: string; body: string; html: string; author?: string; created: string | null; extended: string; replies: number; owner: string; feature: string; permalink: string } {
    const doc = document(html); const op = doc.querySelector('.forum_op'); if (!op) throw new Error('UNAVAILABLE_OR_PRIVATE');
    const title = doc.querySelector('.forum_topic_name, .forum_op .title, .forum_topic_header')?.textContent?.trim() ?? '';
    const content = op.querySelector('.content'); if (!content || !title) throw new Error('INVALID_EVENT: topic content/title');
    const init = jsonAfterCall(html, 'InitializeCommentThread');
    if (!object(init) || init.feature2 !== gid || !digits(init.owner) || init.feature !== forum.gidforum || !Number.isSafeInteger(init.total_count) || Number(init.total_count) < 0 || typeof init.extended_data !== 'string') throw new Error('INVALID_EVENT: topic thread initialization');
    let extended: unknown; try { extended = JSON.parse(init.extended_data); } catch { throw new Error('INVALID_EVENT: topic extended data'); }
    if (!object(extended) || extended.forum_appid !== appId || extended.forum_public !== 1 || extended.forum_type !== forum.type || extended.forum_gidfeature !== forumId
      || !object(extended.topic_permissions) || extended.topic_permissions.can_view !== 1) throw new Error('UNAVAILABLE_OR_PRIVATE');
    const timestamp = op.querySelector('[data-timestamp]')?.getAttribute('data-timestamp') ?? undefined;
    const author = op.querySelector('a[href*="/profiles/"]')?.getAttribute('data-miniprofile') ?? op.querySelector('a[href*="/profiles/"]')?.getAttribute('href')?.match(/\/profiles\/(\d+)/)?.[1];
    return { title, body: plainText(content), html: content.innerHTML, ...(author && digits(author) ? { author } : {}), created: iso(timestamp), extended: init.extended_data,
      replies: Number(init.total_count), owner: init.owner, feature: init.feature, permalink: safeLink('https://steamcommunity.com/app/' + appId + '/discussions/' + forumId + '/' + gid + '/', appId, forumId, gid) };
  }
  private replies(html: string, start: number, topic: Topic): { total: number; comments: Array<{ id: string; body: string; html: string; timestamp?: string; author?: string; parent?: string }> } {
    let value: unknown; try { value = JSON.parse(html); } catch { throw new Error('INVALID_EVENT: reply page JSON'); }
    if (!object(value) || value.success !== true || value.start !== start || !Number.isSafeInteger(value.total_count) || Number(value.total_count) < 0 || typeof value.comments_html !== 'string') throw new Error(object(value) && value.success === false ? 'UNAVAILABLE_OR_PRIVATE' : 'INVALID_EVENT: reply page shape');
    const doc = document(value.comments_html); const comments = Array.from(doc.querySelectorAll('.commentthread_comment')).map(row => {
      const nativeId = row.getAttribute('id')?.match(/^comment_(\d+)$/)?.[1]; const content = row.querySelector('.commentthread_comment_text');
      if (!digits(nativeId) || !content) throw new Error('INVALID_EVENT: reply row');
      const author = row.querySelector('[data-miniprofile]')?.getAttribute('data-miniprofile') ?? undefined;
      const parent = row.getAttribute('data-parentcommentid')?.replace(/^comment_/, '') ?? undefined;
      const timestamp = row.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
      return { id: nativeId, body: plainText(content), html: content.innerHTML, ...(timestamp ? { timestamp } : {}),
        ...(author && digits(author) ? { author } : {}), ...(parent && digits(parent) ? { parent } : {}) };
    });
    if (comments.length > 15) throw new Error('INVALID_EVENT: oversized reply page');
    if (comments.length === 0 && start < Number(value.total_count)) throw new Error('INVALID_EVENT: empty reply page');
    const expected = Math.max(0, Math.min(15, Number(value.total_count) - start));
    if (comments.length !== expected) throw new Error('INVALID_EVENT: incomplete reply page');
    if (new Set(comments.map(comment => comment.id)).size !== comments.length) throw new Error('INVALID_EVENT: duplicate reply id');
    return { total: Number(value.total_count), comments };
  }
  private async report(host: SourcePluginHostV1, state: State, reason: string, coverage: 'partial' | 'unavailable' = 'partial'): Promise<void> {
    const gaps = Object.entries(state.topics).filter(([, topic]) => topic.gap).map(([id, topic]) => `${id}:${topic.gap}`);
    const pending = Object.values(state.topics).filter(topic => !topic.lastChecked || this.now().getTime() - topic.lastChecked >= this.config.rescanIntervalMs).length;
    const details = [reason, `phase=${state.phase}`, `pendingTopics=${pending}`, `queuedTopics=${state.topicQueue.length}`, `retryableGaps=${gaps.length}`];
    if (state.headError) details.push(`headError=${state.headError}`);
    if (state.listError) details.push(`listError=${state.listError}`);
    if (gaps.length) details.push(`gaps=${gaps.slice(0, 5).join(';')}`);
    if (gaps.length > 5) details.push(`additionalGaps=${gaps.length - 5}`);
    const message = details.join(' ');
    this.capability = { connection: 'poll', coverage, readMessages: coverage === 'partial', readHistory: coverage === 'partial', readEdits: coverage === 'partial', readAttachments: false, reason: message };
    await host.reportHealth({ coverage, reason: message, checkedAt: this.now().toISOString() });
  }
  async sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); const state = stateFrom(await host.getCheckpoint(), this.config, this.now().getTime());
    this.deferUntil = Math.max(this.deferUntil, state.retryAfter ?? 0);
    if (this.deferUntil > this.now().getTime()) {
      await this.report(host, state, 'RATE_LIMITED: collection deferred until ' + new Date(this.deferUntil).toISOString(), 'unavailable'); return;
    }
    delete state.retryAfter;
    const budget: RequestBudget = { used: 0, limit: this.config.maxRequestsPerSync }; const max = this.config.maxRequestsPerSync;
    const checkpoint = () => host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
    const listWork = async (limit: number): Promise<boolean> => {
      if (!state.backgroundActive) return false;
      budget.limit = limit;
      try { return await this.backgroundPage(state, host, signal, budget); }
      catch (error) {
        if (!this.isHeadFailure(error)) throw error;
        state.listError = error instanceof Error ? error.message : 'LIST_REFRESH_FAILED';
        await checkpoint(); return false;
      }
    };
    const summary = (reason: string) => {
      const error = state.headError ? ` headRefresh=${state.headError}` : '';
      const listError = state.listError ? ` backgroundList=${state.listError}` : '';
      return this.report(host, state, reason + error + listError,
        Object.keys(state.topics).length === 0 && /^(PERMISSION_DENIED|UNAVAILABLE_OR_PRIVATE|INVALID_EVENT:)/.test(state.headError ?? state.listError ?? '') ? 'unavailable' : 'partial');
    };
    try {
      const now = this.now().getTime();
      if (!state.backgroundActive && state.backgroundDueAt <= now) {
        state.backgroundActive = true; state.backgroundForumIndex = 0; state.backgroundStart = 0; state.phase = 'lists';
        for (const topic of Object.values(state.topics)) if ((!topic.retryAt || topic.retryAt <= now) && (!topic.lastChecked || now - topic.lastChecked >= this.config.rescanIntervalMs)) {
          if (topic.extendedData) topic.refreshThread = true;
          this.enqueue(state, topic.gid);
        }
        await checkpoint();
      }
      for (const topic of Object.values(state.topics)) if (topic.retryAt !== undefined && topic.retryAt <= now) {
        delete topic.retryAt; delete topic.gap; if (topic.extendedData) topic.refreshThread = true; this.enqueue(state, topic.gid, true);
      }

      const doHead = max > 1 || state.turn === 'head';
      if (doHead) {
        budget.limit = max > 1 ? Math.max(1, max - 2) : 1;
        const index = state.headForumIndex; const forumId = this.config.forumIds[index]!;
        let page: ReturnType<PublicDiscussionsCollector['topicPage']> | undefined;
        try {
          await this.ensureForum(state, forumId, host, signal, budget);
          const forum = state.forums[forumId]!;
          const url = new URL(`https://steamcommunity.com/forum/${forum.owner}/${forum.type}/render/${forum.feature}/`);
          url.searchParams.set('start', '0'); url.searchParams.set('count', '15');
          page = this.topicPage(await this.request(url, signal, budget), this.config.appId, forumId, 0);
        } catch (error) {
          if (!this.isHeadFailure(error)) throw error;
          state.headError = error instanceof Error ? error.message : 'HEAD_REFRESH_FAILED';
          state.turn = 'backfill'; await checkpoint();
        }
        if (page) {
          this.observeTopics(state, forumId, page.topics, this.now().getTime());
          if (state.backgroundActive && state.backgroundForumIndex === index && state.backgroundStart === 0) this.advanceBackground(state, page.total);
          state.headForumIndex = (index + 1) % this.config.forumIds.length;
          delete state.headError; state.turn = 'backfill';
          await checkpoint();
        }
      }

      if (max === 1) {
        if (doHead) { state.turn = 'backfill'; state.phase = state.backgroundActive ? 'lists' : 'topics'; await checkpoint(); await summary('Head refresh completed; backfill continues on the next budget turn'); return; }
        budget.limit = 1;
        let didWork = false;
        if (state.backfillTurn === 'list' && state.backgroundActive) { didWork = await listWork(1); state.backfillTurn = 'topics'; }
        else if (state.topicQueue.length) { state.phase = 'topics'; didWork = await this.processOneTopic(state, host, signal, budget); state.backfillTurn = 'list'; }
        else if (state.backgroundActive) { didWork = await listWork(1); state.backfillTurn = 'topics'; }
        state.turn = 'head'; state.phase = state.backgroundActive ? 'lists' : state.topicQueue.length ? 'topics' : 'head';
        await checkpoint();
        await summary('One-request poll turn completed; unfinished work retained'); return;
      }

      budget.limit = max;
      if (max === 2) {
        if (state.backfillTurn === 'list' && state.backgroundActive) { await listWork(max); state.backfillTurn = 'topics'; }
        else if (state.topicQueue.length) { state.phase = 'topics'; await this.processOneTopic(state, host, signal, budget); state.backfillTurn = 'list'; }
        else if (state.backgroundActive) { await listWork(max); state.backfillTurn = 'topics'; }
      } else {
        if (state.backgroundActive) await listWork(max - 1);
        budget.limit = max;
        while (budget.used < max && state.topicQueue.length) { state.phase = 'topics'; await this.processOneTopic(state, host, signal, budget); }
      }
      state.phase = state.backgroundActive ? 'lists' : state.topicQueue.length ? 'topics' : 'head';
      await checkpoint(); await summary(state.backgroundActive || state.topicQueue.length ? 'Public scan continues; background offset and topic revisions retained' : 'Public scan is current; quiet known objects remain on daily rescan');
    } catch (error) {
      if (error instanceof Error && error.message === 'REQUEST_BUDGET') { await summary('Public scan paused at the request budget; checkpoint retained'); return; }
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : 'PUBLIC_COLLECTION_FAILED';
        await this.report(host, state, message, Object.keys(state.topics).length === 0 && /^(PERMISSION_DENIED|UNAVAILABLE_OR_PRIVATE|INVALID_EVENT:)/.test(message) ? 'unavailable' : 'partial');
      }
      throw error;
    } finally {
      if (this.deferUntil > this.now().getTime() && !signal.aborted) {
        const retained = stateFrom(await host.getCheckpoint(), this.config, this.now().getTime());
        retained.retryAfter = this.deferUntil;
        await host.commitBatch([], { sourceId: host.sourceId, cursor: retained as unknown as JSONValue });
      }
    }
  }
  private isHeadFailure(error: unknown): boolean {
    return error instanceof Error && /^(REQUEST_BUDGET|TRANSIENT_NETWORK|RATE_LIMITED|PLATFORM_UNAVAILABLE|PERMISSION_DENIED|UNAVAILABLE_OR_PRIVATE|INVALID_EVENT:|RESPONSE_TOO_LARGE)/.test(error.message);
  }
  private isTopicGap(error: unknown): boolean {
    return error instanceof Error && (/^(UNAVAILABLE_OR_PRIVATE|PERMISSION_DENIED|INVALID_EVENT:|RESPONSE_TOO_LARGE)/).test(error.message);
  }
}
