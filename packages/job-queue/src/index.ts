import { randomUUID } from 'node:crypto';
import { parseContract } from '@superagent/contract-validation';
import { SqliteStore, canonicalJSON, systemClock, timestamp, addMilliseconds, stableId,ensureQQFeatures } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { AgentTaskV1, JSONValue, TaskStatus } from '@superagent/contracts';

export type QueueLane = 'ingress' | 'admission' | 'full_agent' | 'report' | 'delivery' | 'p0_alert';
export interface JobView {
  jobId: string; projectId: string; kind: AgentTaskV1['kind']; payload: JSONValue;
  lane: QueueLane; status: TaskStatus; attempt: number; leaseToken: string | null;
  leaseUntil: string | null; lastErrorCode: string | null;
}
interface JobRow {
  job_id: string; project_id: string; kind: AgentTaskV1['kind']; payload_json: string;
  lane: QueueLane; status: TaskStatus; attempt: number; max_attempts: number;
  lease_token: string | null; lease_until: string | null; last_error_code: string | null;
  priority: number; created_at: string;
  queue_sequence: number;
}
const view = (row: JobRow): JobView => ({ jobId: row.job_id, projectId: row.project_id, kind: row.kind,
  payload: JSON.parse(row.payload_json) as JSONValue, lane: row.lane, status: row.status,
  attempt: row.attempt, leaseToken: row.lease_token, leaseUntil: row.lease_until, lastErrorCode: row.last_error_code });
const external = (kind: string) => kind.includes('.github.') || kind === 'report.deliver' || kind === 'notification.p0.deliver';
export function laneFor(kind: AgentTaskV1['kind']): QueueLane {
  if (kind === 'feedback.admit' || kind === 'feedback.audit') return 'admission';
  if (kind === 'report.generate') return 'report';
  if (kind === 'report.deliver') return 'delivery';
  if (kind.startsWith('notification.p0.')) return 'p0_alert';
  return 'full_agent';
}

export class DurableJobQueue {
  constructor(readonly store: SqliteStore, readonly clock: Clock = systemClock,
    private readonly concurrency: Partial<Record<QueueLane, number>> = { full_agent: 3 }) {
    for (const limit of Object.values(concurrency)) if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_QUEUE_CONCURRENCY');
  }
  enqueue(task: AgentTaskV1, options: { lane?: QueueLane; maxAttempts?: number } = {}): JobView {
    parseContract('agent-task-v1', task);
    const lane = options.lane ?? laneFor(task.kind);
    if (lane !== laneFor(task.kind)) throw new Error('JOB_LANE_MISMATCH');
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('INVALID_RETRY_BUDGET');
    const payload = canonicalJSON(task.payload);
    return this.store.transaction(() => {
      const old = this.store.get<JobRow>('SELECT * FROM jobs WHERE project_id=? AND idempotency_key=?', task.projectId, task.idempotencyKey);
      if (old) {
        if (old.kind !== task.kind || old.payload_json !== payload || old.lane !== lane) throw new Error('JOB_IDEMPOTENCY_CONFLICT');
        return view(old);
      }
      this.store.run(`INSERT INTO jobs(job_id,project_id,kind,payload_json,idempotency_key,lane,priority,created_at,available_at,status,max_attempts)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`, task.id, task.projectId, task.kind, payload, task.idempotencyKey, lane, task.priority, timestamp(task.createdAt), timestamp(task.createdAt), maxAttempts);
      return this.get(task.id)!;
    });
  }
  create(projectId: string, kind: AgentTaskV1['kind'], payload: JSONValue, idempotencyKey: string, priority = 0): JobView {
    return this.enqueue({ id: stableId('job', projectId, idempotencyKey), projectId, kind, payload, idempotencyKey, priority, createdAt: timestamp(this.clock()) });
  }
  get(jobId: string): JobView | undefined { const row = this.store.get<JobRow>('SELECT * FROM jobs WHERE job_id=?', jobId); return row && view(row); }
  recoverExpired(now = this.clock()): number {
    now = timestamp(now);
    return Number(this.store.run(`UPDATE jobs SET
      status=CASE WHEN kind LIKE '%.github.%' OR kind IN ('report.deliver','notification.p0.deliver') OR attempt>=max_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
      last_error_code=CASE WHEN kind LIKE '%.github.%' OR kind IN ('report.deliver','notification.p0.deliver') THEN 'EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION' ELSE 'LEASE_EXPIRED' END,
      available_at=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL
      WHERE status IN ('leased','running') AND lease_until<=?`, now, now).changes);
  }
  claim(worker: string, lane: QueueLane, leaseMs = 30_000, kinds?: readonly AgentTaskV1['kind'][],fairPriority=false): JobView | undefined {
    if (!worker || !Number.isInteger(leaseMs) || leaseMs < 1) throw new Error('INVALID_LEASE');
    const now = timestamp(this.clock());
    if (kinds?.length === 0) return undefined;
    const filter = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    if(fairPriority)ensureQQFeatures(this.store);
    return this.store.transaction(() => {
      this.recoverExpired(now);
      const active = this.store.get<{ n: number }>("SELECT count(*) n FROM jobs WHERE lane=? AND status IN ('leased','running') AND lease_until>?", lane, now)!.n;
      if (active >= (this.concurrency[lane] ?? 1)) return undefined;
      const candidates = ['pending', 'retry_wait'].flatMap(status => {
        const row = this.store.get<JobRow>(`SELECT *,rowid AS queue_sequence FROM jobs WHERE lane=? AND status=? AND available_at<=?${filter} ORDER BY priority DESC,created_at,rowid LIMIT 1`, lane, status, now, ...(kinds ?? []));
        return row ? [row] : [];
      }).sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.queue_sequence - b.queue_sequence);
      let candidate = candidates[0];
      if(fairPriority&&(this.store.get<{burst:number}>('SELECT burst FROM queue_fairness WHERE lane=?',lane)?.burst??0)>=3){
        const ordinary=this.store.get<JobRow>(`SELECT *,rowid AS queue_sequence FROM jobs WHERE lane=? AND status IN ('pending','retry_wait') AND available_at<=? AND priority<50${filter} ORDER BY priority DESC,created_at,rowid LIMIT 1`,lane,now,...(kinds??[]));
        if(ordinary)candidate=ordinary;
      }
      if (!candidate) return undefined;
      if(fairPriority)this.store.run('INSERT INTO queue_fairness VALUES(?,?) ON CONFLICT(lane) DO UPDATE SET burst=excluded.burst',lane,candidate.priority>=50?Math.min(3,1+(this.store.get<{burst:number}>('SELECT burst FROM queue_fairness WHERE lane=?',lane)?.burst??0)):0);
      this.store.run("UPDATE jobs SET status='leased',attempt=attempt+1,lease_owner=?,lease_token=?,lease_until=? WHERE job_id=?", worker, randomUUID(), addMilliseconds(now, leaseMs), candidate.job_id);
      return this.get(candidate.job_id);
    });
  }
  private transition(jobId: string, token: string, sql: string, parameters: (string | number | null)[] = []): void {
    const result = this.store.run(`${sql} WHERE job_id=? AND lease_token=? AND status IN ('leased','running') AND lease_until>?`, ...parameters, jobId, token, timestamp(this.clock()));
    if (Number(result.changes) !== 1) throw new Error('JOB_LEASE_LOST');
  }
  start(jobId: string, token: string): void { this.transition(jobId, token, "UPDATE jobs SET status='running'"); }
  heartbeat(jobId: string, token: string, leaseMs = 30_000): void {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error('INVALID_LEASE');
    this.transition(jobId, token, 'UPDATE jobs SET lease_until=?', [addMilliseconds(timestamp(this.clock()), leaseMs)]);
  }
  complete(jobId: string, token: string): void {
    this.transition(jobId, token, "UPDATE jobs SET status='completed',completed_at=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL", [timestamp(this.clock())]);
  }
  fail(jobId: string, token: string, errorCode: string, retryable = true): void {
    if (!/^[A-Z0-9_]{1,100}$/.test(errorCode)) throw new Error('INVALID_ERROR_CODE');
    const job = this.store.get<JobRow>('SELECT * FROM jobs WHERE job_id=?', jobId);
    if (!job) throw new Error('JOB_LEASE_LOST');
    const retry = retryable && !external(job.kind) && job.attempt < job.max_attempts;
    this.transition(jobId, token, 'UPDATE jobs SET status=?,available_at=?,last_error_code=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL',
      [retry ? 'retry_wait' : 'dead_letter', addMilliseconds(timestamp(this.clock()), Math.min(60_000, 1_000 * 2 ** (job.attempt - 1))), external(job.kind) ? 'EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION' : errorCode]);
  }
  cancel(jobId: string): boolean {
    const job = this.get(jobId);
    if (job && external(job.kind) && (job.status === 'leased' || job.status === 'running')) throw new Error('EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION');
    return Number(this.store.run("UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE job_id=? AND status IN ('pending','retry_wait','leased','running')", jobId).changes) === 1;
  }
}
