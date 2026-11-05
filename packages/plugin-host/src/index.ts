import { randomUUID } from 'node:crypto';
export { DiscordModuleHost, installDiscordState, discordPacketKey } from './discord-state.js';
import type { DeliveryPluginHostV1, DeliveryPluginV1, DeliveryRequestV1, DeliveryResultV1, PluginLogger } from '@superagent/plugin-sdk';
import type { JSONValue } from '@superagent/contracts';
import { parseContract } from '@superagent/contract-validation';
import { addMilliseconds, canonicalJSON, SqliteStore, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';

const quiet: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };
export function deliveryHost(plugin: DeliveryPluginV1, read: (key: string) => Promise<string>, logger: PluginLogger = quiet): DeliveryPluginHostV1 {
  const keys = new Set(plugin.manifest.permissions.secretKeys);
  return Object.freeze({ logger, getSecret: async (key: string) => { if (!keys.has(key)) throw new Error('SECRET_NOT_AUTHORIZED'); return read(key); } });
}
interface Row {
  operation_id: string; state: string; attempt: number; request_json: string;
  result_json: string | null; lease_owner: string | null; lease_until: string | null; purpose:'report'|'acceptance'|'interaction';
}
export interface DeliveryHostOptions {
  projectId: string; recipientRef: string; recipientBindingId: string; allowWrites?: boolean; clock?: Clock;
  leaseMs?: number; timeoutMs?: number; maxAttempts?: number;
  authorizeInteraction?: (request: DeliveryRequestV1) => void;
  authorizeDelivery?: (request: DeliveryRequestV1) => void;
}
/** Trusted, platform-independent Host owns the send intent and uncertainty barrier. */
export class DurableDeliveryService {
  constructor(readonly store: SqliteStore, readonly plugin: DeliveryPluginV1, private readonly host: DeliveryPluginHostV1, private readonly options: DeliveryHostOptions) {
    if (!options.projectId || !options.recipientRef || !options.recipientBindingId || (options.leaseMs ?? 60_000) <= (options.timeoutMs ?? 30_000)) throw new Error('INVALID_DELIVERY_HOST_CONFIGURATION');
    if (plugin.manifest.kind !== 'delivery' || plugin.manifest.permissions.deliverySend !== true) throw new Error('DELIVERY_PLUGIN_NOT_AUTHORIZED');
    this.store.transaction(() => {
      const old = store.get<{ binding_id: string }>('SELECT binding_id FROM plugin_delivery_bindings WHERE plugin_id=? AND project_id=? AND recipient_ref=?', plugin.manifest.id, options.projectId, options.recipientRef);
      if (old && old.binding_id !== options.recipientBindingId) throw new Error('DELIVERY_RECIPIENT_BINDING_CHANGED');
      if (!old) store.run('INSERT INTO plugin_delivery_bindings VALUES(?,?,?,?)', plugin.manifest.id, options.projectId, options.recipientRef, options.recipientBindingId);
    });
  }
  private now(): string { return timestamp((this.options.clock ?? systemClock)()); }
  enqueue(input: DeliveryRequestV1, purpose: 'report' | 'acceptance' | 'interaction' = 'report'): string {
    const request = parseContract('delivery-request-v1', input);
    if (request.projectId !== this.options.projectId || request.recipientRef !== this.options.recipientRef) throw new Error('DELIVERY_RECIPIENT_NOT_AUTHORIZED');
    if (purpose === 'acceptance' && (request.presentation || !request.title.startsWith('[QQ 验收]'))) throw new Error('DELIVERY_ACCEPTANCE_SCOPE_REQUIRED');
    if (purpose === 'interaction') { if (!this.options.authorizeInteraction) throw new Error('INTERACTION_DELIVERY_NOT_AUTHORIZED'); this.options.authorizeInteraction(request); }
    if (purpose === 'report') {
      const report = this.store.get<{ project_id: string }>('SELECT r.project_id FROM report_revisions r JOIN report_revision_seals s USING(report_id,revision) WHERE r.report_id=? AND r.revision=?', request.reportId, request.reportRevision ?? 0);
      if (report?.project_id !== request.projectId) throw new Error('SEALED_REPORT_NOT_AUTHORIZED');
    }
    const json = canonicalJSON(request as unknown as JSONValue);
    const requestHash = stableId('request', this.plugin.manifest.id, this.options.recipientBindingId, purpose, json);
    const id = stableId('external', this.plugin.manifest.id, request.idempotencyKey);
    return this.store.transaction(() => {
      const prior = this.store.get<{ request_hash: string }>('SELECT request_hash FROM external_operations WHERE idempotency_key=?', request.idempotencyKey);
      if (prior) { if (prior.request_hash !== requestHash) throw new Error('DELIVERY_IDENTITY_CONFLICT'); return id; }
      this.store.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES(?,'qq.c2c.send',?,?,?,'prepared',?,?)", id, request.recipientRef, request.idempotencyKey, requestHash, this.now(), this.now());
      this.store.run('INSERT INTO plugin_delivery_requests(operation_id,plugin_id,project_id,recipient_ref,purpose,request_json,next_attempt_at) VALUES(?,?,?,?,?,?,?)', id, this.plugin.manifest.id, request.projectId, request.recipientRef, purpose, json, this.now());
      return id;
    });
  }
  get(operationId: string): { state: string; result: DeliveryResultV1 | null } | null {
    const row = this.store.get<Row>('SELECT o.*,r.* FROM external_operations o JOIN plugin_delivery_requests r USING(operation_id) WHERE operation_id=? AND plugin_id=? AND project_id=? AND recipient_ref=?', operationId, this.plugin.manifest.id, this.options.projectId, this.options.recipientRef);
    return row ? { state: row.state, result: row.result_json ? JSON.parse(row.result_json) as DeliveryResultV1 : null } : null;
  }
  recover(): number {
    return Number(this.store.run(`UPDATE external_operations SET state='unknown',last_error='DELIVERY_SEND_WINDOW_EXPIRED',lease_owner=NULL,lease_until=NULL,updated_at=?
      WHERE kind='qq.c2c.send' AND state='in_flight' AND lease_until<=? AND operation_id IN (SELECT operation_id FROM plugin_delivery_requests WHERE plugin_id=? AND project_id=? AND recipient_ref=?)`, this.now(), this.now(), this.plugin.manifest.id, this.options.projectId, this.options.recipientRef).changes);
  }
  async tick(filter:{purpose?:'report'|'acceptance'|'interaction';operationId?:string}={}): Promise<{ processed: boolean; operationId?: string; state?: string }> {
    this.recover();
    if (!this.options.allowWrites) return { processed: false, state: 'write_disabled' };
    const row = this.store.get<Row>(`SELECT o.*,r.* FROM external_operations o JOIN plugin_delivery_requests r USING(operation_id)
      WHERE plugin_id=? AND project_id=? AND recipient_ref=? AND state IN ('prepared','safe_retry') AND next_attempt_at<=? ${filter.purpose?'AND purpose=?':''} ${filter.operationId?'AND operation_id=?':''} ORDER BY created_at,operation_id LIMIT 1`, this.plugin.manifest.id, this.options.projectId, this.options.recipientRef, this.now(),...(filter.purpose?[filter.purpose]:[]),...(filter.operationId?[filter.operationId]:[]));
    if (!row) return { processed: false };
    if (row.attempt >= (this.options.maxAttempts ?? 3)) {
      this.store.run("UPDATE external_operations SET state='manual_review',last_error='DELIVERY_RETRY_BUDGET' WHERE operation_id=? AND state='safe_retry'", row.operation_id);
      return { processed: false, operationId: row.operation_id, state: 'manual_review' };
    }
    const token = randomUUID();
    const claimed = this.store.transaction(() => {
      const n = Number(this.store.run("UPDATE external_operations SET state='in_flight',attempt=attempt+1,lease_owner=?,lease_until=?,updated_at=? WHERE operation_id=? AND state=?", token, addMilliseconds(this.now(), this.options.leaseMs ?? 60_000), this.now(), row.operation_id, row.state).changes);
      if (n) this.store.run('INSERT INTO external_operation_attempts(attempt_id,operation_id,attempt_number,started_at) VALUES(?,?,?,?)', stableId('attempt', row.operation_id, String(row.attempt + 1)), row.operation_id, row.attempt + 1, this.now());
      return n;
    });
    if (!claimed) return { processed: false };
    let timer: ReturnType<typeof setTimeout> | undefined; let result: DeliveryResultV1;
    try {
      const request=JSON.parse(row.request_json) as DeliveryRequestV1;
      try{const binding=this.store.get<{binding_id:string}>('SELECT binding_id FROM plugin_delivery_bindings WHERE plugin_id=? AND project_id=? AND recipient_ref=?',this.plugin.manifest.id,this.options.projectId,this.options.recipientRef);if(binding?.binding_id!==this.options.recipientBindingId)throw new Error('BINDING_CHANGED');this.options.authorizeDelivery?.(request);if(row.purpose==='interaction'){if(!this.options.authorizeInteraction)throw new Error();this.options.authorizeInteraction(request);}}catch{result={status:'blocked',errorCode:'DELIVERY_AUTHORIZATION_REVOKED'};throw result;}
      result = await Promise.race([
        this.plugin.send(request, this.host),
        new Promise<DeliveryResultV1>(resolve => { timer = setTimeout(() => resolve({ status: 'unknown', errorCode: 'DELIVERY_HOST_TIMEOUT' }), this.options.timeoutMs ?? 30_000); }),
      ]);
      result = parseContract('delivery-result-v1', result);
    } catch(error) { result = error&&typeof error==='object'&&'errorCode' in error&&error.errorCode==='DELIVERY_AUTHORIZATION_REVOKED'?{status:'blocked',errorCode:'DELIVERY_AUTHORIZATION_REVOKED'}:{ status: 'unknown', errorCode: 'DELIVERY_PLUGIN_UNKNOWN' }; }
    finally { if (timer) clearTimeout(timer); }
    const state = result.status === 'accepted' ? 'succeeded' : result.status === 'retryable' ? 'safe_retry' : result.status === 'unknown' ? 'unknown' : 'blocked';
    this.store.transaction(() => {
      const changed = Number(this.store.run("UPDATE external_operations SET state=?,provider_object_id=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=? AND state='in_flight' AND lease_owner=? AND lease_until>?", state, result.providerMessageId ?? null, result.errorCode ?? null, this.now(), row.operation_id, token, this.now()).changes);
      if (!changed) return;
      this.store.run('UPDATE plugin_delivery_requests SET result_json=?,next_attempt_at=? WHERE operation_id=?', canonicalJSON(result as unknown as JSONValue), addMilliseconds(this.now(), Math.max(30_000, result.retryAfterMs ?? 0)), row.operation_id);
      this.store.run('UPDATE external_operation_attempts SET finished_at=?,transport_outcome=? WHERE operation_id=? AND attempt_number=?', this.now(), state, row.operation_id, row.attempt + 1);
    });
    this.recover();
    return { processed: true, operationId: row.operation_id, state: this.get(row.operation_id)!.state };
  }
}
export { ReportDeliveryCoordinator } from './reports.js';
export { QQCardRetirementService } from './cards.js';
export type { MessageRecallPort } from './cards.js';
