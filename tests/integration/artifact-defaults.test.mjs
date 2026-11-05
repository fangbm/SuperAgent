import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadApplicationConfig,parseApplicationConfig} from '../../scripts/application-config.mjs';
import {createApplication} from '../../scripts/application.mjs';
import {appFixture,sourceDouble} from './application-helpers.mjs';
import {FixtureGitHub} from './m3-helpers.mjs';
const key='18'.repeat(32);
const fresh=f=>{const c=structuredClone(f.config);delete c.artifacts;delete c.github.attachmentUploads;for(const e of c.sources)if(e.plugin==='qq-official')delete e.config.captureAttachments;return c;};

test('shipped defaults enable attachment capability without starting disabled platforms or requiring unused secrets',async t=>{
 const f=appFixture(t),config=loadApplicationConfig(fileURLToPath(new URL('../../config/superagent.json',import.meta.url)));
 config.database=path.join(f.directory,'defaults.sqlite');config.artifacts.root=path.join(f.directory,'files');
 assert.equal(config.artifacts.enabled,true);assert.equal(config.sources.find(e=>e.plugin==='qq-official').config.captureAttachments,true);assert.equal(config.github.enabled,false);
 assert.equal(config.artifacts.dnsMode,'aliyun-doh');assert.throws(()=>parseApplicationConfig({...config,artifacts:{...config.artifacts,dnsMode:'https://arbitrary.invalid'}}),/INVALID_ARTIFACT_CONFIG/);
 const app=await createApplication(config,{env:{},access:f.access});f.after(()=>app.close());await app.start();await app.tick();assert.equal(app.artifacts,undefined);assert.equal(app.artifactPublisher,undefined);assert.deepEqual(app.plugins.status(),{});
});

test('enabled QQ captures by default with a persistent supplied key; missing key fails closed and explicit opt-out remains usable',async t=>{
 const f=appFixture(t),config=fresh(f),qq=config.sources.find(e=>e.plugin==='qq-official');qq.enabled=true;
 const parsed=parseApplicationConfig(config);assert.equal(parsed.sources.find(e=>e.id===qq.id).config.captureAttachments,true);assert.equal(parsed.artifacts.enabled,true);
 await assert.rejects(createApplication(config,{env:{},access:f.access}),/APPLICATION_SECRET_MISSING/);
 const app=await createApplication(config,{env:{SA_ARTIFACT_KEY:key},access:f.access,sourceFactories:{'qq-official':()=>sourceDouble(parsed.sources.find(e=>e.id===qq.id))}});f.after(()=>app.close());await app.start();assert.ok(app.artifacts);assert.equal(app.artifactPublisher,undefined);await app.close();
 const off=fresh(f);off.database=path.join(f.directory,'off.sqlite');off.artifacts={enabled:false};off.sources.find(e=>e.id===qq.id).enabled=true;
 const opted=await createApplication(off,{env:{},access:f.access,sourceFactories:{'qq-official':()=>sourceDouble(off.sources.find(e=>e.id===qq.id))}});f.after(()=>opted.close());await opted.start();assert.equal(opted.artifacts,undefined);assert.equal(opted.config.sources.find(e=>e.id===qq.id).config.captureAttachments,false);
});

test('native attachment publication follows the existing GitHub write gate by default and respects explicit disable',async t=>{
 const f=appFixture(t),config=fresh(f),github=new FixtureGitHub(),port={repository:github.repository,inspect:async()=>{throw new Error('UNEXPECTED_NETWORK');},upload:async()=>{throw new Error('UNEXPECTED_UPLOAD');},verify:async()=>false};
 config.github={enabled:true,allowWrites:true,repository:github.repository,tokenEnv:'TEST_GH'};
 const app=await createApplication(config,{env:{SA_ARTIFACT_KEY:key},access:f.access,github,assetPort:port});f.after(()=>app.close());assert.ok(app.artifactPublisher);assert.equal(app.config.github.attachmentUploads.allowWrites,true);await app.tick();await app.close();
 const readonly=fresh(f);readonly.database=path.join(f.directory,'readonly.sqlite');readonly.github={...config.github,allowWrites:false};const parsed=parseApplicationConfig(readonly);assert.equal(parsed.github.attachmentUploads.enabled,true);assert.equal(parsed.github.attachmentUploads.allowWrites,false);
 const off=fresh(f);off.database=path.join(f.directory,'off-gh.sqlite');off.github={...config.github,attachmentUploads:{enabled:false,allowWrites:false}};
 const opted=await createApplication(off,{env:{SA_ARTIFACT_KEY:key},access:f.access,github,assetPort:port});f.after(()=>opted.close());assert.equal(opted.artifactPublisher,undefined);
});
