import { SqliteStore, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DurableJobQueue } from '@superagent/job-queue';
import { IngressService } from '@superagent/ingress';
import { PersistentFeedbackBuffer, validateBatchingPolicy } from '@superagent/feedback-buffer';
import type { BatchingPolicyV1, InternalEventId } from '@superagent/contracts';
import { setTimeout as delay } from 'node:timers/promises';

/** M1 local pipeline. Full-Agent, report and external-send workers are not installed. */
export class M1Runtime {
  readonly store: SqliteStore;
  readonly queue: DurableJobQueue;
  readonly ingress: IngressService;
  readonly buffer: PersistentFeedbackBuffer;
  private readonly clock: Clock;
  constructor(filename: string, options: { policy: BatchingPolicyV1; clock?: Clock; idFactory?: () => string }) {
    const policy = validateBatchingPolicy(options.policy);
    this.clock = options.clock ?? systemClock;
    this.store = new SqliteStore(filename);
    try {
      this.queue = new DurableJobQueue(this.store, this.clock, { full_agent: policy.maxConcurrentFullAgentJobs });
      this.ingress = new IngressService(this.store, this.queue, this.clock, options.idFactory);
      this.buffer = new PersistentFeedbackBuffer(this.store, this.queue, policy, this.clock);
    } catch (error) { this.store.close(); throw error; }
  }
  async accept(eventId: InternalEventId): Promise<{ jobId: string }> {
    const event = this.store.get<{ project_id: string }>('SELECT project_id FROM source_events WHERE event_id=?', eventId);
    if (!event) throw new Error('EVENT_NOT_FOUND');
    return { jobId: this.queue.create(event.project_id, 'feedback.admit', { eventId }, `admit:admission-v1:${eventId}`).jobId };
  }
  tick(options: { maxAdmissions?: number; workerId?: string } = {}): { dispatched: number; admitted: number; failed: number; flushed: number; recoveredJobs: number } {
    const limit = options.maxAdmissions ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('INVALID_TICK_LIMIT');
    const recoveredJobs = this.queue.recoverExpired();
    const dispatched = this.ingress.dispatchOutbox(limit);
    let admitted = 0;
    let failed = 0;
    // A bounded slice commits admission effects and local acknowledgements
    // together. No network or await is allowed inside this transaction.
    this.store.transaction(() => {
      for (let i = 0; i < limit; i++) {
        const job = this.queue.claim(options.workerId ?? 'm1-admission', 'admission', 30_000, ['feedback.admit']);
        if (!job) break;
        const token = job.leaseToken!;
        this.queue.start(job.jobId, token);
        try {
          if (job.kind !== 'feedback.admit' || !job.payload || Array.isArray(job.payload) || typeof job.payload !== 'object' || typeof job.payload.eventId !== 'string') throw new Error('INVALID_ADMISSION_TASK');
          const eventId = job.payload.eventId as InternalEventId;
          if (!this.ingress.getEvent(job.projectId, eventId)) throw new Error('EVENT_PROJECT_MISMATCH');
          this.buffer.admitSync(eventId);
          this.queue.complete(job.jobId, token);
          admitted++;
        } catch {
          this.queue.fail(job.jobId, token, 'ADMISSION_FAILED');
          failed++;
        }
      }
    });
    return { dispatched, admitted, failed, flushed: this.buffer.recoverStaleSync(this.clock()), recoveredJobs };
  }
  metrics(): Record<string, unknown> {
    const count = (sql: string) => this.store.get<{ n: number }>(sql)!.n;
    const oldest = this.store.get<{ oldest: string | null }>("SELECT min(created_at) oldest FROM jobs WHERE status IN ('pending','retry_wait','leased','running')")!.oldest;
    return {
      sourceEventsIngested: count('SELECT count(*) n FROM source_events'),
      pendingReconciliations: count("SELECT count(*) n FROM source_reconciliations WHERE status='pending'"),
      pendingOutbox: count("SELECT count(*) n FROM event_outbox WHERE status='pending'"),
      admissionDecisions: count('SELECT count(*) n FROM admission_decisions'),
      archivedEvents: count("SELECT count(*) n FROM admission_decisions WHERE decision='archive_only'"),
      archivedEventsAudited: count("SELECT count(*) n FROM admission_decisions WHERE decision='audit_sample'"),
      openSegments: count("SELECT count(*) n FROM conversation_segments WHERE state='open'"),
      feedbackBatches: count('SELECT count(*) n FROM feedback_batches'),
      fullAgentJobs: count("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage'"),
      pendingAnalysis: count("SELECT count(*) n FROM source_events e WHERE NOT EXISTS(SELECT 1 FROM admission_decisions a WHERE a.event_id=e.event_id) OR EXISTS(SELECT 1 FROM segment_events se JOIN conversation_segments s ON s.segment_id=se.segment_id WHERE se.event_id=e.event_id AND se.role='candidate' AND s.state='open') OR EXISTS(SELECT 1 FROM batch_events b JOIN jobs j ON j.kind='feedback.batch.triage' AND json_extract(j.payload_json,'$.batchId')=b.batch_id WHERE b.event_id=e.event_id AND b.role='candidate' AND j.status<>'completed')"),
      oldestPendingSeconds: oldest ? Math.max(0, (Date.parse(timestamp(this.clock())) - Date.parse(oldest)) / 1_000) : 0,
      queue: this.store.all('SELECT lane,status,count(*) count FROM jobs GROUP BY lane,status ORDER BY lane,status'),
      batchFlushReasons: this.store.all('SELECT reason,count(*) count FROM feedback_batches GROUP BY reason ORDER BY reason'),
      sources: this.store.all('SELECT project_id,source_id,coverage,health_reason FROM sources ORDER BY source_id'),
    };
  }
  async run(signal: AbortSignal, options: { pollIntervalMs?: number; maxAdmissions?: number; onTick?: (result: ReturnType<M1Runtime['tick']>) => void } = {}): Promise<void> {
    const interval = options.pollIntervalMs ?? 1_000;
    if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) throw new Error('INVALID_POLL_INTERVAL');
    while (!signal.aborted) {
      const result = this.tick(options);
      options.onTick?.(result);
      try { await delay(interval, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
  close(): void { this.store.close(); }
}
