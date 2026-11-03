import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { m3Fixture } from './m3-helpers.mjs';
import { createAnalysisServices } from '../../scripts/m3-services.mjs';
import { createM5 } from '../../scripts/m5-runtime.mjs';

test('M3 service factory reuses the provided runtime and injected model',async t=>{
  const f=await m3Fixture(t);f.add('factory');
  const model={modelId:'injected-fixture',generate:async({prompt})=>{const task=JSON.parse(prompt);return{modelId:'injected-fixture',value:{schemaVersion:'2.0',batchId:task.batchId,pipelineVersion:task.pipelineVersion,revision:task.revision,items:[],requiresHumanReview:true,nonActionableReason:'insufficient_context'},usage:{}};}};
  const services=createAnalysisServices(f.runtime,{projectId:'game-test',env:{},model,memory:f.memory,domain:f.domain});
  assert.equal(services.memory,f.memory);assert.equal(services.domain,f.domain);
  const ingress=f.runtime.tick();const result=await services.tick();
  assert.equal(typeof ingress.admitted,'number');assert.equal(result.analysis.status,'succeeded');
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM feedback_batches').n,1);
});

test('M5 closes without closing its borrowed runtime and rejects a different database',async t=>{
  const f=await m3Fixture(t);const key='core-service-factory-test-access-key-at-least-32';const previous=process.env.SA_WEB_ACCESS_KEY;process.env.SA_WEB_ACCESS_KEY=key;
  t.after(()=>{if(previous===undefined)delete process.env.SA_WEB_ACCESS_KEY;else process.env.SA_WEB_ACCESS_KEY=previous;});
  const app=await createM5({database:f.filename,project:'game-test'},undefined,{runtime:f.runtime,memory:f.memory,domain:f.domain,tickIngress:false});
  let ingressTicks=0;t.mock.method(f.runtime,'tick',()=>{ingressTicks++;return{};});await app.tick();assert.equal(ingressTicks,0);
  await app.close();assert.equal(f.runtime.store.get('SELECT count(*) n FROM projects').n,1);
  await assert.rejects(()=>createM5({database:path.join(f.directory,'other.sqlite'),project:'game-test'},undefined,{runtime:f.runtime}),/M5_RUNTIME_DATABASE_MISMATCH/);
});
