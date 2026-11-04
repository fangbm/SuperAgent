import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, FeedbackEventV1, JSONValue, PluginManifestV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';
export { SteamReviewCommentsConnector, seedSteamReviewCommentsCheckpoint, steamReviewCommentsConfigSchema } from './comments.js';
export type { SteamReviewCommentsConfig } from './comments.js';

export interface SteamReviewsConfig {
  sourceUri: string;
  appId: number;
  reviewScope?: 'negative' | 'all';
  publisherKeySecret?: string;
  pageSize?: number;
  maxPagesPerSync?: number;
  overlapSeconds?: number;
  pollIntervalMs?: number;
}
export const steamReviewsConfigSchema = {
  type: 'object', additionalProperties: false, required: ['sourceUri', 'appId'],
  properties: {
    sourceUri: { type: 'string', format: 'uri' }, appId: { type: 'integer', minimum: 1, maximum: 4294967295 },
    reviewScope: { enum: ['negative', 'all'] },
    publisherKeySecret: { type: 'string', minLength: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    maxPagesPerSync: { type: 'integer', minimum: 1, maximum: 10000 }, overlapSeconds: { type: 'integer', minimum: 1, maximum: 604800 },
    pollIntervalMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
  },
};
type RecordJSON = { [key: string]: JSONValue };
interface Review extends RecordJSON {
  recommendationid: string; review: string; language: string; voted_up: boolean;
  timestamp_created: number; timestamp_updated: number; author: RecordJSON & { steamid: string };
}
interface State {
  version: 1; appId: number; cursor: string; watermark: number; scanHigh: number;
  reviewScope?: 'negative' | 'all'; sequences?: Record<string, number>; observationTimes?: Record<string, number>;
  tracked: Record<string, string>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: JSONValue): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
const hash = (value: JSONValue) => createHash('sha256').update(canonical(value)).digest('hex');
function parseReview(input: unknown): Review {
  if (!object(input) || typeof input.recommendationid !== 'string' || !/^\d+$/.test(input.recommendationid)
    || typeof input.review !== 'string' || typeof input.language !== 'string' || !input.language
    || typeof input.voted_up !== 'boolean' || !object(input.author) || typeof input.author.steamid !== 'string' || !/^\d+$/.test(input.author.steamid)
    || !Number.isSafeInteger(input.timestamp_created) || !Number.isSafeInteger(input.timestamp_updated)
    || Number(input.timestamp_created) <= 0 || Number(input.timestamp_updated) < Number(input.timestamp_created)) throw new Error('INVALID_EVENT: steam review');
  return input as Review;
}
/** The immutable event identity includes the native revision and metadata snapshot, never text alone. */
export function normalizeSteamReview(input: unknown, config: SteamReviewsConfig, scope: { projectId: string; sourceId: string }, action?: 'created' | 'updated'): FeedbackEventV1 {
  const review = parseReview(input);
  const revision = String(review.timestamp_updated) + ':' + hash(review);
  const change = action ?? (review.timestamp_updated > review.timestamp_created ? 'updated' : 'created');
  return {
    specversion: '1.0', id: 'review:' + review.recommendationid + ':' + change + ':' + revision,
    source: config.sourceUri, type: 'com.superagent.feedback.review.' + change + '.v1' as 'com.superagent.feedback.review.created.v1' | 'com.superagent.feedback.review.updated.v1',
    time: new Date(review.timestamp_updated * 1000).toISOString(), datacontenttype: 'application/json',
    data: {
      schemaVersion: '1.0', projectId: scope.projectId, sourceId: scope.sourceId, platform: 'steam-reviews',
      object: { kind: 'review', externalId: review.recommendationid, revision },
      actor: { opaqueId: review.author.steamid, isBot: false }, content: { text: review.review, language: review.language },
      origin: { permalink: 'https://steamcommunity.com/profiles/' + review.author.steamid + '/recommended/' + config.appId + '/', locale: review.language },
      attributes: { appId: config.appId, voted_up: review.voted_up, timestamp_created: review.timestamp_created,
        timestamp_updated: review.timestamp_updated, native: review },
    },
  };
}
function readState(input: JSONValue | null, appId: number, scope: 'negative' | 'all'): State {
  if (input === null) return { version: 1, appId, reviewScope: scope, cursor: '*', watermark: 0, scanHigh: 0, tracked: {}, sequences: {} };
  if (!object(input) || input.version !== 1 || input.appId !== appId || typeof input.cursor !== 'string' || !input.cursor
    || (input.reviewScope ?? 'negative') !== scope
    || (input.sequences !== undefined && (!object(input.sequences) || Object.entries(input.sequences).some(([id, count]) => !/^\d+$/.test(id) || !Number.isSafeInteger(count) || Number(count) < 1)))
    || (input.observationTimes !== undefined && (!object(input.observationTimes) || Object.entries(input.observationTimes).some(([id, time]) => !/^\d+$/.test(id) || !Number.isSafeInteger(time) || Number(time) < 1)))
    || !Number.isSafeInteger(input.watermark) || Number(input.watermark) < 0 || !Number.isSafeInteger(input.scanHigh) || Number(input.scanHigh) < 0
    || !object(input.tracked) || Object.entries(input.tracked).some(([id, revision]) => !/^\d+$/.test(id) || typeof revision !== 'string')) throw new Error('INVALID_CHECKPOINT');
  return structuredClone(input) as unknown as State;
}

export class SteamReviewsConnector implements SourcePluginV1 {
  readonly manifest: PluginManifestV1;
  private readonly config: Required<Omit<SteamReviewsConfig, 'publisherKeySecret'>> & Pick<SteamReviewsConfig, 'publisherKeySecret'>;
  private readonly fetcher: typeof fetch;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  private controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private healthHost: SourcePluginHostV1 | undefined;
  private capability: ConnectorCapabilityV1 = { connection: 'poll', coverage: 'unknown', readMessages: false, readHistory: false, readEdits: false, readAttachments: false, reason: 'Not probed against Steam yet' };
  constructor(config: SteamReviewsConfig, options: { fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
    new URL(config.sourceUri);
    if (Object.keys(config).some(key => !Object.hasOwn(steamReviewsConfigSchema.properties, key))
      || !Number.isInteger(config.appId) || config.appId < 1 || config.appId > 4294967295
      || (config.reviewScope !== undefined && !['negative', 'all'].includes(config.reviewScope))
      || (config.publisherKeySecret !== undefined && !config.publisherKeySecret.trim())) throw new Error('INVALID_CONFIG');
    this.config = { reviewScope: 'negative', pageSize: 100, maxPagesPerSync: 10, overlapSeconds: 600, pollIntervalMs: 60000, ...config };
    for (const [key, min, max] of [['pageSize', 1, 100], ['maxPagesPerSync', 1, 10000], ['overlapSeconds', 1, 604800], ['pollIntervalMs', 1000, 86400000]] as const) {
      const value = this.config[key]; if (!Number.isInteger(value) || value < min || value > max) throw new Error('INVALID_CONFIG: ' + key);
    }
    this.fetcher = options.fetch ?? fetch;
    this.pause = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    this.manifest = { apiVersion: 'superagent.io/plugin/v1', id: 'superagent.steam-reviews', version: '0.1.0', displayName: 'Steam Reviews', kind: 'source', engine: { sdk: '^0.1.0' },
      permissions: { networkHosts: ['api.steampowered.com'], secretKeys: config.publisherKeySecret ? [config.publisherKeySecret] : [], eventPublish: true }, configSchema: steamReviewsConfigSchema };
  }
  private async page(cursor: string, signal: AbortSignal, key?: string, host?: SourcePluginHostV1): Promise<{ reviews: Review[]; cursor: string }> {
    const url = new URL('https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/');
    url.searchParams.set('input_json', JSON.stringify({ appid: this.config.appId, filter: 2, languages: ['all'], review_type: 0,
      purchase_type: 1, num_per_page: this.config.pageSize, filter_offtopic_activity: false, cursor }));
    if (key) url.searchParams.set('key', key);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try { response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error' }); }
      catch {
        signal.throwIfAborted();
        if (attempt === 3) throw new Error('TRANSIENT_NETWORK');
        await host?.reportHealth({coverage:'partial',reason:'STEAM_REVIEWS_POLL_INTERRUPTED:TRANSIENT_NETWORK',checkedAt:new Date().toISOString()});
        await this.pause(1000 * 2 ** attempt, signal); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await host?.reportHealth({coverage:'partial',reason:response.status===429?'STEAM_REVIEWS_POLL_INTERRUPTED:RATE_LIMITED':'STEAM_REVIEWS_POLL_INTERRUPTED:PLATFORM_UNAVAILABLE',checkedAt:new Date().toISOString()});
        await response.body?.cancel();
        if (attempt === 3) throw new Error(response.status === 429 ? 'RATE_LIMITED' : 'PLATFORM_UNAVAILABLE');
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0;
        await this.pause(Math.max(1000 * 2 ** attempt, Number.isFinite(wait) ? wait : 0), signal); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'PERMISSION_DENIED' : 'PLATFORM_UNAVAILABLE'); }
      let body: unknown;
      try { body = await response.json(); } catch { throw new Error('INVALID_EVENT: response JSON'); }
      if (!object(body) || !object(body.response)
        || typeof body.response.cursor !== 'string' || !body.response.cursor) throw new Error('INVALID_EVENT: response shape');
      // Steam omits the repeated protobuf field on terminal pages; require an explicit zero count.
      const reviews = body.response.reviews === undefined && object(body.response.query_summary) && body.response.query_summary.num_reviews === 0 ? [] : body.response.reviews;
      if (!Array.isArray(reviews)) throw new Error('INVALID_EVENT: response reviews');
      return { reviews: reviews.map(parseReview), cursor: body.response.cursor };
    }
  }
  probe(): Promise<ConnectorCapabilityV1> {
    const job = this.tail.then(() => this.checkAccess());
    this.tail = job.then(() => {}, () => {});
    return job;
  }
  private async checkAccess(): Promise<ConnectorCapabilityV1> {
    try {
      await this.page('*', AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]), undefined, this.healthHost);
      this.capability = { connection: 'poll', coverage: 'partial', readMessages: true, readHistory: true, readEdits: true, readAttachments: false,
        reason: 'Public current review snapshots only; deleted reviews and intermediate revisions between polls are unavailable; scan completion is reported by sync' };
    } catch (error) {
      this.capability = { connection: 'poll', coverage: 'unavailable', readMessages: false, readHistory: false, readEdits: false, readAttachments: false,
        reason: error instanceof Error && /^(RATE_LIMITED|UNAUTHORIZED|PERMISSION_DENIED|INVALID_EVENT|TRANSIENT_NETWORK|PLATFORM_UNAVAILABLE)/.test(error.message) ? error.message : 'PLATFORM_UNAVAILABLE' };
    }
    return { ...this.capability };
  }
  sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    const job = this.tail.then(() => this.scan(host, AbortSignal.any([signal, this.controller.signal])));
    this.tail = job.catch(() => {}); return job;
  }
  private async scan(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    try {
      let state = readState(await host.getCheckpoint(), this.config.appId, this.config.reviewScope);
      const key = this.config.publisherKeySecret ? await host.getSecret(this.config.publisherKeySecret) : undefined;
      for (let page = 0; page < this.config.maxPagesPerSync; page++) {
        signal.throwIfAborted();
        const result = await this.page(state.cursor, signal, key, host);
        const next = structuredClone(state);
        const events: FeedbackEventV1[] = [];
        let crossed = false;
        for (const review of result.reviews) {
          if (this.config.reviewScope === 'negative' && state.watermark > 0 && review.timestamp_updated < state.watermark - this.config.overlapSeconds) { crossed = true; continue; }
          next.scanHigh = Math.max(next.scanHigh, review.timestamp_updated);
          const previous = next.tracked[review.recommendationid];
          // Archive-all mode preserves native metadata changes even without timestamp_updated changes.
          const revision = this.config.reviewScope === 'all' ? hash(review) : hash({ id: review.recommendationid, text: review.review, language: review.language, voted_up: review.voted_up,
            created: review.timestamp_created, updated: review.timestamp_updated, author: review.author.steamid });
          if ((this.config.reviewScope === 'all' || review.voted_up === false || previous !== undefined) && previous !== revision) {
            const event = normalizeSteamReview(review, this.config, host, previous ? 'updated' : undefined);
            if (this.config.reviewScope === 'all') {
              const sequence = (next.sequences?.[review.recommendationid] ?? (previous ? 1 : 0)) + 1;
              (next.sequences ??= {})[review.recommendationid] = sequence;
              // Observation order distinguishes A→B→A snapshots with identical native timestamps.
              event.id += ':observation:' + sequence;
              event.data.object.revision += ':observation:' + sequence;
              // Core orders projections by event.time, but Steam metadata may change
              // without advancing its native timestamp_updated. Persist a strictly
              // increasing observation time, including across restarts.
              const nativeTime = review.timestamp_updated * 1000;
              const priorTime = next.observationTimes?.[review.recommendationid] ?? nativeTime;
              const observationTime = previous ? Math.max(Date.now(), nativeTime + 1, priorTime + 1) : nativeTime;
              (next.observationTimes ??= {})[review.recommendationid] = observationTime;
              event.time = new Date(observationTime).toISOString();
            }
            events.push(event);
            next.tracked[review.recommendationid] = revision;
          }
        }
        const complete = result.reviews.length === 0 || crossed;
        if (!complete && result.cursor === state.cursor) throw new Error('INVALID_EVENT: non-advancing cursor');
        next.cursor = complete ? '*' : result.cursor;
        if (complete) { next.watermark = Math.max(state.watermark, next.scanHigh); next.scanHigh = 0; }
        await host.commitBatch(events, { sourceId: host.sourceId, cursor: next as unknown as JSONValue });
        state = next;
        await host.reportHealth({ coverage: 'partial', checkedAt: new Date().toISOString(), reason: complete
          ? 'Review scan completed; public snapshots only; deletions and intermediate revisions cannot be recovered'
          : 'Review scan incomplete; committed pagination will resume; public snapshots only' });
        if (complete) return;
      }
    } catch (error) {
      if (!signal.aborted) await host.reportHealth({ coverage: 'unavailable', checkedAt: new Date().toISOString(), reason: 'Review sync failed; committed checkpoint retained' });
      throw error;
    }
  }
  async start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void> {
    this.healthHost = host;
    const combined = AbortSignal.any([signal, this.controller.signal]);
    try { while (!combined.aborted) { await this.sync(host, combined); await this.pause(this.config.pollIntervalMs, combined); } }
    catch (error) { if (!combined.aborted) throw error; }
  }
  async stop(): Promise<void> { this.controller.abort(); await this.tail; this.healthHost = undefined; }
}
