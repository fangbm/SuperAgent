import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../scripts/application.mjs';
import { loadApplicationConfig } from '../../scripts/application-config.mjs';
import { ApplicationPlugins } from '../../scripts/application-plugins.mjs';
import { SteamReviewsConnector,SteamReviewCommentsConnector,seedSteamReviewCommentsCheckpoint,normalizeSteamReview } from '@superagent/connector-steam-reviews';
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
  assert.equal(config.analysis.enabled,true);assert.equal(config.analysis.allowExternalCalls,true);
  assert.equal(config.analysis.baseURL,'http://127.0.0.1:11434/v1');
  assert.equal(config.github.allowWrites,false);assert.equal(config.deliveries.length,0);
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


test('first-ever 429 is persisted before any supervised probe and respected after restart', async t => {
  for (const kind of ['steam-review-comments', 'steam-discussions']) await t.test(kind, async t => {
    const f = appFixture(t), clock = new SupervisorClock(), config = loadApplicationConfig(example);
    config.database = f.config.database;
    config.sources = config.sources.filter(entry => entry.plugin === kind);
    config.runtime.healthGraceMs = 10;
    const entry = config.sources[0], scope = { projectId: config.projectId, sourceId: entry.id };
    const deadlineField = kind === 'steam-review-comments' ? 'nextEligibleAt' : 'retryAfter';
    let calls = 0;
    const sourceFactories = { [kind]: c => {
      const options = {
        passiveProbe: true,
        sleep: async (_ms, signal) => untilAbort(signal),
        now: () => clock.now(), clock: () => new Date(clock.now()),
        fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '3600' } }); },
      };
      return kind === 'steam-review-comments' ? new SteamReviewCommentsConnector(c, options) : new SteamDiscussionsConnector(c, options);
    } };
    let app = await createApplication(config, { env: {}, access: f.access, policy: f.policy, supervisorTiming: clock, sourceFactories });
    f.after(() => app?.close());
    await app.start();
    await eventually(() => app.runtime.ingress.getCheckpoint(scope)?.[deadlineField] === clock.now() + 3600000);
    assert.equal(calls, 1, 'no unbound startup probe or early retry of a rate-limited request');
    await app.close();
    app = await createApplication(config, { env: {}, access: f.access, policy: f.policy, supervisorTiming: clock, sourceFactories });
    await app.start();
    await eventually(() => app.status().plugins[entry.id].state === 'retry_wait');
    assert.equal(calls, 1, 'fresh process must not make any early external request');
    await clock.advance(3599999);
    assert.equal(calls, 1);
  });
});


test('Steam review-comment M1 batches include the exact same-app parent review context', async t => {
  const f = appFixture(t);
  const runtime = new M1Runtime(f.config.database, { policy: { ...f.policy, maxCandidateMessages: 1 } });
  f.after(() => runtime.close());
  const projectId = 'steam-link-fixture', appId = 570;
  const parent = { projectId, sourceId: 'reviews-all', sourceUri: 'urn:steam:reviews-all', platform: 'steam-reviews' };
  const child = { projectId, sourceId: 'review-comments', sourceUri: 'urn:steam:review-comments', platform: 'steam-reviews' };
  runtime.ingress.registerSource(parent); runtime.ingress.registerSource(child);
  const native = JSON.parse(fixture('steam-review.json'));
  const reviewEvent = normalizeSteamReview(native, { sourceUri: parent.sourceUri, appId }, parent);
  const reviewId = native.recommendationid;
  const commentEvent = structuredClone(reviewEvent);
  commentEvent.source = child.sourceUri;
  commentEvent.id = 'comment:' + reviewId + ':9001:created:x1';
  commentEvent.type = 'com.superagent.feedback.comment.created.v1';
  commentEvent.data.sourceId = child.sourceId;
  commentEvent.data.object = { kind: 'comment', externalId: 'comment:' + reviewId + ':9001', revision: 'x1',
    parentExternalId: reviewId, threadExternalId: 'review:' + reviewId };
  commentEvent.data.content = { text: '更新后联机仍然崩溃，请修复' };
  commentEvent.data.attributes = { appId, surface: 'review-comments', parentReviewSourceId: parent.sourceId,
    parentRecommendationId: reviewId };
  const parentReceipt = runtime.ingress.commitBatch(parent, [reviewEvent]);
  const childReceipt = runtime.ingress.commitBatch(child, [commentEvent]);
  runtime.tick();
  const batches = runtime.store.all('SELECT batch_json FROM feedback_batches').map(row => JSON.parse(row.batch_json));
  const batch = batches.find(item => item.candidateEventIds.includes(childReceipt.refs[0].eventId));
  assert.ok(batch, 'comment must still enter the model candidate queue');
  assert.ok(batch.contextEventIds.includes(parentReceipt.refs[0].eventId), 'parent review belongs in M3 context');
  assert.ok(!batch.candidateEventIds.includes(parentReceipt.refs[0].eventId), 'parent review is not new comment evidence');
  // An unrelated Steam comment Source cannot inherit the first Source's
  // previously flushed context, even if the native review ID happens to match.
  const foreign = { ...child, sourceId: 'review-comments-other-app', sourceUri: 'urn:steam:review-comments-other-app' };
  runtime.ingress.registerSource(foreign);
  const bad = structuredClone(commentEvent); bad.id += ':wrong-app'; bad.source = foreign.sourceUri;
  bad.data.sourceId = foreign.sourceId;
  bad.data.object.externalId += ':other'; bad.data.object.revision = 'x2';
  bad.data.attributes.appId = 999;
  const badReceipt = runtime.ingress.commitBatch(foreign, [bad]);
  runtime.tick();
  const other = runtime.store.all('SELECT batch_json FROM feedback_batches').map(row => JSON.parse(row.batch_json))
    .find(item => item.candidateEventIds.includes(badReceipt.refs[0].eventId));
  assert.ok(other);
  assert.ok(!other.contextEventIds.includes(parentReceipt.refs[0].eventId), 'wrong-app parent must not cross-link');
});
