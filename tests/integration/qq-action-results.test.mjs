import assert from 'node:assert/strict';
import test from 'node:test';
import { QQOperatorService } from '@superagent/control-plane';
import { GitHubSyncManager, GitHubActionWorker, GitHubError } from '@superagent/issue-tracker';
import { m5Fixture } from './m5-helpers.mjs';
import { FixtureGitHub } from './m3-helpers.mjs';
import { binding, count } from './helpers.mjs';
import { originalFromMarkdown } from './qq-markdown-helpers.mjs';
import { createDemo,demoProject } from '../../scripts/m5-demo-data.mjs';

async function setup(t){
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const report=f.generate(),remote=new FixtureGitHub(),sync=new GitHubSyncManager(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true});await sync.tick();await sync.tick();
  let patches=0;remote.updateIssueState=async(number,state,reason)=>{patches++;const issue={...remote.issuesMap.get(number),state,stateReason:reason};remote.issuesMap.set(number,issue);return issue;};
  const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock}),worker=new GitHubActionWorker(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true,authorize:(actor,p)=>f.auth.authorize(f.auth.principal(actor),p,true)});
  const receive=(id,kind,content)=>{qq.receive({interactionId:id,kind,content,reply:kind==='button'?{eventId:`INTERACTION_CREATE:${id}`}:{messageId:id}});const processed=qq.tick(),row=f.runtime.store.get('SELECT * FROM operator_reply_plans WHERE delivery_id=?',processed.deliveryId);return{...row,request:JSON.parse(row.request_json),options:JSON.parse(row.message_options_json)};};
  const card=receive('initial','command','/bugs'),pending=receive('fix','button',card.options.buttons.find(b=>b.label==='标记修复').token),command=f.runtime.store.get("SELECT command_id FROM operator_commands WHERE source='qq'");
  return{...f,report,remote,qq,worker,receive,card,pending,commandId:command.command_id,patches:()=>patches};
}

test('QQ confirmed actions refresh the same Bug page and buttons before outbox enqueue',async t=>{
  const f=await setup(t);assert.match(f.pending.request.text,/等待 GitHub 确认/);assert.equal(f.pending.options.buttons[0].label,'查看结果');assert.equal((await f.worker.tick()).state,'succeeded');
  assert.equal(f.qq.refreshActionReplies(),1);const refreshed=f.runtime.store.get('SELECT request_json,message_options_json FROM operator_reply_plans WHERE delivery_id=?',f.pending.delivery_id),receipt=JSON.parse(refreshed.request_json),options=JSON.parse(refreshed.message_options_json);
  assert.match(receipt.text,/^# Bug · 1 \/ 1/);assert.match(receipt.text,/\*\*状态\*\*：已修复/);assert.equal(receipt.text.replace('**状态**：已修复','**状态**：待处理'),f.card.request.text);assert.equal(originalFromMarkdown(receipt.text),originalFromMarkdown(f.card.request.text));assert.ok(options.buttons.some(b=>b.label==='重新打开'));assert.ok(!options.buttons.some(b=>b.label==='标记修复'));assert.deepEqual(options.replyTo,f.pending.options.replyTo);assert.equal(receipt.deliveryId,f.pending.request.deliveryId);assert.equal(receipt.reportId,f.report.reportId);assert.equal(receipt.reportRevision,1);assert.equal(f.patches(),1);
  const stale=f.receive('stale-other-action','button',f.card.options.buttons.find(b=>b.label==='开始调查').token);assert.match(stale.request.text,/状态已变化/);assert.equal(f.patches(),1);assert.equal(count(f.runtime.store,'operator_commands'),1);
  // A plan that has entered the outbox must not acquire a different request identity.
  f.runtime.store.run("UPDATE operator_reply_plans SET operation_id='fixture-enqueued-operation' WHERE delivery_id=?",f.pending.delivery_id);assert.equal(f.qq.refreshActionReplies(),0);assert.equal(f.runtime.store.get('SELECT request_json FROM operator_reply_plans WHERE delivery_id=?',f.pending.delivery_id).request_json,refreshed.request_json);
  const bug=f.control.work(f.principal,binding.projectId,'defect',f.report.issueIds[0]),request={kind:'defect',id:bug.id,action:'reopen',expectedVersion:bug.version};f.control.executeAction(f.principal,binding.projectId,request,f.control.issueActionToken(f.principal,binding.projectId,request),'web','reopen');await f.worker.tick();assert.equal(f.patches(),2);
  const latest=f.receive('result-query','button',f.pending.options.buttons[0].token);assert.match(latest.request.text,/\*\*状态\*\*：待处理/);assert.ok(latest.options.buttons.some(b=>b.label==='标记修复'));assert.equal(f.patches(),2);assert.equal(count(f.runtime.store,'operator_commands'),2);
});

test('successful QQ actions stay on the same non-first report member with verbatim evidence',async t=>{
  const app=await createDemo(':memory:');t.after(()=>app.runtime.close());const actor='web-developer',qq=new QQOperatorService(app.control,{projectId:demoProject,actorRef:actor,recipientRef:actor,clock:app.clock});let n=0;
  const click=(kind,content)=>{qq.receive({interactionId:`page-action-${n++}`,kind,content,reply:kind==='command'?{messageId:'fixture'}:{eventId:'INTERACTION_CREATE:fixture'}});const r=qq.tick(),p=app.runtime.store.get('SELECT request_json,message_options_json FROM operator_reply_plans WHERE delivery_id=?',r.deliveryId);return{request:JSON.parse(p.request_json),options:JSON.parse(p.message_options_json)};};
  const first=click('command','/bugs'),second=click('button',first.options.buttons.find(b=>b.label==='下一条').token),changed=click('button',second.options.buttons.find(b=>b.label==='开始调查').token);
  assert.match(changed.request.text,/^# Bug · 2 \/ 3/);assert.match(changed.request.text,/\*\*状态\*\*：调查中/);assert.equal(originalFromMarkdown(changed.request.text),originalFromMarkdown(second.request.text));assert.equal(changed.request.reportId,second.request.reportId);assert.equal(changed.request.reportRevision,second.request.reportRevision);assert.ok(changed.options.buttons.some(b=>b.label==='上一条'));assert.ok(changed.options.buttons.some(b=>b.label==='下一条'));
});

test('QQ result polling never resubmits an uncertain GitHub operation or announces completion before readback',async t=>{
  const f=await setup(t);let patches=0;f.remote.updateIssueState=async()=>{patches++;throw new GitHubError('RESPONSE_LOST');};assert.equal((await f.worker.tick()).state,'unknown');const token=f.pending.options.buttons[0].token;
  for(let n=0;n<3;n++){const query=f.receive(`query-${n}`,'button',token);assert.match(query.request.text,/结果待核对/);assert.doesNotMatch(query.request.text,/GitHub 已确认/);}
  assert.equal(patches,1);assert.equal(count(f.runtime.store,'operator_commands'),1);assert.equal(f.domain.getWork(binding.projectId,'defect',f.report.issueIds[0]).status,'open');
  for(let n=0;n<3;n++){f.advance(31_000);await f.worker.tick();}assert.match(f.receive('review','button',token).request.text,/需要人工复核/);assert.equal(patches,1);
});

test('QQ action result access is bound to actor/project and remains read-only after developer downgrade',async t=>{
  const f=await setup(t);await f.worker.tick();const token=f.pending.options.buttons[0].token;
  const reader=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'reader',recipientRef:'reader',clock:f.clock});assert.throws(()=>reader.actionResult(f.commandId),/COMMAND_NOT_FOUND/);
  reader.receive({interactionId:'stolen-result',kind:'button',content:token,reply:{eventId:'INTERACTION_CREATE:stolen'}});const blocked=reader.tick();assert.match(JSON.parse(f.runtime.store.get('SELECT request_json FROM operator_reply_plans WHERE delivery_id=?',blocked.deliveryId).request_json).text,/操作未完成/);
  f.runtime.store.run("UPDATE operator_accounts SET role='reader' WHERE actor_ref='developer'");const result=f.receive('downgraded-result','button',token);assert.match(result.request.text,/\*\*状态\*\*：已修复/);assert.ok(!result.options.buttons.some(b=>b.label==='重新打开'));assert.equal(f.patches(),1);assert.equal(count(f.runtime.store,'operator_commands'),1);
  f.runtime.store.run("UPDATE operator_accounts SET projects_json='[]' WHERE actor_ref='developer'");assert.throws(()=>f.qq.actionResult(f.commandId),/FORBIDDEN/);
});
