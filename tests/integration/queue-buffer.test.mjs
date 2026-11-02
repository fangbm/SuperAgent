import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAdmission } from '@superagent/feedback-buffer';
import { fixture, initial, binding, scope, event, count } from './helpers.mjs';

test('queue leases fence stale workers across connections and isolate report capacity', t => {
  const f = fixture(t);
  const { queue } = f.runtime;
  for (let i = 0; i < 4; i++) queue.create(binding.projectId, 'feedback.batch.triage', { batchId: `b${i}` }, `full-${i}`);
  const leases = [queue.claim('a', 'full_agent', 100), queue.claim('b', 'full_agent', 100), queue.claim('c', 'full_agent', 100)];
  assert.ok(leases.every(Boolean));
  assert.equal(f.open().queue.claim('d', 'full_agent', 100), undefined);
  queue.create(binding.projectId, 'report.generate', { window: 'test' }, 'report');
  assert.ok(queue.claim('report-worker', 'report'));
  queue.start(leases[0].jobId, leases[0].leaseToken);
  f.advance(101);
  const reclaimed = queue.claim('a', 'full_agent', 100);
  assert.ok(reclaimed);
  assert.throws(() => queue.complete(leases[0].jobId, leases[0].leaseToken), /JOB_LEASE_LOST/);
  queue.heartbeat(reclaimed.jobId, reclaimed.leaseToken, 200);
  queue.complete(reclaimed.jobId, reclaimed.leaseToken);
  assert.equal(queue.get(reclaimed.jobId).status, 'completed');
});

test('retry budgets, cancellation and semantic idempotency survive storage', t => {
  const f = fixture(t);
  const { queue } = f.runtime;
  const job = queue.create(binding.projectId, 'feedback.admit', { eventId: 'not-read-in-this-queue-test' }, 'retry');
  assert.equal(queue.create(binding.projectId, 'feedback.admit', { eventId: 'not-read-in-this-queue-test' }, 'retry').jobId, job.jobId);
  assert.throws(() => queue.create(binding.projectId, 'feedback.admit', { eventId: 'changed' }, 'retry'), /JOB_IDEMPOTENCY_CONFLICT/);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = queue.claim('worker', 'admission');
    assert.equal(claim.attempt, attempt);
    queue.fail(claim.jobId, claim.leaseToken, 'TEST_FAILURE');
    if (attempt < 3) { assert.equal(queue.claim('worker', 'admission'), undefined); f.advance(10_000); }
  }
  assert.equal(queue.get(job.jobId).status, 'dead_letter');
  const cancelled = queue.create(binding.projectId, 'feedback.admit', {}, 'cancel');
  assert.equal(queue.cancel(cancelled.jobId), true);
  assert.equal(queue.claim('worker', 'admission'), undefined);
});

test('expired or failed external jobs are not automatically resent', t => {
  const f = fixture(t);
  const { queue } = f.runtime;
  queue.create(binding.projectId, 'report.deliver', {}, 'external');
  const claim = queue.claim('sender', 'delivery', 10);
  assert.throws(() => queue.cancel(claim.jobId), /EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION/);
  f.advance(11);
  queue.recoverExpired();
  assert.equal(queue.get(claim.jobId).status, 'dead_letter');
  assert.equal(queue.get(claim.jobId).lastErrorCode, 'EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION');
  assert.equal(queue.claim('sender', 'delivery'), undefined);
});

test('M1 worker does not consume tasks without installed handlers or bypass lane limits', t => {
  const { runtime } = fixture(t);
  const reserved = runtime.queue.create(binding.projectId, 'feedback.audit', {}, 'future-audit');
  assert.equal(runtime.tick().admitted, 0);
  assert.equal(runtime.queue.get(reserved.jobId).status, 'pending');
  assert.throws(() => runtime.queue.enqueue({ id: 'wrong-lane', projectId: binding.projectId, kind: 'feedback.batch.triage', payload: {}, idempotencyKey: 'wrong-lane', priority: 0, createdAt: initial }, { lane: 'report' }), /JOB_LANE_MISMATCH/);
});

test('thread/reply topology separates discussions while independent segments share compute batches', t => {
  const f = fixture(t);
  const { runtime } = f;
  runtime.ingress.commitBatch(scope, [event('root-a'), event('root-b', { text: '希望增加自定义按键' }), event('reply-a', { parent: 'root-a', text: '我也是' }), event('context', { parent: 'root-a', text: '谢谢' })]);
  runtime.tick();
  assert.equal(count(runtime.store, 'conversation_segments'), 2);
  assert.equal(count(runtime.store, 'feedback_batches'), 0);
  f.advance(60_001); runtime.tick();
  const id = runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id;
  const batch = runtime.buffer.getBatch(id).batch;
  assert.equal(batch.segmentIds.length, 2);
  assert.equal(batch.candidateEventIds.length, 3);
  assert.equal(batch.contextEventIds.length, 1);
  assert.equal(count(runtime.store, 'jobs'), 5); // 4 lightweight admissions + 1 batch
  assert.equal(runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage'").status, 'pending');
});

test('same platform event ID from different sources/projects remains independent through batching', t => {
  const f = fixture(t);
  const other = { projectId: 'other-game', sourceId: 'discord-other', sourceUri: 'urn:superagent:source:discord-other', platform: 'discord' };
  f.runtime.ingress.registerSource(other);
  const e = event('same-id');
  e.source = other.sourceUri; e.data.projectId = other.projectId; e.data.sourceId = other.sourceId; e.data.platform = other.platform;
  f.runtime.ingress.commitBatch(scope, [event('same-id')]);
  f.runtime.ingress.commitBatch({ projectId: other.projectId, sourceId: other.sourceId }, [e]);
  f.runtime.tick(); f.advance(60_001); f.runtime.tick();
  assert.equal(count(f.runtime.store, 'source_events'), 2);
  assert.equal(count(f.runtime.store, 'feedback_batches'), 2);
  assert.deepEqual(f.runtime.store.all('SELECT project_id,source_id FROM feedback_batches ORDER BY source_id').map(row => [row.project_id, row.source_id]), [[other.projectId, other.sourceId], [binding.projectId, binding.sourceId]]);
});

test('continuous related activity still flushes at maxWait and resumes with a new segment', t => {
  const f = fixture(t, { maxCandidateMessages: 100 });
  for (const [id, milliseconds] of [['a', 0], ['b', 59_000], ['c', 118_000], ['d', 121_000]]) {
    f.setTime(Date.parse(initial) + milliseconds);
    f.runtime.ingress.commitBatch(scope, [event(id, { thread: 'busy-thread' })]);
    f.runtime.tick();
  }
  assert.equal(count(f.runtime.store, 'feedback_batches'), 1);
  assert.equal(f.runtime.store.get('SELECT reason FROM feedback_batches').reason, 'max_wait');
  assert.equal(f.runtime.store.get("SELECT candidate_count FROM conversation_segments WHERE state='open'").candidate_count, 1);
});

test('urgent candidates flush within 5s without declaring P0 or sending notifications', t => {
  const f = fixture(t);
  f.runtime.ingress.commitBatch(scope, [event('urgent', { text: '更新后存档损坏丢失了' })]);
  f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions').decision, 'urgent_candidate');
  assert.equal(count(f.runtime.store, 'feedback_batches'), 0);
  f.advance(4_999); f.runtime.tick();
  assert.equal(count(f.runtime.store, 'feedback_batches'), 0);
  f.advance(1); f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT reason FROM feedback_batches').reason, 'urgent');
  assert.equal(count(f.runtime.store, 'p0_alerts'), 0);
  assert.equal(count(f.runtime.store, 'external_operations'), 0);
});

test('size flush creates stable batch/job identities and context is bounded across batches', async t => {
  const f = fixture(t, { maxCandidateMessages: 2, maxContextMessages: 1 });
  const { runtime } = f;
  runtime.ingress.commitBatch(scope, [event('a', { thread: 'topic' }), event('b', { thread: 'topic' })]);
  runtime.tick();
  const firstSegment = runtime.store.get('SELECT segment_id FROM conversation_segments').segment_id;
  const firstBatch = await runtime.buffer.flush(firstSegment, 'size_limit');
  assert.equal(await runtime.buffer.flush(firstSegment, 'replay'), firstBatch);
  runtime.ingress.commitBatch(scope, [event('c', { thread: 'topic' }), event('d', { thread: 'topic' })]);
  runtime.tick();
  const batches = runtime.store.all('SELECT batch_id FROM feedback_batches');
  assert.equal(batches.length, 2);
  const second = runtime.buffer.getBatch(batches.find(row => row.batch_id !== firstBatch).batch_id);
  assert.equal(second.batch.candidateEventIds.length, 2);
  assert.equal(second.batch.contextEventIds.length, 1);
  assert.equal(second.contextOmitted, 1);
  assert.equal(runtime.store.get("SELECT count(*) n FROM batch_events WHERE role='candidate'").n, 4);
});

test('batch and triage job roll back together on failure and deterministically recover', t => {
  const f = fixture(t);
  f.runtime.ingress.commitBatch(scope, [event('a')]);
  f.runtime.tick();
  f.advance(60_001);
  f.runtime.store.exec("CREATE TRIGGER fault_batch_job BEFORE INSERT ON jobs WHEN NEW.kind='feedback.batch.triage' BEGIN SELECT RAISE(ABORT,'BATCH_JOB_FAILURE'); END;");
  assert.throws(() => f.runtime.buffer.recoverStaleSync(), /BATCH_JOB_FAILURE/);
  assert.equal(count(f.runtime.store, 'feedback_batches'), 0);
  assert.equal(f.runtime.store.get('SELECT state FROM conversation_segments').state, 'open');
  f.runtime.store.exec('DROP TRIGGER fault_batch_job');
  assert.equal(f.runtime.buffer.recoverStaleSync(), 1);
  assert.equal(f.runtime.buffer.recoverStaleSync(), 0);
  assert.equal(count(f.runtime.store, 'feedback_batches'), 1);
});

test('archival screening remains auditable and can be manually reprocessed once', t => {
  const f = fixture(t);
  const { runtime } = f;
  const id = runtime.ingress.commitBatch(scope, [event('chat', { text: '谢谢' })]).refs[0].eventId;
  runtime.tick();
  assert.equal(count(runtime.store, 'feedback_batches'), 0);
  assert.equal(runtime.store.get('SELECT decision FROM admission_decisions').decision, 'archive_only');
  runtime.buffer.reprocessArchived(id, 'request-1', 'developer', 'Audit missed context');
  runtime.buffer.reprocessArchived(id, 'request-1', 'developer', 'Audit missed context');
  assert.throws(() => runtime.buffer.reprocessArchived(id, 'request-2', 'developer', 'Audit missed context'), /EVENT_ALREADY_CANDIDATE/);
  assert.equal(count(runtime.store, 'admission_decisions'), 2);
  f.advance(60_001); runtime.tick();
  assert.equal(runtime.store.get('SELECT reason FROM feedback_batches').reason, 'replay');
  assert.equal(count(runtime.store, 'source_events'), 1);
  assert.equal(count(runtime.store, 'buffer_reprocess_requests'), 1);
});

test('unknown substantive text is retained and audit sampling is stable', () => {
  const f = { policyVersion: 'sampling-test', auditSampleRate: 0.02 };
  assert.equal(classifyAdmission(event('novel', { text: '操作后的画面和以前不一样了' }), 'host-id', f).decision, 'candidate');
  const a = classifyAdmission(event('chat', { text: 'hello' }), 'host-id', f);
  assert.deepEqual(a, classifyAdmission(event('chat', { text: 'hello' }), 'host-id', f));
});

test('edit/delete events schedule new batches and prior raw evidence remains unchanged', t => {
  const f = fixture(t, { maxCandidateMessages: 1 });
  const { runtime } = f;
  const first = runtime.ingress.commitBatch(scope, [event('created')]).refs[0].eventId;
  runtime.tick();
  runtime.ingress.commitBatch(scope, [event('edited', { objectId: 'created', action: 'updated', time: '2026-11-02T00:01:00Z' })]);
  runtime.tick();
  runtime.ingress.commitBatch(scope, [event('deleted', { objectId: 'created', action: 'deleted', time: '2026-11-02T00:02:00Z' })]);
  runtime.tick();
  assert.equal(count(runtime.store, 'source_events'), 3);
  assert.equal(count(runtime.store, 'feedback_batches'), 3);
  assert.equal(runtime.store.get("SELECT count(*) n FROM feedback_batches WHERE reason='replay'").n, 2);
  assert.equal(runtime.ingress.getEvent(binding.projectId, first).event.data.content.text, event('created').data.content.text);
});

test('stored policy cannot silently change under the same version', t => {
  const f = fixture(t);
  f.runtime.close();
  assert.throws(() => f.open({ policy: { ...f.policy, quietWindowMs: 1 } }), /POLICY_VERSION_REUSED/);
});

test('policy re-evaluation cannot create a second candidate claim or break later flushing', t => {
  const f = fixture(t, { maxCandidateMessages: 1 });
  const id = f.runtime.ingress.commitBatch(scope, [event('candidate')]).refs[0].eventId;
  f.runtime.tick();
  f.runtime.close();
  const next = f.open({ policy: { ...f.policy, policyVersion: 'new-policy-version' } });
  next.buffer.admitSync(id);
  next.buffer.recoverStaleSync();
  assert.equal(count(next.store, 'admission_decisions'), 2);
  assert.equal(count(next.store, 'feedback_batches'), 1);
  assert.equal(next.store.get("SELECT count(*) n FROM batch_events WHERE role='candidate'").n, 1);
});

test('archived context admitted before its candidate is still attached to the thread', t => {
  const f = fixture(t);
  const receipt = f.runtime.ingress.commitBatch(scope, [event('context-first', { thread: 'topic', text: '谢谢' }), event('candidate-later', { thread: 'topic' })]);
  f.runtime.buffer.admitSync(receipt.refs[0].eventId);
  f.runtime.buffer.admitSync(receipt.refs[1].eventId);
  f.advance(60_001); f.runtime.buffer.recoverStaleSync();
  const batch = f.runtime.buffer.getBatch(f.runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id).batch;
  assert.deepEqual(batch.contextEventIds, [receipt.refs[0].eventId]);
});

test('large archived context is capped and records unread references', t => {
  const f = fixture(t, { maxContextMessages: 2 });
  f.runtime.ingress.commitBatch(scope, [
    ...Array.from({ length: 20 }, (_, i) => event(`chat-${i}`, { thread: 'topic', text: '谢谢' })),
    event('candidate', { thread: 'topic' }),
  ]);
  f.runtime.tick();
  f.advance(60_001); f.runtime.tick();
  const batch = f.runtime.buffer.getBatch(f.runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id);
  assert.equal(batch.batch.contextEventIds.length, 2);
  assert.equal(batch.contextOmitted, 18);
  assert.equal(count(f.runtime.store, 'source_events'), 21);
});
