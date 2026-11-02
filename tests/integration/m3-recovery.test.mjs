import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
import { binding, count } from './helpers.mjs';
import { m3Fixture, fixtureAnswer } from './m3-helpers.mjs';

test('real model-worker termination recovers its run, lease and unfinished call without duplicate effects',{timeout:15_000},async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');f.runtime.close();
  const child=spawn(process.execPath,[fileURLToPath(new URL('./m3-crash-child.mjs',import.meta.url)),f.filename],{windowsHide:true,stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const exit=once(child,'exit');await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('CHILD_NOT_READY')),5000);child.stdout.on('data',d=>{text+=d.toString();if(text.includes('MODEL_WAIT')){clearTimeout(timer);resolve();}});child.once('error',reject);});
  child.kill('SIGKILL');await exit;f.advance(61_001);const runtime=f.open();const memory=new HybridMemory(runtime.store);const domain=new DomainService(runtime.store,memory,{clock:f.clock});
  const worker=new AnalysisWorker(runtime.store,runtime.queue,domain,memory,f.model,{clock:f.clock});assert.equal((await worker.tick()).status,'succeeded');
  assert.equal(count(runtime.store,'issues'),1);assert.equal(runtime.store.get("SELECT count(*) n FROM agent_runs WHERE error_code='WORKER_LEASE_EXPIRED'").n,1);
  assert.equal(runtime.store.get("SELECT count(*) n FROM model_calls WHERE status='interrupted'").n,1);assert.equal(runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage'").status,'completed');
});

test('expired worker cannot publish a domain mutation after its replacement completes',async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');let release,entered;
  const ready=new Promise(resolve=>entered=resolve);const slow={modelId:'slow-fixture',generate:async request=>{entered();await new Promise(resolve=>release=resolve);return{value:fixtureAnswer(JSON.parse(request.prompt)),modelId:'slow-fixture',usage:{inputTokens:1,outputTokens:1}};}};
  const first=new AnalysisWorker(f.runtime.store,f.runtime.queue,f.domain,f.memory,slow,{clock:f.clock});const waiting=first.tick();await ready;f.advance(61_001);
  try{assert.equal((await f.worker.tick()).status,'succeeded');}finally{release();}
  assert.equal((await waiting).status,'JOB_LEASE_LOST');assert.equal(count(f.runtime.store,'issues'),1);assert.equal(count(f.runtime.store,'feedback_items'),1);
});

test('HTTP timeouts retain source data and retry only within the job budget',async t=>{
  const f=await m3Fixture(t,{workerOptions:{timeoutMs:25},responder:async(task,_wire,n)=>{if(n===1)await new Promise(resolve=>setTimeout(resolve,100));return fixtureAnswer(task);}});
  f.add('one','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'MODEL_TIMEOUT');assert.equal(count(f.runtime.store,'issues'),0);
  f.advance(1_001);assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'source_events'),1);assert.equal(count(f.runtime.store,'issues'),1);
});

test('invalid structured output is rejected before any domain write',async t=>{
  const f=await m3Fixture(t,{responder:()=>({schemaVersion:'wrong'})});f.add('one');assert.equal((await f.worker.tick()).status,'MODEL_SCHEMA_INVALID');
  assert.equal(count(f.runtime.store,'triage_extractions'),0);assert.equal(count(f.runtime.store,'issues'),0);assert.equal(count(f.runtime.store,'source_events'),1);
});

test('cross-project or context-only evidence cannot count as a new item',async t=>{
  const f=await m3Fixture(t,{responder:task=>{const r=fixtureAnswer(task);r.items[0].evidence[0].eventId='invented-foreign-event';return r;}});f.add('one');assert.equal((await f.worker.tick()).status,'EVIDENCE_OUTSIDE_BATCH');
  assert.equal(count(f.runtime.store,'feedback_items'),0);
});
