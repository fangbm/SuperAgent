import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../../scripts/application.mjs';
import { parseApplicationConfig } from '../../scripts/application-config.mjs';
import { appFixture,material,eventually } from './application-helpers.mjs';
import { modelServer,fixtureAnswer } from './m3-helpers.mjs';
import { OperatorAuth,TokenService,ControlPlane } from '@superagent/control-plane';
import { ReportService } from '@superagent/reporting';
import { HybridMemory } from '@superagent/memory';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const critical='Windows 1.2.0 更新后存档永久丢失，无法恢复。';
const stop=()=>new AbortController().signal;
function register(app,f){const entry=f.config.sources[0];app.runtime.ingress.registerSource({projectId:f.config.projectId,sourceId:entry.id,sourceUri:entry.config.sourceUri,platform:entry.plugin});return (id,text)=>{const e=material(entry,f.config.projectId,id);e.data.content.text=text;return app.runtime.ingress.commitBatch({projectId:f.config.projectId,sourceId:entry.id},[e]);};}
async function base(t){
  const f=appFixture(t);let now='2026-11-02T00:00:00.000Z';
  const server=await modelServer({after:f.after},task=>{
    if(task.task==='assess_p0')return{verdict:'confirmed',impact:'irreversible_save_loss',rationale:'两条原文均核实不可恢复存档损失',evidence:task.evidence.map(e=>({eventId:e.eventId,quote:e.quote}))};
    const answer=fixtureAnswer(task);if(task.task==='extract'&&task.messages[0].text.includes('存档')){answer.items[0].title='存档永久丢失';answer.items[0].description=critical;answer.items[0].observedBehavior=critical;}return answer;
  });
  f.config.analysis={enabled:true,allowExternalCalls:true,baseURL:server.baseURL,model:'fixture-model',allowLoopbackHTTP:true};
  return {...f,server,clock:()=>now,setTime:v=>now=v};
}
test('unified entry P0 runs Archive→M3→confirmed incident→blocked local delivery and Web without external credentials',async t=>{
  const f=await base(t);f.config.notifications.p0Enabled=true;f.config.web={enabled:true,port:0};
  const app=await createApplication(f.config,{policy:f.policy,access:f.access,clock:f.clock,env:{}});f.after(()=>app.close());const add=register(app,f);
  add('p0-a',critical);await app.tick();add('p0-b',critical);await app.tick();
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,2);assert.equal(app.runtime.store.get('SELECT count(*) n FROM p0_alerts').n,1);
  assert.equal(app.runtime.store.get('SELECT status FROM p0_alert_deliveries').status,'blocked');assert.equal(app.status().p0,'enabled');
  await app.start();const origin=`http://127.0.0.1:${app.status().webPort}`;
  const r=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessKey:f.access.accessKey})});const cookie=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');await r.body.cancel();
  const alerts=await fetch(`${origin}/api/p0?project=${f.config.projectId}`,{headers:{Cookie:cookie}});assert.equal(alerts.status,200);const data=await alerts.json();assert.equal(data.alerts.length,1);assert.equal(data.alerts[0].delivery_status,'blocked');
  const denied=await fetch(`${origin}/api/p0?project=unauthorized`,{headers:{Cookie:cookie}});assert.equal(denied.status,403);await denied.body.cancel();
  const csrf=await fetch(`${origin}/api/p0/actions?project=${f.config.projectId}`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);await csrf.body.cancel();
  const {window,document}=parseHTML(await (await fetch(origin)).text());document.cookie=cookie;
  runInNewContext(await (await fetch(origin+'/app.js')).text(),{document,Node:window.Node,Intl,crypto:webcrypto,setTimeout:()=>0,fetch:(url,options={})=>fetch(new URL(url,origin),{...options,headers:{...options.headers,Origin:origin,Cookie:cookie}})});
  await eventually(()=>document.querySelector('.nav'));
  [...document.querySelectorAll('.nav button')].find(b=>b.textContent.includes('P0 告警')).click();
  assert.match(document.querySelector('.main').textContent,/未获发送权限/);assert.match(document.querySelector('.main').textContent,/P0_DELIVERY_NOT_CONFIGURED/);
  [...document.querySelectorAll('.main button')].find(b=>b.textContent==='存档永久丢失').click();
  await eventually(()=>document.querySelector('textarea[aria-label="P0 确认理由"]'));
  assert.equal([...document.querySelectorAll('.main button')].filter(b=>b.textContent==='确认 P0').length,1);
});
test('urgent analysis bypasses a hung normal model and 60-second quiet buffer through existing high-priority jobs',async t=>{
  const f=await base(t);f.config.notifications.p0Enabled=true;
  // Keep normal-size batching; advance only the existing five-second urgent deadline.
  const policy={...f.policy,maxCandidateMessages:80,quietWindowMs:60000,maxWaitMs:120000,urgentMaxDelayMs:5000};
  let blocked=false,release;
  const model={modelId:'urgent-fixture',generate:async request=>{
    const task=JSON.parse(request.prompt);
    if(task.task==='extract'&&task.messages.some(m=>m.text==='普通联机错误')){blocked=true;await new Promise(resolve=>{release=resolve;});}
    return{modelId:'urgent-fixture',usage:{inputTokens:1,outputTokens:1},value:fixtureAnswer(task)};
  }};
  const app=await createApplication(f.config,{model,policy,access:f.access,clock:f.clock});f.after(()=>app.close());const add=register(app,f);
  add('normal','普通联机错误');app.runtime.tick();for(const s of app.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))app.runtime.buffer.flushSync(s.segment_id,'replay');
  const normal=app.m3.analysis.tick(stop());f.after(async()=>{release?.();await normal;});await eventually(()=>blocked);
  add('urgent',critical);app.runtime.tick();assert.equal(app.runtime.store.get('SELECT count(*) n FROM triage_extractions').n,0);
  f.setTime('2026-11-02T00:00:05.001Z');app.runtime.tick();
  assert.equal((await app.m3.urgent.tick(stop())).status,'succeeded');assert.equal(app.runtime.store.get('SELECT count(*) n FROM triage_extractions').n,1);
  assert.ok(app.runtime.store.get("SELECT 1 FROM jobs WHERE priority=100 AND status='completed'"));
});
test('Embedding config is explicit, validates permissions and resolves separate provider env references',async t=>{
  const f=appFixture(t);
  assert.equal(parseApplicationConfig(f.config).embeddings.enabled,false);
  assert.throws(()=>parseApplicationConfig({...f.config,embeddings:{enabled:true,allowExternalCalls:false,baseURL:'https://example.invalid',model:'e'}}),/INVALID_EMBEDDING/);
  assert.throws(()=>parseApplicationConfig({...f.config,notifications:{p0Enabled:true}}),/P0_ANALYSIS_REQUIRED/);
  f.config.embeddings={enabled:true,allowExternalCalls:true,baseURLEnv:'EMBED_URL',modelEnv:'EMBED_MODEL',apiKeyEnv:'EMBED_KEY'};
  await assert.rejects(createApplication(f.config,{env:{},access:f.access}),/APPLICATION_SECRET_MISSING/);
  await assert.rejects(createApplication(f.config,{env:{EMBED_URL:'http://remote.invalid',EMBED_MODEL:'vector',EMBED_KEY:'fixture'},access:f.access}),/PROVIDER_REQUIRES_HTTPS/);
  const app=await createApplication({...f.config,embeddings:{enabled:false,allowExternalCalls:false}},{env:{SA_EMBED_BASE_URL:'https://unused.invalid'},access:f.access});f.after(()=>app.close());assert.equal(app.status().embeddings.state,'disabled');
});
test('unified Embedding HTTP indexes new work and hybrid queries; changed text/model cannot use stale vectors',async t=>{
  const f=await base(t),requests=[];
  const server=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const wire=JSON.parse(body);requests.push({path:req.url,authorization:req.headers.authorization,wire});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,2,3]}))}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');f.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  f.config.embeddings={enabled:true,allowExternalCalls:true,baseURLEnv:'EMBED_URL',modelEnv:'EMBED_MODEL',apiKeyEnv:'EMBED_KEY',allowLoopbackHTTP:true,batchSize:2,timeoutMs:500};
  const app=await createApplication(f.config,{policy:f.policy,access:f.access,clock:f.clock,env:{EMBED_URL:`http://127.0.0.1:${server.address().port}/v1`,EMBED_MODEL:'embed-v1',EMBED_KEY:'embedding-only-fixture'}});f.after(()=>app.close());
  register(app,f)('embedding-work','联机加载崩溃');await app.tick();assert.equal(app.runtime.store.get("SELECT count(*) n FROM embedding_outbox WHERE state='completed'").n,1);
  assert.equal(app.m5.control.metrics(app.m5.auth.principal('web-developer'),f.config.projectId).embeddings.state,'available');
  const found=await app.memory.search(f.config.projectId,'defect','unrelated query');assert.equal(found.mode,'hybrid');assert.equal(found.items.length,1);
  assert.ok(requests.every(r=>r.path==='/v1/embeddings'&&r.authorization==='Bearer embedding-only-fixture'&&r.wire.model==='embed-v1'));
  const work=found.items[0];app.memory.index({...work,title:'Changed',summary:'new text'});
  const stale=await app.memory.search(f.config.projectId,'defect','unrelated query');assert.equal(stale.items.length,0);
  await app.memory.drainEmbeddings(stop());assert.equal((await app.memory.search(f.config.projectId,'defect','unrelated query')).items.length,1);
  const another=new HybridMemory(app.runtime.store,{modelId:'embed-v2',embed:async texts=>texts.map(()=>[1,2,3])});assert.equal((await another.search(f.config.projectId,'defect','unrelated query')).items.length,0);
});
test('Embedding outage has cooldown, lexical fallback and never stops managed admission/report loops; shutdown bounds ignored abort',async t=>{
  const f=await base(t);f.config.reports.enabled=true;f.config.embeddings={enabled:true,allowExternalCalls:true,baseURL:'https://fixture.invalid',model:'embed-fixture',timeoutMs:100};
  let calls=0;const app=await createApplication(f.config,{policy:f.policy,access:f.access,clock:f.clock,embeddings:{modelId:'embed-fixture',embed:async()=>{calls++;throw new Error('OUTAGE');}}});f.after(()=>app.close());
  const add=register(app,f);add('outage','联机载入90%时崩溃');await app.tick();assert.equal(calls,1);assert.equal(app.status().embeddings.state,'unavailable');
  const query=await app.memory.search(f.config.projectId,'defect','联机崩溃');assert.equal(query.mode,'lexical');assert.equal(query.items.length,1);assert.equal(calls,1);
  const state=app.m5.control.metrics(app.m5.auth.principal('web-developer'),f.config.projectId).embeddings;assert.equal(state.consecutiveFailures,1);assert.ok(state.retryAt);
  const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});f.setTime('2026-11-02T10:04:00.000Z');add('during-outage','你好');
  await eventually(()=>app.runtime.store.get("SELECT count(*) n FROM event_outbox WHERE status='pending'").n===0&&app.runtime.store.get('SELECT count(*) n FROM report_revisions').n>0);assert.equal(calls,1);
  await app.close();await running;
  const other=appFixture(t);other.config.embeddings=f.config.embeddings;
  const pending=await createApplication(other.config,{policy:other.policy,access:other.access,embeddings:{modelId:'uncooperative',embed:()=>new Promise(()=>{})}});other.after(()=>pending.close());
  const search=pending.memory.search(other.config.projectId,'defect','query');await delay(10);await pending.close();await assert.rejects(search,/EMBEDDING_REQUEST_ABORTED/);
});
test('P0 developer actions require current evidence/version, bound one-use tokens and preserve audit; readers cannot act',async t=>{
  const f=await base(t);f.config.notifications.p0Enabled=true;const app=await createApplication(f.config,{policy:f.policy,access:f.access,clock:f.clock});f.after(()=>app.close());register(app,f)('manual',critical);await app.tick();
  const auth=new OperatorAuth(app.runtime.store,f.clock);auth.register({actorRef:'operator',role:'developer',projects:[f.config.projectId]},'local-developer-key-longer-than-32-characters');auth.register({actorRef:'reader',role:'reader',projects:[f.config.projectId]},'local-reader-key-longer-than-32-characters');
  const control=new ControlPlane(app.runtime.store,app.domain,new ReportService(app.runtime.store,app.domain,app.runtime.queue),auth,new TokenService(app.runtime.store,'local-p0-signing-key-longer-than-32',f.clock),f.clock);control.p0Enabled=true;
  const work=app.domain.getWork(f.config.projectId,'defect',app.runtime.store.get('SELECT issue_id FROM issues').issue_id),request={issueId:work.id,expectedVersion:work.version,action:'confirm',impact:'irreversible_save_loss',reason:'人工核对原文，确认不可恢复丢失'};
  assert.throws(()=>control.p0Token(auth.principal('reader'),f.config.projectId,request),/FORBIDDEN/);
  const developer=auth.principal('operator'),token=control.p0Token(developer,f.config.projectId,request),concurrent=control.p0Token(developer,f.config.projectId,{...request,action:'realert'});assert.equal(control.p0Action(developer,f.config.projectId,token).alerts.length,1);
  assert.throws(()=>control.p0Action(developer,f.config.projectId,concurrent),/WORK_VERSION_CONFLICT/);
  assert.throws(()=>control.p0Action(developer,f.config.projectId,token),/TOKEN_EXPIRED_OR_USED/);
  const changed=control.p0Token(developer,f.config.projectId,{...request,action:'realert'});app.runtime.store.run("UPDATE work_metadata SET review_required=1");
  // Domain snapshots, rather than untrusted caller fields, govern the action.
  const current=app.domain.getWork(f.config.projectId,'defect',work.id);app.memory.index(current);
  app.runtime.store.run("UPDATE work_metadata SET content_json=json_set(content_json,'$.version',99)");
  assert.throws(()=>control.p0Action(developer,f.config.projectId,changed),/WORK_VERSION_CONFLICT/);
  assert.ok(app.runtime.store.get("SELECT 1 FROM work_history WHERE action='p0.command'"));
});
