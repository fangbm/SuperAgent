import assert from 'node:assert/strict';
import test from 'node:test';
import { P0Service, P0NotificationPolicy } from '@superagent/domain';
import { QQC2CDelivery } from '@superagent/qq-official';
import { deliveryHost } from '@superagent/plugin-host';
import { createP0Services } from '../../scripts/p0-services.mjs';
import { m3Fixture,fixtureAnswer } from './m3-helpers.mjs';
import { binding,scope,event } from './helpers.mjs';
import { readSecret } from './qq-helpers.mjs';

const critical='Windows 1.2.0 更新后存档永久丢失，无法恢复。';
const signal=()=>new AbortController().signal;
async function setup(t,{copies=2,send,allowWrites=true,timeoutMs=100}={}){
  const f=await m3Fixture(t,{responder:task=>{
    const value=fixtureAnswer(task);if(task.task==='extract'){value.items[0].title='更新后存档永久丢失';value.items[0].description=critical;value.items[0].observedBehavior=critical;}return value;
  }});
  for(let i=0;i<copies;i++){f.add('critical-'+i,critical);assert.equal((await f.worker.tick()).status,'succeeded');}
  const service=new P0Service(f.runtime.store,f.domain,f.clock);
  const work=()=>f.domain.getWork(binding.projectId,'defect',f.runtime.store.get('SELECT issue_id FROM issues').issue_id);
  let calls=0,posts=0;
  const model={modelId:'p0-fixture',generate:async request=>{calls++;const task=JSON.parse(request.prompt);return{modelId:'p0-fixture',usage:{inputTokens:1,outputTokens:1},value:{verdict:'confirmed',impact:'irreversible_save_loss',rationale:'两份当前原文均说明实际不可恢复存档损失',evidence:task.evidence.map(e=>({eventId:e.eventId,quote:e.quote}))}};}};
  const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'qq-developer',api:{fetch:async(url,init)=>{
    if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture',expires_in:7200});
    posts++;return send?send(url,init):Response.json({id:'p0-sent-'+posts});
  }}});
  const port={plugin,host:deliveryHost(plugin,readSecret),bindingId:'fixture-binding',allowWrites,authorize:()=>{}};
  f.runtime.store.run('INSERT INTO plugin_delivery_bindings VALUES(?,?,?,?)',plugin.manifest.id,binding.projectId,'qq-developer',port.bindingId);
  const options={projectId:binding.projectId,domain:f.domain,model,delivery:port,clock:f.clock,timeoutMs,sendTimeoutMs:timeoutMs};
  const p0=createP0Services(f.runtime,options);
  return{...f,service,work,p0,model,port,options,calls:()=>calls,posts:()=>posts};
}

test('P0 policy routes only evidenced P0 defects, never suggestions, reviews or other severity',async()=>{
  const policy=new P0NotificationPolicy(),base={projectId:'p',assessedAt:'2026-11-04T00:00:00Z'};
  for(const input of [{...base,kind:'suggestion',suggestionId:'s'},{...base,kind:'steam_negative_review',reviewId:'r'},{...base,kind:'defect',issueId:'d',severity:'P1',evidence:[{eventId:'e'}]},{...base,kind:'defect',issueId:'d',severity:'P0',evidence:[]}])assert.equal((await policy.decide(input)).route,'digest_only');
  assert.equal((await policy.decide({...base,kind:'defect',issueId:'d',severity:'P0',evidence:[{eventId:'e'}]})).route,'p0_realtime');
});
test('one urgent report is archived for review; it never grants realtime send entitlement',async t=>{
  const f=await setup(t,{copies:1});assert.equal((await f.p0.evaluate(signal())).status,'review');
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM p0_alerts').n,0);assert.equal((await f.p0.deliver(signal())).processed,false);assert.equal(f.posts(),0);
});
test('corroborated evidence creates one immutable alert and dedicated QQ P0 send; duplicate schedules/restarts never replay',async t=>{
  const f=await setup(t);assert.equal((await f.p0.evaluate(signal())).status,'confirmed');
  assert.equal((await f.p0.deliver(signal())).status,'succeeded');assert.equal(f.posts(),1);
  const before=f.runtime.store.get('SELECT * FROM p0_alerts');
  const evidence=f.service.evidence(f.work()).map(e=>({eventId:e.eventId,quote:e.quote}));
  for(let i=0;i<20;i++){assert.equal(f.service.assess(f.work(),{verdict:'confirmed',impact:'irreversible_save_loss',rationale:'重复反馈',evidence}),undefined);f.p0.schedule();}
  const restarted=createP0Services(f.runtime,f.options);await restarted.evaluate(signal());await restarted.deliver(signal());
  assert.equal(f.posts(),1);assert.equal(f.calls(),1);assert.deepEqual(f.runtime.store.get('SELECT * FROM p0_alerts'),before);
  assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'accepted');
});
test('current exact primary evidence and domain policy reject hallucination, context, stale edits and speculative impact',async t=>{
  const f=await setup(t),work=f.work(),evidence=f.service.evidence(work).map(e=>({eventId:e.eventId,quote:e.quote}));
  const assessment={verdict:'confirmed',impact:'irreversible_save_loss',rationale:'test',evidence};
  assert.equal(f.service.assess(work,{...assessment,evidence:[...evidence,{eventId:'outside',quote:critical}]}),undefined);
  assert.equal(f.service.assess(work,{...assessment,evidence:evidence.map(e=>({...e,quote:'invented'}))}),undefined);
  assert.equal(f.service.assess({...work,reviewRequired:true},assessment),undefined);
  const edit=event('edited',{objectId:'critical-0',action:'updated',revision:'2',text:'已确认存档正常'});
  f.runtime.ingress.commitBatch(scope,[edit]);f.runtime.tick();
  assert.equal(f.service.assess(work,assessment),undefined);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM p0_alerts').n,0);
});
test('unknown QQ POST outcome is stored once and never retried after restart',async t=>{
  const f=await setup(t,{send:()=>{throw new Error('LOST_RESPONSE');}});await f.p0.evaluate(signal());
  assert.equal((await f.p0.deliver(signal())).status,'unknown');assert.equal(f.posts(),1);
  const restarted=createP0Services(f.runtime,f.options);f.advance(3600000);
  for(let i=0;i<3;i++){await restarted.evaluate(signal());await restarted.deliver(signal());}
  assert.equal(f.posts(),1);assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'unknown');
});
test('write disabled, missing capability and changed binding fail closed without ordinary-report fallback',async t=>{
  for(const mode of ['disabled','capability','binding','authorization','resolved','stale'])await t.test(mode,async t=>{
    const f=await setup(t,{allowWrites:mode!=='disabled'});if(mode==='capability')f.port.plugin.sendP0Alert=undefined;
    await f.p0.evaluate(signal());
    if(mode==='binding')f.runtime.store.run("UPDATE plugin_delivery_bindings SET binding_id='changed'");
    if(mode==='authorization')f.port.authorize=()=>{throw new Error('REVOKED');};
    if(mode==='resolved')f.service.resolve(binding.projectId,f.work().id,'developer');
    if(mode==='stale'){f.runtime.ingress.commitBatch(scope,[event('withdrawn',{objectId:'critical-0',action:'updated',revision:'2',text:'存档正常'})]);f.runtime.tick();}
    await f.p0.deliver(signal());assert.equal(f.posts(),0);assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'blocked');
  });
});
test('P0 QQ rendering escapes evidence and does not invoke report navigation or fallback',async()=>{
  const payloads=[];const plugin=new QQC2CDelivery({projectId:'p',recipientRef:'qq-developer',messageOptions:async()=>{throw new Error('REPORT_PATH_USED');},api:{fetch:async(url,init)=>{
    if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture',expires_in:7200});
    assert.match(String(url),/\/v2\/users\//);payloads.push(JSON.parse(init.body));return Response.json({id:'alert'});
  }}});
  const request={deliveryId:'id',idempotencyKey:'key',projectId:'p',alertId:'a',recipientRef:'qq-developer',title:'[title](https://example.invalid)',markdown:'# evidence <script>',requestedAt:'2026-11-04T00:00:00Z'};
  assert.equal((await plugin.sendP0Alert({...request,recipientRef:'other'},deliveryHost(plugin,readSecret))).status,'blocked');assert.equal(payloads.length,0);
  assert.equal((await plugin.sendP0Alert(request,deliveryHost(plugin,readSecret))).status,'accepted');assert.equal(payloads.length,1);
  assert.equal(payloads[0].keyboard,undefined);assert.match(payloads[0].markdown.content,/\\\[title\\\]/);assert.match(payloads[0].markdown.content,/\\<script\\>/);
});
test('known safe P0 retries wait at least 30 seconds and stop at three attempts',async t=>{
  for(const eventualSuccess of [true,false])await t.test(String(eventualSuccess),async t=>{
    const f=await setup(t);let calls=0;f.port.plugin.sendP0Alert=async()=>{calls++;return eventualSuccess&&calls===3?{status:'accepted',providerMessageId:'third'}:{status:'retryable',errorCode:'SAFE_BEFORE_POST',retryAfterMs:1};};
    await f.p0.evaluate(signal());await f.p0.deliver(signal());assert.equal(calls,1);
    await f.p0.deliver(signal());f.advance(29999);await f.p0.deliver(signal());assert.equal(calls,1);
    f.advance(1);await f.p0.deliver(signal());assert.equal(calls,2);
    f.advance(30000);await f.p0.deliver(signal());assert.equal(calls,3);
    f.advance(3600000);await f.p0.deliver(signal());assert.equal(calls,3);
    assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,eventualSuccess?'accepted':'manual_review');
  });
});
test('explicit realert adds generation, resolved incident needs new regression evidence for automatic alert',async t=>{
  const f=await setup(t);await f.p0.evaluate(signal());
  const work=f.work(),refs=f.service.evidence(work).map(e=>({eventId:e.eventId,excerpt:e.quote}));
  const second=f.service.confirm(work,refs,'irreversible_save_loss','developer',true);assert.equal(second.alertGeneration,2);
  f.service.resolve(binding.projectId,work.id,'developer');
  const assessment={verdict:'confirmed',impact:'irreversible_save_loss',rationale:'test',evidence:refs.map(e=>({eventId:e.eventId,quote:e.excerpt}))};
  assert.equal(f.service.assess(work,assessment),undefined,'old evidence is not a confirmed regression');
  f.advance(1000);f.add('regression',critical);await f.worker.tick();
  const updated=f.work(),alert=f.service.assess(updated,{...assessment,evidence:f.service.evidence(updated).map(e=>({eventId:e.eventId,quote:e.quote}))});
  assert.equal(alert.alertGeneration,1);assert.notEqual(alert.incidentId,second.incidentId);
  const report=(await import('@superagent/reporting')).ReportService;
  const reports=new report(f.runtime.store,f.domain,f.runtime.queue,{clock:f.clock});
  f.setTime('2026-11-02T10:04:00Z');const r=reports.generate((await import('@superagent/reporting')).latestClosedWindow(binding.projectId,f.clock()));
  assert.equal(r.counts.uniqueDefects,1);assert.match(r.markdown,/P0/);
});
test('expired assessment lease cannot publish; crashed delivery lease becomes unknown without a second POST',async t=>{
  const f=await setup(t),original=f.model.generate;
  f.model.generate=async request=>{const response=await original(request);f.advance(31000);return response;};
  assert.equal((await f.p0.evaluate(signal())).status,'lease_lost');assert.equal(f.runtime.store.get('SELECT count(*) n FROM p0_alerts').n,0);
  f.model.generate=original;f.runtime.queue.recoverExpired();f.advance(1000);await f.p0.evaluate(signal());
  const row=f.runtime.store.get('SELECT operation_id FROM p0_alert_deliveries');assert.ok(row);
  f.runtime.store.run("UPDATE external_operations SET state='in_flight',attempt=1,lease_owner='crashed',lease_until=? WHERE operation_id=?",f.clock(),row.operation_id);
  f.p0.recover();await f.p0.deliver(signal());assert.equal(f.posts(),0);assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'unknown');
});
test('timeout and cancellation contain uncooperative model/plugin promises and late completions never change outcome',async t=>{
  const f=await setup(t);let release;
  const original=f.model.generate;
  f.model.generate=()=>new Promise(resolve=>{release=resolve;});
  const running=f.p0.evaluate(signal());await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await running).status,'P0_EVALUATION_FAILED');
  const late=await original({prompt:JSON.stringify({evidence:f.service.evidence(f.work())})});release(late);await new Promise(setImmediate);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM p0_alerts').n,0);
  f.advance(2000);f.model.generate=original;await f.p0.evaluate(signal());
  let finish;f.port.plugin.sendP0Alert=()=>new Promise(resolve=>{finish=resolve;});
  assert.equal((await f.p0.deliver(signal())).status,'unknown');finish({status:'accepted',providerMessageId:'late'});await new Promise(setImmediate);
  assert.equal(f.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'unknown');
});
