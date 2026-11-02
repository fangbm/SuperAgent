import assert from 'node:assert/strict';
import test from 'node:test';
import { QQOperatorService } from '@superagent/control-plane';
import { QQC2CDelivery, QQSource } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost, ReportDeliveryCoordinator } from '@superagent/plugin-host';
import { m5Fixture } from './m5-helpers.mjs';
import { binding, scope, count, event } from './helpers.mjs';
import { fixtureAnswer } from './m3-helpers.mjs';
import { qqSecrets, readSecret, signed } from './qq-helpers.mjs';

async function setup(t,options={}){
  const f=await m5Fixture(t);f.add('one',options.text);await f.worker.tick();const report=f.generate();const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});
  const requests=[];let coordinator;
  const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',navigationTokens:async request=>qq.navigationTokens(request),messageOptions:async request=>coordinator.messageOptions(request.deliveryId),api:{fetch:async(url,init)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});requests.push({url:String(url),body:JSON.parse(init.body),method:init.method});return options.send?options.send(requests.length):Response.json({id:`fixture-message-${requests.length}`});}}});
  const service=new DurableDeliveryService(f.runtime.store,plugin,deliveryHost(plugin,readSecret),{projectId:binding.projectId,recipientRef:'developer',recipientBindingId:'m5-fixture-binding',clock:f.clock,allowWrites:true,authorizeInteraction:r=>coordinator.authorizeReply(r),authorizeDelivery:()=>f.auth.authorize(f.auth.principal('developer'),binding.projectId)});
  coordinator=new ReportDeliveryCoordinator(f.runtime.store,service,{getReport:(p,id,rev)=>f.reports.getExact(p,id,rev),clock:f.clock});
  const receive=(id,kind,content)=>{qq.receive({interactionId:id,kind,content,reply:{messageId:id}});const processed=qq.tick();const plan=processed.deliveryId?f.runtime.store.get('SELECT * FROM operator_reply_plans WHERE delivery_id=?',processed.deliveryId):null;return plan?{request:JSON.parse(plan.request_json),options:JSON.parse(plan.message_options_json)}:null;};
  return{...f,report,qq,plugin,service,coordinator,requests,receive};
}
test('report delivery renders three scoped navigation buttons, persists accepted once and never patches report',async t=>{
  const f=await setup(t);assert.equal(f.coordinator.prepare(binding.projectId,'developer').prepared,1);assert.equal((await f.service.tick({purpose:'report'})).state,'succeeded');f.coordinator.prepare(binding.projectId,'developer');
  assert.equal(f.requests.length,1);const buttons=f.requests[0].body.keyboard.content.rows[0].buttons;assert.equal(buttons.length,3);assert.ok(buttons.every(b=>b.action.data.length===43));assert.equal(f.runtime.store.get('SELECT status FROM deliveries').status,'accepted');
  assert.equal((await f.service.tick()).processed,false);assert.equal(f.reports.getExact(binding.projectId,f.report.reportId,1).revision,1);
});
test('only definitive Markdown denial permits a durable plain-text fallback; unknown never does',async t=>{
  const f=await setup(t,{send:n=>n===1?Response.json({code:40034127}):Response.json({id:'plain-accepted'})});f.coordinator.prepare(binding.projectId,'developer');assert.equal((await f.service.tick()).state,'blocked');assert.equal(f.coordinator.prepare(binding.projectId,'developer').prepared,1);
  assert.equal((await f.service.tick()).state,'succeeded');f.coordinator.prepare(binding.projectId,'developer');assert.deepEqual(f.requests.map(r=>r.body.msg_type),[2,0]);assert.match(f.requests[1].body.content,/\/bugs/);
});
test('QQ unknown reply send remains unknown and receives no format fallback or replay',async t=>{
  const f=await setup(t,{send:()=>{throw new Error('fixture-lost-response');}});f.coordinator.prepare(binding.projectId,'developer');assert.equal((await f.service.tick()).state,'unknown');f.coordinator.prepare(binding.projectId,'developer');assert.equal(f.runtime.store.get('SELECT state FROM report_delivery_plans').state,'unknown');assert.equal((await f.service.tick()).processed,false);assert.equal(f.requests.length,1);
});
test('duplicate QQ command creates one reply and original queries use the frozen report revision',async t=>{
  const f=await setup(t);const one=f.receive('command-1','command','/suggestions');assert.equal(one.options.buttons.some(b=>b.label==='详情 1'),true);assert.equal(f.receive('command-1','command','/suggestions'),null);
  const detail=f.receive('detail-1','button',one.options.buttons.find(b=>b.label==='详情 1').token);assert.match(detail.request.text,/candidate/);const accept=detail.options.buttons.find(b=>b.label==='Accept');assert.ok(accept);
  f.receive('accept-1','button',accept.token);const work=f.control.listWorks(f.principal,binding.projectId,'suggestion')[0];assert.equal(work.status,'accepted');f.receive('accept-1','button',accept.token);assert.equal(count(f.runtime.store,'suggestion_status_history'),1);
  f.coordinator.enqueueReplies(binding.projectId,'developer');for(let i=0;i<3;i++)await f.service.tick({purpose:'interaction'});assert.equal(f.requests.length,3);assert.equal((await f.service.tick({purpose:'interaction'})).processed,false);
});
test('QQ original text is segmented without loss or broken emoji',async t=>{
  const original='联机崩溃：'+'🙂'.repeat(3000);const f=await setup(t,{text:original});const section=f.receive('bugs','command','/bugs');const detail=f.receive('work','button',section.options.buttons.find(b=>b.label==='详情 1').token);let response=f.receive('evidence','button',detail.options.buttons.find(b=>b.label==='Details 原文').token);let recovered='';let n=0;
  while(response){recovered+=response.request.text.split('\n\n')[1];assert.equal(response.options.format,'text');const next=response.options.buttons.find(b=>b.label==='Next 续文');if(!next)break;response=f.receive('more-'+(++n),'button',next.token);}
  assert.equal(recovered,original);assert.equal(n,2);
});

test('QQ read-only operators can query frozen details and originals without receiving action tokens',async t=>{
  const f=await setup(t);f.runtime.store.run("UPDATE operator_accounts SET role='reader' WHERE actor_ref='developer'");const section=f.receive('reader-bugs','command','/bugs');const detail=f.receive('reader-work','button',section.options.buttons.find(b=>b.label==='详情 1').token);assert.equal(detail.options.buttons.length,1);assert.match(detail.request.text,/当前状态/);const original=f.receive('reader-original','button',detail.options.buttons[0].token);assert.match(original.request.text,/联机/);assert.equal(count(f.runtime.store,'operator_commands'),0);
});
test('QQ evidence navigation continues beyond fifty independent source objects without omitting originals',async t=>{
  const f=await m5Fixture(t,{responder:task=>{const answer=fixtureAnswer(task);if(task.task==='extract')answer.items[0].evidence=task.messages.filter(m=>m.role==='candidate').map(m=>({eventId:m.eventId,role:'primary',quote:m.text}));return answer;}});
  const events=Array.from({length:51},(_,i)=>event(`source-${i}`,{text:`联机载入90%时崩溃，原始反馈 #${i}`}));f.runtime.ingress.commitBatch(scope,events);f.runtime.tick();for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
  while((await f.worker.tick()).processed){}const report=f.generate();assert.equal(f.domain.getWork(binding.projectId,'defect',report.issueIds[0]).feedbackCount,51);
  const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});let n=0;
  const click=(kind,content)=>{qq.receive({interactionId:'many-'+n++,kind,content,reply:{messageId:'reply-'+n}});const result=qq.tick();return JSON.parse(f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=?',result.deliveryId).message_options_json);};
  let buttons=click('command','/bugs');buttons=click('button',buttons.buttons.find(b=>b.label==='详情 1').token);buttons=click('button',buttons.buttons.find(b=>b.label==='Details 原文').token);let pages=1;
  while(buttons.buttons.some(b=>b.label==='下一条原文')){buttons=click('button',buttons.buttons.find(b=>b.label==='下一条原文').token);pages++;}
  assert.equal(pages,51);assert.equal(count(f.runtime.store,'operator_reply_plans'),53);
});
test('authenticated QQ interactions persist quickly before ACK, reject wrong actors/scenes and never ingest control messages',async t=>{
  const f=await setup(t);const events=[];const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(f.clock()),operator:{receive:async request=>{events.push('persist');return f.qq.receive(request);}},api:{fetch:async(url)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});events.push('ack');return new Response(null,{status:204});}}});
  const host=f.runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:async key=>key==='QQ_OPERATOR_OPENID'?qqSecrets.QQ_RECIPIENT_OPENID:readSecret(key)});await source.start(host,new AbortController().signal);
  const request={deliveryId:'00000000-0000-4000-a000-000000000001',projectId:binding.projectId,recipientRef:'developer',reportId:f.report.reportId,reportRevision:1};const token=f.qq.navigationTokens(request)[0];
  const callback={op:0,t:'INTERACTION_CREATE',d:{id:'button-event',scene:'c2c',user_openid:qqSecrets.QQ_RECIPIENT_OPENID,data:{type:11,resolved:{button_data:token}}}};
  try{
    assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);assert.deepEqual(events,['persist','ack']);assert.equal(f.runtime.store.get("SELECT state FROM operator_inbox").state,'pending');
    await source.handleWebhook(...signed({...callback,d:{...callback.d,id:'group-forgery',scene:'group',group_openid:qqSecrets.QQ_SCOPE_ID}},f.clock));await source.handleWebhook(...signed({...callback,d:{...callback.d,id:'actor-forgery',user_openid:'other-user'}},f.clock));assert.equal(count(f.runtime.store,'operator_inbox'),1);assert.equal(count(f.runtime.store,'source_events'),1);
  }finally{await source.stop();}
});
