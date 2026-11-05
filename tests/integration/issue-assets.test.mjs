import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ArtifactStore,ArtifactError} from '@superagent/plugin-host';
import {ArtifactPublisher,GitHubIssueAssets,IssueAssetError,GitHubSyncManager,issueAssetURL} from '@superagent/issue-tracker';
import {WorkReportBuilder} from '@superagent/reporting';
import {m3Fixture,FixtureGitHub} from './m3-helpers.mjs';
import {binding,scope,event} from './helpers.mjs';
import {createApplication} from '../../scripts/application.mjs';
import {appFixture} from './application-helpers.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),key=Buffer.alloc(32,11),signal=()=>new AbortController().signal,url='https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
class Assets {
 repository='owner/private-test';uploads=0;verifications=0;mode='ok';private=true;repositoryId='99';
 async inspect(){return{private:this.private,repositoryId:this.repositoryId,canPush:true};}
 async upload(bytes){this.uploads++;assert.deepEqual(bytes,png);if(this.mode==='timeout')throw new IssueAssetError('UPLOAD_TIMEOUT');if(this.mode==='429')throw new IssueAssetError('GITHUB_ASSET_HTTP_429','safe_retry');return url;}
 async verify(){this.verifications++;if(this.mode==='verify_network')throw new IssueAssetError('READ_FAILED');if(this.mode==='public')throw new IssueAssetError('GITHUB_ASSET_NOT_PRIVATE','blocked');return true;}
}
async function setup(t,options={}){
 const f=await m3Fixture(t);let manager,publisher;
 const artifacts=new ArtifactStore(f.runtime.store,{root:path.join(f.directory,'artifacts'),key,clock:f.clock,download:async()=>{if(options.captureFail)throw new ArtifactError('ARTIFACT_TYPE_REJECTED');return png;},onChanged:id=>manager?.artifactChanged(id)});
 const message=event('source-image',{text:'Windows 1.2.0 联机载入90%时崩溃'});message.data.content.attachments=[{kind:'image',mimeType:'image/png',assetRef:'image-one'}];
 artifacts.stage({projectId:binding.projectId,sourceId:binding.sourceId,sourceUri:binding.sourceUri,externalEventId:message.id,assetRef:'image-one',url:'https://gchat.qpic.cn/file?key=SECRET',mimeType:'image/png',filename:'a.png',ordinal:0});f.runtime.ingress.commitBatch(scope,[message]);f.runtime.tick();for(const s of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(s.segment_id,'replay');await f.worker.tick();
 const port=new FixtureGitHub(),assetsPort=new Assets(),builder=new WorkReportBuilder(f.runtime.store,f.domain,{artifacts:(p,e,r)=>publisher?.attachment(p,e,r)});
 manager=new GitHubSyncManager(f.runtime.store,f.domain,port,{allowWrites:true,clock:f.clock,reportBuilder:builder});
 const publisherOptions={links:f.domain.attachments,allowWrites:true,clock:f.clock,authorize:p=>assert.equal(p,binding.projectId),onChanged:id=>manager.artifactChanged(id)};
 publisher=new ArtifactPublisher(f.runtime.store,artifacts,assetsPort,publisherOptions);
 return{...f,artifacts,manager,publisher,assetsPort,publisherOptions,port,builder,workId:f.runtime.store.get('SELECT issue_id FROM issues').issue_id,eventId:f.runtime.store.get('SELECT event_id FROM source_events').event_id};
}
test('late file publication refreshes the robot report at the same work version and preserves the human Issue body',async t=>{
 const f=await setup(t);await f.manager.tick();f.port.issuesMap.get('1').body+='\nHuman-authored reproduction';const original=f.port.issuesMap.get('1').body;
 await f.artifacts.tick(signal());assert.equal((await f.publisher.tick(signal())).state,'published');assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.port.commentPosts,1);assert.match(f.port.commentsMap.get('1').body,/!\[原消息附件/);assert.ok(f.port.commentsMap.get('1').body.includes(url));assert.equal(f.port.issuesMap.get('1').body,original);assert.equal(f.domain.getWork(binding.projectId,'defect',f.workId).version,1);
 f.manager.artifactChanged(f.eventId);await f.manager.tick();assert.equal(f.port.patches,0);assert.equal(f.assetsPort.uploads,1);
});
test('asset completion during an in-flight initial Issue cannot be lost by version-only outbox acknowledgment',async t=>{
 const f=await setup(t),create=f.port.createIssue.bind(f.port);f.port.createIssue=async(...args)=>{const result=await create(...args);await f.artifacts.tick(signal());await f.publisher.tick(signal());return result;};
 await f.manager.tick();assert.equal(f.runtime.store.get('SELECT state FROM github_sync_outbox').state,'pending');f.advance(60001);await f.manager.tick();assert.ok(f.port.commentsMap.get('1').body.includes(url));assert.equal(f.assetsPort.uploads,1);
});
test('capture failure and upload unknown never prevent initial Issue creation, and unknown upload is never repeated after reopen',async t=>{
 const f=await setup(t,{captureFail:true});await f.artifacts.tick(signal());await f.publisher.tick(signal());assert.equal((await f.manager.tick()).state,'succeeded');assert.equal(f.assetsPort.uploads,0);assert.match(f.port.issuesMap.get('1').body,/unavailable/);
 const g=await setup(t);await g.artifacts.tick(signal());g.assetsPort.mode='timeout';assert.equal((await g.publisher.tick(signal())).state,'unknown');assert.equal((await g.manager.tick()).state,'succeeded');g.advance(120001);const restarted=new ArtifactPublisher(g.runtime.store,g.artifacts,g.assetsPort,g.publisherOptions);await restarted.tick(signal());assert.equal(g.assetsPort.uploads,1);assert.ok(!g.port.issuesMap.get('1').body.includes(url));
});
test('a persisted upload URL is verified read-only after recovery, while a lost local URL acknowledgment remains unknown',async t=>{
 const f=await setup(t);await f.artifacts.tick(signal());f.assetsPort.mode='verify_network';assert.equal((await f.publisher.tick(signal())).state,'uploaded');f.assetsPort.mode='ok';f.advance(60001);const next=new ArtifactPublisher(f.runtime.store,f.artifacts,f.assetsPort,f.publisherOptions);assert.equal((await next.tick(signal())).state,'published');assert.equal(f.assetsPort.uploads,1);
 const g=await setup(t);await g.artifacts.tick(signal());g.runtime.store.exec("CREATE TRIGGER asset_url_fault BEFORE UPDATE OF asset_url ON artifact_publications BEGIN SELECT RAISE(ABORT,'CONTROLLED_ACK_FAILURE'); END;");assert.equal((await g.publisher.tick(signal())).state,'unknown');g.runtime.store.exec('DROP TRIGGER asset_url_fault');g.advance(60001);await g.publisher.tick(signal());assert.equal(g.assetsPort.uploads,1);
});
test('public targets, revoked authorization and anonymous-readable uploaded assets are blocked',async t=>{
 const f=await setup(t);await f.artifacts.tick(signal());f.assetsPort.private=false;assert.equal((await f.publisher.tick(signal())).state,'blocked');assert.equal(f.assetsPort.uploads,0);
 const g=await setup(t);await g.artifacts.tick(signal());const denied=new ArtifactPublisher(g.runtime.store,g.artifacts,g.assetsPort,{...g.publisherOptions,authorize:()=>{throw new Error('REVOKED');}});assert.equal((await denied.tick(signal())).state,'blocked');assert.equal(g.assetsPort.uploads,0);
 const h=await setup(t);await h.artifacts.tick(signal());h.assetsPort.mode='public';assert.equal((await h.publisher.tick(signal())).state,'blocked');assert.equal(h.builder.build(binding.projectId,'defect',h.workId).attachments[0].url,undefined);
});
test('manual report comment edits are not overwritten by a late asset',async t=>{
 const f=await setup(t);await f.manager.tick();f.add('more','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();f.advance(60001);await f.manager.tick();f.port.commentsMap.get('1').body+='\nDeveloper investigation';
 await f.artifacts.tick(signal());await f.publisher.tick(signal());assert.equal((await f.manager.tick()).state,'manual_review');assert.equal(f.port.patches,0);assert.match(f.port.commentsMap.get('1').body,/Developer investigation/);
});
test('GitHub native protocol sends binary bytes and repository id; authorized hash reads pass while anonymous reads fail',async()=>{
 const calls=[],hash=createHash('sha256').update(png).digest('hex');const port=new GitHubIssueAssets({repository:'owner/private-test',token:'fixture-secret',session:'unused-expired-file-session',fetch:async(input,init)=>{const u=new URL(input);assert.equal(init.headers.Cookie,undefined);calls.push({url:u,init});if(u.hostname==='api.github.com')return Response.json({id:99,private:true,permissions:{push:true}});if(u.hostname==='uploads.github.com'){assert.equal(u.pathname,'/user-attachments/assets');assert.equal(u.searchParams.get('repository_id'),'99');assert.equal(u.searchParams.get('content_type'),'image/png');assert.deepEqual(Buffer.from(init.body),png);return Response.json({url});}return init.headers.Authorization?new Response(png):new Response(null,{status:404});}});
 assert.equal((await port.inspect()).private,true);assert.equal(await port.upload(png,'image/png','artifact-'+'a'.repeat(64)+'.png','99',signal()),url);assert.equal(await port.verify(url,hash,png.length,signal()),true);assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
 for(const bad of ['http://github.com/user-attachments/assets/'+'a'.repeat(32),'https://evil.test/file','https://github.com/user-attachments/assets/'+'a'.repeat(32)+'?token=secret'])assert.throws(()=>issueAssetURL(bad));
 const publicPort=new GitHubIssueAssets({repository:'owner/private-test',token:'fixture-secret',fetch:async()=>new Response(png)});await assert.rejects(publicPort.verify(url,hash,png.length,signal()),/NOT_PRIVATE/);
});
test('native files require explicit web session; verified reads strip bearer credentials on approved content redirects',async()=>{
 const log=Buffer.from('ERROR: network disconnected\n'),hash=createHash('sha256').update(log).digest('hex');let posts=0;
 const port=new GitHubIssueAssets({repository:'owner/private-test',token:'fixture',fetch:async(input,init)=>{const u=new URL(input);if(u.hostname==='uploads.github.com'){posts++;assert.equal(u.searchParams.get('content_type'),'text/plain');assert.deepEqual(Buffer.from(init.body),log);return Response.json({url});}if(u.hostname==='github.com')return init.headers.Authorization?new Response(null,{status:302,headers:{Location:'https://private-user-images.githubusercontent.com/example?jwt=fixture'}}):new Response(null,{status:404});assert.equal(init.headers.Authorization,undefined);return new Response(log);}});
 assert.equal(port.canUpload('text/plain'),false);await assert.rejects(port.upload(log,'text/plain','artifact-'+'b'.repeat(64)+'.txt','99',signal()),/SESSION_REQUIRED/);assert.equal(await port.verify(url,hash,log.length,signal()),true);assert.equal(posts,0);
});
test('disabled publisher sends nothing and shutdown bounds a provider that ignores abort',async t=>{
 const f=await setup(t);await f.artifacts.tick(signal());const disabled=new ArtifactPublisher(f.runtime.store,f.artifacts,f.assetsPort,{...f.publisherOptions,allowWrites:false});await disabled.tick(signal());assert.equal(f.assetsPort.uploads,0);
 f.assetsPort.inspect=()=>new Promise(()=>{});const controller=new AbortController(),pending=f.publisher.tick(controller.signal);setTimeout(()=>controller.abort(),10);await pending;assert.equal(f.assetsPort.uploads,0);
});

test('private native assets follow the observed GitHub S3 redirect without forwarding credentials or persisting signed URLs',async()=>{
 const hash=createHash('sha256').update(png).digest('hex'),cdn='https://github-production-user-asset-6210df.s3.amazonaws.com/owner/image.png?X-Amz-Signature=fixture';
 const calls=[];const port=new GitHubIssueAssets({repository:'owner/private-test',token:'fixture',fetch:async(input,init)=>{const u=new URL(input);calls.push({u,init});if(u.hostname==='github.com')return init.headers.Authorization?new Response(null,{status:302,headers:{Location:cdn}}):new Response(null,{status:404});assert.equal(u.href,cdn);assert.equal(init.headers.Authorization,undefined);return new Response(png);}});
 assert.equal(await port.verify(url,hash,png.length,signal()),true);assert.equal(calls.length,3);assert.equal(issueAssetURL(url),url);
 for(const location of ['https://attacker.s3.amazonaws.com/file','https://github-production-user-asset-6210df.s3.amazonaws.com.evil.test/file','http://github-production-user-asset-6210df.s3.amazonaws.com/file']){
  const bad=new GitHubIssueAssets({repository:'owner/private-test',token:'fixture',fetch:async()=>new Response(null,{status:302,headers:{Location:location}})});await assert.rejects(bad.verify(url,hash,png.length,signal()),/REDIRECT_INVALID/);
 }
});
test('unified entry assembles capture, report builder and native publication only with separate explicit write flags',async t=>{
 const f=appFixture(t);for(const s of f.config.sources)s.enabled=false;for(const d of f.config.deliveries)d.enabled=false;f.config.analysis={enabled:false,allowExternalCalls:false};f.config.artifacts={enabled:true,root:path.join(f.directory,'files'),keyEnv:'TEST_KEY'};f.config.github={enabled:true,allowWrites:true,repository:'owner/private-test',tokenEnv:'TEST_GH',attachmentUploads:{enabled:true,allowWrites:true}};
 const port=new FixtureGitHub(),assets=new Assets(),app=await createApplication(f.config,{access:f.access,env:{TEST_KEY:key.toString('hex'),TEST_GH:'fixture'},github:port,assetPort:assets,artifactDownload:async()=>png});f.after(()=>app.close());assert.ok(app.artifacts);assert.ok(app.artifactPublisher);await app.tick();assert.equal(assets.uploads,0);assert.equal(port.posts,0);
 const invalid=structuredClone(f.config);invalid.github.allowWrites=false;await assert.rejects(createApplication(invalid,{access:f.access,env:{TEST_KEY:key.toString('hex'),TEST_GH:'fixture'},github:port,assetPort:assets}),/INVALID_GITHUB_ATTACHMENT_CONFIG/);
});
test('known rate-limit rejection is retried only after the provider interval, not on every tick',async t=>{
 const f=await setup(t);await f.artifacts.tick(signal());f.assetsPort.upload=async()=>{f.assetsPort.uploads++;throw new IssueAssetError('GITHUB_ASSET_HTTP_429','safe_retry',120000);};
 assert.equal((await f.publisher.tick(signal())).state,'safe_retry');assert.equal(f.assetsPort.uploads,1);f.advance(60001);await f.publisher.tick(signal());assert.equal(f.assetsPort.uploads,1);f.advance(60000);await f.publisher.tick(signal());assert.equal(f.assetsPort.uploads,2);
});
test('missing file configuration waits without network attempts and resumes when configuration becomes available',async t=>{
 const f=await setup(t);await f.artifacts.tick(signal());f.assetsPort.canUpload=()=>false;assert.equal((await f.publisher.tick(signal())).state,'waiting_configuration');assert.equal(f.assetsPort.uploads,0);assert.equal(f.runtime.store.get('SELECT attempt FROM artifact_publications').attempt,0);
 f.advance(60001);f.assetsPort.canUpload=()=>true;assert.equal((await new ArtifactPublisher(f.runtime.store,f.artifacts,f.assetsPort,f.publisherOptions).tick(signal())).state,'published');assert.equal(f.assetsPort.uploads,1);
});
