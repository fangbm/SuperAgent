import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fixture, binding, defaultPolicy } from './helpers.mjs';
import { accessKey } from './m5-helpers.mjs';
import { m5Fixture } from './m5-helpers.mjs';
import { GitHubSyncManager } from '@superagent/issue-tracker';
import { FixtureGitHub } from './m3-helpers.mjs';
import { qqSecrets } from './qq-helpers.mjs';
import { createM5 } from '../../scripts/m5-runtime.mjs';
test('production M5 CLI generates and archives a due report, never logs access key, and exits without external writes',async t=>{
  const f=fixture(t);const filename=path.join(f.directory,'m5-cli.sqlite');const result=await promisify(execFile)(process.execPath,['scripts/m5-run.mjs','--database',filename,'--project',binding.projectId,'--port','0','--once'],{cwd:process.cwd(),windowsHide:true,timeout:15_000,env:{...process.env,SA_WEB_ACCESS_KEY:accessKey,SA_WEB_READER_KEY:'',SA_GITHUB_TOKEN:'',SA_GITHUB_REPOSITORY:''}});
  const lines=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(lines[0].qqWrites,false);assert.equal(lines[0].githubWrites,false);assert.equal(lines[1].report.status,'succeeded');assert.equal(result.stdout.includes(accessKey),false);
});

test('production M5 tick reads GitHub confirmation before sending its first QQ action receipt',async t=>{
  const f=await m5Fixture(t,{policyOverrides:{auditSampleRate:defaultPolicy.auditSampleRate}});f.add('one');await f.worker.tick();f.generate();const remote=new FixtureGitHub(),sync=new GitHubSyncManager(f.runtime.store,f.domain,remote,{clock:f.clock,allowWrites:true});await sync.tick();await sync.tick();
  const bug=f.control.listWorks(f.principal,binding.projectId,'defect')[0],link=f.runtime.store.get("SELECT external_issue_id FROM external_work_links WHERE work_kind='defect' AND work_id=?",bug.id);
  const env={SA_WEB_ACCESS_KEY:'runtime-fixture-web-key-at-least-32-characters',SA_WEB_READER_KEY:'',SA_CURSOR_SIGNING_KEY:'runtime-fixture-signing-key-at-least-32-characters',SA_GITHUB_REPOSITORY:remote.repository,SA_GITHUB_TOKEN:'fixture-github-token',SA_QQ_APP_ID:qqSecrets.QQ_APP_ID,SA_QQ_APP_SECRET:qqSecrets.QQ_APP_SECRET,SA_QQ_DEVELOPER_OPENID:qqSecrets.QQ_RECIPIENT_OPENID},prior=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);t.after(()=>{for(const [k,v]of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  let remoteState='open',remoteReason=null,patches=0;const messages=[],recalls=[];
  t.mock.method(globalThis,'fetch',async(url,init={})=>{const p=new URL(url).pathname;if(p==='/app/getAppAccessToken')return Response.json({access_token:'fixture-qq-token',expires_in:7200});if(p.startsWith('/v2/users/')){if(init.method==='DELETE'){recalls.push(p);return new Response(null,{status:200});}messages.push(JSON.parse(init.body));return Response.json({id:`fixture-reply-${messages.length}`});}if(p===`/repos/${remote.repository}`)return Response.json({private:true});if(p==='/user')return Response.json({id:1});if(p===`/repos/${remote.repository}/issues/${link.external_issue_id}`){if(init.method==='PATCH'){patches++;const body=JSON.parse(init.body);remoteState=body.state;remoteReason=body.state_reason??null;}return Response.json({number:Number(link.external_issue_id),body:'fixture',state:remoteState,state_reason:remoteReason});}throw new Error('UNEXPECTED_FIXTURE_NETWORK_CALL');});
  const controller=new AbortController(),app=await createM5({database:path.join(f.directory,'state.sqlite'),project:binding.projectId,'qq-configured':true,'qq-write':true,'github-write':true},controller.signal);t.after(async()=>{controller.abort();await app.close();});
  t.mock.method(app.reports,'scheduleDue',()=>0);t.mock.method(app.reports,'tick',()=>({processed:false}));
  app.qq.receive({interactionId:'runtime-card',kind:'command',content:'/bugs',reply:{messageId:'runtime-command'}});await app.tick();const fix=messages[0].keyboard.content.rows.flatMap(r=>r.buttons).find(b=>b.render_data.label==='标记修复');assert.ok(fix);
  app.qq.receive({interactionId:'runtime-fix',kind:'button',content:fix.action.data,reply:{eventId:'INTERACTION_CREATE:runtime-fix'}});const tick=await app.tick();assert.equal(tick.github.state,'succeeded');assert.equal(patches,1);assert.equal(messages.length,2);assert.match(messages[1].markdown.content,/\*\*状态\*\*：已修复/);assert.doesNotMatch(messages[1].markdown.content,/等待 GitHub 确认/);assert.equal(messages[1].event_id,'INTERACTION_CREATE:runtime-fix');assert.ok(messages[1].keyboard.content.rows.flatMap(r=>r.buttons).some(b=>b.render_data.label==='重新打开'));assert.equal(tick.recall.state,'succeeded');assert.equal(recalls.length,1);assert.ok(recalls[0].endsWith('/messages/fixture-reply-1'));
});
