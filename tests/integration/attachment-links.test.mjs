import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {ArtifactStore} from '@superagent/plugin-host';
import {ArtifactPublisher,GitHubSyncManager} from '@superagent/issue-tracker';
import {WorkReportBuilder} from '@superagent/reporting';
import {DomainService} from '@superagent/domain';
import {HybridMemory} from '@superagent/memory';
import {OperatorAuth,TokenService,ControlPlane} from '@superagent/control-plane';
import {ReportService} from '@superagent/reporting';
import {m3Fixture,FixtureGitHub} from './m3-helpers.mjs';
import {binding,scope,event} from './helpers.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),url='https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222';
async function setup(t,text='Windows 1.2.0 多人联机加载90%崩溃'){
 const f=await m3Fixture(t),message=event('text-feedback',{text,thread:'room'});message.data.actor={opaqueId:'alice',isBot:false};
 f.runtime.ingress.commitBatch(scope,[message]);f.runtime.tick();for(const s of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(s.segment_id,'replay');await f.worker.tick();
 const artifacts=new ArtifactStore(f.runtime.store,{root:path.join(f.directory,'files'),key:Buffer.alloc(32,17),clock:f.clock,download:async()=>png});
 const image=(id,{parent,actor='alice',thread='room',text='',time='2026-11-02T00:01:00.000Z',count=1}={})=>{const e=event(id,{parent,thread,text,time});e.data.actor={opaqueId:actor,isBot:false};e.data.content.attachments=Array.from({length:count},(_,i)=>({kind:'image',mimeType:'image/png',assetRef:`file-${id}-${i}`}));for(const [i,a]of e.data.content.attachments.entries())artifacts.stage({projectId:binding.projectId,sourceId:binding.sourceId,sourceUri:binding.sourceUri,externalEventId:e.id,assetRef:a.assetRef,url:'https://gchat.qpic.cn/image',mimeType:'image/png',filename:'image.png',ordinal:i});f.runtime.ingress.commitBatch(scope,[e]);f.runtime.tick();return f.runtime.store.get('SELECT event_id FROM source_events WHERE external_event_id=?',id).event_id;};
 return{...f,artifacts,image,workId:f.runtime.store.get('SELECT issue_id FROM issues').issue_id};
}
test('quoted image separated by unrelated chat joins the original feedback without adding an independent report',async t=>{
 const f=await setup(t);const noise=event('other-chat',{text:'今天吃什么',thread:'room',time:'2026-11-02T00:00:30.000Z'});noise.data.actor={opaqueId:'bob',isBot:false};f.runtime.ingress.commitBatch(scope,[noise]);f.runtime.tick();
 const id=f.image('reply-image',{parent:'text-feedback'});f.domain.attachments.refresh(binding.projectId);const links=f.domain.attachments.forWork(binding.projectId,'defect',f.workId);assert.deepEqual(links.map(a=>a.eventId),[id]);assert.equal(links[0].method,'reply');assert.equal(f.domain.getWork(binding.projectId,'defect',f.workId).feedbackCount,1);
 assert.equal(new WorkReportBuilder(f.runtime.store,f.domain).build(binding.projectId,'defect',f.workId).attachments[0].eventId,id);
});
test('unquoted same-author image is a candidate requiring confirmation; rejection survives refresh and restart',async t=>{
 const f=await setup(t),id=f.image('loose-image');f.domain.attachments.refresh(binding.projectId);let row=f.domain.attachments.list(binding.projectId).items.find(r=>r.event_id===id);assert.equal(row.status,'review');assert.equal(row.candidates.length,1);assert.equal(f.domain.attachments.forWork(binding.projectId,'defect',f.workId).length,0);
 f.domain.attachments.review(binding.projectId,id,row.asset_ref,row.candidates[0].feedbackItemId,row.version,'确认这张是崩溃截图','developer',()=>{});assert.equal(f.domain.attachments.forWork(binding.projectId,'defect',f.workId).length,1);assert.equal(f.domain.getWork(binding.projectId,'defect',f.workId).feedbackCount,1);
 row=f.domain.attachments.list(binding.projectId).items.find(r=>r.event_id===id);f.domain.attachments.review(binding.projectId,id,row.asset_ref,null,row.version,'附件与该问题无关','developer',()=>{});f.advance(60000);f.domain.attachments.refresh(binding.projectId);assert.equal(f.domain.attachments.forWork(binding.projectId,'defect',f.workId).length,0);assert.equal(f.runtime.store.get('SELECT status FROM attachment_links WHERE event_id=?',id).status,'rejected');
 const before=f.image('image-before-text',{time:'2026-11-01T23:59:00.000Z'});f.domain.attachments.refresh(binding.projectId);assert.equal(f.runtime.store.get('SELECT status FROM attachment_links WHERE event_id=?',before).status,'review');
 const reopened=f.open(),domain=new DomainService(reopened.store,new HybridMemory(reopened.store),{clock:f.clock});f.advance(31000);domain.attachments.refresh(binding.projectId);assert.equal(reopened.store.get('SELECT status FROM attachment_links WHERE event_id=?',id).status,'rejected');assert.equal(domain.attachments.forWork(binding.projectId,'defect',f.workId).length,0);
});
test('different authors, different conversations, ambiguous targets and invalidated evidence never silently attach',async t=>{
 const f=await setup(t,'Windows 1.2.0 联机崩溃，希望自动重连');const ambiguous=f.image('ambiguous',{parent:'text-feedback'}),other=f.image('other-author',{actor:'bob'}),room=f.image('other-room',{parent:'text-feedback',thread:'another'});f.domain.attachments.refresh(binding.projectId);
 assert.equal(f.runtime.store.get('SELECT status FROM attachment_links WHERE event_id=?',ambiguous).status,'review');for(const id of [other,room])assert.equal(f.runtime.store.get('SELECT status FROM attachment_links WHERE event_id=?',id).status,'pending');assert.equal(f.domain.attachments.forWork(binding.projectId,'defect',f.workId).length,0);
 const g=await setup(t),linked=g.image('valid',{parent:'text-feedback'});g.domain.attachments.refresh(binding.projectId);assert.equal(g.domain.attachments.confirmed(binding.projectId,linked,'file-valid-0'),true);
 g.runtime.ingress.commitBatch(scope,[event('delete-text',{action:'deleted',objectId:'text-feedback',time:'2026-11-02T00:02:00.000Z',thread:'room'})]);g.runtime.tick();assert.equal(g.domain.attachments.confirmed(binding.projectId,linked,'file-valid-0'),false);assert.equal(g.domain.attachments.forWork(binding.projectId,'defect',g.workId).length,0);
});
test('cross-message attachment completion refreshes the mapped Issue and review removal refreshes its robot comment',async t=>{
 const f=await setup(t),github=new FixtureGitHub();let publisher;const builder=new WorkReportBuilder(f.runtime.store,f.domain,{artifacts:(p,e,r)=>publisher?.attachment(p,e,r)}),sync=new GitHubSyncManager(f.runtime.store,f.domain,github,{allowWrites:true,clock:f.clock,reportBuilder:builder});
 let posts=0;publisher=new ArtifactPublisher(f.runtime.store,f.artifacts,{repository:github.repository,inspect:async()=>({private:true,repositoryId:'1',canPush:true}),upload:async()=>{posts++;return url;},verify:async()=>true},{links:f.domain.attachments,allowWrites:true,clock:f.clock,authorize:()=>{},onChanged:id=>sync.artifactChanged(id)});
 await sync.tick();const id=f.image('late-image',{parent:'text-feedback'});await f.artifacts.tick(new AbortController().signal);await publisher.tick(new AbortController().signal);await sync.tick();assert.equal(github.posts,1);assert.equal(posts,1);assert.ok(github.commentsMap.get('1').body.includes(url));
 const row=f.domain.attachments.list(binding.projectId).items.find(r=>r.event_id===id);f.domain.attachments.review(binding.projectId,id,row.asset_ref,null,row.version,'误关联，移除引用','developer',()=>{});await sync.tick();assert.ok(!github.commentsMap.get('1').body.includes(url));assert.equal(f.domain.getWork(binding.projectId,'defect',f.workId).feedbackCount,1);
 for(const attach of [true,false]){const next=f.domain.attachments.list(binding.projectId).items.find(r=>r.event_id===id);const target=f.runtime.store.get('SELECT feedback_item_id FROM work_feedback_links WHERE work_id=?',f.workId).feedback_item_id;f.domain.attachments.review(binding.projectId,id,next.asset_ref,attach?target:null,next.version,attach?'重新确认附件':'再次移除附件','developer',()=>{});await sync.tick();assert.equal(github.commentsMap.get('1').body.includes(url),attach);}assert.equal(posts,1);
});
test('review authorization, token scope, optimistic versions and compound pagination are enforced',async t=>{
 const f=await setup(t),id=f.image('multi',{count:3});f.domain.attachments.refresh(binding.projectId);const auth=new OperatorAuth(f.runtime.store,f.clock),principal={actorRef:'developer',role:'developer',projects:[binding.projectId]},reader={actorRef:'reader',role:'reader',projects:[binding.projectId]};auth.register(principal,'developer-local-test-key-long-enough');auth.register(reader,'reader-local-test-key-long-enough-123');const control=new ControlPlane(f.runtime.store,f.domain,new ReportService(f.runtime.store,f.domain,f.runtime.queue,{clock:f.clock}),auth,new TokenService(f.runtime.store,'attachment-test-signing-key-long-enough',f.clock),f.clock);
 const page=f.domain.attachments.list(binding.projectId,2),last=f.domain.attachments.list(binding.projectId,2,page.nextCursor);assert.equal(page.items.length,2);assert.equal(last.items.length,1);assert.equal(new Set([...page.items,...last.items].map(a=>a.asset_ref)).size,3);
 const row=page.items[0],request={eventId:id,assetRef:row.asset_ref,feedbackItemId:row.candidates[0].feedbackItemId,expectedVersion:row.version,reason:'开发者确认'};assert.throws(()=>control.attachmentToken(reader,binding.projectId,request),/FORBIDDEN/);assert.throws(()=>f.domain.attachments.review(binding.projectId,id,row.asset_ref,request.feedbackItemId,row.version,'reason','developer',()=>{throw new Error('REVOKED');}),/REVOKED/);
 const token=control.attachmentToken(principal,binding.projectId,request);assert.equal(control.reviewAttachment(principal,binding.projectId,request,token).state,'succeeded');assert.throws(()=>control.reviewAttachment(principal,binding.projectId,request,token),/TOKEN_/);assert.throws(()=>f.domain.attachments.review(binding.projectId,id,row.asset_ref,null,row.version,'old version','developer',()=>{}),/VERSION_CONFLICT/);
 assert.throws(()=>f.domain.attachments.review('other-project',id,row.asset_ref,request.feedbackItemId,row.version,'cross project','developer',()=>{}),/NOT_FOUND/);
});
