import { randomUUID } from 'node:crypto';
import { parseContract } from '@superagent/contract-validation';
import { SqliteStore, canonicalJSON, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DurableJobQueue } from '@superagent/job-queue';
import type { CommitResultV1, InternalEventId, JSONValue, NormalizedEventV1, SyncCheckpointV1, SourceCoverage } from '@superagent/contracts';
import type { SourcePluginHostV1, PluginLogger } from '@superagent/plugin-sdk';

export interface SourceBinding { projectId: string; sourceId: string; sourceUri: string; platform: string }
export interface SourceScope { projectId: string; sourceId: string }
interface EventRow { event_id: InternalEventId; payload_json: string; received_at: string; project_id: string; source_id: string }
interface ObjectRow { event_id: InternalEventId; occurred_at: string; action_rank: number; object_kind: string; conversation_key: string; deleted: number }
const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class IngressService {
  constructor(readonly store: SqliteStore, private readonly queue: DurableJobQueue,
    private readonly clock: Clock = systemClock, private readonly idFactory: () => string = randomUUID) {}
  registerSource(binding: SourceBinding): void {
    if (Object.values(binding).some(value => typeof value !== 'string' || !value.trim())) throw new Error('INVALID_SOURCE_BINDING');
    try { new URL(binding.sourceUri); } catch { throw new Error('INVALID_SOURCE_URI'); }
    this.store.transaction(() => {
      const old = this.store.get<{ project_id: string; source_uri: string; platform: string }>('SELECT * FROM sources WHERE source_id=?', binding.sourceId);
      if (old) {
        if (old.project_id !== binding.projectId || old.source_uri !== binding.sourceUri || old.platform !== binding.platform) throw new Error('SOURCE_IDENTITY_CONFLICT');
        return;
      }
      this.store.run('INSERT INTO projects(project_id) VALUES(?) ON CONFLICT DO NOTHING', binding.projectId);
      this.store.run('INSERT INTO sources(source_id,project_id,source_uri,platform) VALUES(?,?,?,?)', binding.sourceId, binding.projectId, binding.sourceUri, binding.platform);
    });
  }
  private binding(scope: SourceScope): SourceBinding {
    const source = this.store.get<{ project_id: string; source_uri: string; platform: string }>('SELECT * FROM sources WHERE source_id=? AND project_id=?', scope.sourceId, scope.projectId);
    if (!source) throw new Error('SOURCE_NOT_AUTHORIZED');
    return { ...scope, sourceUri: source.source_uri, platform: source.platform };
  }
  commitBatch(scope: SourceScope, inputs: readonly unknown[], checkpoint?: SyncCheckpointV1): CommitResultV1 {
    const source = this.binding(scope);
    if (checkpoint && checkpoint.sourceId !== source.sourceId) throw new Error('CHECKPOINT_SOURCE_MISMATCH');
    const cursor = checkpoint ? canonicalJSON(checkpoint.cursor) : undefined;
    // Validate and snapshot the complete input before any write. No async boundary
    // or upstream acknowledgement occurs before the SQLite COMMIT.
    const events = inputs.map(input => {
      const event = parseContract('normalized-event-v1', input);
      if (event.data.projectId !== source.projectId || event.data.sourceId !== source.sourceId || event.source !== source.sourceUri || event.data.platform !== source.platform) throw new Error('EVENT_SOURCE_MISMATCH');
      return { event, json: canonicalJSON(event as unknown as JSONValue) };
    });
    const now = timestamp(this.clock());
    return this.store.transaction(() => {
      const refs: Array<CommitResultV1['refs'][number]> = [];
      let accepted = 0;
      for (const { event, json } of events) {
        const existing = this.store.get<EventRow>('SELECT * FROM source_events WHERE source_uri=? AND external_event_id=?', event.source, event.id);
        if (existing) {
          if (existing.payload_json !== json) throw new Error('EVENT_IDENTITY_CONFLICT');
          refs.push({ eventId: existing.event_id, source: event.source, id: event.id, inserted: false });
          continue;
        }
        const eventId = this.idFactory() as InternalEventId;
        this.store.run(`INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at)
          VALUES(?,?,?,?,?,?,?,?)`, eventId, event.source, event.id, scope.projectId, scope.sourceId, event.type, json, now);
        this.store.run('INSERT INTO event_outbox(event_id,handler_version,status) VALUES(?,?,?)', eventId, 'admission-v1', 'pending');
        if (event.type === 'com.superagent.source.coverage.changed.v1') this.reportHealth(scope, { coverage: event.data.coverage, checkedAt: now, ...(event.data.reason ? { reason: event.data.reason } : {}) });
        else this.project(eventId, event, now);
        refs.push({ eventId, source: event.source, id: event.id, inserted: true });
        accepted++;
      }
      if (cursor !== undefined) this.store.run(`INSERT INTO sync_cursors(source_id,cursor_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`, scope.sourceId, cursor, now);
      return { accepted, duplicates: events.length - accepted, transactionId: randomUUID(), refs };
    });
  }
  private project(eventId: InternalEventId, event: Exclude<NormalizedEventV1, { type: 'com.superagent.source.coverage.changed.v1' }>, receivedAt: string): void {
    const object = event.data.object;
    const current = this.store.get<ObjectRow>('SELECT * FROM source_objects WHERE source_id=? AND external_id=?', event.data.sourceId, object.externalId);
    const occurredAt = timestamp(event.time);
    const rank = event.type.includes('.deleted.') ? 2 : event.type.includes('.updated.') ? 1 : 0;
    const parent = object.parentExternalId ? this.store.get<ObjectRow>('SELECT * FROM source_objects WHERE source_id=? AND external_id=?', event.data.sourceId, object.parentExternalId) : undefined;
    const conversationKey = current?.conversation_key ?? (object.threadExternalId ? `thread:${object.threadExternalId}` : object.parentExternalId ? parent?.conversation_key ?? `object:${object.parentExternalId}` : `object:${object.externalId}`);
    this.store.run('INSERT INTO source_event_routes VALUES(?,?,?,?)', eventId, event.data.sourceId, conversationKey, receivedAt);
    if (current && (current.object_kind !== object.kind || occurredAt < current.occurred_at || (occurredAt === current.occurred_at && rank <= current.action_rank))) {
      this.store.run('INSERT INTO source_reconciliations(event_id,current_event_id,reason) VALUES(?,?,?)', eventId, current.event_id, current.object_kind !== object.kind ? 'OBJECT_KIND_CONFLICT' : occurredAt === current.occurred_at ? 'AMBIGUOUS_REVISION_ORDER' : 'OUT_OF_ORDER');
      return;
    }
    this.store.run(`INSERT INTO source_objects(source_id,external_id,object_kind,event_id,revision,occurred_at,action_rank,conversation_key,deleted)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET
      event_id=excluded.event_id,revision=excluded.revision,occurred_at=excluded.occurred_at,action_rank=excluded.action_rank,deleted=excluded.deleted`,
    event.data.sourceId, object.externalId, object.kind, eventId, object.revision, occurredAt, rank, conversationKey, rank === 2 ? 1 : 0);
  }
  getCheckpoint(scope: SourceScope): JSONValue | null {
    this.binding(scope);
    const row = this.store.get<{ cursor_json: string }>('SELECT cursor_json FROM sync_cursors WHERE source_id=?', scope.sourceId);
    return row ? JSON.parse(row.cursor_json) as JSONValue : null;
  }
  getEvent(projectId: string, eventId: InternalEventId): { event: NormalizedEventV1; receivedAt: string } | undefined {
    const row = this.store.get<EventRow>('SELECT * FROM source_events WHERE event_id=? AND project_id=?', eventId, projectId);
    return row ? { event: JSON.parse(row.payload_json) as NormalizedEventV1, receivedAt: row.received_at } : undefined;
  }
  reportHealth(scope: SourceScope, info: { coverage: SourceCoverage; reason?: string; checkedAt: string }): void {
    this.binding(scope);
    if (!['full', 'partial', 'unknown', 'unavailable'].includes(info.coverage)) throw new Error('INVALID_COVERAGE');
    const now = timestamp(info.checkedAt);
    this.store.run('UPDATE sources SET coverage=?,health_reason=?,health_checked_at=? WHERE source_id=? AND (health_checked_at IS NULL OR health_checked_at<=?)', info.coverage, info.reason ?? null, now, scope.sourceId, now);
  }
  dispatchOutbox(limit = 1_000): number {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_DISPATCH_LIMIT');
    return this.store.transaction(() => {
      const rows = this.store.all<{ id: number; event_id: string; project_id: string; handler_version: string }>(`SELECT o.id,o.event_id,e.project_id,o.handler_version FROM event_outbox o
        JOIN source_events e ON e.event_id=o.event_id WHERE o.status='pending' ORDER BY o.id LIMIT ?`, limit);
      for (const row of rows) {
        this.queue.create(row.project_id, 'feedback.admit', { eventId: row.event_id }, `admit:${row.handler_version}:${row.event_id}`);
        this.store.run("UPDATE event_outbox SET status='dispatched' WHERE id=?", row.id);
      }
      return rows.length;
    });
  }
  sourceHost(scope: SourceScope, options: { logger?: PluginLogger; secretKeys?: readonly string[]; getSecret?: (key: string) => Promise<string> } = {}): SourcePluginHostV1 {
    this.binding(scope);
    const boundScope = Object.freeze({ projectId: scope.projectId, sourceId: scope.sourceId });
    const keys = new Set(options.secretKeys ?? []);
    return Object.freeze({
      ...boundScope,
      logger: options.logger ?? silentLogger,
      getCheckpoint: async () => this.getCheckpoint(boundScope),
      commitBatch: async (events: readonly NormalizedEventV1[], checkpoint?: SyncCheckpointV1) => this.commitBatch(boundScope, events, checkpoint),
      getSecret: async (key: string) => {
        if (!keys.has(key) || !options.getSecret) throw new Error('SECRET_NOT_AUTHORIZED');
        return options.getSecret(key);
      },
      reportHealth: async (info: { coverage: SourceCoverage; reason?: string; checkedAt: string }) => this.reportHealth(boundScope, info),
    });
  }
}
