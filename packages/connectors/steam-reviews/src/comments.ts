import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, FeedbackEventV1, JSONValue, PluginManifestV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';

const parseHTML = createRequire(import.meta.url)('linkedom').parseHTML as (html: string) => { document: any };

export interface SteamReviewCommentsConfig {
  sourceUri: string;
  appId: number;
  parentReviewSourceId: string;
  publisherKeySecret?: string;
  pollIntervalMs?: number;
  requestIntervalMs?: number;
  maxRequestsPerSync?: number;
  rescanIntervalMs?: number;
  pageSize?: number;
}

export const steamReviewCommentsConfigSchema = {
  type: 'object', additionalProperties: false,
  required: ['sourceUri', 'appId', 'parentReviewSourceId'],
  properties: {
    sourceUri: { type: 'string', format: 'uri' }, appId: { type: 'integer', minimum: 1, maximum: 4294967295 },
    parentReviewSourceId: { type: 'string', minLength: 1 }, publisherKeySecret: { type: 'string', minLength: 1 },
    pollIntervalMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, requestIntervalMs: { type: 'integer', minimum: 2000, maximum: 60000 },
    maxRequestsPerSync: { type: 'integer', minimum: 1, maximum: 25 }, rescanIntervalMs: { type: 'integer', minimum: 1000, maximum: 604800000 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

type Dict = Record<string, unknown>;
type NativeComment = { id: string; authorUrl?: string; authorId?: string; created: number; text: string; nativeHtml: string; reviewId: string; reviewOwner: string; renderUrl: string };
type Thread = { owner: string; reportedCount: number; offset: number; lastScannedAt: number; pending: boolean; known: boolean; retryAt: number; refreshAfterScan?: boolean };
type Observation = { materialHash: string; revision: number; eventIds: string[]; observedAt: string };
type State = { version: 2; appId: number; sourceUri: string; parentReviewSourceId: string; mode: 'bounded-anonymous-web-observation'; reviewCursor: string; metadataSweepAt: number; nextEligibleAt: number; serviceTurn: 'head' | 'background' | 'comments'; knownReviews: Record<string, true>; threads: Record<string, Thread>; observations: Record<string, Observation> };

const isObject = (value: unknown): value is Dict => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function emptyState(config: SteamReviewCommentsConfig): State {
  return { version: 2, appId: config.appId, sourceUri: config.sourceUri, parentReviewSourceId: config.parentReviewSourceId,
    mode: 'bounded-anonymous-web-observation', reviewCursor: '*', metadataSweepAt: 0, nextEligibleAt: 0, serviceTurn: 'head', knownReviews: {}, threads: {}, observations: {} };
}
function readState(input: JSONValue | null, config: SteamReviewCommentsConfig): State {
  if (input === null) return emptyState(config);
  if (isObject(input) && input.version === 1) throw new Error('CORE_CHECKPOINT_SEED_REQUIRED');
  if (!isObject(input) || input.version !== 2 || input.appId !== config.appId || input.sourceUri !== config.sourceUri
    || input.parentReviewSourceId !== config.parentReviewSourceId || input.mode !== 'bounded-anonymous-web-observation'
    || typeof input.reviewCursor !== 'string' || !input.reviewCursor || input.reviewCursor.length > 4096 || !Number.isSafeInteger(input.metadataSweepAt)
    || !Number.isSafeInteger(input.nextEligibleAt) || Number(input.nextEligibleAt) < 0 || !['head', 'background', 'comments'].includes(String(input.serviceTurn))
    || !isObject(input.knownReviews) || Object.keys(input.knownReviews).some(reviewId => !id(reviewId) || (input.knownReviews as Record<string, unknown>)[reviewId] !== true)
    || !isObject(input.threads) || !isObject(input.observations)) throw new Error('INVALID_CHECKPOINT');
  for (const [reviewId, value] of Object.entries(input.threads)) if (!id(reviewId) || !isObject(value) || !id(value.owner)
    || !Number.isSafeInteger(value.reportedCount) || Number(value.reportedCount) < 0 || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0
    || !Number.isSafeInteger(value.lastScannedAt) || typeof value.pending !== 'boolean' || typeof value.known !== 'boolean'
    || !Number.isSafeInteger(value.retryAt) || Number(value.retryAt) < 0 || (value.refreshAfterScan !== undefined && typeof value.refreshAfterScan !== 'boolean')) throw new Error('INVALID_CHECKPOINT');
  for (const [key, value] of Object.entries(input.observations)) if (!/^comment:\d+:\d+$/.test(key) || !isObject(value) || typeof value.materialHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.materialHash) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.eventIds)
    || value.eventIds.length === 0 || value.eventIds.some(eventId => typeof eventId !== 'string') || new Set(value.eventIds).size !== value.eventIds.length
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('INVALID_CHECKPOINT');
  return structuredClone(input) as unknown as State;
}

function legacyMaterial(item: Partial<NativeComment>): string {
  const bodyHtml = typeof item.nativeHtml === 'string' && item.nativeHtml.length <= 1_000_000 ? (() => {
    const { document } = parseHTML(`<div id="root">${item.nativeHtml}</div>`);
    const body = document.querySelector('.commentthread_comment_text');
    if (!body) return '';
    const escapeText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/\n[\t ]+/g, '\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;');
    const canonical = (node: any): string => {
      if (node.nodeType === 3) return escapeText(node.data);
      if (node.nodeType !== 1) return '';
      const tag = String(node.tagName).toLowerCase();
      const attrs = [...node.attributes].map((attr: any) => [String(attr.name).toLowerCase(), attr.value] as const).sort(([a], [b]) => a.localeCompare(b));
      const opening = `<${tag}${attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')}>`;
      if (['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) return opening;
      return `${opening}${[...node.childNodes].map(canonical).join('')}</${tag}>`;
    };
    return [...body.childNodes].map(canonical).join('');
  })() : '';
  const fingerprintText = typeof item.text === 'string' ? item.text.replace(/\r\n?/g, '\n').replace(/\n[\t ]+/g, '\n').trim() : item.text;
  return sha(JSON.stringify({ id: item.id, reviewId: item.reviewId, reviewOwner: item.reviewOwner, created: item.created, authorId: item.authorId ?? null,
    authorUrl: item.authorUrl ?? null, text: fingerprintText, bodyHtml }));
}

/** Seeds material snapshots from archived source projections without touching the archive. */
export function seedSteamReviewCommentsCheckpoint(config: SteamReviewCommentsConfig, previousCheckpoint: JSONValue | null, archivedEvents: readonly FeedbackEventV1[], expectedScope?: { projectId: string; sourceId: string }): JSONValue {
  if (isObject(previousCheckpoint) && previousCheckpoint.version === 2) return structuredClone(readState(previousCheckpoint, config)) as unknown as JSONValue;
  if (previousCheckpoint !== null && !(isObject(previousCheckpoint) && previousCheckpoint.version === 1 && previousCheckpoint.appId === config.appId
    && previousCheckpoint.mode === 'bounded-anonymous-web-observation' && isObject(previousCheckpoint.revisions) && (isObject(previousCheckpoint.threads) || Array.isArray(previousCheckpoint.threads)))) throw new Error('INVALID_CHECKPOINT');
  const state = emptyState(config);
  const versions = new Map<string, Set<string>>();
  const legacyObservedAt = isObject(previousCheckpoint) && typeof previousCheckpoint.capturedAt === 'string'
    && Number.isFinite(Date.parse(previousCheckpoint.capturedAt)) ? previousCheckpoint.capturedAt : undefined;
  for (const event of archivedEvents) {
    if (event.source !== config.sourceUri) continue;
    const data = event.data as unknown as Dict;
    if (!isObject(data) || data.platform !== 'steam-reviews' || typeof data.sourceId !== 'string' || typeof data.projectId !== 'string'
      || (expectedScope && (data.projectId !== expectedScope.projectId || data.sourceId !== expectedScope.sourceId))
      || !isObject(data.object) || data.object.kind !== 'comment' || !isObject(data.content)
      || !isObject(data.attributes) || data.attributes.appId !== config.appId || data.attributes.parentReviewSourceId !== config.parentReviewSourceId
      || !isObject(data.attributes.native)) throw new Error('INVALID_EVENT: archived comment binding');
    const item = data.attributes.native as unknown as NativeComment;
    if (!id(item.id) || !id(item.reviewId) || !id(item.reviewOwner) || typeof item.text !== 'string' || !Number.isSafeInteger(item.created) || item.created <= 0
      || typeof item.nativeHtml !== 'string' || !item.nativeHtml.includes('commentthread_comment_text')) throw new Error('INVALID_EVENT: archived comment native payload');
    const externalId = `comment:${item.reviewId}:${item.id}`;
    const action = event.type === 'com.superagent.feedback.comment.created.v1' ? 'created' : event.type === 'com.superagent.feedback.comment.updated.v1' ? 'updated' : null;
    const revision = data.object.revision;
    const codec = typeof revision === 'string' ? revision.match(/^(?:([1-9]\d*):)?([a-f0-9]{64})$/) : null;
    if (!action || !codec || data.object.externalId !== externalId || data.object.parentExternalId !== item.reviewId
      || data.object.threadExternalId !== `review:${item.reviewId}` || data.attributes.parentRecommendationId !== item.reviewId
      || data.content.text !== item.text || data.attributes.nativeCreatedAt !== item.created
      || event.id !== `${externalId}:${action}:${codec[1] && action === 'updated' ? revision : codec[2]}`) throw new Error('INVALID_EVENT: archived comment identity or parent mismatch');
    const materialHash = legacyMaterial(item);
    if (codec[1] && codec[2] !== materialHash) throw new Error('INVALID_EVENT: archived comment revision mismatch');
    const eventSet = versions.get(externalId) ?? new Set<string>(); eventSet.add(event.id); versions.set(externalId, eventSet);
    state.observations[externalId] = { materialHash, revision: codec[1] ? Number(codec[1]) : eventSet.size, eventIds: [...eventSet], observedAt: legacyObservedAt ?? event.time };
    state.knownReviews[item.reviewId] = true;
    if (state.threads[item.reviewId] && state.threads[item.reviewId]!.owner !== item.reviewOwner) throw new Error('INVALID_EVENT: archived review owner mismatch');
    state.threads[item.reviewId] ??= { owner: item.reviewOwner, reportedCount: 0, offset: 0, lastScannedAt: 0, pending: false, known: true, retryAt: 0 };
  }
  // Legacy thread summaries can include known threads with no comments; keep them eligible for a future daily scan.
  const legacy = previousCheckpoint as unknown as Dict | null;
  if (legacy && Array.isArray(legacy.threads)) for (const item of legacy.threads) if (isObject(item) && id(item.reviewId)) state.knownReviews[item.reviewId] = true;
  if (legacy && isObject(legacy.threads)) for (const [reviewId, item] of Object.entries(legacy.threads)) if (id(reviewId) && isObject(item)) {
    state.knownReviews[reviewId] = true;
    if (id(item.owner) && Number.isSafeInteger(item.reportedCount)) state.threads[reviewId] = { owner: item.owner, reportedCount: Number(item.reportedCount), offset: 0, lastScannedAt: 0, pending: false, known: true, retryAt: 0 };
  }
  return state as unknown as JSONValue;
}

function reviewsQuery(appId: number, pageSize: number, cursor: string): URL {
  const url = new URL('https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/');
  url.searchParams.set('input_json', JSON.stringify({ appid: appId, filter: 2, languages: ['all'], review_type: 0, purchase_type: 1,
    num_per_page: pageSize, filter_offtopic_activity: false, cursor }));
  return url;
}
function renderText(node: any): string {
  const walk = (n: any): string => {
    if (n.nodeType === 3) return n.data;
    if (n.nodeType !== 1) return [...(n.childNodes ?? [])].map(walk).join('');
    const tag = String(n.tagName).toLowerCase();
    if (tag === 'br') return '\n';
    const content = [...(n.childNodes ?? [])].map(walk).join('');
    return ['p', 'div', 'li', 'blockquote'].includes(tag) ? `\n${content}\n` : content;
  };
  return walk(node).replace(/\r/g, '').replace(/\n[\t ]+/g, '\n').trim();
}
function parseComments(html: string, reviewId: string, owner: string, renderUrl: string): NativeComment[] {
  if (html.length > 1_000_000) throw new Error('INVALID_EVENT: comment HTML too large');
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  return Array.from(document.querySelectorAll('.commentthread_comment[id^="comment_"]')).map((element: any) => {
    const commentId = element.getAttribute('id')?.slice('comment_'.length);
    const textNode = element.querySelector('.commentthread_comment_text');
    const timeNode = element.querySelector('[data-timestamp]');
    if (!id(commentId) || !textNode || !timeNode || !/^\d+$/.test(timeNode.getAttribute('data-timestamp') ?? '')
      || !Number.isSafeInteger(Number(timeNode.getAttribute('data-timestamp'))) || Number(timeNode.getAttribute('data-timestamp')) <= 0) throw new Error('INVALID_EVENT: comment shape');
    const author = element.querySelector('a.commentthread_author_link, a[href*="/profiles/"]');
    const authorUrl = author?.getAttribute('href') ?? undefined;
    const authorId = authorUrl?.match(/\/profiles\/(\d+)/)?.[1] ?? undefined;
    return { id: commentId, ...(authorUrl ? { authorUrl } : {}), ...(authorId ? { authorId } : {}), created: Number(timeNode.getAttribute('data-timestamp')),
      text: renderText(textNode), nativeHtml: element.outerHTML, reviewId, reviewOwner: owner, renderUrl };
  });
}

export class SteamReviewCommentsConnector implements SourcePluginV1 {
  readonly manifest: PluginManifestV1;
  private readonly config: Required<Omit<SteamReviewCommentsConfig, 'publisherKeySecret'>> & Pick<SteamReviewCommentsConfig, 'publisherKeySecret'>;
  private readonly fetcher: typeof fetch; private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>; private readonly now: () => number;
  private controller = new AbortController(); private tail: Promise<void> = Promise.resolve(); private lastRequestAt = 0; private activeRequests = 0; private requestLimit = 0; private deferUntil = 0;
  private capability: ConnectorCapabilityV1 = { connection: 'poll', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'Not probed against a public review comment thread' };
  private verifiedCommentAccess = false;
  // Bypass unbound network probes under unified supervision; the Host owns cooldown persistence.
  private readonly passiveProbe: boolean;
  constructor(config: SteamReviewCommentsConfig, options: { fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number; passiveProbe?: boolean } = {}) {
    new URL(config.sourceUri);
    if (Object.keys(config).some(key => !Object.hasOwn(steamReviewCommentsConfigSchema.properties, key)) || !Number.isInteger(config.appId) || config.appId < 1
      || config.appId > 4294967295 || !config.parentReviewSourceId.trim() || (config.publisherKeySecret !== undefined && !config.publisherKeySecret.trim())) throw new Error('INVALID_CONFIG');
    this.config = { pollIntervalMs: 600000, requestIntervalMs: 2000, maxRequestsPerSync: 25, rescanIntervalMs: 86400000, pageSize: 100, ...config };
    for (const [key, min, max] of [['pollIntervalMs', 1000, 86400000], ['requestIntervalMs', 2000, 60000], ['maxRequestsPerSync', 1, 25], ['rescanIntervalMs', 1000, 604800000], ['pageSize', 1, 100]] as const) {
      const value = this.config[key]; if (!Number.isInteger(value) || value < min || value > max) throw new Error('INVALID_CONFIG: ' + key);
    }
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.passiveProbe = options.passiveProbe === true;
    this.pause = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    this.manifest = { apiVersion: 'superagent.io/plugin/v1', id: 'superagent.steam-review-comments', version: '0.1.0', displayName: 'Steam Review Comments', kind: 'source', engine: { sdk: '^0.1.0' },
      permissions: { networkHosts: ['api.steampowered.com', 'steamcommunity.com'], secretKeys: config.publisherKeySecret ? [config.publisherKeySecret] : [], eventPublish: true }, configSchema: steamReviewCommentsConfigSchema };
  }
  private async request(url: URL, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      if (this.activeRequests >= this.requestLimit) throw new Error('REQUEST_BUDGET');
      if (this.lastRequestAt) await this.pause(Math.max(0, this.lastRequestAt + this.config.requestIntervalMs - this.now()), signal);
      this.activeRequests++;
      this.lastRequestAt = this.now();
      let response: Response;
      try { response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error', headers: { accept: 'application/json,text/plain' } }); }
      catch { signal.throwIfAborted(); if (attempt === 3) throw new Error('TRANSIENT_NETWORK'); await this.pause(1000 * 2 ** attempt, signal); continue; }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        const header = response.headers.get('retry-after'); const seconds = header === null ? NaN : Number(header);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - this.now() : 0;
        const retryWait = Math.max(this.config.requestIntervalMs, 1000 * 2 ** attempt, Number.isFinite(wait) ? wait : 0);
        if (response.status === 429) {
          // Never sleep through a long Retry-After inside a bounded probe. The
          // running scan persists the deadline through the scoped Host.
          this.deferUntil = Math.max(this.deferUntil, this.now() + retryWait);
          throw new Error('RATE_LIMITED');
        }
        if (attempt === 3) throw new Error('PLATFORM_UNAVAILABLE');
        await this.pause(retryWait, signal); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 403 ? 'PERMISSION_DENIED' : response.status === 401 ? 'UNAUTHORIZED' : 'PLATFORM_UNAVAILABLE'); }
      const length = Number(response.headers.get('content-length') ?? 0); if (length > 1_000_000) { await response.body?.cancel(); throw new Error('INVALID_EVENT: response too large'); }
      return response;
    }
  }
  private async jsonBody(response: Response): Promise<unknown> {
    if (!response.body) throw new Error('INVALID_EVENT: empty response');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1_000_000) { await reader.cancel(); throw new Error('INVALID_EVENT: response too large'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('INVALID_EVENT: response JSON'); }
  }
  private async page(cursor: string, signal: AbortSignal): Promise<{ reviews: unknown[]; cursor: string }> {
    const response = await this.request(reviewsQuery(this.config.appId, this.config.pageSize, cursor), signal);
    const body = await this.jsonBody(response);
    if (!isObject(body) || !isObject(body.response) || typeof body.response.cursor !== 'string' || !body.response.cursor) throw new Error('INVALID_EVENT: response shape');
    const reviews = body.response.reviews === undefined && isObject(body.response.query_summary) && body.response.query_summary.num_reviews === 0 ? [] : body.response.reviews;
    if (!Array.isArray(reviews)) throw new Error('INVALID_EVENT: response reviews');
    return { reviews, cursor: body.response.cursor };
  }
  private async comments(threadId: string, thread: Thread, offset: number, signal: AbortSignal): Promise<{ items: NativeComment[]; total: number; returned: number }> {
    const url = new URL(`https://steamcommunity.com/comment/Recommendation/render/${thread.owner}/${this.config.appId}/`);
    url.searchParams.set('start', String(offset)); url.searchParams.set('count', String(this.config.pageSize));
    const response = await this.request(url, signal); const body = await this.jsonBody(response);
    if (!isObject(body) || body.success !== true || typeof body.comments_html !== 'string' || !Number.isSafeInteger(body.total_count)
      || Number(body.total_count) < 0 || !Number.isSafeInteger(body.start) || Number(body.start) !== offset) throw new Error(body && isObject(body) && body.success === false ? 'PERMISSION_DENIED' : 'INVALID_EVENT: comment response shape');
    const items = parseComments(body.comments_html, threadId, thread.owner, url.href);
    if (items.length > this.config.pageSize || (items.length === 0 && offset < Number(body.total_count))
      || items.length > Math.max(0, Number(body.total_count) - offset)
      || new Set(items.map(item => item.id)).size !== items.length) throw new Error('INVALID_EVENT: comment page');
    return { items, total: Number(body.total_count), returned: items.length };
  }
  probe(): Promise<ConnectorCapabilityV1> {
    // Production discovers capability by start(host)/sync(host), so a first 429
    // can be committed to the checkpoint before the next instance starts.
    if (this.passiveProbe) return Promise.resolve({ ...this.capability });
    const job = this.tail.then(() => this.checkAccess());
    this.tail = job.then(() => {}, () => {});
    return job;
  }
  private async checkAccess(): Promise<ConnectorCapabilityV1> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]);
    try {
      if (this.deferUntil > this.now()) throw new Error('RATE_LIMITED');
      this.activeRequests = 0; this.requestLimit = 2;
      const result = await this.page('*', signal);
      const candidate = result.reviews.map(item => this.reviewMetadata(item)).find(item => item.count > 0);
      if (!candidate) this.capability = { connection: 'poll', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'No public review with a comment was available to verify comment access' };
      else {
        await this.comments(candidate.id, { owner: candidate.owner, reportedCount: candidate.count, offset: 0, lastScannedAt: 0, pending: false, known: false, retryAt: 0 }, 0, signal);
        this.verifiedCommentAccess = true;
        this.capability = { connection: 'poll', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: false, reason: 'Anonymous public review comments are reachable; deletions and intermediate edits between observations are unavailable' };
      }
    }
    catch (error) { this.capability = { connection: 'poll', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: error instanceof Error ? error.message : 'PLATFORM_UNAVAILABLE' }; }
    return { ...this.capability };
  }
  private reviewMetadata(input: unknown): { id: string; owner: string; count: number } {
    if (!isObject(input) || !id(input.recommendationid) || !isObject(input.author) || !id(input.author.steamid) || !Number.isSafeInteger(input.comment_count) || Number(input.comment_count) < 0) throw new Error('INVALID_EVENT: review metadata');
    return { id: input.recommendationid, owner: input.author.steamid, count: Number(input.comment_count) };
  }
  private mergeReviews(state: State, reviews: unknown[]): void {
    for (const raw of reviews) {
      const r = this.reviewMetadata(raw); const old = state.threads[r.id];
      const changed = old ? old.reportedCount !== r.count || old.owner !== r.owner : false;
      const continuing = old?.pending && old.owner === r.owner;
      state.threads[r.id] = { owner: r.owner, reportedCount: r.count, offset: continuing ? old.offset : 0,
        lastScannedAt: old?.lastScannedAt ?? 0, pending: old ? old.pending || changed : r.count > 0,
        known: old?.known ?? state.knownReviews[r.id] === true, retryAt: changed ? 0 : old?.retryAt ?? 0,
        ...(continuing && (old.refreshAfterScan || changed) ? { refreshAfterScan: true } : {}) };
    }
  }
  private async metadataPage(host: SourcePluginHostV1, state: State, cursor: string, background: boolean, turn: State['serviceTurn'], signal: AbortSignal): Promise<State> {
    const result = await this.page(cursor, signal);
    if (background && result.reviews.length && result.cursor === cursor) throw new Error('INVALID_EVENT: non-advancing review cursor');
    if (background && result.reviews.length && result.cursor === '*') throw new Error('INVALID_EVENT: non-advancing review cursor');
    const next = structuredClone(state); this.mergeReviews(next, result.reviews);
    if (background) {
      next.reviewCursor = result.reviews.length ? result.cursor : '*';
      if (next.reviewCursor === '*') next.metadataSweepAt = this.now();
    }
    next.serviceTurn = turn;
    await host.commitBatch([], { sourceId: host.sourceId, cursor: next as unknown as JSONValue });
    return next;
  }
  private eligibleThreads(state: State): Array<[string, Thread]> {
    return Object.entries(state.threads).filter(([, thread]) => thread.retryAt <= this.now()
      && (thread.pending || (thread.known && this.now() - thread.lastScannedAt >= this.config.rescanIntervalMs)))
      .sort(([, a], [, b]) => Number(a.known) - Number(b.known) || a.lastScannedAt - b.lastScannedAt);
  }
  private async threadPage(host: SourcePluginHostV1, state: State, reviewId: string, thread: Thread, turn: State['serviceTurn'], signal: AbortSignal): Promise<{ state: State; gap: boolean }> {
    let result: Awaited<ReturnType<typeof this.comments>>;
    try { result = await this.comments(reviewId, thread, thread.offset, signal); this.verifiedCommentAccess = true; }
    catch (error) {
      if (error instanceof Error && ['REQUEST_BUDGET', 'RATE_LIMITED'].includes(error.message)) throw error;
      const next = structuredClone(state); const failed = next.threads[reviewId];
      if (failed) failed.retryAt = this.now() + (error instanceof Error && error.message === 'PERMISSION_DENIED'
        ? this.config.rescanIntervalMs : Math.min(this.config.rescanIntervalMs, 300000));
      next.serviceTurn = turn;
      await host.commitBatch([], { sourceId: host.sourceId, cursor: next as unknown as JSONValue });
      return { state: next, gap: true };
    }
    const next = structuredClone(state); const current = next.threads[reviewId];
    if (!current) throw new Error('INVALID_CHECKPOINT');
    const terminal = result.returned === 0 || current.offset + result.returned >= result.total;
    current.reportedCount = result.total; current.offset = terminal ? 0 : current.offset + result.returned;
    current.pending = !terminal || current.refreshAfterScan === true;
    if (terminal) delete current.refreshAfterScan;
    current.lastScannedAt = this.now(); current.known = true; current.retryAt = 0; next.knownReviews[reviewId] = true;
    const events: FeedbackEventV1[] = [];
    for (const item of result.items) {
      const externalId = `comment:${item.reviewId}:${item.id}`; const materialHash = legacyMaterial(item); const previous = next.observations[externalId];
      if (previous?.materialHash === materialHash) continue;
      const revision = previous ? previous.revision + 1 : 1; const observedAt = new Date(this.now()).toISOString();
      const eventId = previous ? `${externalId}:updated:${revision}:${materialHash}` : `${externalId}:created:${materialHash}`;
      const action = previous ? 'updated' : 'created';
      const event: FeedbackEventV1 = { specversion: '1.0', id: eventId, source: this.config.sourceUri,
        type: `com.superagent.feedback.comment.${action}.v1` as 'com.superagent.feedback.comment.created.v1' | 'com.superagent.feedback.comment.updated.v1',
        time: previous ? observedAt : new Date(item.created * 1000).toISOString(), datacontenttype: 'application/json',
        data: { schemaVersion: '1.0', projectId: host.projectId, sourceId: host.sourceId, platform: 'steam-reviews',
          object: { kind: 'comment', externalId, revision: `${revision}:${materialHash}`, parentExternalId: item.reviewId, threadExternalId: `review:${item.reviewId}` },
          ...(item.authorId ? { actor: { opaqueId: item.authorId, isBot: false } } : {}), content: { text: item.text },
          origin: { permalink: `https://steamcommunity.com/profiles/${item.reviewOwner}/recommended/${this.config.appId}/#comment_${item.id}` },
          attributes: { appId: this.config.appId, surface: 'review-comments', ingestionMode: 'bounded-anonymous-web-observation', parentReviewSourceId: this.config.parentReviewSourceId,
            parentRecommendationId: item.reviewId, nativeCreatedAt: item.created, ...(previous ? { observedAt } : {}), sourceEndpoint: item.renderUrl, native: item } } };
      events.push(event); next.observations[externalId] = { materialHash, revision, eventIds: [...(previous?.eventIds ?? []), eventId], observedAt };
    }
    next.serviceTurn = turn;
    await host.commitBatch(events, { sourceId: host.sourceId, cursor: next as unknown as JSONValue });
    return { state: next, gap: false };
  }
  sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> { const job = this.tail.then(() => this.scan(host, AbortSignal.any([signal, this.controller.signal]))); this.tail = job.catch(() => {}); return job; }
  private async scan(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    try {
      this.activeRequests = 0; this.requestLimit = this.config.maxRequestsPerSync;
      let state = readState(await host.getCheckpoint(), this.config);
      this.deferUntil = Math.max(this.deferUntil, state.nextEligibleAt);
      if (state.nextEligibleAt > this.now()) {
        await host.reportHealth({ coverage: 'partial', checkedAt: new Date(this.now()).toISOString(), reason: `Steam asked to retry after ${new Date(state.nextEligibleAt).toISOString()}` });
        return;
      }
      state.nextEligibleAt = 0;
      const initialCursor = state.reviewCursor;
      let gaps = 0;
      const drainThreads = async (turn: State['serviceTurn'], limit = Number.MAX_SAFE_INTEGER) => {
        let count = 0;
        for (const [reviewId, thread] of this.eligibleThreads(state)) {
          if (this.activeRequests >= this.config.maxRequestsPerSync || count >= limit) break;
          const result = await this.threadPage(host, state, reviewId, thread, turn, signal);
          state = result.state; if (result.gap) gaps++; count++;
        }
        return count;
      };
      if (this.config.maxRequestsPerSync === 1) {
        let turn = state.serviceTurn;
        if (turn === 'comments' && this.eligibleThreads(state).length === 0) turn = state.reviewCursor === '*' ? 'head' : 'background';
        if (turn === 'comments') await drainThreads('background', 1);
        else if (turn === 'background' && state.reviewCursor !== '*') state = await this.metadataPage(host, state, state.reviewCursor, true, 'head', signal);
        else state = await this.metadataPage(host, state, '*', state.reviewCursor === '*', 'comments', signal);
      } else {
        const startedAtHead = state.reviewCursor === '*';
        // Refresh current reviews every poll; use the same response to open a fresh background sweep.
        state = await this.metadataPage(host, state, '*', startedAtHead, state.serviceTurn, signal);
        const commentsFirst = !startedAtHead && state.serviceTurn === 'comments';
        if (commentsFirst) {
          await drainThreads('background');
          if (this.activeRequests < this.config.maxRequestsPerSync && state.reviewCursor !== '*') state = await this.metadataPage(host, state, state.reviewCursor, true, 'background', signal);
          else if (state.reviewCursor !== '*') state.serviceTurn = 'background';
        } else {
          if (!startedAtHead && this.activeRequests < this.config.maxRequestsPerSync && state.reviewCursor !== '*') state = await this.metadataPage(host, state, state.reviewCursor, true, 'comments', signal);
          if (this.activeRequests < this.config.maxRequestsPerSync) await drainThreads('comments');
        }
      }
      await host.commitBatch([], { sourceId: host.sourceId, cursor: state as unknown as JSONValue });
      const backlog = Object.values(state.threads).some(thread => thread.pending || (thread.known && this.now() - thread.lastScannedAt >= this.config.rescanIntervalMs)) || state.reviewCursor !== '*';
      await host.reportHealth({ coverage: 'partial', checkedAt: new Date(this.now()).toISOString(), reason: gaps
        ? `${gaps} thread page(s) inaccessible or malformed; their offsets were retained and will retry later`
        : state.reviewCursor !== '*' || backlog ? 'Review metadata sweep or known comment thread backlog remains; observations are bounded and incomplete'
        : initialCursor !== '*' ? 'Review metadata pagination resumed; comments are observed without native edit timestamps or deletion coverage'
          : 'Public anonymous review comment snapshots observed; intermediate edits and deleted/private threads are unavailable' });
      this.capability = this.verifiedCommentAccess
        ? { connection: 'poll', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: false, reason: backlog ? 'Comment or metadata backlog remains' : 'Public comment snapshots only; deletions and intermediate revisions cannot be recovered' }
        : { connection: 'poll', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'No public comment thread has yet verified the comment endpoint' };
    } catch (error) {
      if (error instanceof Error && ['REQUEST_BUDGET', 'RATE_LIMITED'].includes(error.message)) {
        if (this.deferUntil > this.now()) {
          const retained = readState(await host.getCheckpoint(), this.config);
          retained.nextEligibleAt = this.deferUntil;
          await host.commitBatch([], { sourceId: host.sourceId, cursor: retained as unknown as JSONValue });
        }
        const rateLimited = error.message === 'RATE_LIMITED' || this.deferUntil > this.now();
        await host.reportHealth({ coverage: rateLimited ? 'unavailable' : 'partial', checkedAt: new Date(this.now()).toISOString(), reason: rateLimited
          ? `Steam rate limited comment polling; next request is deferred until ${new Date(this.deferUntil).toISOString()}`
          : 'Request budget reached; committed metadata and thread cursors will resume on the next sync' });
        return;
      }
      if (!signal.aborted) await host.reportHealth({ coverage: 'unavailable', checkedAt: new Date(this.now()).toISOString(), reason: 'Review comment sync failed; committed checkpoint retained' }); throw error;
    }
  }
  async start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    try {
      while (!combined.aborted) {
        try { await this.sync(host, combined); }
        catch (error) { if (error instanceof Error && /^(INVALID_CONFIG|INVALID_CHECKPOINT|CORE_CHECKPOINT_SEED_REQUIRED)/.test(error.message)) throw error; }
        await this.pause(this.config.pollIntervalMs, combined);
      }
    } catch (error) { if (!combined.aborted) throw error; }
  }
  async stop(): Promise<void> { this.controller.abort(); await this.tail; }
}
