import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../scripts/application.mjs';
import { loadApplicationConfig } from '../../scripts/application-config.mjs';
import { ApplicationPlugins } from '../../scripts/application-plugins.mjs';
import { SteamReviewsConnector,SteamReviewCommentsConnector,seedSteamReviewCommentsCheckpoint } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { appFixture,eventually,untilAbort,SupervisorClock } from './application-helpers.mjs';
import { M1Runtime } from '@superagent/agent-core';

const example=fileURLToPath(new URL('../../examples/steam-public/superagent.json',import.meta.url));
const fixture=name=>readFileSync(new URL('../fixtures/m4/'+name,import.meta.url),'utf8');

test('Steam application example validates real manifests without opening its archive or enabling external services',t=>{
  const f=appFixture(t),config=loadApplicationConfig(example);config.database=f.config.database;
  new ApplicationPlugins(null,config,null,{env:{}});
  assert.equal(existsSync(config.database),false);
  assert.deepEqual(config.sources.map(s=>s.plugin),['steam-reviews','steam-review-comments','steam-discussions']);
  assert.equal(config.analysis.enabled,false);assert.equal(config.github.allowWrites,false);assert.equal(config.deliveries.length,0);
  const defaults=loadApplicationConfig(fileURLToPath(new URL('../../config/superagent.json',import.meta.url)));
  assert.ok(defaults.sources.every(source=>!source.enabled));
});

test('three actual Steam plugins are supervised independently and archive through one application Host/store',async t=>{
  const f=appFixture(t),config=loadApplicationConfig(example);config.database=f.config.database;
  const review=JSON.parse(fixture('steam-review.json'));review.comment_count=1;
  const thread=fixture('steam-review-comments.html');const done=new Set();
  const constructors={'steam-reviews':SteamReviewsConnector,'steam-review-comments':SteamReviewCommentsConnector,'steam-discussions':SteamDiscussionsConnector};
  const sourceFactories=Object.fromEntries(Object.entries(constructors).map(([kind,Ctor])=>[kind,c=>{
    const plugin=new Ctor(c,{sleep:async(ms,signal)=>{if(ms>=600000)await untilAbort(signal);},fetch:async input=>{
      const url=new URL(input);
      if(url.hostname==='api.steampowered.com')return Response.json({response:{cursor:'end',reviews:JSON.parse(url.searchParams.get('input_json')).cursor==='*'?[review]:[]}});
      if(url.pathname.startsWith('/comment/Recommendation/'))return Response.json({success:true,start:0,total_count:1,comments_html:thread});
      if(url.pathname.startsWith('/forum/'))return Response.json({success:1,start:0,total_count:0,topics_html:''});
      return new Response(fixture('steam-discussions-public-forum.html'));
    }});
    const sync=plugin.sync.bind(plugin);plugin.sync=async(...args)=>{await sync(...args);done.add(kind);};return plugin;
  }]));
  const app=await createApplication(config,{env:{},access:f.access,policy:f.policy,sourceFactories});f.after(()=>app.close());
  await app.start();await eventually(()=>done.size===3);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,2);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM sources').n,3);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_objects').n,2);
  for(const entry of config.sources){
    const host=app.plugins.instances.get(entry.id).host;assert.ok(await host.getCheckpoint());
    const events=app.runtime.store.all('SELECT payload_json FROM source_events WHERE source_id=?',entry.id).map(row=>JSON.parse(row.payload_json));
    const replay=await host.commitBatch(events);assert.equal(replay.duplicates,events.length);
  }
});

test('fresh application instances delay diagnostic probes until each Steam source committed Retry-After expires',async t=>{
  for(const kind of ['steam-review-comments','steam-discussions'])await t.test(kind,async t=>{
    const f=appFixture(t),clock=new SupervisorClock(),config=loadApplicationConfig(example);config.database=f.config.database;
    config.sources=config.sources.filter(entry=>entry.plugin===kind);const entry=config.sources[0];
    const binding={projectId:config.projectId,sourceId:entry.id,sourceUri:entry.config.sourceUri,platform:kind==='steam-review-comments'?'steam-reviews':kind};
    const runtime=new M1Runtime(config.database,{policy:f.policy});runtime.ingress.registerSource(binding);
    let cp;
    if(kind==='steam-review-comments')cp={...seedSteamReviewCommentsCheckpoint(entry.config,null,[]),nextEligibleAt:clock.now()+3600000};
    else {
      const plugin=new SteamDiscussionsConnector(entry.config,{sleep:async()=>{},fetch:async input=>new URL(input).pathname.startsWith('/forum/')
        ?Response.json({success:1,start:0,total_count:0,topics_html:''}):new Response(fixture('steam-discussions-public-forum.html'))});
      await plugin.sync(runtime.ingress.sourceHost(binding),new AbortController().signal);
      cp={...runtime.ingress.getCheckpoint(binding),retryAfter:clock.now()+3600000};
    }
    runtime.ingress.commitBatch(binding,[],{sourceId:entry.id,cursor:cp});runtime.close();let probes=0;
    const app=await createApplication(config,{env:{},policy:f.policy,access:f.access,supervisorTiming:clock,sourceFactories:{[kind]:c=>{
      const plugin=kind==='steam-review-comments'?new SteamReviewCommentsConnector(c):new SteamDiscussionsConnector(c);
      plugin.probe=async()=>{probes++;return{connection:'poll',coverage:'partial',readMessages:true,readHistory:true,readEdits:true,readAttachments:false};};
      plugin.start=async(_host,signal)=>untilAbort(signal);return plugin;
    }}});f.after(()=>app.close());await app.start();
    await eventually(()=>app.status().plugins[entry.id].state==='retry_wait');assert.equal(probes,0);
    await clock.advance(3599999);assert.equal(probes,0);
    await clock.advance(1);await eventually(()=>probes>0);
  });
});
