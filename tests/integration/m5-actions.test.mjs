import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubActionWorker, GitHubSyncManager, GitHubError } from '@superagent/issue-tracker';
import { m5Fixture } from './m5-helpers.mjs';
import { binding, count } from './helpers.mjs';
import { FixtureGitHub } from './m3-helpers.mjs';
test('operator state transitions require project, role, one-time token, version and replay identity',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const work=f.control.listWorks(f.principal,binding.projectId,'suggestion')[0];
  const request={kind:'suggestion',id:work.id,action:'accept',expectedVersion:work.version};assert.throws(()=>f.control.issueActionToken(f.reader,binding.projectId,request),/FORBIDDEN/);
  const token=f.control.issueActionToken(f.principal,binding.projectId,request);const result=f.control.executeAction(f.principal,binding.projectId,request,token,'web','one');assert.equal(result.status,'accepted');
  assert.deepEqual(f.control.executeAction(f.principal,binding.projectId,request,token,'web','one'),result);assert.equal(count(f.runtime.store,'suggestion_status_history'),1);
  assert.throws(()=>f.control.executeAction(f.principal,binding.projectId,{...request,action:'decline'},token,'web','one'),/REPLAY_CONFLICT/);
  assert.throws(()=>f.control.executeAction(f.principal,binding.projectId,request,token,'web','different'),/VERSION_CONFLICT/);
  const plan={...request,action:'plan',expectedVersion:result.version};const next=f.control.issueActionToken(f.principal,binding.projectId,plan);f.advance(16*60_000);assert.throws(()=>f.control.executeAction(f.principal,binding.projectId,plan,next,'web','late'),/EXPIRED/);
  assert.equal(f.domain.getWork(binding.projectId,'suggestion',work.id).status,'accepted');
});
test('report cursors are bound to actor, project, revision, section and page size',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const report=f.generate();const scope={projectId:binding.projectId,id:report.reportId,revision:1,section:'bugs',limit:3};const cursor=f.tokens.cursor(f.principal,scope,3);
  assert.throws(()=>f.control.reportPage(f.reader,binding.projectId,report.reportId,1,'bugs',cursor),/CURSOR_SCOPE/);assert.throws(()=>f.control.reportPage(f.principal,binding.projectId,report.reportId,1,'suggestions',cursor),/CURSOR_SCOPE/);
  assert.throws(()=>f.control.reportPage(f.principal,'other',report.reportId,1,'bugs',cursor),/FORBIDDEN/);assert.throws(()=>f.control.reportPage(f.principal,binding.projectId,report.reportId,1,'bugs',cursor.slice(0,-2)+'aa'),/CURSOR_INVALID/);
});
test('linked Bug fix remains pending until status-only GitHub PATCH is read back',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const remote=new FixtureGitHub();const sync=new GitHubSyncManager(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true});await sync.tick();await sync.tick();const bug=f.control.listWorks(f.principal,binding.projectId,'defect')[0];
  let patches=0;remote.updateIssueState=async(number,state,reason)=>{patches++;const next={...remote.issuesMap.get(number),state,stateReason:reason};remote.issuesMap.set(number,next);return next;};
  const request={kind:'defect',id:bug.id,action:'fix',expectedVersion:bug.version};const token=f.control.issueActionToken(f.principal,binding.projectId,request);const pending=f.control.executeAction(f.principal,binding.projectId,request,token,'web','fix');assert.equal(pending.state,'pending_remote');assert.equal(f.domain.getWork(binding.projectId,'defect',bug.id).status,'open');
  const worker=new GitHubActionWorker(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true,authorize:(actor,project)=>f.auth.authorize(f.auth.principal(actor),project,true)});
  assert.equal((await worker.tick()).state,'succeeded');assert.equal(f.domain.getWork(binding.projectId,'defect',bug.id).status,'fixed');assert.equal(patches,1);assert.equal((await worker.tick()).processed,false);
});
test('unknown GitHub status PATCH reconciles without reposting',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const remote=new FixtureGitHub();const sync=new GitHubSyncManager(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true});await sync.tick();await sync.tick();const bug=f.control.listWorks(f.principal,binding.projectId,'defect')[0];let patches=0;
  remote.updateIssueState=async(number,state,reason)=>{patches++;remote.issuesMap.set(number,{...remote.issuesMap.get(number),state,stateReason:reason});throw new GitHubError('RESPONSE_LOST');};
  const request={kind:'defect',id:bug.id,action:'fix',expectedVersion:bug.version};const token=f.control.issueActionToken(f.principal,binding.projectId,request);f.control.executeAction(f.principal,binding.projectId,request,token,'web','fix');const worker=new GitHubActionWorker(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true,authorize:(actor,p)=>f.auth.authorize(f.auth.principal(actor),p,true)});
  assert.equal((await worker.tick()).state,'unknown');f.advance(31_000);assert.equal((await worker.tick()).state,'succeeded');assert.equal(patches,1);
});
test('manual corrections split, move and merge with audit and leave old report evidence accessible',async t=>{
  const f=await m5Fixture(t);f.add('first');await f.worker.tick();f.add('second','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();const report=f.generate();let from=f.control.listWorks(f.principal,binding.projectId,'defect')[0];const first=f.control.linkedItems(f.principal,binding.projectId,'defect',from.id)[0];
  const split={kind:'defect',id:from.id,action:'split',expectedVersion:from.version,feedbackItemId:first.feedbackItemId,reason:'两个独立复现条件，先拆分复核'};
  assert.throws(()=>f.control.correctionToken(f.reader,binding.projectId,split),/FORBIDDEN/);const splitToken=f.control.correctionToken(f.principal,binding.projectId,split);const result=f.control.correct(f.principal,binding.projectId,split,splitToken,'split');assert.deepEqual(f.control.correct(f.principal,binding.projectId,split,splitToken,'split'),result);
  from=f.control.work(f.principal,binding.projectId,'defect',from.id);let target=f.control.work(f.principal,binding.projectId,'defect',result.workId);assert.equal(from.feedbackCount,1);assert.equal(target.feedbackCount,1);
  const remaining=f.control.linkedItems(f.principal,binding.projectId,'defect',from.id)[0];const move={kind:'defect',id:from.id,action:'move',expectedVersion:from.version,feedbackItemId:remaining.feedbackItemId,targetId:target.id,targetVersion:target.version,reason:'人工核对后确认关联到新条目'};const moveToken=f.control.correctionToken(f.principal,binding.projectId,move);f.control.correct(f.principal,binding.projectId,move,moveToken,'move');
  from=f.control.work(f.principal,binding.projectId,'defect',from.id);target=f.control.work(f.principal,binding.projectId,'defect',target.id);const merge={kind:'defect',id:from.id,action:'merge',expectedVersion:from.version,targetId:target.id,targetVersion:target.version,reason:'保留全部证据并合并空旧条目'};const mergeToken=f.control.correctionToken(f.principal,binding.projectId,merge);f.control.correct(f.principal,binding.projectId,merge,mergeToken,'merge');
  assert.equal(f.control.work(f.principal,binding.projectId,'defect',from.id).mergedInto,target.id);assert.equal(f.control.listWorks(f.principal,binding.projectId,'defect').length,1);assert.equal(f.control.evidence(f.principal,binding.projectId,'defect',from.id,{reportId:report.reportId,revision:1}).total,2);
});

test('unconfirmed GitHub PATCH stays read-only on reconciliation and revoked actors cannot dispatch',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const remote=new FixtureGitHub();const sync=new GitHubSyncManager(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true});await sync.tick();await sync.tick();const bug=f.control.listWorks(f.principal,binding.projectId,'defect')[0];let patches=0;
  remote.updateIssueState=async()=>{patches++;throw new GitHubError('RESPONSE_LOST');};
  const request={kind:'defect',id:bug.id,action:'fix',expectedVersion:bug.version};const token=f.control.issueActionToken(f.principal,binding.projectId,request);f.control.executeAction(f.principal,binding.projectId,request,token,'web','uncertain-fix');
  const worker=new GitHubActionWorker(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true,authorize:(actor,p)=>f.auth.authorize(f.auth.principal(actor),p,true)});assert.equal((await worker.tick()).state,'unknown');
  for(let i=0;i<3;i++){f.advance(31_000);await worker.tick();}assert.equal(patches,1);assert.equal(f.domain.getWork(binding.projectId,'defect',bug.id).status,'open');assert.equal(f.runtime.store.get('SELECT state FROM operator_commands').state,'manual_review');
  const again=f.control.issueActionToken(f.principal,binding.projectId,request);f.control.executeAction(f.principal,binding.projectId,request,again,'web','revoked-fix');f.runtime.store.run("UPDATE operator_accounts SET enabled=0 WHERE actor_ref='developer'");assert.equal((await worker.tick()).state,'blocked');assert.equal(patches,1);
});
test('remote polling preserves explicit verification and investigating state instead of undoing developer actions',async t=>{
  const f=await m5Fixture(t);f.add('first');await f.worker.tick();let work=f.control.listWorks(f.principal,binding.projectId,'defect')[0];
  f.domain.remoteStatus(binding.projectId,'defect',work.id,'closed','completed');work=f.control.work(f.principal,binding.projectId,'defect',work.id);const request={kind:'defect',id:work.id,action:'verify',expectedVersion:work.version};const token=f.control.issueActionToken(f.principal,binding.projectId,request);f.control.executeAction(f.principal,binding.projectId,request,token,'web','verify');
  const verified=f.control.work(f.principal,binding.projectId,'defect',work.id);f.domain.remoteStatus(binding.projectId,'defect',work.id,'closed','completed');assert.equal(f.control.work(f.principal,binding.projectId,'defect',work.id).status,'verified');assert.equal(f.control.work(f.principal,binding.projectId,'defect',work.id).version,verified.version);
  f.domain.remoteStatus(binding.projectId,'defect',work.id,'open',null);assert.equal(f.control.work(f.principal,binding.projectId,'defect',work.id).status,'open');
});
