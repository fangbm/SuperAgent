import { createHash } from 'node:crypto';
import { parseContract } from '@superagent/contract-validation';
import { SqliteStore, canonicalJSON, systemClock, timestamp, addMilliseconds, stableId, isRestrictedProject } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DurableJobQueue } from '@superagent/job-queue';
import type { AdmissionDecisionV1, AdmissionKindV1, BatchingPolicyV1, BatchFlushReasonV1, FeedbackBatchV1, FeedbackBufferV1, InternalEventId, JSONValue, NormalizedEventV1 } from '@superagent/contracts';

interface DecisionRow { decision: AdmissionKindV1; rationale_code: string; decided_at: string }
interface SegmentRow {
  segment_id: string; project_id: string; source_id: string; segment_key: string;
  policy_version: string; revision: number; state: 'open' | 'flushed'; candidate_count: number;
  quiet_due_at: string; max_due_at: string; urgent_due_at: string | null;
  replay: number; policy_json: string; context_omitted: number;
}
interface EventRow { event_id: InternalEventId; project_id: string; source_id: string; payload_json: string; received_at: string }

export function validateBatchingPolicy(input: BatchingPolicyV1): Readonly<BatchingPolicyV1> {
  const policy: BatchingPolicyV1 = { policyVersion: input.policyVersion, quietWindowMs: input.quietWindowMs, maxWaitMs: input.maxWaitMs,
    maxCandidateMessages: input.maxCandidateMessages, maxContextMessages: input.maxContextMessages,
    urgentMaxDelayMs: input.urgentMaxDelayMs, auditSampleRate: input.auditSampleRate, maxConcurrentFullAgentJobs: input.maxConcurrentFullAgentJobs };
  for (const field of ['quietWindowMs', 'maxWaitMs', 'maxCandidateMessages', 'urgentMaxDelayMs', 'maxConcurrentFullAgentJobs'] as const) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 1) throw new Error('INVALID_BATCHING_POLICY');
  }
  if (!policy.policyVersion?.trim() || !Number.isSafeInteger(policy.maxContextMessages) || policy.maxContextMessages < 0 ||
    !Number.isFinite(policy.auditSampleRate) || policy.auditSampleRate < 0 || policy.auditSampleRate > 1 ||
    policy.maxWaitMs < policy.quietWindowMs || policy.urgentMaxDelayMs > policy.maxWaitMs) throw new Error('INVALID_BATCHING_POLICY');
  return Object.freeze(policy);
}

/** A low-cost lexical check, applied to body and thread title independently. */
function isTrivialText(value: string): boolean {
  const text = value.trim();
  return !text || /^(?:早上好|晚上好|大家好|你好|谢谢|哈哈+|hi|hello|thanks|lol)[!！。,.，\s]*$/iu.test(text)
    || /^[\p{P}\p{S}\s]+$/u.test(text);
}
/** Title is signed source evidence, not inferred from a snippet of the body. */
function threadTitle(event: Exclude<NormalizedEventV1,{type:'com.superagent.source.coverage.changed.v1'}>): string {
  return event.data.object.kind === 'thread' && typeof event.data.attributes?.title === 'string'
    ? event.data.attributes.title.trim() : '';
}

/** Conservative, reversible rules. Unknown substantive text remains a candidate. */
export function classifyAdmission(event: NormalizedEventV1, eventId: InternalEventId, policy: BatchingPolicyV1): { decision: AdmissionKindV1; rationale: string } {
  if (event.type === 'com.superagent.source.coverage.changed.v1') return { decision: 'archive_only', rationale: 'SOURCE_HEALTH_EVENT' };
  if (event.type.includes('.deleted.') || event.type.includes('.updated.')) return { decision: 'candidate', rationale: 'SOURCE_REVISION_REPROCESS' };
  const body = event.data.content?.text?.trim() ?? '';
  const title = threadTitle(event);
  const text = [title, body].filter(Boolean).join('\n');
  if (/(?:存档|save).*(?:损坏|丢失|corrupt|lost)|(?:账号|account).*(?:被盗|泄露|exploit)/iu.test(text)) return { decision: 'urgent_candidate', rationale: 'URGENT_REQUIRES_VERIFICATION' };
  if (event.data.content?.attachments?.length) return { decision: 'candidate', rationale: 'ATTACHMENT_REQUIRES_REVIEW' };
  const trivial = isTrivialText(body) && isTrivialText(title);
  if (trivial) {
    const sample = createHash('sha256').update(JSON.stringify([eventId, policy.policyVersion])).digest().readUInt32BE(0) / 0x1_0000_0000;
    return sample < policy.auditSampleRate ? { decision: 'audit_sample', rationale: 'ARCHIVE_AUDIT_SAMPLE' } : { decision: 'archive_only', rationale: 'EXPLICIT_NON_ACTIONABLE' };
  }
  if (/闪退|崩溃|报错|卡顿|无法|希望|建议|增加|bug|crash|error|please add/iu.test(text)) return { decision: 'candidate', rationale: 'FEEDBACK_SIGNAL' };
  if (text.length < 8) return { decision: 'needs_context', rationale: 'SHORT_UNCERTAIN_TEXT' };
  return { decision: 'candidate', rationale: 'SUBSTANTIVE_UNKNOWN_RETAINED' };
}

export class PersistentFeedbackBuffer implements FeedbackBufferV1 {
  readonly policy: Readonly<BatchingPolicyV1>;
  constructor(readonly store: SqliteStore, private readonly queue: DurableJobQueue, policy: BatchingPolicyV1, private readonly clock: Clock = systemClock) {
    this.policy = validateBatchingPolicy(policy);
    this.registerPolicy(this.policy);
  }
  private registerPolicy(policy: BatchingPolicyV1): void {
    const json = canonicalJSON(policy as unknown as JSONValue);
    const old = this.store.get<{ policy_json: string }>('SELECT policy_json FROM buffer_policies WHERE policy_version=?', policy.policyVersion);
    if (old && old.policy_json !== json) throw new Error('POLICY_VERSION_REUSED');
    if (!old) this.store.run('INSERT INTO buffer_policies VALUES(?,?)', policy.policyVersion, json);
  }
  async admit(eventId: InternalEventId): Promise<AdmissionDecisionV1> { return this.admitSync(eventId); }
  admitSync(eventId: InternalEventId, policy: BatchingPolicyV1 = this.policy, forced = false): AdmissionDecisionV1 {
    return this.store.transaction(() => {
      const old = this.store.get<DecisionRow>('SELECT * FROM admission_decisions WHERE event_id=? AND policy_version=?', eventId, policy.policyVersion);
      if(old){
        const pending=!forced&&this.store.get('SELECT 1 FROM qq_explicit_feedback WHERE event_id=? AND outcome IS NULL',eventId);
        const sealed=this.store.get("SELECT 1 FROM batch_events WHERE event_id=? AND role='candidate'",eventId);
        if(pending&&!sealed){
          const memberships=this.store.all<{segment_id:string}>("SELECT se.segment_id FROM segment_events se JOIN conversation_segments s USING(segment_id) WHERE se.event_id=? AND se.role='candidate' AND s.state='open'",eventId);
          for(const member of memberships){this.store.run('DELETE FROM segment_events WHERE segment_id=? AND event_id=?',member.segment_id,eventId);this.store.run('UPDATE conversation_segments SET candidate_count=candidate_count-1 WHERE segment_id=?',member.segment_id);
            if(this.store.get<{candidate_count:number}>('SELECT candidate_count FROM conversation_segments WHERE segment_id=?',member.segment_id)!.candidate_count===0){this.store.run('DELETE FROM segment_events WHERE segment_id=?',member.segment_id);this.store.run('DELETE FROM conversation_segments WHERE segment_id=?',member.segment_id);}
          }
          this.store.run('DELETE FROM admission_decisions WHERE event_id=? AND policy_version=?',eventId,policy.policyVersion);
        }else{if(pending)this.store.run("UPDATE qq_explicit_feedback SET outcome='QQ_EXPLICIT_ALREADY_BATCHED' WHERE event_id=?",eventId);return {schemaVersion:'1.0',eventId,policyVersion:policy.policyVersion,decision:old.decision,rationaleCode:old.rationale_code,decidedAt:old.decided_at};}
      }
      const stored = this.store.get<EventRow>('SELECT * FROM source_events WHERE event_id=?', eventId);
      if (!stored) throw new Error('EVENT_NOT_FOUND');
      if(isRestrictedProject(this.store,stored.project_id)){
        if(forced)throw new Error('PRIVATE_PROJECT_PROCESSING_NOT_AUTHORIZED');
        const now=timestamp(this.clock());this.store.run('INSERT INTO admission_decisions VALUES(?,?,?,?,?)',eventId,policy.policyVersion,'archive_only','STAFF_ONLY_PROJECT',now);
        return {schemaVersion:'1.0',eventId,policyVersion:policy.policyVersion,decision:'archive_only',rationaleCode:'STAFF_ONLY_PROJECT',decidedAt:now};
      }
      const event = JSON.parse(stored.payload_json) as NormalizedEventV1;
      const now = timestamp(this.clock());
      const explicit=this.store.get<{intent_json:string;config_json:string}>('SELECT intent_json,config_json FROM qq_explicit_feedback WHERE event_id=?',eventId);
      if(!forced&&explicit&&event.type!=='com.superagent.source.coverage.changed.v1')return this.admitExplicit(stored,event,explicit,policy,now);
      let result = forced ? { decision: 'candidate' as const, rationale: 'MANUAL_ARCHIVE_REPROCESS' } : classifyAdmission(event, eventId, policy);
      // A queued later edit must never be mistaken for an already-admitted
      // predecessor. Skip only when the immediately preceding *earlier* event
      // was itself safely archived as trivial. Pending/relevant predecessors,
      // attachments and material thread titles all retain reanalysis.
      if (!forced && event.type !== 'com.superagent.source.coverage.changed.v1'
        && event.type.includes('.updated.') && typeof event.data.content?.text === 'string'
        && !event.data.content.attachments?.length
        && isTrivialText(event.data.content.text) && isTrivialText(threadTitle(event))) {
        const previous = this.store.get<{ payload_json: string; decision: string | null; rationale_code: string | null }>(`
          SELECT prior.payload_json, admission.decision, admission.rationale_code
          FROM source_events prior
          LEFT JOIN admission_decisions admission
            ON admission.event_id=prior.event_id AND admission.policy_version=?
          WHERE prior.source_id=? AND prior.rowid<(SELECT rowid FROM source_events WHERE event_id=?)
            AND json_extract(prior.payload_json,'$.data.object.externalId')=?
          ORDER BY prior.rowid DESC LIMIT 1`,
          policy.policyVersion, stored.source_id, eventId, event.data.object.externalId);
        if (previous?.decision === 'archive_only'
          && (previous.rationale_code === 'EXPLICIT_NON_ACTIONABLE' || previous.rationale_code === 'TRIVIAL_REVISION')) {
          const old = JSON.parse(previous.payload_json) as NormalizedEventV1;
          if (old.type !== 'com.superagent.source.coverage.changed.v1'
            && isTrivialText(old.data.content?.text ?? '') && isTrivialText(threadTitle(old))
            && !old.data.content?.attachments?.length)
            result = { decision: 'archive_only', rationale: 'TRIVIAL_REVISION' };
        }
      }
      this.store.run('INSERT INTO admission_decisions VALUES(?,?,?,?,?)', eventId, policy.policyVersion, result.decision, result.rationale, now);
      const alreadyCandidate = this.store.get("SELECT 1 FROM segment_events WHERE event_id=? AND role='candidate' LIMIT 1", eventId);
      // Re-evaluating a policy never invents a second player feedback entity.
      // Explicit model reanalysis belongs to the later analysis workflow.
      if (!alreadyCandidate && event.type !== 'com.superagent.source.coverage.changed.v1') {
        const object = this.store.get<{ conversation_key: string }>('SELECT conversation_key FROM source_event_routes WHERE event_id=?', eventId);
        const key = object?.conversation_key ?? (event.data.object.threadExternalId ? `thread:${event.data.object.threadExternalId}` : `object:${event.data.object.parentExternalId ?? event.data.object.externalId}`);
        let segment = this.store.get<SegmentRow>("SELECT * FROM conversation_segments WHERE source_id=? AND segment_key=? AND policy_version=? AND state='open'", stored.source_id, key, policy.policyVersion);
        if (segment && this.dueReason(segment, now)) { this.flushSync(segment.segment_id, this.dueReason(segment, now)!); segment = undefined; }
        if (result.decision !== 'archive_only') {
          if (!segment) segment = this.openSegment(stored, key, policy, now);
          const membership = this.store.get<{ role: string }>('SELECT role FROM segment_events WHERE segment_id=? AND event_id=?', segment.segment_id, eventId);
          if (membership?.role !== 'candidate') {
            this.store.run("INSERT INTO segment_events VALUES(?,?,'candidate') ON CONFLICT(segment_id,event_id) DO UPDATE SET role='candidate'", segment.segment_id, eventId);
            this.store.run('UPDATE conversation_segments SET candidate_count=candidate_count+1 WHERE segment_id=?', segment.segment_id);
          }
          const parentId = event.data.object.parentExternalId ?? event.data.object.threadExternalId;
          if (parentId) {
            const parent = this.store.get<{ event_id: string }>('SELECT event_id FROM source_objects WHERE source_id=? AND external_id=? AND deleted=0', stored.source_id, parentId);
            if (parent && parent.event_id !== eventId) this.addContext(segment.segment_id, parent.event_id, policy.maxContextMessages);
          }
          // Comments and original reviews live in separate Sources. Carry only
          // exact same-project, same-app Steam review context into the M3 batch.
          const attrs = event.data.attributes;
          if (event.data.platform === 'steam-reviews' && event.data.object.kind === 'comment'
            && attrs?.surface === 'review-comments' && typeof attrs.parentReviewSourceId === 'string'
            && typeof attrs.appId === 'number' && typeof event.data.object.parentExternalId === 'string'
            && attrs.parentRecommendationId === event.data.object.parentExternalId
            && attrs.parentReviewSourceId !== stored.source_id) {
            const review = this.store.get<{ event_id: string }>(`SELECT o.event_id FROM source_objects o
              JOIN sources s ON s.source_id=o.source_id AND s.project_id=? AND s.platform='steam-reviews'
              JOIN source_events e ON e.event_id=o.event_id AND e.project_id=? AND e.source_id=o.source_id
              WHERE o.source_id=? AND o.external_id=? AND o.object_kind='review' AND o.deleted=0
                AND json_extract(e.payload_json,'$.data.platform')='steam-reviews'
                AND json_extract(e.payload_json,'$.data.attributes.appId')=?
                AND json_extract(e.payload_json,'$.data.object.externalId')=?`,
              stored.project_id, stored.project_id, attrs.parentReviewSourceId,
              event.data.object.parentExternalId, attrs.appId, event.data.object.parentExternalId);
            if (review && review.event_id !== eventId) this.addContext(segment.segment_id, review.event_id, policy.maxContextMessages);
          }
          this.store.run('UPDATE conversation_segments SET last_related_at=?,quiet_due_at=?,urgent_due_at=CASE WHEN ?=1 THEN coalesce(urgent_due_at,?) ELSE urgent_due_at END,replay=max(replay,?) WHERE segment_id=?',
            now, addMilliseconds(now, policy.quietWindowMs), result.decision === 'urgent_candidate' ? 1 : 0, addMilliseconds(now, policy.urgentMaxDelayMs), forced || event.type.includes('.updated.') || event.type.includes('.deleted.') ? 1 : 0, segment.segment_id);
          const total = this.store.get<{ n: number }>("SELECT coalesce(sum(candidate_count),0) n FROM conversation_segments WHERE source_id=? AND policy_version=? AND state='open'", stored.source_id, policy.policyVersion)!.n;
          if (total >= policy.maxCandidateMessages) this.flushSync(segment.segment_id, 'size_limit');
        } else if (segment) {
          this.addContext(segment.segment_id, eventId, policy.maxContextMessages);
          this.store.run('UPDATE conversation_segments SET last_related_at=?,quiet_due_at=? WHERE segment_id=?', now, addMilliseconds(now, policy.quietWindowMs), segment.segment_id);
        }
      }
      return { schemaVersion: '1.0', eventId, policyVersion: policy.policyVersion, decision: result.decision, rationaleCode: result.rationale, decidedAt: now };
    });
  }
  private openSegment(event: EventRow, key: string, policy: BatchingPolicyV1, now: string): SegmentRow {
    const revision = this.store.get<{ n: number }>('SELECT coalesce(max(revision),0)+1 n FROM conversation_segments WHERE source_id=? AND segment_key=? AND policy_version=?', event.source_id, key, policy.policyVersion)!.n;
    const id = stableId('segment', event.project_id, event.source_id, key, policy.policyVersion, String(revision));
    this.store.run(`INSERT INTO conversation_segments(segment_id,project_id,source_id,segment_key,policy_version,revision,state,opened_at,last_related_at,quiet_due_at,max_due_at,policy_json)
      VALUES(?,?,?,?,?,?,'open',?,?,?,?,?)`, id, event.project_id, event.source_id, key, policy.policyVersion, revision, now, now, addMilliseconds(now, policy.quietWindowMs), addMilliseconds(now, policy.maxWaitMs), canonicalJSON(policy as unknown as JSONValue));
    // Only carry the immediately preceding conversation slice. Every omitted
    // item remains in the source event store; metadata records truncation.
    const prior = this.store.get<{ segment_id: string }>("SELECT segment_id FROM conversation_segments WHERE source_id=? AND segment_key=? AND state='flushed' ORDER BY revision DESC LIMIT 1", event.source_id, key);
    if (prior) {
      const context = this.store.all<{ event_id: string }>(`SELECT se.event_id FROM segment_events se JOIN source_events e ON e.event_id=se.event_id
        WHERE se.segment_id=? AND NOT EXISTS(SELECT 1 FROM source_objects o WHERE o.source_id=e.source_id AND o.external_id=json_extract(e.payload_json,'$.data.object.externalId') AND o.deleted=1)
        ORDER BY e.received_at DESC,e.event_id`, prior.segment_id);
      for (const row of context) this.addContext(id, row.event_id, policy.maxContextMessages);
    }
    const archiveQuery = `FROM source_event_routes route JOIN source_events e ON e.event_id=route.event_id
      JOIN source_objects o ON o.source_id=route.source_id AND o.external_id=json_extract(e.payload_json,'$.data.object.externalId')
      JOIN admission_decisions a ON a.event_id=e.event_id AND a.policy_version=? AND a.decision='archive_only'
      WHERE route.source_id=? AND route.conversation_key=? AND o.deleted=0 AND route.received_at>=? AND route.received_at<=?
      AND NOT EXISTS(SELECT 1 FROM segment_events se WHERE se.segment_id=? AND se.event_id=route.event_id)`;
    const archiveParameters = [policy.policyVersion, event.source_id, key, addMilliseconds(now, -policy.maxWaitMs), now, id];
    const archiveCount = this.store.get<{ n: number }>(`SELECT count(*) n ${archiveQuery}`, ...archiveParameters)!.n;
    const archivedContext = this.store.all<{ event_id: string }>(`SELECT e.event_id ${archiveQuery} ORDER BY route.received_at DESC,route.event_id LIMIT ?`, ...archiveParameters, policy.maxContextMessages + 1);
    for (const row of archivedContext) this.addContext(id, row.event_id, policy.maxContextMessages);
    if (archiveCount > archivedContext.length) this.store.run('UPDATE conversation_segments SET context_omitted=context_omitted+? WHERE segment_id=?', archiveCount - archivedContext.length, id);
    return this.store.get<SegmentRow>('SELECT * FROM conversation_segments WHERE segment_id=?', id)!;
  }
  private addContext(segmentId: string, eventId: string, limit: number): void {
    if (this.store.get('SELECT 1 FROM segment_events WHERE segment_id=? AND event_id=?', segmentId, eventId)) return;
    const count = this.store.get<{ n: number }>("SELECT count(*) n FROM segment_events WHERE segment_id=? AND role='context'", segmentId)!.n;
    if (count < limit) this.store.run("INSERT INTO segment_events VALUES(?,?,'context')", segmentId, eventId);
    else this.store.run('UPDATE conversation_segments SET context_omitted=context_omitted+1 WHERE segment_id=?', segmentId);
  }
  async flush(segmentId: string, reason: BatchFlushReasonV1): Promise<string> { return this.flushSync(segmentId, reason); }
  flushSync(segmentId: string, reason: BatchFlushReasonV1, isolated=false): string {
    if (!['quiet_timeout', 'max_wait', 'size_limit', 'urgent', 'replay'].includes(reason)) throw new Error('INVALID_FLUSH_REASON');
    return this.store.transaction(() => {
      const target = this.store.get<SegmentRow>('SELECT * FROM conversation_segments WHERE segment_id=?', segmentId);
      if (!target) throw new Error('SEGMENT_NOT_FOUND');
      if (target.state === 'flushed') return this.store.get<{ batch_id: string }>('SELECT batch_id FROM batch_segments WHERE segment_id=?', segmentId)!.batch_id;
      const policy = JSON.parse(target.policy_json) as BatchingPolicyV1;
      const selected = [target];
      let total = target.candidate_count;
      if (total < 1 || total > policy.maxCandidateMessages) throw new Error('INVALID_SEGMENT_SIZE');
      const others = this.store.all<SegmentRow>("SELECT * FROM conversation_segments WHERE source_id=? AND policy_version=? AND state='open' AND segment_id<>? ORDER BY opened_at,segment_id", target.source_id, target.policy_version, segmentId);
      for (const segment of others) if (!isolated&&!target.segment_key.startsWith('qq-explicit:')&&!segment.segment_key.startsWith('qq-explicit:')&&segment.candidate_count > 0 && total + segment.candidate_count <= policy.maxCandidateMessages) { selected.push(segment); total += segment.candidate_count; }
      selected.sort((a, b) => a.segment_id.localeCompare(b.segment_id));
      const candidates = new Set<InternalEventId>();
      const contexts = new Set<InternalEventId>();
      for (const segment of selected) {
        for (const row of this.store.all<{ event_id: InternalEventId; role: string }>('SELECT event_id,role FROM segment_events WHERE segment_id=? ORDER BY event_id', segment.segment_id)) {
          if (row.role === 'candidate') candidates.add(row.event_id); else contexts.add(row.event_id);
        }
      }
      for (const candidate of candidates) contexts.delete(candidate);
      const contextIds = [...contexts].slice(0, policy.maxContextMessages);
      const urgent = selected.some(segment => segment.urgent_due_at !== null);
      const batch: FeedbackBatchV1 = { schemaVersion: '1.0', batchId: stableId('batch', target.project_id, target.source_id, target.policy_version, ...selected.map(s => s.segment_id)),
        projectId: target.project_id, sourceId: target.source_id, segmentIds: selected.map(s => s.segment_id), candidateEventIds: [...candidates], contextEventIds: contextIds,
        policyVersion: target.policy_version, revision: 1, reason: urgent ? 'urgent' : selected.some(s => s.replay) ? 'replay' : reason, createdAt: timestamp(this.clock()) };
      parseContract('feedback-batch-v1', batch);
      this.store.run('INSERT INTO feedback_batches VALUES(?,?,?,?,?,?,?,?)', batch.batchId, batch.projectId, batch.sourceId, batch.policyVersion, batch.createdAt, batch.reason,
        canonicalJSON(batch as unknown as JSONValue), contexts.size - contextIds.length + selected.reduce((n, s) => n + s.context_omitted, 0));
      for (const segment of selected) {
        this.store.run('INSERT INTO batch_segments VALUES(?,?)', batch.batchId, segment.segment_id);
        this.store.run("UPDATE conversation_segments SET state='flushed' WHERE segment_id=?", segment.segment_id);
      }
      for (const id of batch.candidateEventIds) this.store.run("INSERT INTO batch_events VALUES(?,?,'candidate')", batch.batchId, id);
      for (const id of batch.contextEventIds) this.store.run("INSERT INTO batch_events VALUES(?,?,'context')", batch.batchId, id);
      this.queue.create(batch.projectId, 'feedback.batch.triage', { batchId: batch.batchId }, `triage:${batch.batchId}`, urgent ? 100 : target.segment_key.startsWith('qq-explicit:')?50:0);
      return batch.batchId;
    });
  }
  private admitExplicit(stored:EventRow,event:Exclude<NormalizedEventV1,{type:'com.superagent.source.coverage.changed.v1'}>,record:{intent_json:string;config_json:string},policy:BatchingPolicyV1,now:string):AdmissionDecisionV1 {
    const config=JSON.parse(record.config_json) as {allowReplyContext:boolean;maxDescriptionLength:number;rateWindowMs:number;perUserRateLimit:number;perGroupRateLimit:number;perProjectRateLimit:number},intent=JSON.parse(record.intent_json) as {start:number};
    const body=(event.data.content?.text??'').slice(intent.start).trim();
    const parent=config.allowReplyContext&&event.data.object.parentExternalId?this.store.get<{event_id:string;payload_json:string}>(`SELECT e.event_id,e.payload_json FROM source_objects o JOIN source_events e ON e.event_id=o.event_id WHERE o.source_id=? AND o.external_id=? AND o.deleted=0 AND e.project_id=? AND json_extract(e.payload_json,'$.data.object.threadExternalId')=?`,stored.source_id,event.data.object.parentExternalId,stored.project_id,event.data.object.threadExternalId??''):undefined;
    const parentEvent=parent?JSON.parse(parent.payload_json) as NormalizedEventV1:undefined;
    const readable=policy.maxContextMessages>0&&parentEvent&&parentEvent.type!=='com.superagent.source.coverage.changed.v1'&&Boolean(parentEvent.data.content?.text?.trim());
    let rationale=!body&&!event.data.content?.attachments?.length&&!readable?'QQ_EXPLICIT_EMPTY':body.length>config.maxDescriptionLength?'QQ_EXPLICIT_DESCRIPTION_LIMIT':'QQ_EXPLICIT_IMMEDIATE';
    const window=new Date(Math.floor(Date.parse(now)/config.rateWindowMs)*config.rateWindowMs).toISOString();
    const limits:[string,string,number][]=[['user',stableId('qq-rate',stored.source_id,event.data.actor?.opaqueId??'unknown'),config.perUserRateLimit],['group',stored.source_id,config.perGroupRateLimit],['project',stored.project_id,config.perProjectRateLimit]];
    if(rationale==='QQ_EXPLICIT_IMMEDIATE'){
      for(const [scope,key,max] of limits)if((this.store.get<{used:number}>('SELECT used FROM qq_feedback_rate WHERE scope=? AND identity=? AND window_start=?',scope,key,window)?.used??0)>=max){rationale=`QQ_EXPLICIT_RATE_${scope.toUpperCase()}`;break;}
      if(rationale==='QQ_EXPLICIT_IMMEDIATE')for(const [scope,key]of limits)this.store.run('INSERT INTO qq_feedback_rate VALUES(?,?,?,1) ON CONFLICT(scope,identity,window_start) DO UPDATE SET used=used+1',scope,key,window);
    }
    const decision=rationale==='QQ_EXPLICIT_IMMEDIATE'?'candidate':'archive_only';
    this.store.run('INSERT INTO admission_decisions VALUES(?,?,?,?,?)',stored.event_id,policy.policyVersion,decision,rationale,now);
    let batchId:string|null=null;
    if(decision==='candidate'){
      const segment=this.openSegment(stored,`qq-explicit:${stored.event_id}`,policy,now);
      this.store.run("INSERT INTO segment_events VALUES(?,?,'candidate')",segment.segment_id,stored.event_id);
      if(parent)this.addContext(segment.segment_id,parent.event_id,policy.maxContextMessages);
      this.store.run('UPDATE conversation_segments SET candidate_count=1,quiet_due_at=? WHERE segment_id=?',now,segment.segment_id);
      batchId=this.flushSync(segment.segment_id,'quiet_timeout',true);
    }
    this.store.run('UPDATE qq_explicit_feedback SET outcome=?,batch_id=? WHERE event_id=?',rationale,batchId,stored.event_id);
    this.store.run('DELETE FROM qq_feedback_rate WHERE window_start<?',addMilliseconds(now,-86400000));
    return{schemaVersion:'1.0',eventId:stored.event_id,policyVersion:policy.policyVersion,decision,rationaleCode:rationale,decidedAt:now};
  }
  private dueReason(segment: SegmentRow, now: string): BatchFlushReasonV1 | undefined {
    if (segment.urgent_due_at && segment.urgent_due_at <= now) return 'urgent';
    if (segment.max_due_at <= now) return 'max_wait';
    if (segment.quiet_due_at <= now) return 'quiet_timeout';
    return undefined;
  }
  async recoverStale(now: string): Promise<number> { return this.recoverStaleSync(now); }
  recoverStaleSync(now = this.clock()): number {
    now = timestamp(now);
    return this.store.transaction(() => {
      const segments = this.store.all<SegmentRow>("SELECT * FROM conversation_segments WHERE state='open' AND (max_due_at<=? OR quiet_due_at<=? OR urgent_due_at<=?) ORDER BY opened_at,segment_id", now, now, now);
      let count = 0;
      for (const segment of segments) {
        if (this.store.get<{ state: string }>('SELECT state FROM conversation_segments WHERE segment_id=?', segment.segment_id)!.state === 'flushed') continue;
        this.flushSync(segment.segment_id, this.dueReason(segment, now)!);
        count++;
      }
      return count;
    });
  }
  reprocessArchived(eventId: InternalEventId, requestId: string, actorRef: string, reason: string): AdmissionDecisionV1 {
    if (!requestId || !actorRef || !reason) throw new Error('INVALID_REPROCESS_REQUEST');
    return this.store.transaction(() => {
      const old = this.store.get<{ event_id: string; policy_version: string; actor_ref: string; reason: string }>('SELECT * FROM buffer_reprocess_requests WHERE request_id=?', requestId);
      if (old && (old.event_id !== eventId || old.actor_ref !== actorRef || old.reason !== reason)) throw new Error('REPROCESS_IDENTITY_CONFLICT');
      const policy = { ...this.policy, policyVersion: old?.policy_version ?? `${this.policy.policyVersion}:replay:${requestId}` };
      const original = this.store.get<DecisionRow>('SELECT * FROM admission_decisions WHERE event_id=? AND policy_version=?', eventId, this.policy.policyVersion);
      if (!original || original.decision !== 'archive_only') throw new Error('EVENT_NOT_ARCHIVED');
      const event = this.store.get<EventRow>('SELECT * FROM source_events WHERE event_id=?', eventId)!;
      if ((JSON.parse(event.payload_json) as NormalizedEventV1).type === 'com.superagent.source.coverage.changed.v1') throw new Error('HEALTH_EVENT_NOT_FEEDBACK');
      const existingClaim = this.store.get("SELECT 1 FROM segment_events WHERE event_id=? AND role='candidate' LIMIT 1", eventId);
      if (existingClaim && !old) throw new Error('EVENT_ALREADY_CANDIDATE');
      this.registerPolicy(policy);
      if (!old) this.store.run('INSERT INTO buffer_reprocess_requests VALUES(?,?,?,?,?,?)', requestId, eventId, policy.policyVersion, actorRef, reason, timestamp(this.clock()));
      return this.admitSync(eventId, policy, true);
    });
  }
  getBatch(batchId: string): { batch: FeedbackBatchV1; contextOmitted: number } | undefined {
    const row = this.store.get<{ batch_json: string; context_omitted: number }>('SELECT batch_json,context_omitted FROM feedback_batches WHERE batch_id=?', batchId);
    return row && { batch: JSON.parse(row.batch_json) as FeedbackBatchV1, contextOmitted: row.context_omitted };
  }
}
