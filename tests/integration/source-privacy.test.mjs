import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, event, binding, scope } from './helpers.mjs';
import { DomainService } from '@superagent/domain';
import { HybridMemory } from '@superagent/memory';
import { AnalysisWorker } from '@superagent/agent-workers';

const privateBinding = { projectId: 'game-private', sourceId: 'private-tickets', sourceUri: 'urn:source:private-tickets', platform: 'discord' };
const privateScope = { projectId: privateBinding.projectId, sourceId: privateBinding.sourceId };
function privateEvent(id, options = {}) {
  const input = event(id, { text: 'PRIVATE-SENTINEL: private report with substantive crash details', ...options });
  input.source = privateBinding.sourceUri;
  Object.assign(input.data, privateScope, { platform: 'discord' });
  return input;
}

test('private archive policy survives restart and blocks normal workers, forced admission, reprocess and model evidence', async t => {
  const f = fixture(t);
  f.runtime.ingress.registerSource(privateBinding);
  f.runtime.ingress.setSourcePolicy(privateScope, { visibility: 'staff', processingMode: 'archive_only' });
  const inputs = [privateEvent('created', { objectId: 'one' }), privateEvent('edited', { objectId: 'one', action: 'updated', time: '2026-11-02T00:01:00Z' }),
    privateEvent('deleted', { objectId: 'one', action: 'deleted', text: null, time: '2026-11-02T00:02:00Z' })];
  const receipt = f.runtime.ingress.commitBatch(privateScope, inputs, { sourceId: privateScope.sourceId, cursor: { sequence: 3 } });
  const ids = receipt.refs.map(ref => ref.eventId);
  f.runtime.close();
  const runtime = f.open();
  assert.deepEqual(runtime.ingress.getCheckpoint(privateScope), { sequence: 3 });
  const duplicate = runtime.ingress.commitBatch(privateScope, inputs);
  assert.deepEqual(duplicate.refs.map(ref => ref.eventId), ids);
  assert.equal(duplicate.duplicates, 3);
  assert.deepEqual(runtime.tick(), { dispatched: 0, admitted: 0, failed: 0, flushed: 0, recoveredJobs: 0 });
  await assert.rejects(runtime.accept(ids[0]), /SOURCE_ARCHIVE_ONLY/);
  assert.throws(() => runtime.buffer.admitSync(ids[0]), /SOURCE_ARCHIVE_ONLY/);
  assert.throws(() => runtime.buffer.admitSync(ids[0], runtime.buffer.policy, true), /SOURCE_ARCHIVE_ONLY/);
  assert.throws(() => runtime.buffer.reprocessArchived(ids[0], 'request', 'owner', 'test'), /SOURCE_ARCHIVE_ONLY/);
  assert.equal(runtime.store.get('SELECT count(*) n FROM admission_decisions').n, 0);
  assert.equal(runtime.store.get('SELECT count(*) n FROM buffer_reprocess_requests').n, 0);
  const memory = new HybridMemory(runtime.store);
  const domain = new DomainService(runtime.store, memory);
  assert.equal(domain.evidence(privateScope.projectId, ids[0]), undefined);
  assert.equal(domain.evidence(scope.projectId, ids[0]), undefined);
  assert.ok(runtime.ingress.getEvent(privateScope.projectId, ids[0]).event.data.content.text.includes('PRIVATE-SENTINEL'));
  assert.equal(runtime.ingress.getEvent(scope.projectId, ids[0]), undefined);
  let calls = 0;
  const worker = new AnalysisWorker(runtime.store, runtime.queue, domain, memory, { modelId: 'should-not-run', generate: async () => { calls++; throw new Error('private leak'); } });
  assert.deepEqual(await worker.tick(), { processed: false });
  assert.equal(calls, 0);
  assert.equal(runtime.store.get('SELECT count(*) n FROM external_operations').n, 0);
  assert.equal(runtime.metrics().pendingOutbox, 3);
});

test('trusted policy cannot downgrade private evidence or mix public and private source projects', t => {
  const { runtime } = fixture(t);
  runtime.ingress.registerSource(privateBinding);
  runtime.ingress.setSourcePolicy(privateScope, { visibility: 'staff', processingMode: 'archive_only' });
  assert.throws(() => runtime.ingress.setSourcePolicy(privateScope, { visibility: 'staff', processingMode: 'standard' }), /INVALID_SOURCE_POLICY/);
  assert.throws(() => runtime.ingress.setSourcePolicy(privateScope, { visibility: 'public', processingMode: 'archive_only' }), /PRIVATE_SOURCE_POLICY_IMMUTABLE/);
  const other = { ...privateBinding, sourceId: 'wrong-public', sourceUri: 'urn:source:wrong-public' };
  runtime.ingress.registerSource(other);
  assert.throws(() => runtime.ingress.setSourcePolicy({ projectId: other.projectId, sourceId: other.sourceId }, { visibility: 'public', processingMode: 'standard' }), /PROJECT_VISIBILITY_CONFLICT/);
  assert.throws(() => runtime.ingress.commitBatch({ projectId: other.projectId, sourceId: other.sourceId }, []), /PROJECT_VISIBILITY_CONFLICT/);
  runtime.ingress.registerSource({ ...binding, sourceId: 'another-public', sourceUri: 'urn:source:another-public' });
  assert.throws(() => runtime.ingress.setSourcePolicy(scope, { visibility: 'staff', processingMode: 'archive_only' }), /PROJECT_VISIBILITY_CONFLICT/);
});

test('public archive-only policy preserves pending outbox while default sources keep existing admission behavior', t => {
  const { runtime } = fixture(t);
  runtime.ingress.setSourcePolicy(scope, { visibility: 'public', processingMode: 'archive_only' });
  runtime.ingress.commitBatch(scope, [event('kept')]);
  assert.equal(runtime.ingress.dispatchOutbox(), 0);
  assert.equal(runtime.metrics().pendingOutbox, 1);
  runtime.ingress.setSourcePolicy(scope, { visibility: 'public', processingMode: 'standard' });
  assert.equal(runtime.tick().admitted, 1);
  assert.throws(() => runtime.ingress.setSourcePolicy(scope, { visibility: 'public', processingMode: 'archive_only' }), /SOURCE_ALREADY_PROCESSED/);
  assert.equal(runtime.store.get('SELECT processing_mode FROM source_policies WHERE source_id=?', binding.sourceId).processing_mode, 'standard');
});
