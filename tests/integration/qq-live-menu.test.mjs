import assert from 'node:assert/strict';
import test from 'node:test';
import {QQOperatorService,QQLiveQueries} from '@superagent/control-plane';
import {QQSource,QQC2CDelivery} from '@superagent/qq-official';
import {deliveryHost} from '@superagent/plugin-host';
import {qqMenuDenial} from '../../scripts/qq-menu-denial.mjs';
import {m5Fixture} from './m5-helpers.mjs';
import {binding,scope,count,event} from './helpers.mjs';
import {signed,readSecret,qqSecrets} from './qq-helpers.mjs';
async function setup(t,role='developer'){
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();
  const service=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:role,recipientRef:'developer',clock:f.clock,menu:{enabled:true,defaultRecentHours:24,webURL:'https://work.example.com/console'}});
  let seq=0;const receive=(content,kind='command')=>{seq++;service.receive({interactionId:`menu-${seq}`,kind,content,reply:kind==='command'?{messageId:`m-${seq}`}:{eventId:`INTERACTION_CREATE:${seq}`}});const r=service.tick(),plan=f.runtime.store.get('SELECT * FROM operator_reply_plans WHERE delivery_id=?',r.deliveryId);return{delivery:JSON.parse(plan.request_json),options:JSON.parse(plan.message_options_json)};};
  return{...f,service,receive,queries:new QQLiveQueries(f.control)};
}
test('real-time pending/recent work without a report, signed navigation includes current detail/original/status and passive reply context',async t=>{
  const f=await setup(t),list=f.receive('/pending');assert.match(list.delivery.text,/实时待办/);assert.match(list.delivery.text,/未处理 Bug/);assert.equal(list.options.replyTo.messageId,'m-1');assert.equal(list.options.requireReplyContext,true);assert.equal(list.delivery.reportId,'operator-response');assert.equal(count(f.runtime.store,'report_revisions'),0);
  const detail=f.receive(list.options.buttons.find(b=>b.label==='详情 1').token,'button');assert.ok(detail.options.card);assert.equal(detail.options.replyTo.eventId,'INTERACTION_CREATE:2');
  const original=f.receive(detail.options.buttons.find(b=>b.label==='查看原文').token,'button');assert.match(original.delivery.text,/Windows 1.2.0/);assert.equal(count(f.runtime.store,'operator_commands'),0);
  assert.match(f.receive('/recent').delivery.text,/窗口/);assert.match(f.receive('/web').delivery.text,/https:\/\/work.example.com\/console/);
});
test('pending bug/suggestion states separate fixed from unprocessed and exclude accepted suggestions/terminal bugs',async t=>{
  const f=await setup(t),store=f.runtime.store;const issue=store.get('SELECT issue_id FROM issues').issue_id,suggestion=store.get('SELECT suggestion_id FROM suggestions').suggestion_id;
  store.run("UPDATE issues SET status='fixed' WHERE issue_id=?",issue);store.run("UPDATE suggestions SET status='accepted' WHERE suggestion_id=?",suggestion);
  let snapshot=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.equal(snapshot.entries.find(e=>e.id===issue).category,'待验证');assert.equal(snapshot.entries.some(e=>e.id===suggestion),false);
  store.run("UPDATE issues SET status='verified' WHERE issue_id=?",issue);snapshot=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.equal(snapshot.entries.some(e=>e.id===issue),false);
});
test('recent starts at sealed report cutoff, includes existing work new independent source objects and does not count reruns as new messages',async t=>{
  const f=await setup(t),report=f.generate(),before=structuredClone(report);f.setTime('2026-11-02T10:05:00.000Z');f.add('new-player');await f.worker.tick();
  let snapshot=f.queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(snapshot.start,report.window.endExclusive);const repeated=snapshot.entries.find(e=>e.kind==='defect');assert.equal(repeated.category,'已有问题新增反馈');assert.equal(repeated.count,1);
  const batch=f.runtime.store.get("SELECT batch_id FROM feedback_batches ORDER BY rowid LIMIT 1").batch_id;f.worker.reanalyze(binding.projectId,batch,'menu-reanalysis');await f.worker.tick();
  snapshot=f.queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(snapshot.entries.find(e=>e.kind==='defect').count,1);assert.deepEqual(f.reports.getExact(binding.projectId,report.reportId,report.revision),before);
});
test('snapshot pagination does not change when new feedback arrives; actor/project binding and expiry are rechecked',async t=>{
  const f=await setup(t),snapshot=f.queries.create(f.principal,binding.projectId,'all-bugs',f.clock()),original=structuredClone(snapshot);f.add('later');await f.worker.tick();assert.deepEqual(f.queries.read(f.principal,binding.projectId,snapshot.id,f.clock()),original);
  assert.throws(()=>f.queries.read(f.reader,binding.projectId,snapshot.id,f.clock()),/TOKEN_EXPIRED/);assert.throws(()=>f.queries.read(f.principal,'other-project',snapshot.id,f.clock()),/FORBIDDEN/);f.advance(3600001);assert.throws(()=>f.queries.read(f.principal,binding.projectId,snapshot.id,f.clock()),/TOKEN_EXPIRED/);
});
test('reader navigation cannot issue mutations, revoked accounts/old buttons cannot reveal data',async t=>{
  const f=await setup(t,'reader'),list=f.receive('/all-bugs'),detail=f.receive(list.options.buttons.find(b=>b.label==='详情 1').token,'button');assert.ok(!detail.options.buttons.some(b=>['标记修复','重新打开'].includes(b.label)));
  f.runtime.store.run("UPDATE operator_accounts SET enabled=0 WHERE actor_ref='reader'");assert.throws(()=>f.service.receive({interactionId:'revoked',kind:'command',content:'/pending',reply:{messageId:'x'}}));assert.equal(count(f.runtime.store,'operator_commands'),0);
});
test('live status action returns the same feedback with new buttons; replay and expired snapshot cannot mutate state',async t=>{
  for(const expired of [false,true])await t.test(expired?'expired snapshot':'action and replay',async t=>{
    const f=await setup(t),list=f.receive('/all-bugs');if(expired)f.advance(59*60000);
    const detail=f.receive(list.options.buttons.find(b=>b.label==='详情 1').token,'button'),token=detail.options.buttons.find(b=>b.label==='标记修复').token;
    if(expired)f.advance(2*60000);const result=f.receive(token,'button');
    if(expired){assert.equal(count(f.runtime.store,'operator_commands'),0);assert.equal(f.runtime.store.get('SELECT status FROM issues').status,'open');assert.match(result.delivery.text,/卡片已失效/);}
    else{assert.equal(result.options.card.workId,detail.options.card.workId);assert.equal(result.options.card.version,2);assert.ok(result.options.buttons.some(b=>b.label==='重新打开'));assert.match(result.delivery.text,/Windows 1.2.0/);f.receive(token,'button');assert.equal(count(f.runtime.store,'operator_commands'),1);}
  });
});
test('pending/running/retry/dead-letter analysis is never counted as new confirmed Bug',async t=>{
  const f=await setup(t);f.add('pending');const old=f.queries.create(f.principal,binding.projectId,'recent',f.clock());assert.ok(old.entries.some(e=>e.kind==='task'));assert.equal(old.entries.filter(e=>e.kind==='defect').length,1);
  const job=f.runtime.queue.claim('fault','full_agent');f.runtime.queue.start(job.jobId,job.leaseToken);let view=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.ok(view.entries.some(e=>e.kind==='task'&&e.status==='running'));
  f.runtime.queue.fail(job.jobId,job.leaseToken,'MODEL_RATE_LIMITED',true);view=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.ok(view.entries.some(e=>e.status==='retry'));
  f.advance(2000);const retry=f.runtime.queue.claim('fault','full_agent');f.runtime.queue.fail(retry.jobId,retry.leaseToken,'MODEL_REJECTED',false);view=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.ok(view.entries.some(e=>e.status==='failed'));
});
test('pending includes explicit reanalysis jobs while recent does not turn old evidence into new feedback',async t=>{
  const f=await setup(t),report=f.generate(),batch=f.runtime.store.get('SELECT batch_id FROM feedback_batches ORDER BY rowid LIMIT 1').batch_id;f.setTime('2026-11-02T10:05:00.000Z');f.worker.reanalyze(binding.projectId,batch,'menu-pending-reanalysis');
  const pending=f.queries.create(f.principal,binding.projectId,'pending',f.clock());assert.ok(pending.entries.some(e=>e.kind==='task'&&e.status==='pending'));
  const recent=f.queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(recent.start,report.window.endExclusive);assert.equal(recent.entries.length,0);await f.worker.tick();assert.ok(!f.queries.create(f.principal,binding.projectId,'pending',f.clock()).entries.some(e=>e.kind==='task'));
});
test('report/history entry reuses frozen reports and fallback commands; unsafe Web URLs and automatic menu deploy are rejected',async t=>{
  const f=await setup(t);f.generate();assert.match(f.receive('/reports').delivery.text,/社区反馈半日报/);assert.match(f.receive('/history').delivery.text,/历史报告/);assert.ok(f.receive('/more').options.buttons.some(b=>b.label==='Steam 差评'));
  assert.throws(()=>new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',menu:{enabled:true,autoDeploy:true}}),/QQ_MENU_CONFIG_INVALID/);
  assert.throws(()=>new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',menu:{enabled:true,webURL:'https://example.com?key=secret'}}),/QQ_MENU_INVALID_WEB_URL/);
});
test('authenticated unauthorized C2C gets one fixed passive denial, replay/unknown never resends; group messages never trigger denial',async t=>{
  const f=await setup(t),calls=[];const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',api:{fetch:async(url,init)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture',expires_in:7200});calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json({id:'denial'});}}});
  const deny=qqMenuDenial({runtime:f.runtime,plugin,host:deliveryHost(plugin,readSecret),enabled:true,allowWrites:true,clock:f.clock});
  const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(f.clock()),operator:{receive:async r=>f.service.receive(r),reject:deny}});const host=f.runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:async key=>key==='QQ_OPERATOR_OPENID'?'bound-developer':readSecret(key)});await source.start(host,new AbortController().signal);t.after(()=>source.stop());
  const payload={op:0,t:'C2C_MESSAGE_CREATE',d:{id:'unauth-command',author:{user_openid:'untrusted-user'},content:'/pending'}};
  await source.handleWebhook(...signed(payload,f.clock));await source.handleWebhook(...signed(payload,f.clock));assert.equal(calls.length,1);assert.equal(calls[0].body.msg_id,'unauth-command');assert.equal(calls[0].body.content,'当前账号没有访问权限。');assert.ok(!JSON.stringify(calls).includes('联机'));assert.equal(count(f.runtime.store,'qq_explicit_feedback'),0);
  await deny({identity:'lost',actor:'anonymous',openid:'untrusted-user',reply:{messageId:'lost'}});assert.equal(calls.length,2);
  await source.handleWebhook(...signed({op:0,id:'outer-event',t:'INTERACTION_CREATE',d:{id:'inner-ack',application_id:qqSecrets.QQ_APP_ID,user_openid:'untrusted-user',scene:'c2c',data:{type:11,resolved:{button_data:'a'.repeat(43)}}}},f.clock));assert.equal(calls.length,3);assert.equal(calls[2].body.event_id,'outer-event');assert.ok(!calls[2].body.msg_id);
  let attempts=0;const uncertain=qqMenuDenial({runtime:f.runtime,plugin:{denyMenuAccess:async()=>{attempts++;throw new Error('CONNECTION_LOST');}},host:{},enabled:true,allowWrites:true,clock:f.clock});
  const request={identity:'uncertain',actor:'anonymous',openid:'untrusted-user',reply:{messageId:'uncertain'}};await uncertain(request);await uncertain(request);assert.equal(attempts,1);assert.equal(f.runtime.store.get("SELECT state FROM qq_menu_denials WHERE identity='uncertain'").state,'unknown');
  await source.handleWebhook(...signed({op:0,t:'GROUP_MESSAGE_CREATE',d:{id:'group-command',group_openid:qqSecrets.QQ_SCOPE_ID,author:{member_openid:'player'},timestamp:f.clock(),content:'/pending'}},f.clock));assert.equal(calls.length,3);
});
test('all-work pagination crosses 256 and 1000 entries by persistent ordinal index without truncation or live insertion shifts',async t=>{
  const f=await setup(t),store=f.runtime.store,original=store.get("SELECT content_json FROM work_metadata WHERE work_kind='defect'").content_json;
  store.transaction(()=>{for(let n=0;n<1005;n++){const id=`bulk-${String(n).padStart(5,'0')}`,content={...JSON.parse(original),id,evidence:[]};store.run("INSERT INTO issues VALUES(?,?,?,?,'open',1,?,?)",id,binding.projectId,'bulk','bulk',f.clock(),f.clock());store.run("INSERT INTO work_metadata(work_kind,work_id,project_id,fingerprint,content_json,review_required,priority) VALUES('defect',?,?,?,?,0,0)",id,binding.projectId,id,JSON.stringify(content));}});
  const snapshot=f.queries.create(f.principal,binding.projectId,'all-bugs',f.clock());assert.equal(snapshot.total,1006);const tail=f.queries.page(f.principal,binding.projectId,snapshot.id,f.clock(),1002,10);assert.equal(tail.length,4);assert.equal(new Set(tail.map(e=>e.id)).size,4);
  const plan=store.all('EXPLAIN QUERY PLAN SELECT payload_json FROM qq_query_members WHERE snapshot_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal',snapshot.id,1002,1012);assert.ok(plan.some(p=>p.detail.includes('SEARCH')));assert.ok(!plan.some(p=>/SCAN qq_query_members/.test(p.detail)));
});
