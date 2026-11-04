import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync,readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { QQSource,QQC2CDelivery } from '@superagent/qq-official';
import { createApplication } from '../../scripts/application.mjs';
import { appFixture,eventually } from './application-helpers.mjs';
import { material,sourceDouble } from './application-helpers.mjs';
import { modelServer,fixtureAnswer,FixtureGitHub } from './m3-helpers.mjs';
import { qqSecrets,qqEvent,signed } from './qq-helpers.mjs';

const text='Windows 1.2.0 联机载入90%时崩溃';
class Socket extends EventTarget {
  readyState=1;
  constructor(){super();queueMicrotask(()=>this.receive({op:10,d:{heartbeat_interval:10000}}));}
  receive(p){if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(p)}));}
  send(raw){const p=JSON.parse(raw);if(p.op===2)this.receive({op:0,t:'READY',s:1,d:{session_id:'unified-fixture-session',resume_gateway_url:'wss://gateway.discord.gg/'}});if(p.op===1)this.receive({op:11});}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.defineProperty(e,'code',{value:code});queueMicrotask(()=>this.dispatchEvent(e));}
}
function discordFetch(){return async url=>{
  const p=new URL(url).pathname;
  if(p.endsWith('/oauth2/applications/@me'))return Response.json({flags:1<<19});
  if(p.endsWith('/users/@me'))return Response.json({id:'999'});
  if(p.endsWith('/members/999'))return Response.json({user:{id:'999'},roles:[]});
  if(p.endsWith('/roles'))return Response.json([{id:'100',permissions:'66560'}]);
  if(p.endsWith('/channels/200'))return Response.json({id:'200',guild_id:'100',type:0,permission_overwrites:[]});
  if(p.endsWith('/messages'))return Response.json([{id:'100000000001',channel_id:'200',guild_id:'100',content:text,timestamp:'2026-11-02T00:00:00.000Z',author:{id:'123',bot:false},attachments:[]}]);
  if(p.endsWith('/gateway/bot'))return Response.json({url:'wss://gateway.discord.gg/'});
  throw new Error('UNEXPECTED_FIXTURE_ROUTE');
};}
async function integrated(t,{unknownGitHub=false,unknownDelivery=false}={}) {
  const f=appFixture(t);let now='2026-11-02T00:00:00.000Z';const clock=()=>now;
  const server=await modelServer({after:f.after},(task,...args)=>{assert.ok(app.runtime.store.get('SELECT count(*) n FROM source_events').n>=1,'archive precedes model');return fixtureAnswer(task,...args);});
  f.config.analysis={enabled:true,allowExternalCalls:true,baseURL:server.baseURL,model:'fixture-model',allowLoopbackHTTP:true};
  f.config.github={enabled:true,allowWrites:true,repository:'owner/private-test',tokenEnv:'FIXTURE_GITHUB_TOKEN'};
  f.config.reports.enabled=true;f.config.web={enabled:true,port:0};f.config.runtime.stopTimeoutMs=2000;f.config.runtime.probeIntervalMs=50;
  for(const entry of f.config.sources)entry.enabled=true;
  const qq=f.config.sources[0];qq.config.transport='webhook';qq.port=0;
  const discussions=f.config.sources[3];discussions.config.mode='snapshot';discussions.config.snapshotPath=f.directory+'/discussions.json';
  writeFileSync(discussions.config.snapshotPath,JSON.stringify({schemaVersion:'1.0',appId:570,records:[]}));
  const delivery=f.config.deliveries[0];delivery.enabled=true;delivery.allowWrites=true;
  const secrets={...qqSecrets,QQ_OPERATOR_OPENID:qqSecrets.QQ_RECIPIENT_OPENID};
  const env={FIXTURE_GITHUB_TOKEN:'fixture-only',SA_DISCORD_BOT_TOKEN:'fixture-discord'};
  for(const entry of [qq,delivery])for(const [key,name] of Object.entries(entry.secrets))env[name]=secrets[key];
  const remote=new FixtureGitHub();if(unknownGitHub)remote.issueMode='timeout';
  let sends=0;
  const api=async url=>{
    const p=new URL(url).pathname;
    if(p.endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-only',expires_in:7200});
    if(p.endsWith('/messages')){sends++;if(unknownDelivery)throw new Error('SIMULATED_TRANSPORT_LOSS');return Response.json({id:'fixture-send-'+sends,timestamp:clock()});}
    return Response.json({id:'fixture-bot'});
  };
  const review=JSON.parse(readFileSync(new URL('../fixtures/m4/steam-review.json',import.meta.url),'utf8'));review.review=text;
  const sources={
    'qq-official':c=>new QQSource({...c,now:()=>Date.parse(clock()),api:{fetch:api}}),
    discord:c=>new DiscordConnector(c,{fetch:discordFetch(),webSocket:()=>new Socket()}),
    'steam-reviews':c=>new SteamReviewsConnector(c,{fetch:async url=>{const cursor=JSON.parse(url.searchParams.get('input_json')).cursor;return Response.json({response:{reviews:cursor==='*'?[review]:[],cursor:'end'}});}}),
    // Steam Discussions intentionally uses its real local snapshot implementation.
  };
  const options={access:f.access,policy:f.policy,clock,env,github:remote,sourceFactories:sources,deliveryFactory:c=>new QQC2CDelivery({...c,api:{fetch:api}})};
  let app=await createApplication(f.config,options);f.after(()=>app?.close());
  await app.start();await eventually(()=>app.plugins.instances.size===4&&app.plugins.status()['qq-main'].state==='running');
  const payload=qqEvent('unified-real-adapter',{text,type:'GROUP_MESSAGE_CREATE'}),[headers,body]=signed(payload,clock);
  const endpoint=`http://127.0.0.1:${app.status().sourcePorts['qq-main']}/qq/events`;
  for(let i=0;i<2;i++){const r=await fetch(endpoint,{method:'POST',headers,body});assert.equal(r.status,200);await r.body.cancel();}
  await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===3);
  return {...f,server,remote,clock,setTime:v=>now=v,sends:()=>sends,get app(){return app;},async restart(){await app.close();app=await createApplication(f.config,options);await app.start();return app;}};
}

test('single application starts all four real adapters and runs SQLite→M3 cross-platform Bug→GitHub→scheduled report→QQ/Web',async t=>{
  const f=await integrated(t),app=f.app;
  assert.equal(app.m5.runtime,app.runtime);assert.equal(app.m5.domain,app.domain);assert.equal(app.m3.analysis.store,app.runtime.store);
  const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});
  await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM triage_extractions').n===3&&f.remote.posts===1);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM issues').n,1);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM triage_extractions').n,3);
  const issueId=app.runtime.store.get('SELECT issue_id FROM issues').issue_id;
  assert.equal(app.domain.getWork(f.config.projectId,'defect',issueId).feedbackCount,3);
  assert.equal(f.server.requests.filter(r=>r.task.task==='match_bug').length,2);assert.equal(f.remote.posts,1);
  f.setTime('2026-11-02T10:04:00.000Z');await eventually(()=>f.remote.commentPosts===1&&app.runtime.store.get("SELECT 1 FROM report_revisions WHERE window_end='2026-11-02T10:00:00.000Z'")&&app.runtime.store.get("SELECT count(*) n FROM report_delivery_plans WHERE state='pending'").n===0);
  const row=app.runtime.store.get('SELECT * FROM report_revisions WHERE window_end=?','2026-11-02T10:00:00.000Z');
  assert.ok(row);const report=JSON.parse(row.report_json);assert.equal(report.counts.uniqueDefects,1);assert.equal(report.uniqueSourceEventCount,3);assert.equal(report.steamNegativeReviews.length,1);
  assert.ok(f.sends()>=1);assert.equal(f.remote.commentPosts,1);
  const seals=app.runtime.store.all('SELECT * FROM report_revision_seals ORDER BY report_id');
  const posts=f.sends(),modelCalls=f.server.requests.length;
  const origin=`http://127.0.0.1:${app.status().webPort}`;
  const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessKey:f.access.accessKey})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');await login.body.cancel();
  const html=await fetch(`${origin}/api/reports/${row.report_id}/1/content?project=${f.config.projectId}`,{headers:{Cookie:cookie}});assert.equal(html.status,200);assert.match((await html.json()).html,/<h1>/);
  const before=app.runtime.store.all('SELECT event_id,payload_json FROM source_events ORDER BY event_id');
  await app.close();await running;
  const restarted=await f.restart();const again=restarted.run();again.catch(()=>{});f.after(async()=>{await restarted.close();await again;});await eventually(()=>restarted.plugins.instances.size===4);await delay(100);
  assert.equal(f.remote.posts,1);assert.equal(f.sends(),posts);assert.equal(f.server.requests.length,modelCalls);
  assert.deepEqual(restarted.runtime.store.all('SELECT * FROM report_revision_seals ORDER BY report_id'),seals);
  assert.deepEqual(restarted.runtime.store.all('SELECT event_id,payload_json FROM source_events ORDER BY event_id'),before);
  assert.equal(restarted.runtime.store.get('PRAGMA quick_check').quick_check,'ok');
});

test('application restarts preserve unknown GitHub outcome and reconcile instead of creating twice',async t=>{
  const f=await integrated(t,{unknownGitHub:true});for(let i=0;i<5;i++)await f.app.tick();
  assert.equal(f.remote.posts,1);assert.ok(f.app.runtime.store.get("SELECT 1 FROM external_operations WHERE kind='github.issue.create' AND state='unknown'"));
  const app=await f.restart();f.setTime('2026-11-02T00:02:00.000Z');for(let i=0;i<5;i++)await app.tick();
  assert.equal(f.remote.posts,1);assert.equal(app.runtime.store.get("SELECT state FROM external_operations WHERE kind='github.issue.create'").state,'succeeded');
});

test('unknown QQ report delivery is never replayed after restarting the unified application',async t=>{
  const f=await integrated(t,{unknownDelivery:true});for(let i=0;i<5;i++)await f.app.tick();
  assert.equal(f.sends(),1);assert.equal(f.app.runtime.store.get("SELECT state FROM external_operations WHERE kind='qq.c2c.send'").state,'unknown');
  const app=await f.restart();for(let i=0;i<4;i++)await app.tick();assert.equal(f.sends(),1);
  assert.equal(app.runtime.store.get("SELECT state FROM external_operations WHERE kind='qq.c2c.send'").state,'unknown');
});

test('slow M3 model IO does not block M1 admission or fixed-window M5 reports in the managed main loop',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;f.config.reports.enabled=true;let now='2026-11-02T00:00:00.000Z',release;
  const pending=new Promise(resolve=>{release=resolve;});
  const server=await modelServer({after:f.after},async task=>{await pending;return fixtureAnswer(task);});
  f.config.analysis={enabled:true,allowExternalCalls:true,baseURL:server.baseURL,model:'fixture-model',allowLoopbackHTTP:true};
  const app=await createApplication(f.config,{access:f.access,clock:()=>now,policy:f.policy,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:host=>host.commitBatch([material(entry,f.config.projectId)])})}});
  const running=app.run();running.catch(()=>{});f.after(async()=>{release();await app.close();await running;});
  await eventually(()=>server.requests.length===1);now='2026-11-02T10:04:00.000Z';
  await eventually(()=>app.runtime.store.get("SELECT 1 FROM report_revisions WHERE window_end='2026-11-02T10:00:00.000Z'"));
  const report=JSON.parse(app.runtime.store.get("SELECT report_json FROM report_revisions WHERE window_end='2026-11-02T10:00:00.000Z'").report_json);
  assert.equal(app.runtime.store.get("SELECT status FROM model_calls").status,'running');assert.equal(report.counts.pendingAnalysis,1);assert.equal(report.uniqueSourceEventCount,1);
});
