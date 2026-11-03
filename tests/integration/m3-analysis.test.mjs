import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridMemory } from '@superagent/memory';
import { binding, count, event, scope } from './helpers.mjs';
import { m3Fixture, fixtureAnswer } from './m3-helpers.mjs';
import { AnalysisWorker } from '@superagent/agent-workers';

test('HTTP model extraction creates independent Bug/suggestion with grounded original evidence',async t=>{
  const f=await m3Fixture(t);const id=f.add('one');const result=await f.worker.tick();assert.equal(result.status,'succeeded');
  assert.equal(count(f.runtime.store,'issues'),1);assert.equal(count(f.runtime.store,'suggestions'),1);assert.equal(count(f.runtime.store,'feedback_items'),2);
  assert.equal(f.runtime.store.get('SELECT count(DISTINCT event_id) n FROM feedback_primary_objects').n,1);
  assert.equal(count(f.runtime.store,'github_sync_outbox'),2);assert.equal(f.worker.getRun(result.runId).status,'succeeded');
  const source=f.domain.evidence(binding.projectId,id);assert.ok(source.text.includes('自动重连'));
  assert.equal(f.server.requests[0].wire.messages[0].role,'system');assert.equal(f.server.requests[0].wire.messages.length,2);
  assert.equal(count(f.runtime.store,'external_operations'),0);
});

test('cross-platform similar feedback is retrieved, evidence-matched and linked without another Issue',async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'succeeded');
  f.add('two','Windows 1.2.0 联机载入90%时崩溃',{projectId:binding.projectId,sourceId:'discord',sourceUri:'urn:source:discord',platform:'discord'});
  assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'issues'),1);
  const work=JSON.parse(f.runtime.store.get('SELECT content_json FROM work_metadata').content_json);assert.equal(work.feedbackCount,2);
  assert.equal(count(f.runtime.store,'work_match_decisions'),1);assert.equal(f.server.requests.filter(r=>r.task.task==='match_bug').length,1);
});

test('uncertainty or conflicting evidence remains local candidate and does not sync',async t=>{
  const f=await m3Fixture(t,{responder:task=>task.task==='match_bug'?{...fixtureAnswer(task),relationship:'uncertain',missingInformation:['复现步骤未知']}:fixtureAnswer(task)});
  f.add('one','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.add('two','Windows 1.2.0 联机载入90%时崩溃');
  assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'issues'),2);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM work_metadata WHERE review_required=1').n,1);assert.equal(count(f.runtime.store,'github_sync_outbox'),1);
});

test('untrusted model cannot invent source evidence, exact quotes or cross-project writes',async t=>{
  const f=await m3Fixture(t,{responder:task=>{const result=fixtureAnswer(task);result.items[0].evidence[0].quote='invented source quote';return result;}});
  f.add('one');assert.equal((await f.worker.tick()).status,'EVIDENCE_QUOTE_MISMATCH');
  for(const table of ['triage_extractions','feedback_items','issues','suggestions','github_sync_outbox'])assert.equal(count(f.runtime.store,table),0,table);
});

test('model 429 retries are bounded and raw provider errors never reach run logs',async t=>{
  const f=await m3Fixture(t,{responder:()=>({httpStatus:429})});f.add('one');
  for(let i=0;i<3;i++){const result=await f.worker.tick();assert.equal(result.status,'MODEL_HTTP_429');f.advance(10_000);}
  assert.equal(f.runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage'").status,'dead_letter');
  assert.equal(count(f.runtime.store,'issues'),0);assert.equal(count(f.runtime.store,'source_events'),1);
  assert.equal(JSON.stringify(f.runtime.store.all('SELECT * FROM agent_runs')).includes('fixture-secret-error-body'),false);
});

test('same-run retry reuses cached structured output; domain and local ack roll back atomically',async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');
  f.runtime.store.exec("CREATE TRIGGER final_ack_failure BEFORE UPDATE OF status ON jobs WHEN NEW.kind='feedback.batch.triage' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'ACK_FAILURE');END;");
  const first=await f.worker.tick();assert.notEqual(first.status,'succeeded');assert.equal(count(f.runtime.store,'triage_extractions'),0);assert.equal(count(f.runtime.store,'issues'),0);
  f.runtime.store.exec('DROP TRIGGER final_ack_failure');const batchId=f.runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id;
  f.runtime.queue.create(binding.projectId,'feedback.batch.triage',{batchId},'explicit-local-retry');
  assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(f.server.requests.length,1);assert.equal(count(f.runtime.store,'issues'),1);
});

test('reanalyzing the same batch supersedes items and preserves manual corrections',async t=>{
  const f=await m3Fixture(t,{responder:task=>task.task==='match_bug'?{...fixtureAnswer(task),relationship:'different'}:fixtureAnswer(task)});
  f.add('one','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.add('two','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();
  const works=f.runtime.store.all('SELECT issue_id,version FROM issues ORDER BY rowid');const firstItem=f.runtime.store.get('SELECT feedback_item_id FROM feedback_items ORDER BY rowid LIMIT 1').feedback_item_id;
  f.domain.moveFeedback(binding.projectId,firstItem,works[1].issue_id,works[1].version,'developer','人工确认应属于另一个问题');
  const batchId=f.runtime.store.get('SELECT batch_id FROM feedback_batches ORDER BY rowid LIMIT 1').batch_id;
  f.worker.reanalyze(binding.projectId,batchId,'triage-v2.1');assert.equal((await f.worker.tick()).status,'succeeded');
  const target=f.domain.getWork(binding.projectId,'defect',works[1].issue_id);assert.equal(target.feedbackCount,2);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM feedback_items WHERE active=1').n,2);assert.equal(count(f.runtime.store,'manual_work_overrides'),1);
});

test('deleted/superseded source candidates complete without a model call and deactivate old evidence',async t=>{
  const f=await m3Fixture(t);const id=f.add('one','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();
  const source=f.domain.evidence(binding.projectId,id).event;const deleted=structuredClone(source);deleted.id='delete';deleted.type='com.superagent.feedback.message.deleted.v1';deleted.time='2026-11-02T00:03:00Z';deleted.data.object.revision='deleted';deleted.data.content.text=null;
  f.runtime.ingress.commitBatch({projectId:binding.projectId,sourceId:binding.sourceId},[deleted]);f.runtime.tick();for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
  assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(f.server.requests.length,1);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM feedback_items WHERE active=1').n,0);assert.equal(f.domain.getWork(binding.projectId,'defect',f.runtime.store.get('SELECT issue_id FROM issues').issue_id).feedbackCount,0);
});

test('FTS and optional semantic vectors keep kind/project boundaries and survive model version changes',async t=>{
  const embeddings={modelId:'embedding-v1',embed:async texts=>texts.map(()=>[1,0])};const f=await m3Fixture(t,{embeddings});f.add('one');await f.worker.tick();
  assert.equal(await f.memory.drainEmbeddings(new AbortController().signal),2);
  const result=await f.memory.search(binding.projectId,'suggestion','semantic-query-with-no-shared-words',5);assert.equal(result.mode,'hybrid');assert.equal(result.items.length,1);assert.equal(result.items[0].kind,'suggestion');
  assert.equal((await f.memory.search('other-project','suggestion','semantic-query-with-no-shared-words',5)).items.length,0);
  const next=new HybridMemory(f.runtime.store,{...embeddings,modelId:'embedding-v2'});assert.equal(await next.drainEmbeddings(new AbortController().signal),2);
  assert.equal(count(f.runtime.store,'work_embeddings'),4);
});

test('model call budgets stop a workflow without committing partial feedback',async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.add('two','Windows 1.2.0 联机载入90%时崩溃');
  const limited=new AnalysisWorker(f.runtime.store,f.runtime.queue,f.domain,f.memory,f.model,{clock:f.clock,maxCalls:1});assert.equal((await limited.tick()).status,'MODEL_CALL_BUDGET_EXCEEDED');
  assert.equal(count(f.runtime.store,'issues'),1);assert.equal(count(f.runtime.store,'feedback_items'),1);
});

test('matching context stays bounded while the full evidence and counts are retained',async t=>{
  const f=await m3Fixture(t,{responder:task=>{const result=fixtureAnswer(task);if(task.task==='extract'&&task.messages.length>1)result.items[0].evidence=task.messages.filter(m=>m.role==='candidate').map(m=>({eventId:m.eventId,role:'primary',quote:m.text}));return result;}});
  f.runtime.ingress.commitBatch(scope,Array.from({length:30},(_,i)=>event(`many-${i}`,{text:'Windows 1.2.0 联机载入90%时崩溃'})));f.runtime.tick();assert.equal((await f.worker.tick()).status,'succeeded');
  f.add('new','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'succeeded');
  const match=f.server.requests.find(r=>r.task.task==='match_bug');assert.equal(match.task.candidate.evidence.length,5);assert.equal(match.task.candidate.evidenceTruncated,true);
  const work=JSON.parse(f.runtime.store.get('SELECT content_json FROM work_metadata').content_json);assert.equal(work.feedbackCount,31);assert.equal(work.evidence.length,31);
});

test('reanalysis repairs an independently reported duplicate classified as corroboration without inflating context or erasing history',async t=>{
  const f=await m3Fixture(t,{responder:task=>{const result=fixtureAnswer(task);if(task.task==='extract'){const reports=task.messages.filter(m=>m.role==='candidate'&&m.text.includes('崩溃'));result.items[0].evidence=reports.map((m,i)=>({eventId:m.eventId,quote:m.text,role:i===0||task.revision>1?'primary':'corroboration'}));}return result;}});
  const input=[event('report-one',{text:'Windows 1.2.0 联机载入90%时崩溃'}),event('report-two',{text:'我这里 Windows 1.2.0 联机载入90%也崩溃'}),event('context-only',{text:'嗯嗯'})];f.runtime.ingress.commitBatch(scope,input);f.runtime.tick();for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
  assert.equal((await f.worker.tick()).status,'succeeded');const workId=f.runtime.store.get('SELECT issue_id FROM issues').issue_id,batchId=f.runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id,original=f.runtime.store.get('SELECT result_json FROM triage_extractions WHERE revision=1').result_json;
  assert.equal(f.domain.getWork(binding.projectId,'defect',workId).feedbackCount,1);const rawBefore=f.runtime.store.all('SELECT * FROM source_events ORDER BY rowid');
  f.worker.reanalyze(binding.projectId,batchId,'triage-v2.2');assert.equal((await f.worker.tick()).status,'succeeded');const repaired=f.domain.getWork(binding.projectId,'defect',workId);assert.equal(repaired.feedbackCount,2);assert.equal(repaired.evidence.length,2);assert.equal(count(f.runtime.store,'issues'),1);assert.equal(f.runtime.store.get('SELECT count(*) n FROM feedback_items WHERE active=1').n,1);
  assert.equal(f.runtime.store.get('SELECT result_json FROM triage_extractions WHERE revision=1').result_json,original);assert.equal(count(f.runtime.store,'triage_extractions'),2);assert.deepEqual(f.runtime.store.all('SELECT * FROM source_events ORDER BY rowid'),rawBefore);assert.equal(count(f.runtime.store,'external_operations'),0);
});

test('an upgraded worker resumes a prior pipeline identity while new batches use the new default',async t=>{
  const f=await m3Fixture(t,{responder:(task,_wire,n)=>n===1?{httpStatus:429}:fixtureAnswer(task)});f.add('legacy','Windows 1.2.0 联机载入90%时崩溃');const previous=new AnalysisWorker(f.runtime.store,f.runtime.queue,f.domain,f.memory,f.model,{clock:f.clock,pipelineVersion:'triage-v2.1'});
  assert.equal((await previous.tick()).status,'MODEL_HTTP_429');f.advance(1_001);assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(f.runtime.store.get('SELECT pipeline_version FROM triage_extractions').pipeline_version,'triage-v2.1');assert.equal(count(f.runtime.store,'analysis_requests'),1);
  f.add('current','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(f.runtime.store.get('SELECT pipeline_version FROM triage_extractions ORDER BY rowid DESC LIMIT 1').pipeline_version,'triage-v2.2');assert.equal(count(f.runtime.store,'issues'),1);assert.equal(JSON.parse(f.runtime.store.get('SELECT content_json FROM work_metadata').content_json).feedbackCount,2);
});

test('reanalyzing a paraphrased suggestion with the same evidence reuses its work without duplicate counts or review',async t=>{
  const f=await m3Fixture(t,{responder:task=>{const result=fixtureAnswer(task);if(task.task==='extract'&&task.revision>1)result.items.find(i=>i.kind==='suggestion').title='自动重连并继续会话';return result;}});f.add('one');assert.equal((await f.worker.tick()).status,'succeeded');const suggestion=f.runtime.store.get('SELECT suggestion_id FROM suggestions').suggestion_id,batch=f.runtime.store.get('SELECT batch_id FROM feedback_batches').batch_id;
  f.worker.reanalyze(binding.projectId,batch,'triage-v2.2');assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'suggestions'),1);const work=f.domain.getWork(binding.projectId,'suggestion',suggestion);assert.equal(work.feedbackCount,1);assert.equal(work.reviewRequired,false);assert.equal(work.evidence.length,1);assert.equal(f.runtime.store.get("SELECT count(*) n FROM feedback_items WHERE kind='suggestion' AND active=1").n,1);
});

test('suggestion identity claims with actual distinguishing details still require review and cannot auto-link',async t=>{
  const f=await m3Fixture(t,{responder:task=>task.task==='match_suggestion'?{...fixtureAnswer(task),distinguishingDetails:['断线重试是否保留当前多人会话尚未明确']}:fixtureAnswer(task)});f.add('one');await f.worker.tick();const original=f.runtime.store.get('SELECT suggestion_id FROM suggestions').suggestion_id;f.add('two');assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'suggestions'),2);const newer=f.runtime.store.get('SELECT suggestion_id FROM suggestions WHERE suggestion_id<>?',original).suggestion_id;
  assert.equal(f.domain.getWork(binding.projectId,'suggestion',original).feedbackCount,1);assert.equal(f.domain.getWork(binding.projectId,'suggestion',newer).feedbackCount,1);assert.equal(f.domain.getWork(binding.projectId,'suggestion',newer).reviewRequired,true);assert.equal(f.runtime.store.get("SELECT count(*) n FROM github_sync_outbox WHERE work_kind='suggestion'").n,1);
});
