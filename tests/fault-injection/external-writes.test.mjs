import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { addMilliseconds } from '@superagent/persistence';
import { GitHubSyncManager } from '@superagent/issue-tracker';
import { fixture,binding,count,event,scope } from '../integration/helpers.mjs';
import { deliveryFixture,deliveryRequest } from '../integration/qq-helpers.mjs';
import { m3Fixture,FixtureGitHub,fixtureAnswer } from '../integration/m3-helpers.mjs';

async function http(t,handler){const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return{baseURL:`http://127.0.0.1:${server.address().port}`,allowLoopbackHTTP:true};}

test('M6 real local HTTP auth throttling retries within budget without dispatching a QQ message',async t=>{
  const f=fixture(t);let auth=0,messages=0;const api=await http(t,async(req,res)=>{for await(const _ of req){}if(req.url==='/app/getAppAccessToken'){auth++;res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture-private-error-body'}));}else{messages++;res.end('{}');}}),{service}=deliveryFixture(f,api),id=service.enqueue(deliveryRequest(),'acceptance');
  for(let i=0;i<3;i++){assert.equal((await service.tick()).state,'safe_retry');assert.equal((await service.tick()).processed,false);f.advance(30_001);}assert.equal((await service.tick()).state,'manual_review');assert.equal(auth,3);assert.equal(messages,0);assert.ok(!JSON.stringify(f.runtime.store.all('SELECT * FROM plugin_delivery_requests')).includes('fixture-private-error-body'));assert.equal(service.get(id).state,'manual_review');
});

test('M6 real local HTTP send-body timeout becomes unknown and restart never replays POST',{timeout:8000},async t=>{
  const f=fixture(t);let posts=0;const api=await http(t,async(req,res)=>{for await(const _ of req){}if(req.url==='/app/getAppAccessToken')res.end(JSON.stringify({access_token:'fixture-token',expires_in:7200}));else{posts++;res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();res.write('{"id":');}}),{service}=deliveryFixture(f,{...api,timeoutMs:150});const id=service.enqueue(deliveryRequest(),'acceptance');assert.equal((await service.tick()).state,'unknown');assert.equal(posts,1);
  const reopened=f.open(),next=deliveryFixture({...f,runtime:reopened},api).service;f.advance(300_000);assert.equal((await next.tick()).processed,false);assert.equal(next.get(id).state,'unknown');assert.equal(posts,1);
});

test('M6 QQ permission loss after authentication blocks once without format fallback',async t=>{
  const f=fixture(t);let posts=0;const api=await http(t,async(req,res)=>{for await(const _ of req){}if(req.url==='/app/getAppAccessToken')res.end(JSON.stringify({access_token:'fixture-token',expires_in:7200}));else{posts++;res.writeHead(403);res.end(JSON.stringify({code:11253,message:'fixture-sensitive-provider-detail'}));}}),{service}=deliveryFixture(f,api);const id=service.enqueue(deliveryRequest(),'acceptance');assert.equal((await service.tick()).state,'blocked');f.advance(300_000);assert.equal((await service.tick()).processed,false);assert.equal(posts,1);assert.equal(service.get(id).result.errorCode,'QQ_API_11253');
});

test('M6 changing a durable recipient binding blocks an already prepared delivery before network access',async t=>{
  const f=fixture(t);let calls=0;const{service}=deliveryFixture(f,{fetch:async()=>{calls++;throw new Error('MUST_NOT_DISPATCH');}});const id=service.enqueue(deliveryRequest(),'acceptance');f.runtime.store.run("UPDATE plugin_delivery_bindings SET binding_id='replacement-binding'");assert.equal((await service.tick()).state,'blocked');assert.equal(calls,0);assert.equal(service.get(id).result.errorCode,'DELIVERY_AUTHORIZATION_REVOKED');
});

test('M6 two SQLite connections claim one send and ignore a late accepted result after Host timeout',{timeout:8000},async t=>{
  const f=fixture(t);let release,entered;const ready=new Promise(r=>entered=r);let posts=0;const api={fetch:async url=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});posts++;entered();await new Promise(r=>release=r);return Response.json({id:'late-fixture-id'});}},first=deliveryFixture(f,api,{service:{timeoutMs:100}}).service,id=first.enqueue(deliveryRequest(),'acceptance');
  const second=deliveryFixture({...f,runtime:f.open()},api).service,waiting=first.tick();await ready;assert.equal((await second.tick()).processed,false);assert.equal((await waiting).state,'unknown');release();await new Promise(r=>setImmediate(r));assert.equal(first.get(id).state,'unknown');assert.equal((await second.tick()).processed,false);assert.equal(posts,1);
});

test('M6 GitHub recovery cannot alter QQ or another repository lease',async t=>{
  const f=await m3Fixture(t),store=f.runtime.store,remote=new FixtureGitHub();const manager=new GitHubSyncManager(store,f.domain,remote,{clock:f.clock,allowWrites:true});
  for(const [id,kind]of [['qq-foreign','qq.c2c.send'],['github-foreign','github.issue.create']])store.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,attempt,lease_owner,lease_until,created_at,updated_at) VALUES(?,?,?,?,'fixture','in_flight',1,'other-owner',?,?,?)",id,kind,id,id,addMilliseconds(f.clock(),-1),f.clock(),f.clock());
  store.run("INSERT INTO external_operation_payloads VALUES(?,?,'defect','foreign-work','other/private',1,'{}',0,?)",'github-foreign',binding.projectId,f.clock());const before=store.all('SELECT * FROM external_operations');assert.equal((await manager.tick()).processed,false);assert.deepEqual(store.all('SELECT * FROM external_operations'),before);
});

test('M6 model HTTP 429 preserves incoming events, then resumes the same batch without duplicate effects',async t=>{
  const f=await m3Fixture(t,{responder:(task,_wire,n)=>n<=2?{httpStatus:429}:fixtureAnswer(task)});f.add('one','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'MODEL_HTTP_429');f.runtime.ingress.commitBatch(scope,[event('arrived-during-outage')]);assert.equal(count(f.runtime.store,'source_events'),2);assert.equal(count(f.runtime.store,'issues'),0);
  f.advance(1_001);assert.equal((await f.worker.tick()).status,'MODEL_HTTP_429');f.advance(2_001);assert.equal((await f.worker.tick()).status,'succeeded');assert.equal(count(f.runtime.store,'issues'),1);assert.equal(count(f.runtime.store,'feedback_items'),1);assert.equal(f.server.requests.length,3);assert.equal((await f.worker.tick()).processed,false);
});

test('M6 model permission loss is not retried and leaves durable source evidence intact',async t=>{
  const f=await m3Fixture(t,{responder:()=>({httpStatus:401})});f.add('one');assert.equal((await f.worker.tick()).status,'MODEL_HTTP_401');f.advance(300_000);assert.equal((await f.worker.tick()).processed,false);assert.equal(count(f.runtime.store,'source_events'),1);assert.equal(count(f.runtime.store,'triage_extractions'),0);assert.equal(f.runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage'").status,'dead_letter');assert.equal(f.server.requests.length,1);
});
