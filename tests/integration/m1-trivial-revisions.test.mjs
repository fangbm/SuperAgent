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


test('queued bug -> thanks -> laughter edits remain candidates even before prior admissions run', t => {
  const f=fixture(t,{maxCandidateMessages:1});
  const base='bug-queued',objectId='one-topic';
  const events=[
    event(base,{objectId,text:'联机启动时崩溃',time:'2026-11-02T00:00:00.000Z'}),
    event('thanks-queued',{objectId,action:'updated',revision:'r2',text:'谢谢',time:'2026-11-02T00:00:01.000Z'}),
    event('laugh-queued',{objectId,action:'updated',revision:'r3',text:'哈哈',time:'2026-11-02T00:00:02.000Z'}),
  ];
  const refs=f.runtime.ingress.commitBatch(scope,events).refs;
  f.runtime.tick();
  const decisions=refs.map(ref=>f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',ref.eventId)?.decision);
  assert.deepEqual(decisions,['candidate','candidate','candidate']);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events').n,3);
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM admission_decisions WHERE rationale_code='TRIVIAL_REVISION'").n,0);
});

test('queued later edits cannot influence an earlier trivial update', t => {
  const f=fixture(t);
  const obj='trivial-backlog';
  const refs=f.runtime.ingress.commitBatch(scope,[
    event('hello-old',{objectId:obj,text:'谢谢',time:'2026-11-02T00:00:00.000Z'}),
    event('hello-mid',{objectId:obj,action:'updated',revision:'r2',text:'哈哈',time:'2026-11-02T00:00:01.000Z'}),
    event('bug-new',{objectId:obj,action:'updated',revision:'r3',text:'联机崩溃',time:'2026-11-02T00:00:02.000Z'}),
  ]).refs;
  f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',refs[1].eventId).decision,'archive_only');
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',refs[2].eventId).decision,'candidate');
});

test('trivial-text edit with a new screenshot still reaches the analysis queue', t => {
  const f=fixture(t,{maxCandidateMessages:1});
  const first=f.runtime.ingress.commitBatch(scope,[event('thanks-attachment-0',{objectId:'attach-topic',text:'谢谢'})]).refs[0];
  f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',first.eventId).decision,'archive_only');
  const edited=event('thanks-attachment-1',{objectId:'attach-topic',action:'updated',revision:'r2',text:'谢谢',
    time:'2026-11-02T00:00:01.000Z'});
  edited.data.content.attachments=[{kind:'image',url:'https://example.org/crash.png'}];
  const id=f.runtime.ingress.commitBatch(scope,[edited]).refs[0].eventId;
  f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',id).decision,'candidate');
  assert.equal(f.runtime.store.get('SELECT rationale_code FROM admission_decisions WHERE event_id=?',id).rationale_code,'SOURCE_REVISION_REPROCESS');
  assert.ok(f.runtime.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage'").n>=1);
});

test('actionable Steam thread title survives M1 even with a trivial body', t => {
  const f=fixture(t,{maxCandidateMessages:1});
  const thread=event('title-only',{text:'谢谢'});
  thread.type='com.superagent.feedback.thread.created.v1';
  thread.data.object.kind='thread';
  thread.data.attributes={title:'Windows 联机加载90%时崩溃'};
  const id=f.runtime.ingress.commitBatch(scope,[thread]).refs[0].eventId;
  f.runtime.tick();
  assert.equal(f.runtime.store.get('SELECT decision FROM admission_decisions WHERE event_id=?',id).decision,'candidate');
});
