import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, event, scope } from './helpers.mjs';

test('trivial messages and trivial-to-trivial edits archive, substantive withdrawals remain analysis candidates', t => {
  const f = fixture(t, { maxCandidateMessages: 1 });
  const cases = [
    ['thanks-new', 'thanks-thread', '谢谢', 'created', 'original', 'archive_only'],
    ['thanks-edit', 'thanks-thread', '哈哈', 'updated', 'rev-2', 'archive_only'],
    ['bug-new', 'bug-thread', '联机启动直接崩溃', 'created', 'original', 'candidate'],
    ['bug-edit', 'bug-thread', '谢谢', 'updated', 'rev-2', 'candidate'],
  ];
  for (const [id, objectId, text, action, revision, decision] of cases) {
    const record = event(id, { objectId, text, action, revision });
    const receipt = f.runtime.ingress.commitBatch(scope, [record]);
    f.runtime.tick();
    const actual = f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?', receipt.refs[0].eventId);
    assert.equal(actual?.decision, decision, id);
  }
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events').n, 4);
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage'").n, 2);
});
