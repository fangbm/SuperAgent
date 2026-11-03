import assert from 'node:assert/strict';
import test from 'node:test';
import { QQOperatorService } from '@superagent/control-plane';
import { QQC2CDelivery, QQSource } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost, ReportDeliveryCoordinator } from '@superagent/plugin-host';
import { m5Fixture } from './m5-helpers.mjs';
import { binding, scope, count, event } from './helpers.mjs';
import { originalFromMarkdown } from './qq-markdown-helpers.mjs';
import { fixtureAnswer } from './m3-helpers.mjs';
import { qqSecrets, readSecret, signed } from './qq-helpers.mjs';
import { createDemo,demoProject } from '../../scripts/m5-demo-data.mjs';

async function setup(t,options={}){
  const f=await m5Fixture(t);f.add('one',options.text);await f.worker.tick();const report=f.generate();const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});
  const requests=[];let coordinator;
  const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',navigationTokens:async request=>qq.navigationTokens(request),messageOptions:async request=>coordinator.messageOptions(request.deliveryId),api:{fetch:async(url,init)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});requests.push({url:String(url),body:JSON.parse(init.body),method:init.method});return options.send?options.send(requests.length):Response.json({id:`fixture-message-${requests.length}`});}}});
  const service=new DurableDeliveryService(f.runtime.store,plugin,deliveryHost(plugin,readSecret),{projectId:binding.projectId,recipientRef:'developer',recipientBindingId:'m5-fixture-binding',clock:f.clock,allowWrites:true,authorizeInteraction:r=>coordinator.authorizeReply(r),authorizeDelivery:()=>f.auth.authorize(f.auth.principal('developer'),binding.projectId)});
  coordinator=new ReportDeliveryCoordinator(f.runtime.store,service,{getReport:(p,id,rev)=>f.reports.getExact(p,id,rev),clock:f.clock});
  const receive=(id,kind,content)=>{qq.receive({interactionId:id,kind,content,reply:kind==='button'?{eventId:`INTERACTION_CREATE:${id}`}:{messageId:id}});const processed=qq.tick();const plan=processed.deliveryId?f.runtime.store.get('SELECT * FROM operator_reply_plans WHERE delivery_id=?',processed.deliveryId):null;return plan?{request:JSON.parse(plan.request_json),options:JSON.parse(plan.message_options_json)}:null;};
  return{...f,report,qq,plugin,service,coordinator,requests,receive};
}
test('report delivery renders three scoped navigation buttons, persists accepted once and never patches report',async t=>{
  const f=await setup(t);assert.equal(f.coordinator.prepare(binding.projectId,'developer').prepared,1);assert.equal((await f.service.tick({purpose:'report'})).state,'succeeded');f.coordinator.prepare(binding.projectId,'developer');
  assert.equal(f.requests.length,1);const buttons=f.requests[0].body.keyboard.content.rows[0].buttons;assert.equal(buttons.length,3);assert.ok(buttons.every(b=>b.action.data.length===43));assert.equal(f.runtime.store.get('SELECT status FROM deliveries').status,'accepted');
  assert.equal(f.requests[0].body.markdown.content.match(/^# 社区反馈半日报$/gm).length,1);assert.ok(f.requests[0].body.markdown.content.startsWith('# 社区反馈半日报\n'));
  assert.equal((await f.service.tick()).processed,false);assert.equal(f.reports.getExact(binding.projectId,f.report.reportId,1).revision,1);
});

test('one report click shows summary, state and full short original; returning keeps the selected revision',async t=>{
  const f=await setup(t);f.runtime.store.run("UPDATE operator_accounts SET role='reader' WHERE actor_ref='developer'");const before=JSON.stringify(f.report);
  f.coordinator.prepare(binding.projectId,'developer');await f.service.tick({purpose:'report'});
  const button=f.requests[0].body.keyboard.content.rows[0].buttons[0];
  const card=f.receive('flat-report-bug','button',button.action.data);
  assert.match(card.request.text,/^# Bug · 1 \/ 1/);assert.match(card.request.text,/反馈摘要/);assert.match(card.request.text,/状态/);assert.match(originalFromMarkdown(card.request.text),/联机/);
  assert.deepEqual(card.options.buttons.map(b=>b.label),['返回半日报']);
  f.setTime('2026-11-02T10:06:00.000Z');f.reports.generate(f.report.window,{revise:true,expectedRevision:1});
  const back=f.receive('flat-back','button',card.options.buttons[0].token);assert.match(back.request.text,/社区反馈半日报/);assert.equal(back.request.reportRevision,1);assert.deepEqual(f.reports.getExact(binding.projectId,f.report.reportId,1),JSON.parse(before));
  assert.equal(count(f.runtime.store,'operator_commands'),0);assert.equal(f.runtime.store.get("SELECT count(*) n FROM operator_tokens WHERE purpose='status_action'").n,0);
});

test('flat feedback cards traverse snapshot order, expose Steam text immediately, and keep keyboard limits',async t=>{
  const app=await createDemo(':memory:');t.after(()=>app.runtime.close());const actor='web-developer',principal=app.control.auth.principal(actor),qq=new QQOperatorService(app.control,{projectId:demoProject,actorRef:actor,recipientRef:actor,clock:app.clock});let sequence=0;
  const click=(kind,content)=>{qq.receive({interactionId:'flat-'+sequence++,kind,content,reply:{eventId:'INTERACTION_CREATE:flat'}});const result=qq.tick(),row=app.runtime.store.get('SELECT request_json,message_options_json FROM operator_reply_plans WHERE delivery_id=?',result.deliveryId);return{request:JSON.parse(row.request_json),options:JSON.parse(row.message_options_json)};};
  const report=app.reports.list(demoProject,1)[0];let card=click('command','/bugs'),index=0,first;
  do{
    const id=report.issueIds[index],work=app.control.work(principal,demoProject,'defect',id),evidence=app.control.evidence(principal,demoProject,'defect',id,{reportId:report.reportId,revision:1,limit:1});
    assert.ok(card.request.text.includes(work.title));assert.equal(originalFromMarkdown(card.request.text),evidence.items[0].originalText);assert.ok(card.options.buttons.length<=9);assert.doesNotMatch(card.request.text,/\/open /);assert.ok(card.request.text.length<=3500);
    if(index===0){first=card.request.text;assert.ok(!card.options.buttons.some(b=>b.label==='上一条'));}else{const previous=click('button',card.options.buttons.find(b=>b.label==='上一条').token);assert.match(previous.request.text,new RegExp(`Bug · ${index} / 3`));}
    index++;const next=card.options.buttons.find(b=>b.label==='下一条');if(!next)break;card=click('button',next.token);
  }while(index<10);
  assert.equal(index,report.issueIds.length);assert.equal(index,3);
  const steam=click('command','/steam-negative');assert.match(originalFromMarkdown(steam.request.text),/联机连接不稳定/);assert.deepEqual(steam.options.buttons.map(b=>b.label),['返回半日报']);
  const navToken=app.control.tokens.issue(principal,demoProject,'qq_navigation',{route:'browse',reportId:report.reportId,revision:1,section:'bugs',entryOffset:99});
  const invalid=click('button',navToken);assert.match(invalid.request.text,/操作未完成/);assert.doesNotMatch(invalid.request.text,/原始反馈/);assert.ok(first);
});

test('empty category returns a clear notice with a direct report exit',async t=>{
  const f=await setup(t),empty=f.receive('flat-empty','command','/steam-negative');assert.match(empty.request.text,/本期暂无/);assert.deepEqual(empty.options.buttons.map(b=>b.label),['返回半日报']);const back=f.receive('flat-empty-back','button',empty.options.buttons[0].token);assert.equal(back.request.reportId,f.report.reportId);assert.match(back.request.text,/社区反馈半日报/);
});

test('already-issued list, work and evidence tokens still resolve after flat navigation rollout',async t=>{
  const f=await setup(t),token=f.tokens.issue(f.principal,binding.projectId,'qq_navigation',{route:'section',reportId:f.report.reportId,revision:1,section:'bugs'},{stableKey:'legacy-report:bugs'});
  const current=f.qq.navigationTokens({deliveryId:'legacy-report',projectId:binding.projectId,recipientRef:'developer',reportId:f.report.reportId,reportRevision:1});assert.notEqual(current[0],token);
  const list=f.receive('legacy-section','button',token),work=f.receive('legacy-work','button',list.options.buttons.find(b=>b.label==='详情 1').token),original=f.receive('legacy-original','button',work.options.buttons.find(b=>b.label==='查看原文').token);
  assert.match(originalFromMarkdown(original.request.text),/联机/);assert.equal(original.request.reportRevision,1);
});
test('only definitive Markdown denial permits a durable plain-text fallback; unknown never does',async t=>{
  const f=await setup(t,{send:n=>n===1?Response.json({code:40034127}):Response.json({id:'plain-accepted'})});f.coordinator.prepare(binding.projectId,'developer');assert.equal((await f.service.tick()).state,'blocked');assert.equal(f.coordinator.prepare(binding.projectId,'developer').prepared,1);
  assert.equal((await f.service.tick()).state,'succeeded');f.coordinator.prepare(binding.projectId,'developer');assert.deepEqual(f.requests.map(r=>r.body.msg_type),[2,0]);assert.match(f.requests[1].body.content,/\/bugs/);
});
test('QQ unknown reply send remains unknown and receives no format fallback or replay',async t=>{
  const f=await setup(t,{send:()=>{throw new Error('fixture-lost-response');}});f.coordinator.prepare(binding.projectId,'developer');assert.equal((await f.service.tick()).state,'unknown');f.coordinator.prepare(binding.projectId,'developer');assert.equal(f.runtime.store.get('SELECT state FROM report_delivery_plans').state,'unknown');assert.equal((await f.service.tick()).processed,false);assert.equal(f.requests.length,1);
});
test('duplicate QQ command creates one reply and original queries use the frozen report revision',async t=>{
  const f=await setup(t);const one=f.receive('command-1','command','/suggestions');assert.match(one.request.text,/原始反馈/);assert.equal(f.receive('command-1','command','/suggestions'),null);
  assert.match(one.request.text,/待复核/);const accept=one.options.buttons.find(b=>b.label==='接受建议');assert.ok(accept);
  f.receive('accept-1','button',accept.token);const work=f.control.listWorks(f.principal,binding.projectId,'suggestion')[0];assert.equal(work.status,'accepted');f.receive('accept-1','button',accept.token);assert.equal(count(f.runtime.store,'suggestion_status_history'),1);
  f.coordinator.enqueueReplies(binding.projectId,'developer');for(let i=0;i<2;i++)await f.service.tick({purpose:'interaction'});assert.equal(f.requests.length,2);assert.equal((await f.service.tick({purpose:'interaction'})).processed,false);
  for(const request of f.requests)for(const row of request.body.keyboard?.content.rows??[])for(const button of row.buttons)assert.deepEqual(button.action.permission,{type:2});
});
test('QQ original text is segmented without loss or broken emoji',async t=>{
  const original='联机崩溃：'+'🙂'.repeat(3000);const f=await setup(t,{text:original});let response=f.receive('bugs','command','/bugs');let recovered='';let n=0;
  while(response){recovered+=originalFromMarkdown(response.request.text);assert.equal(response.options.format,'markdown');assert.equal(response.options.bodyIncludesTitle,true);const next=response.options.buttons.find(b=>['继续原文','继续阅读'].includes(b.label));if(!next)break;response=f.receive('more-'+(++n),'button',next.token);}
  assert.equal(recovered,original);assert.equal(n,2);
  const back=f.receive('long-back-to-card','button',response.options.buttons.find(b=>b.label==='返回反馈').token);assert.equal(originalFromMarkdown(back.request.text),Array.from(original).slice(0,800).join(''));
});

test('original pages keep raw evidence but send literal Markdown with native pagination instead of visible open commands',async t=>{
  const original='多人联机90%崩溃\n# [原文](https://example.invalid)\n1. **不要改写** <qqbot-at-everyone /> C:\\game\n'+'🙂'.repeat(1500);
  const f=await setup(t,{text:original});const page=f.receive('literal-card','command','/bugs');
  const next=page.options.buttons.find(b=>b.label==='继续原文');assert.ok(next);assert.equal(page.options.bodyIncludesTitle,true);assert.equal(originalFromMarkdown(page.request.text),Array.from(original).slice(0,800).join(''));
  f.coordinator.enqueueReplies(binding.projectId,'developer');const operation=f.runtime.store.get('SELECT operation_id FROM operator_reply_plans WHERE delivery_id=?',page.request.deliveryId);assert.equal((await f.service.tick({purpose:'interaction',operationId:operation.operation_id})).state,'succeeded');
  const payload=f.requests[0].body;assert.equal(payload.msg_type,2);assert.equal(payload.content,undefined);assert.equal(payload.markdown.content.includes('/open '),false);assert.equal(payload.markdown.content.includes('操作命令'),false);assert.ok(payload.markdown.content.includes('\\# \\[原文\\]\\(https://example.invalid\\)'));assert.ok(payload.markdown.content.includes('\\*\\*不要改写\\*\\*'));assert.ok(payload.markdown.content.includes('\\<qqbot\\-at\\-everyone /\\>'));
  const buttons=payload.keyboard.content.rows.flatMap(r=>r.buttons);assert.ok(buttons.some(b=>b.action.data===next.token));assert.ok(buttons.every(b=>b.action.type===1));assert.ok(payload.markdown.content.length<=3500);
  assert.equal(f.control.evidence(f.principal,binding.projectId,'defect',f.report.issueIds[0],{reportId:f.report.reportId,revision:1}).items[0].originalText,original);
});

test('QQ read-only operators can query frozen details and originals without receiving action tokens',async t=>{
  const f=await setup(t);f.runtime.store.run("UPDATE operator_accounts SET role='reader' WHERE actor_ref='developer'");const card=f.receive('reader-bugs','command','/bugs');assert.deepEqual(card.options.buttons.map(b=>b.label),['返回半日报']);assert.match(card.request.text,/状态/);assert.match(originalFromMarkdown(card.request.text),/联机/);assert.equal(count(f.runtime.store,'operator_commands'),0);assert.equal(f.runtime.store.get("SELECT count(*) n FROM operator_tokens WHERE purpose='status_action'").n,0);
});

test('C2C button replies use the outer event id rather than the interaction UUID or a new active send',async t=>{
  const f=await setup(t);const section=f.receive('passive-command','command','/reports');const detailToken=section.options.buttons.find(b=>b.label==='查看 Bug').token;
  f.qq.receive({interactionId:'button:interaction-uuid',kind:'button',content:detailToken,reply:{eventId:'INTERACTION_CREATE:outer-event-id'}});f.qq.tick();f.coordinator.enqueueReplies(binding.projectId,'developer');
  await f.service.tick({purpose:'interaction'});await f.service.tick({purpose:'interaction'});assert.equal(f.requests.length,2);
  const passive=f.requests.find(r=>r.body.msg_id==='passive-command'),button=f.requests.find(r=>r.body.event_id==='INTERACTION_CREATE:outer-event-id');assert.ok(passive);assert.ok(button);assert.equal(button.body.msg_id,undefined);assert.equal(button.body.msg_seq,1);assert.match(button.body.markdown.content,/状态/);
});

test('missing passive reply context blocks before POST and cannot silently become an active message',async t=>{
  const f=await setup(t);const section=f.receive('summary','command','/reports');f.qq.receive({interactionId:'button:missing-context',kind:'button',content:section.options.buttons.find(b=>b.label==='查看 Bug').token,reply:{}});const reply=f.qq.tick();f.coordinator.enqueueReplies(binding.projectId,'developer');const operation=f.runtime.store.get('SELECT operation_id FROM operator_reply_plans WHERE delivery_id=?',reply.deliveryId);const result=await f.service.tick({purpose:'interaction',operationId:operation.operation_id});assert.equal(result.state,'blocked');assert.equal(f.requests.length,0);assert.equal(f.service.get(result.operationId).result.errorCode,'QQ_REPLY_CONTEXT_REQUIRED');
});
test('QQ evidence navigation continues beyond fifty independent source objects without omitting originals',async t=>{
  const f=await m5Fixture(t,{responder:task=>{const answer=fixtureAnswer(task);if(task.task==='extract')answer.items[0].evidence=task.messages.filter(m=>m.role==='candidate').map(m=>({eventId:m.eventId,role:'primary',quote:m.text}));return answer;}});
  const events=Array.from({length:51},(_,i)=>event(`source-${i}`,{text:`联机载入90%时崩溃，原始反馈 #${i}`}));f.runtime.ingress.commitBatch(scope,events);f.runtime.tick();for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
  while((await f.worker.tick()).processed){}const report=f.generate();assert.equal(f.domain.getWork(binding.projectId,'defect',report.issueIds[0]).feedbackCount,51);
  const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});let n=0;
  const click=(kind,content)=>{qq.receive({interactionId:'many-'+n++,kind,content,reply:kind==='button'?{eventId:'INTERACTION_CREATE:reply-'+n}:{messageId:'reply-'+n}});const result=qq.tick();return JSON.parse(f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=?',result.deliveryId).message_options_json);};
  let buttons=click('command','/bugs');let pages=1;
  while(buttons.buttons.some(b=>b.label==='下一条原文')){buttons=click('button',buttons.buttons.find(b=>b.label==='下一条原文').token);pages++;}
  assert.equal(pages,51);assert.equal(count(f.runtime.store,'operator_reply_plans'),51);
});
test('authenticated QQ interactions persist quickly before ACK, reject wrong actors/scenes and never ingest control messages',async t=>{
  const f=await setup(t);const events=[];const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(f.clock()),operator:{receive:async request=>{events.push('persist');return f.qq.receive(request);}},api:{fetch:async(url)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});events.push('ack');return new Response(null,{status:204});}}});
  const host=f.runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:async key=>key==='QQ_OPERATOR_OPENID'?qqSecrets.QQ_RECIPIENT_OPENID:readSecret(key)});await source.start(host,new AbortController().signal);
  const request={deliveryId:'00000000-0000-4000-a000-000000000001',projectId:binding.projectId,recipientRef:'developer',reportId:f.report.reportId,reportRevision:1};const token=f.qq.navigationTokens(request)[0];
  const callback={op:0,id:'INTERACTION_CREATE:outer-event',t:'INTERACTION_CREATE',d:{id:'button-event',scene:'c2c',user_openid:qqSecrets.QQ_RECIPIENT_OPENID,data:{type:11,resolved:{button_data:token}}}};
  try{
    assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);assert.deepEqual(events,['persist','ack']);assert.equal(f.runtime.store.get("SELECT state FROM operator_inbox").state,'pending');assert.equal(JSON.parse(f.runtime.store.get('SELECT request_json FROM operator_inbox').request_json).reply.eventId,callback.id);
    assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);assert.deepEqual(events,['persist','ack','persist']);
    assert.equal((await source.handleWebhook(...signed({...callback,id:'INTERACTION_CREATE:other-transport'},f.clock))).statusCode,200);assert.deepEqual(events,['persist','ack','persist','persist']);assert.equal(JSON.parse(f.runtime.store.get('SELECT request_json FROM operator_inbox').request_json).reply.eventId,callback.id);
    await source.handleWebhook(...signed({...callback,d:{...callback.d,id:'group-forgery',scene:'group',group_openid:qqSecrets.QQ_SCOPE_ID}},f.clock));await source.handleWebhook(...signed({...callback,d:{...callback.d,id:'actor-forgery',user_openid:'other-user'}},f.clock));assert.equal(count(f.runtime.store,'operator_inbox'),1);assert.equal(count(f.runtime.store,'source_events'),1);
  }finally{await source.stop();}
});

test('C2C msg_idx separates control commands sharing msg_id and allocates distinct passive reply sequences',async t=>{
  const f=await setup(t);const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(f.clock()),operator:{receive:r=>Promise.resolve(f.qq.receive(r))}});
  const host=f.runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:key=>key==='QQ_OPERATOR_OPENID'?Promise.resolve(qqSecrets.QQ_RECIPIENT_OPENID):readSecret(key)});await source.start(host,new AbortController().signal);
  try{for(const index of ['one','two','one']){const callback={op:0,t:'C2C_MESSAGE_CREATE',d:{id:'same-msg-id',author:{user_openid:qqSecrets.QQ_RECIPIENT_OPENID},content:'/bugs',message_scene:{ext:[`msg_idx=${index}`,'auth_token=not-for-core']}}};assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);f.qq.tick();}
    assert.equal(count(f.runtime.store,'operator_inbox'),2);const plans=f.runtime.store.all('SELECT message_options_json FROM operator_reply_plans ORDER BY rowid').map(p=>JSON.parse(p.message_options_json));assert.deepEqual(plans.map(p=>p.replyTo.sequence),[1,2]);assert.ok(plans.every(p=>p.replyTo.messageId==='same-msg-id'));assert.equal(JSON.stringify(f.runtime.store.all('SELECT request_json FROM operator_inbox')).includes('not-for-core'),false);
  }finally{await source.stop();}
});
