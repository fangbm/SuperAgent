import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { GitHubSyncManager } from '@superagent/issue-tracker';
import { m3Fixture, FixtureGitHub } from './m3-helpers.mjs';
import { binding, count } from './helpers.mjs';

async function githubFixture(t,options={}){const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');assert.equal((await f.worker.tick()).status,'succeeded');const port=new FixtureGitHub();const manager=new GitHubSyncManager(f.runtime.store,f.domain,port,{clock:f.clock,allowWrites:true,...options});return{...f,port,manager};}

test('GitHub writes require explicit enablement and private repository verification',async t=>{
  const f=await githubFixture(t);const preview=new GitHubSyncManager(f.runtime.store,f.domain,f.port,{clock:f.clock});
  assert.equal((await preview.tick()).state,'write_disabled');assert.equal(f.port.posts,0);
  f.port.private=false;await assert.rejects(f.manager.tick(),/PUBLIC_REPOSITORY_NOT_AUTHORIZED/);assert.equal(f.port.posts,0);
  f.port.private=true;assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.posts,1);
  assert.equal(count(f.runtime.store,'external_work_links'),1);assert.equal(count(f.runtime.store,'external_operation_attempts'),1);
  await f.manager.tick();assert.equal(f.port.posts,1);
});

test('new feedback coalesces into one robot statistics comment and preserves developer issue body',async t=>{
  const f=await githubFixture(t);await f.manager.tick();const issue=f.port.issuesMap.get('1');issue.body+='\nDeveloper-owned reproduction notes';const original=issue.body;
  f.add('two','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();assert.equal((await f.manager.tick()).processed,false);
  f.advance(60_001);assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.posts,1);assert.equal(f.port.commentPosts,1);assert.ok(f.port.commentsMap.get('1').body.includes('独立来源反馈：2'));
  f.add('three','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.advance(60_001);await f.manager.tick();
  assert.equal(f.port.commentPosts,1);assert.equal(f.port.patches,1);assert.equal(issue.body,original);assert.ok(f.port.commentsMap.get('1').body.includes('独立来源反馈：3'));
});

test('create timeout reconciles by marker without another POST',async t=>{
  const f=await githubFixture(t);f.port.issueMode='timeout';assert.equal((await f.manager.tick()).state,'unknown');assert.equal(f.port.posts,1);
  assert.equal((await f.manager.tick()).processed,false);f.advance(30_001);
  assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.posts,1);assert.equal(count(f.runtime.store,'external_work_links'),1);
});

test('success followed by failed local mapping is recoverable and never reposts',async t=>{
  const f=await githubFixture(t);f.runtime.store.exec("CREATE TRIGGER mapping_fault BEFORE INSERT ON external_work_links BEGIN SELECT RAISE(ABORT,'INJECTED_MAPPING_FAILURE');END;");
  assert.equal((await f.manager.tick()).state,'unknown');assert.equal(count(f.runtime.store,'external_work_links'),0);
  f.runtime.store.exec('DROP TRIGGER mapping_fault');f.advance(30_001);assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.posts,1);
});

test('reconciliation handles all pages, skips PRs and refuses duplicate markers',async t=>{
  const f=await githubFixture(t);f.port.issueMode='timeout';await f.manager.tick();const issue=f.port.issuesMap.get('1');
  f.port.pages=[{items:[{...issue,number:'50',pullRequest:true}],next:true},{items:[issue],next:false}];f.advance(30_001);
  assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.posts,1);
  // Another work uses a separate fixture to exercise multiple authoritative hits.
  const g=await githubFixture(t);g.port.issueMode='timeout';await g.manager.tick();const duplicate=g.port.issuesMap.get('1');g.port.pages=[{items:[duplicate,{...duplicate,number:'2'}],next:false}];g.advance(30_001);
  assert.equal((await g.manager.tick()).state,'manual_review');assert.equal(count(g.runtime.store,'external_work_links'),0);assert.equal(g.port.posts,1);
});

test('absence and incomplete pagination keep unknown until bounded manual review',async t=>{
  const f=await githubFixture(t,{maxPages:1,maxReconciliations:2});f.port.issueMode='timeout';await f.manager.tick();f.port.pages=[{items:[],next:true}];
  f.advance(30_001);assert.equal((await f.manager.tick()).state,'unknown');f.advance(30_001);assert.equal((await f.manager.tick()).state,'manual_review');assert.equal(f.port.posts,1);
});

test('unknown robot comment creation is reconciled and developer edits stop PATCH',async t=>{
  const f=await githubFixture(t);await f.manager.tick();f.add('two','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.advance(60_001);f.port.commentMode='timeout';
  assert.equal((await f.manager.tick()).state,'unknown');f.advance(30_001);assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.commentPosts,1);
  f.port.commentsMap.get('1').body+='\nManually edited';f.add('three','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.advance(60_001);
  assert.equal((await f.manager.tick()).state,'manual_review');assert.equal(f.port.patches,0);
});

test('signed status callbacks are scoped and idempotent; closed is not verified',async t=>{
  const f=await githubFixture(t);await f.manager.tick();const issueId=f.runtime.store.get('SELECT issue_id FROM issues').issue_id;
  const body=Buffer.from(JSON.stringify({repository:{full_name:f.port.repository,private:true},issue:{number:1,state:'closed',state_reason:'completed'}}));
  const signature='sha256='+createHmac('sha256','fixture-webhook-secret').update(body).digest('hex');
  assert.throws(()=>f.manager.webhook('fixture-webhook-secret','delivery','sha256='+'0'.repeat(64),body),/WEBHOOK_SIGNATURE_INVALID/);
  f.manager.webhook('fixture-webhook-secret','delivery',signature,body);f.manager.webhook('fixture-webhook-secret','delivery',signature,body);
  assert.equal(f.domain.getWork(binding.projectId,'defect',issueId).status,'fixed');assert.equal(count(f.runtime.store,'github_webhook_receipts'),1);
  f.port.issuesMap.get('1').state='open';await f.manager.syncStatus(binding.projectId,'defect',issueId);assert.equal(f.domain.getWork(binding.projectId,'defect',issueId).status,'open');
});

test('manual split/merge preserve all raw evidence and require developer/version checks',async t=>{
  const f=await githubFixture(t);f.add('two','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();const original=f.runtime.store.get('SELECT issue_id,version FROM issues');
  const item=f.runtime.store.get('SELECT feedback_item_id FROM feedback_items ORDER BY rowid DESC LIMIT 1').feedback_item_id;
  assert.throws(()=>f.domain.splitFeedback(binding.projectId,item,original.version,'split-1','intruder','纠正'),/DEVELOPER_NOT_AUTHORIZED/);
  const split=f.domain.splitFeedback(binding.projectId,item,original.version,'split-1','developer','人工确认是独立问题');assert.equal(f.domain.splitFeedback(binding.projectId,item,original.version,'split-1','developer','人工确认是独立问题'),split);
  assert.equal(f.domain.getWork(binding.projectId,'defect',split).feedbackCount,1);const source=f.domain.getWork(binding.projectId,'defect',original.issue_id);const target=f.domain.getWork(binding.projectId,'defect',split);
  f.domain.mergeWorks(binding.projectId,'defect',original.issue_id,split,source.version,target.version,'merge-1','developer','重新核对后合并');
  assert.equal(f.domain.getWork(binding.projectId,'defect',split).feedbackCount,2);assert.equal(f.domain.getWork(binding.projectId,'defect',original.issue_id),undefined);
  assert.equal(count(f.runtime.store,'source_events'),2);assert.equal(count(f.runtime.store,'feedback_item_evidence'),2);assert.ok(count(f.runtime.store,'work_history')>=4);
});
