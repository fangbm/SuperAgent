import assert from 'node:assert/strict';
import test from 'node:test';
import {AnalysisWorker} from '@superagent/agent-workers';
import {fixture,binding} from './helpers.mjs';
import {m3Fixture} from './m3-helpers.mjs';

test('urgent candidates bypass a full QQ fairness quota without consuming the ordinary slot after reopen',t=>{
  const f=fixture(t),q=f.runtime.queue;
  const ordinary=q.create(binding.projectId,'feedback.batch.triage',{batchId:'ordinary'},'ordinary');
  for(let i=0;i<4;i++)q.create(binding.projectId,'feedback.batch.triage',{batchId:`explicit-${i}`},`explicit-${i}`,50);
  for(let i=0;i<3;i++){const job=q.claim('normal','full_agent',30000,undefined,undefined,true);assert.match(job.payload.batchId,/explicit/);q.complete(job.jobId,job.leaseToken);}
  const urgent=q.create(binding.projectId,'feedback.batch.triage',{batchId:'urgent'},'urgent',100);
  const reopened=f.open(),claim=reopened.queue.claim('normal','full_agent',30000,undefined,undefined,true);
  assert.equal(claim.jobId,urgent.jobId);reopened.queue.complete(claim.jobId,claim.leaseToken);
  const next=reopened.queue.claim('normal','full_agent',30000,undefined,undefined,true);assert.equal(next.jobId,ordinary.jobId);
});

test('priority and kind filters apply to the fairness fallback and urgent-only claims leave lower priorities pending',t=>{
  const f=fixture(t),q=f.runtime.queue,kinds=['feedback.batch.triage'];
  q.create(binding.projectId,'feedback.batch.triage',{batchId:'below-minimum'},'below-minimum',0);
  const ordinary=q.create(binding.projectId,'feedback.batch.triage',{batchId:'eligible-ordinary'},'eligible-ordinary',20);
  q.create(binding.projectId,'feedback.extract.v2',{batchId:'excluded-kind'},'excluded-kind',100);
  for(let i=0;i<3;i++)q.create(binding.projectId,'feedback.batch.triage',{batchId:`explicit-${i}`},`explicit-${i}`,50);
  for(let i=0;i<3;i++){const job=q.claim('normal','full_agent',30000,kinds,10,true);assert.match(job.payload.batchId,/explicit/);q.complete(job.jobId,job.leaseToken);}
  assert.equal(q.claim('urgent','full_agent',30000,kinds,100),undefined);
  assert.equal(q.claim('normal','full_agent',30000,kinds,10,true).jobId,ordinary.jobId);
  assert.throws(()=>q.claim('invalid','full_agent',30000,kinds,true),/INVALID_PRIORITY_FILTER/);
});

test('real AnalysisWorker urgent-only and regular paths share the queue without stealing ordinary analysis',async t=>{
  const f=await m3Fixture(t);
  f.add('ordinary','Windows 1.2.0 联机加载90%崩溃');
  f.add('urgent','Windows 1.2.0 更新后存档永久丢失，无法恢复');
  const ordinary=f.runtime.store.get('SELECT job_id FROM jobs WHERE kind=? AND priority=0','feedback.batch.triage');
  const urgent=f.runtime.store.get('SELECT job_id FROM jobs WHERE kind=? AND priority=100','feedback.batch.triage');
  assert.ok(ordinary);assert.ok(urgent);
  const worker=new AnalysisWorker(f.runtime.store,f.runtime.queue,f.domain,f.memory,f.model,{clock:f.clock,urgentOnly:true});
  assert.equal((await worker.tick()).status,'succeeded');assert.equal(f.runtime.queue.get(urgent.job_id).status,'completed');assert.equal(f.runtime.queue.get(ordinary.job_id).status,'pending');
  assert.equal((await worker.tick()).processed,false);
  assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(f.runtime.queue.get(ordinary.job_id).status,'completed');
});
