import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {ArtifactStore,ArtifactError,validateArtifactURL,publicArtifactAddress,artifactType,downloadArtifact} from '@superagent/plugin-host';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {QQSource} from '@superagent/qq-official';
import {fixture,binding,scope,event} from './helpers.mjs';
import {qqEvent,readSecret,signed} from './qq-helpers.mjs';
import {createApplication} from '../../scripts/application.mjs';
import {appFixture} from './application-helpers.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),key=Buffer.alloc(32,7),signal=()=>new AbortController().signal;
function setup(t,options={}){
 const f=fixture(t),root=path.join(f.directory,'private-artifacts');let calls=0;
 const settings={root,key,clock:f.clock,download:async()=>{calls++;return png;},...options},artifacts=new ArtifactStore(f.runtime.store,settings);
 const message=event('image');message.data.content.attachments=[{kind:'image',mimeType:'image/png',assetRef:'asset-one'}];
 const request={projectId:binding.projectId,sourceId:binding.sourceId,sourceUri:binding.sourceUri,externalEventId:message.id,assetRef:'asset-one',url:'https://multimedia.nt.qq.com.cn/download?rkey=TOP_SECRET',mimeType:'image/png',filename:'screen.png',ordinal:0};
 return{...f,root,settings,artifacts,message,request,calls:()=>calls,archive:()=>f.runtime.ingress.commitBatch(scope,[message]).refs[0].eventId,row:()=>f.runtime.store.get('SELECT * FROM artifacts')};
}
test('capture is archive-first, encrypted, exactly event-bound, idempotent and authorization checked at read time',async t=>{
 const f=setup(t);f.artifacts.stage(f.request);assert.equal((await f.artifacts.tick(signal())).processed,false);assert.equal(f.calls(),0);assert.ok(!JSON.stringify(f.row()).includes('TOP_SECRET'));
 const eventId=f.archive();assert.equal((await f.artifacts.tick(signal())).state,'stored');assert.equal(f.calls(),1);const row=f.row();assert.equal(row.source_event_id,eventId);assert.equal(row.ticket_cipher,null);assert.ok(!readFileSync(path.join(f.root,row.storage_key)).includes(png));
 assert.deepEqual(f.artifacts.read(binding.projectId,row.artifact_id,()=>{}).bytes,png);assert.throws(()=>f.artifacts.read('other',row.artifact_id,()=>{}),/NOT_FOUND/);
 assert.throws(()=>f.artifacts.read(binding.projectId,row.artifact_id,()=>{throw new Error('REVOKED');}),/REVOKED/);
 let checks=0;assert.throws(()=>f.artifacts.read(binding.projectId,row.artifact_id,()=>{if(++checks===2)throw new Error('REVOKED_DURING_READ');}),/REVOKED_DURING_READ/);
 f.artifacts.stage(f.request);await f.artifacts.tick(signal());assert.equal(f.calls(),1);
 f.runtime.ingress.commitBatch(scope,[event('delete',{objectId:'image',action:'deleted',time:'2026-11-02T00:01:00.000Z'})]);assert.throws(()=>f.artifacts.read(binding.projectId,row.artifact_id,()=>{}),/NOT_FOUND/);
});
test('encrypted tickets survive reopen and recover bounded transient failures without recapturing stored content',async t=>{
 let attempts=0;const f=setup(t,{download:async()=>{if(++attempts===1)throw new ArtifactError('ARTIFACT_NETWORK',true);return png;}});f.artifacts.stage(f.request);f.archive();assert.equal((await f.artifacts.tick(signal())).state,'pending');
 f.advance(5001);const reopened=f.open(),next=new ArtifactStore(reopened.store,f.settings);assert.equal((await next.tick(signal())).state,'stored');assert.equal(attempts,2);
 // Durable boundary after atomic file rename, before final DB acknowledgment.
 reopened.store.run("UPDATE artifacts SET state='capturing',lease_until=?,ticket_cipher=NULL",f.clock());
 await next.tick(signal());assert.equal(f.row().state,'stored');assert.equal(attempts,2);
 assert.throws(()=>new ArtifactStore(reopened.store,{...f.settings,key:Buffer.alloc(32,9)}),/BINDING_CHANGED/);
});
test('unarchived tickets expire without download; exhausted network retries clear credential material',async t=>{
 const f=setup(t,{ticketTtlMs:1000});f.artifacts.stage(f.request);f.advance(1001);await f.artifacts.tick(signal());assert.equal(f.calls(),0);assert.equal(f.row().state,'unavailable');assert.equal(f.row().ticket_cipher,null);
 const g=setup(t,{download:async()=>{throw new ArtifactError('ARTIFACT_NETWORK',true);}});g.artifacts.stage(g.request);g.archive();for(let n=0;n<3;n++){await g.artifacts.tick(signal());g.advance(20000);}assert.equal(g.row().attempt,3);assert.equal(g.row().state,'unavailable');assert.equal(g.row().ticket_cipher,null);
});
test('allowlisted HTTPS and public DNS only; reject HTML, mismatched MIME, oversized files and excess message count',async t=>{
 for(const url of ['http://multimedia.nt.qq.com.cn/a','https://127.0.0.1/a','https://multimedia.nt.qq.com.cn.evil.test/a','https://user:secret@gchat.qpic.cn/a','https://gchat.qpic.cn:444/a'])assert.throws(()=>validateArtifactURL(url));
 for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.2','::1','::ffff:127.0.0.1','fd00::1','2001:db8::1'])assert.equal(publicArtifactAddress(address),false);assert.equal(publicArtifactAddress('8.8.8.8'),true);
 assert.throws(()=>artifactType(Buffer.from('<script>oops</script>'),'image/png','screen.png'));assert.throws(()=>artifactType(png,'image/jpeg','screen.jpg'));assert.equal(artifactType(Buffer.from('ERROR: loading failed\n'),'application/octet-stream','game.log'),'text/plain');
 const f=setup(t,{maxBytes:10});f.artifacts.stage(f.request);f.archive();await f.artifacts.tick(signal());assert.equal(f.row().error_code,'ARTIFACT_TOO_LARGE');
 const g=setup(t);g.artifacts.stage({...g.request,ordinal:5});assert.equal(g.row().state,'rejected');assert.equal(g.row().ticket_cipher,null);assert.throws(()=>g.artifacts.stage({...g.request,sourceId:'unbound'}),/NOT_AUTHORIZED/);
});
test('an archive with a different assetRef never binds and plaintext/tampered files are not served',async t=>{
 const f=setup(t);f.artifacts.stage({...f.request,assetRef:'wrong-asset'});f.archive();await f.artifacts.tick(signal());assert.equal(f.row().state,'rejected');assert.equal(f.calls(),0);
 const g=setup(t);g.artifacts.stage(g.request);g.archive();await g.artifacts.tick(signal());g.runtime.store.run('UPDATE artifacts SET sha256=?','0'.repeat(64));assert.throws(()=>g.artifacts.read(binding.projectId,g.row().artifact_id,()=>{}),/INTEGRITY/);
});
test('download transport pins validated DNS, sends no credential and refuses redirects without a second request',async()=>{
 let calls=0;const transport={resolve:async()=>[{address:'8.8.8.8',family:4}],request:(url,options,callback)=>{calls++;assert.equal(options.family,4);assert.equal(options.headers.Authorization,undefined);options.lookup(url.hostname,{},(error,address)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');});const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=302;callback(res);};return req;}};
 await assert.rejects(downloadArtifact(new URL('https://gchat.qpic.cn/image'),1024,signal(),transport),/HTTP_302/);assert.equal(calls,1);
 await assert.rejects(downloadArtifact(new URL('https://gchat.qpic.cn/image'),1024,signal(),{...transport,resolve:async()=>[{address:'127.0.0.1',family:4}]}),/NOT_PUBLIC/);assert.equal(calls,1);
});
test('QQ Source stages a recoverable ticket before checkpoint commit; URLs never enter frozen event payloads',async t=>{
 const f=setup(t),source=new QQSource({kind:'group',sourceUri:binding.sourceUri,captureAttachments:true,now:()=>Date.parse(f.clock()),artifacts:{stage:r=>f.artifacts.stage(r)}});
 const host=f.runtime.ingress.sourceHost(scope,{getSecret:readSecret,secretKeys:source.manifest.permissions.secretKeys});await source.start(host,signal());t.after(()=>source.stop());
 const payload=qqEvent('native',{data:{attachments:[{content_type:'image/png',filename:'native.png',url:f.request.url}]}});assert.equal((await source.handleWebhook(...signed(payload,f.clock))).statusCode,200);
 assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events').n,1);assert.ok(!f.runtime.store.get('SELECT payload_json FROM source_events').payload_json.includes('TOP_SECRET'));assert.equal(f.row().state,'pending');await f.artifacts.tick(signal());assert.equal(f.row().state,'stored');
 await source.handleWebhook(...signed(payload,f.clock));await f.artifacts.tick(signal());assert.equal(f.calls(),1);
});

test('explicit fixed DoH resolves only the CDN hostname and pins a validated public address without leaking signed URLs',async()=>{
 let dnsCalls=0,downloads=0;const transport={dnsMode:'aliyun-doh',fetch:async(input,init)=>{dnsCalls++;const u=new URL(input);assert.equal(u.origin,'https://dns.alidns.com');assert.equal(u.pathname,'/resolve');assert.equal(u.searchParams.get('name'),'multimedia.nt.qq.com.cn');assert.equal(u.searchParams.get('type'),'A');assert.equal(u.search.includes('SECRET'),false);assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');return Response.json({Status:0,Answer:[{type:5,data:'public-cdn.example'},{type:1,data:'8.8.8.8'}]});},request:(url,options,callback)=>{downloads++;assert.equal(options.family,4);options.lookup(url.hostname,{},(e,address)=>{assert.equal(e,null);assert.equal(address,'8.8.8.8');});assert.equal(options.headers.Authorization,undefined);const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=200;res.headers={};callback(res);res.end(png);};return req;}};
 assert.deepEqual(await downloadArtifact(new URL('https://multimedia.nt.qq.com.cn/image?rkey=SECRET'),1024,signal(),transport),png);assert.equal(dnsCalls,1);assert.equal(downloads,1);
});

test('DoH keeps private/Fake-IP rejection, bounded JSON, redirect rejection and shutdown limits',async()=>{
 let downloads=0;const base={dnsMode:'aliyun-doh',request:()=>{downloads++;throw new Error('MUST_NOT_CONNECT');}};
 for(const address of ['127.0.0.1','198.18.0.156','10.0.0.1'])await assert.rejects(downloadArtifact(new URL('https://gchat.qpic.cn/file'),1024,signal(),{...base,fetch:async()=>Response.json({Status:0,Answer:[{type:1,data:address}]})}),/NOT_PUBLIC/);
 for(const response of [new Response('x'.repeat(16385)),new Response('{broken'),Response.json({Status:0,Answer:[]}),new Response(null,{status:302})])await assert.rejects(downloadArtifact(new URL('https://gchat.qpic.cn/file'),1024,signal(),{...base,fetch:async()=>response}),/ARTIFACT_DNS_/);
 const controller=new AbortController(),pending=downloadArtifact(new URL('https://gchat.qpic.cn/file'),1024,controller.signal,{...base,fetch:()=>new Promise(()=>{})});controller.abort();await assert.rejects(pending,/ARTIFACT_ABORTED/);assert.equal(downloads,0);
});
test('unified managed capture and Web download require current project session; shutdown bounds an ignored abort',async t=>{
 const f=appFixture(t);for(const e of f.config.sources)e.enabled=false;for(const e of f.config.deliveries)e.enabled=false;f.config.web={enabled:true,port:0};f.config.artifacts={enabled:true,root:path.join(f.directory,'files'),keyEnv:'TEST_ARTIFACT_KEY'};
 const app=await createApplication(f.config,{access:f.access,env:{TEST_ARTIFACT_KEY:key.toString('hex')},artifactDownload:async()=>png});f.after(()=>app.close());await app.start();app.runtime.ingress.registerSource({...binding,projectId:f.config.projectId});
 const message=event('web-file');message.data.projectId=f.config.projectId;message.data.content.attachments=[{kind:'image',mimeType:'image/png',assetRef:'web-image'}];
 app.artifacts.stage({projectId:f.config.projectId,sourceId:binding.sourceId,sourceUri:binding.sourceUri,externalEventId:message.id,assetRef:'web-image',url:'https://gchat.qpic.cn/image',mimeType:'image/png',filename:'image.png',ordinal:0});app.runtime.ingress.commitBatch({projectId:f.config.projectId,sourceId:binding.sourceId},[message]);await app.artifacts.tick(signal());const id=app.runtime.store.get('SELECT artifact_id FROM artifacts').artifact_id,origin=`http://127.0.0.1:${app.status().webPort}`,url=`${origin}/api/artifacts/${id}?project=${f.config.projectId}`;
 assert.equal((await fetch(url)).status,401);const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessKey:f.access.accessKey})}),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');await login.body.cancel();
 const ok=await fetch(url,{headers:{cookie}});assert.equal(ok.status,200);assert.match(ok.headers.get('content-disposition'),/^attachment/);assert.equal(ok.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await ok.arrayBuffer()),png);assert.equal((await fetch(url.replace(f.config.projectId,'unbound'),{headers:{cookie}})).status,403);
 app.runtime.store.run("UPDATE operator_accounts SET enabled=0 WHERE actor_ref='web-developer'");assert.equal((await fetch(url,{headers:{cookie}})).status,401);
 const g=setup(t,{download:()=>new Promise(()=>{})});g.artifacts.stage(g.request);g.archive();const controller=new AbortController(),pending=g.artifacts.tick(controller.signal);setTimeout(()=>controller.abort(),10);await pending;assert.equal(g.row().state,'pending');
});
