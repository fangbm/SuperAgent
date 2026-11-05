import assert from 'node:assert/strict';
import test from 'node:test';
import {QQSource,parseQQFeedback} from '@superagent/qq-official';
import {fixture,binding,scope,event,count} from './helpers.mjs';
import {qqEvent,qqSecrets,readSecret,signed} from './qq-helpers.mjs';
import {m3Fixture,fixtureAnswer} from './m3-helpers.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {SqliteStore,bundledMigrations,ensureQQFeatures} from '@superagent/persistence';
async function source(t,f,config={}){
  f.runtime.ingress.configureQQFeedback(scope,{enabled:true,...config});
  const calls=[];const plugin=new QQSource({kind:'group',sourceUri:binding.sourceUri,feedbackCommands:{enabled:true,...config},now:()=>Date.parse(f.clock()),api:{fetch:async(url,init)=>{calls.push({url:String(url),method:init?.method??'GET'});if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture',expires_in:7200});if(String(url).endsWith('/users/@me'))return Response.json({id:'bot-authenticated'});throw new Error('UNEXPECTED_PLATFORM_WRITE');}}});
  const host=f.runtime.ingress.sourceHost(scope,{getSecret:readSecret,secretKeys:plugin.manifest.permissions.secretKeys});await plugin.start(host,new AbortController().signal);t.after(()=>plugin.stop());
  return{calls,plugin,receive:async(id,text,data={},type='GROUP_MESSAGE_CREATE')=>plugin.handleWebhook(...signed(qqEvent(id,{text,type,data}),f.clock))};
}
test('QQ explicit parser: exact head, authenticated mention, Unicode whitespace, multiline; no forged/code/quote/body matches',()=>{
  for(const text of ['/bug crash','/BUG\u3000中文\n多行','\u00a0/suggest add reconnect','<@!bot> /bug crash'])assert.ok(parseQQFeedback(text,'bot'));
  for(const text of ['/buggy a','/suggestion a','hello /bug a','```\n/bug a','> /bug quoted','@机器人 /bug a','<@fake> /bug a','<@!fake> /bug a'])assert.equal(parseQQFeedback(text,'bot'),undefined,text);
  assert.equal(parseQQFeedback('/bug').kind,'bug'); // Bare commands are parsed, then safely archived by M1.
});
test('signed full/at observations archive once; explicit candidates isolate from ordinary segments and carry exact original evidence',async t=>{
  const f=fixture(t),s=await source(t,f);await s.receive('normal','普通联机问题，连接出现错误');f.runtime.tick();
  const response=await s.receive('command',' /BUG\u3000加载90%崩溃\nWindows');assert.equal(response.statusCode,200);f.runtime.tick();
  await s.receive('command',' /BUG\u3000加载90%崩溃\nWindows',{},'GROUP_AT_MESSAGE_CREATE');f.runtime.tick();
  assert.equal(count(f.runtime.store,'source_events'),2);assert.equal(count(f.runtime.store,'feedback_batches'),1);
  const batch=JSON.parse(f.runtime.store.get('SELECT batch_json FROM feedback_batches').batch_json);assert.equal(batch.candidateEventIds.length,1);assert.equal(batch.contextEventIds.length,0);
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM conversation_segments WHERE state='open'").n,1);
  assert.equal(f.runtime.store.get('SELECT rationale_code FROM admission_decisions WHERE event_id=?',batch.candidateEventIds[0]).rationale_code,'QQ_EXPLICIT_IMMEDIATE');
  assert.equal(f.runtime.store.get("SELECT priority FROM jobs WHERE kind='feedback.batch.triage'").priority,50);
  assert.match(JSON.parse(f.runtime.store.get('SELECT payload_json FROM source_events WHERE event_id=?',batch.candidateEventIds[0]).payload_json).data.content.text,/^ \/BUG/);
  assert.ok(s.calls.every(c=>c.method==='GET'||c.url.endsWith('/app/getAppAccessToken')));
});
test('full and mention command renderings/rotating CDN links preserve first immutable archive, while changed body/author still conflicts',async t=>{
  const f=fixture(t),s=await source(t,f),attachment=url=>({attachments:[{content_type:'image/png',filename:'a.png',url}]});
  await s.receive('variants','<@!bot-authenticated> /bug crash',attachment('https://cdn.example/a?rkey=first'));const original=f.runtime.store.get('SELECT payload_json FROM source_events').payload_json;
  assert.equal((await s.receive('variants',' /bug crash ',attachment('https://cdn.example/a?rkey=second'),'GROUP_AT_MESSAGE_CREATE')).statusCode,200);f.runtime.tick();assert.equal(count(f.runtime.store,'source_events'),1);assert.equal(count(f.runtime.store,'feedback_batches'),1);assert.equal(f.runtime.store.get('SELECT payload_json FROM source_events').payload_json,original);
  assert.equal((await s.receive('variants','/bug different',attachment('https://cdn.example/a?rkey=third'))).statusCode,503);
  assert.equal((await s.receive('variants','/bug crash',{...attachment('https://cdn.example/a'),author:{member_openid:'other-player'}})).statusCode,503);
});
test('later authenticated @ observation promotes an unsealed candidate atomically but never reanalyzes sealed feedback',async t=>{
  for(const seal of [false,true])await t.test(seal?'already sealed':'unsealed promotion',async t=>{
    const f=fixture(t),s=await source(t,f);await s.receive('ordinary','普通崩溃反馈');await s.receive('late','<@platform-group-bot-alias> /bug crash');f.runtime.tick();
    if(seal)for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
    const original=f.runtime.store.get("SELECT payload_json FROM source_events ORDER BY rowid DESC LIMIT 1").payload_json;
    assert.equal((await s.receive('late',' /bug crash ',{},'GROUP_AT_MESSAGE_CREATE')).statusCode,200);f.runtime.tick();
    assert.equal(count(f.runtime.store,'source_events'),2);assert.equal(f.runtime.store.get('SELECT payload_json FROM source_events ORDER BY rowid DESC LIMIT 1').payload_json,original);
    if(seal){assert.equal(count(f.runtime.store,'feedback_batches'),1);assert.equal(f.runtime.store.get('SELECT outcome FROM qq_explicit_feedback').outcome,'QQ_EXPLICIT_ALREADY_BATCHED');}
    else{const batch=JSON.parse(f.runtime.store.get('SELECT batch_json FROM feedback_batches').batch_json);assert.equal(batch.candidateEventIds.length,1);assert.equal(f.runtime.store.get("SELECT candidate_count FROM conversation_segments WHERE state='open'").candidate_count,1);}
  });
});
test('bare commands archive with a reason and no batch/model task; attachment-only commands remain candidates without sensitive CDN URLs',async t=>{
  const f=fixture(t),s=await source(t,f);await s.receive('empty','/bug');await s.receive('empty2','/suggest\u3000');await s.receive('image','/bug',{attachments:[{content_type:'image/png',url:'https://cdn.example/private?token=SECRET',auth_token:'SECRET'}]});f.runtime.tick();
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM admission_decisions WHERE rationale_code='QQ_EXPLICIT_EMPTY'").n,2);assert.equal(count(f.runtime.store,'feedback_batches'),1);
  const rows=f.runtime.store.all('SELECT payload_json FROM source_events');assert.ok(rows.every(r=>!r.payload_json.includes('SECRET')));
});
test('authenticated bot mention is recognized, fake @ text and other source forged attributes do not gain priority',async t=>{
  const f=fixture(t),s=await source(t,f);await s.receive('at','<@!bot-authenticated> /bug crash');await s.receive('fake','<@wrong> /bug crash');f.runtime.tick();assert.equal(count(f.runtime.store,'qq_explicit_feedback'),1);
  const other={projectId:binding.projectId,sourceId:'steam',sourceUri:'urn:test:steam',platform:'steam-reviews'};f.runtime.ingress.registerSource(other);
  assert.throws(()=>f.runtime.ingress.configureQQFeedback(other,{enabled:true}),/QQ_FEEDBACK_SOURCE_REQUIRED/);
  const forged=event('forged',{text:'/bug crash'});forged.source=other.sourceUri;Object.assign(forged.data,{sourceId:other.sourceId,platform:other.platform,attributes:{qqScope:'group',qqFeedbackCommand:{version:1,kind:'bug',command:'/bug',start:5,end:10}}});f.runtime.ingress.commitBatch(other,[forged]);f.runtime.tick();assert.equal(count(f.runtime.store,'qq_explicit_feedback'),1);
});
test('reply context is same project/source/group, bounded and never an independent explicit candidate',async t=>{
  const f=fixture(t),s=await source(t,f);await s.receive('parent','联机崩溃',{message_scene:{ext:['msg_idx=parent-index']}});f.runtime.tick();
  await s.receive('reply','/bug',{message_scene:{ext:['msg_idx=reply-index','ref_msg_idx=parent-index']}});f.runtime.tick();
  const batch=JSON.parse(f.runtime.store.get('SELECT batch_json FROM feedback_batches').batch_json);assert.equal(batch.candidateEventIds.length,1);assert.equal(batch.contextEventIds.length,1);assert.notEqual(batch.candidateEventIds[0],batch.contextEventIds[0]);
  await s.receive('missing','/bug',{message_scene:{ext:['msg_idx=missing-index','ref_msg_idx=absent']}});f.runtime.tick();assert.equal(f.runtime.store.get("SELECT count(*) n FROM admission_decisions WHERE rationale_code='QQ_EXPLICIT_EMPTY'").n,1);
});
test('user/group/project rate limits survive process-local reopen; different players are not text-deduplicated',async t=>{
  for(const level of ['User','Group','Project'])await t.test(level,async t=>{
    const f=fixture(t),s=await source(t,f,{[`per${level}RateLimit`]:1});await s.receive('first','/bug same crash');f.runtime.tick();
    await s.receive('second','/bug same crash',level==='User'?{}:{author:{member_openid:'another-player'}});f.runtime.tick();
    assert.equal(count(f.runtime.store,'source_events'),2);assert.equal(count(f.runtime.store,'feedback_batches'),1);assert.equal(f.runtime.store.get("SELECT outcome FROM qq_explicit_feedback ORDER BY rowid DESC LIMIT 1").outcome,`QQ_EXPLICIT_RATE_${level.toUpperCase()}`);
    const reopened=f.open();assert.equal(reopened.store.get('SELECT count(*) n FROM qq_feedback_rate').n,3);f.advance(60000);await s.receive('third','/bug same crash');f.runtime.tick();assert.equal(count(f.runtime.store,'feedback_batches'),2);
  });
});
test('archive/admission/batch/queue fault boundaries recover atomically without duplicate fast batches',async t=>{
  const f=fixture(t),s=await source(t,f);await s.receive('one','/bug crash');assert.equal(count(f.runtime.store,'qq_explicit_feedback'),1);assert.equal(count(f.runtime.store,'admission_decisions'),0);
  const original=f.runtime.queue.create.bind(f.runtime.queue);let fail=true;f.runtime.queue.create=(...args)=>{if(fail&&args[1]==='feedback.batch.triage')throw new Error('INJECTED_QUEUE_FAILURE');return original(...args);};
  f.runtime.tick();assert.equal(count(f.runtime.store,'feedback_batches'),0);assert.equal(count(f.runtime.store,'admission_decisions'),0);assert.equal(count(f.runtime.store,'qq_feedback_rate'),0);
  fail=false;f.advance(2000);f.runtime.tick();f.runtime.tick();assert.equal(count(f.runtime.store,'feedback_batches'),1);assert.equal(count(f.runtime.store,'admission_decisions'),1);
  const reopened=f.open();reopened.tick();assert.equal(count(reopened.store,'feedback_batches'),1);
});
test('M3 may correct explicit kind or return zero items; projection quotes verify against immutable originals; historical matching remains',async t=>{
  const prompts=[];const f=await m3Fixture(t,{responder:task=>{prompts.push(task);const answer=fixtureAnswer(task);if(task.task==='extract'&&task.messages[0].text.includes('哈哈哈'))return{...answer,items:[],nonActionableReason:'not_feedback'};return answer;}}),s=await source(t,f);
  await s.receive('one','/suggest Windows 1.2.0 联机载入90%时崩溃');f.runtime.tick();await f.worker.tick();
  const extraction=prompts.find(p=>p.task==='extract');assert.equal(extraction.messages[0].explicitIntent,'suggestion');assert.ok(!extraction.messages[0].text.startsWith('/suggest'));assert.match(extraction.messages[0].originalText,/^\/suggest/);assert.equal(count(f.runtime.store,'issues'),1);
  await s.receive('two','/bug Windows 1.2.0 联机载入90%时崩溃',{author:{member_openid:'different-player'}});f.runtime.tick();await f.worker.tick();assert.equal(count(f.runtime.store,'issues'),1);assert.ok(prompts.some(p=>p.task==='match_bug'));
  assert.equal(JSON.parse(f.runtime.store.get("SELECT content_json FROM work_metadata WHERE work_kind='defect'").content_json).feedbackCount,2);
  await s.receive('none','/bug 哈哈哈');f.runtime.tick();await f.worker.tick();assert.equal(count(f.runtime.store,'issues'),1);
});
test('QQ native message index unifies transport IDs but separates reused message IDs and quoted commands stay context only',async t=>{
  const f=fixture(t),s=await source(t,f),scene=index=>({message_scene:{ext:[`msg_idx=${index}`]}});
  await s.receive('transport-one','/bug same',scene('index-1'));await s.receive('transport-two','/bug same',scene('index-1'),'GROUP_AT_MESSAGE_CREATE');
  await s.receive('transport-one','/bug same',{...scene('index-2'),author:{member_openid:'different-player'}});
  await s.receive('quoted',' ',{...scene('quote'),message_type:103,msg_elements:[{content:'/bug this is only quoted'}]});f.runtime.tick();
  assert.equal(count(f.runtime.store,'source_events'),3);assert.equal(count(f.runtime.store,'qq_explicit_feedback'),2);assert.equal(count(f.runtime.store,'feedback_batches'),2);
});
test('durable weighted priority gives ordinary analysis a slot after three explicit jobs, including after reopen',t=>{
  const f=fixture(t),q=f.runtime.queue;for(let n=0;n<5;n++)q.create(binding.projectId,'feedback.batch.triage',{batchId:String(n)},`high-${n}`,50);q.create(binding.projectId,'feedback.batch.triage',{batchId:'ordinary'},'ordinary',0);
  for(let n=0;n<3;n++){const j=q.claim('worker','full_agent',30000,undefined,true);assert.notEqual(j.payload.batchId,'ordinary');q.complete(j.jobId,j.leaseToken);}
  const reopened=f.open(),next=reopened.queue.claim('worker','full_agent',30000,undefined,true);assert.equal(next.payload.batchId,'ordinary');
});
test('actual SIGKILL preserves explicit archive and reclaims admission/batch/queued/running states exactly once',async t=>{
  for(const stage of ['archive','admission','batch','queued','worker'])await t.test(stage,async t=>{
    const f=await m3Fixture(t),child=spawn(process.execPath,[fileURLToPath(new URL('./qq-explicit-crash-child.mjs',import.meta.url)),f.filename,stage],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stderr='';child.stderr.on('data',d=>stderr+=d);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    const exited=once(child,'exit');let timer;
    try{await Promise.race([new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(String(d).includes('READY')){child.kill('SIGKILL');resolve();}});exited.then(([code,signal])=>signal||code!==0?resolve():reject(new Error('CHILD_EXITED_EARLY '+stderr)));}),new Promise((_,reject)=>timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CHILD_TIMEOUT '+stderr));},10000))]);await exited;}finally{clearTimeout(timer);}
    assert.equal(count(f.runtime.store,'source_events'),1);f.advance(61000);f.runtime.tick();assert.equal(count(f.runtime.store,'feedback_batches'),1);
    await f.worker.tick();assert.equal(count(f.runtime.store,'issues'),1);assert.equal(f.runtime.store.get('SELECT feedbackCount FROM (SELECT json_extract(content_json,\'$.feedbackCount\') feedbackCount FROM work_metadata WHERE work_kind=\'defect\')').feedbackCount,1);f.runtime.tick();await f.worker.tick();assert.equal(count(f.runtime.store,'feedback_batches'),1);
  });
});
test('explicit model-call budget includes ordinary project calls and never pretends blocked analysis completed',async t=>{
  const f=await m3Fixture(t),s=await source(t,f,{maxModelCallsPerWindow:1});
  await s.receive('one','/bug Windows 1.2.0 联机载入90%时崩溃');f.runtime.tick();await f.worker.tick();assert.equal(count(f.runtime.store,'model_calls'),1);
  await s.receive('two','/bug Windows 1.2.0 联机载入90%时崩溃');f.runtime.tick();assert.equal((await f.worker.tick()).status,'QQ_EXPLICIT_MODEL_BUDGET');assert.equal(count(f.runtime.store,'model_calls'),1);assert.equal(f.runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage' ORDER BY rowid DESC LIMIT 1").status,'retry_wait');
});
test('explicit LLM HTTP 429 and timeouts use existing durable retry/dead-letter semantics without duplicate batches',async t=>{
  for(const mode of ['429','timeout'])await t.test(mode,async t=>{
    const f=await m3Fixture(t,{responder:async task=>{if(mode==='429')return{httpStatus:429};await delay(100);return fixtureAnswer(task);},workerOptions:{timeoutMs:20,leaseMs:1100}}),s=await source(t,f);
    await s.receive('bad-model','/bug 崩溃问题');f.runtime.tick();
    for(let n=0;n<3;n++){await f.worker.tick();f.advance(5000);}
    assert.equal(f.runtime.store.get("SELECT status FROM jobs WHERE kind='feedback.batch.triage'").status,'dead_letter');assert.equal(count(f.runtime.store,'feedback_batches'),1);assert.equal(count(f.runtime.store,'issues'),0);assert.equal(count(f.runtime.store,'source_events'),1);
  });
});
test('bug command may become only a suggestion and fabricated evidence cannot create work',async t=>{
  for(const bad of [false,true])await t.test(bad?'invalid quote':'corrected kind',async t=>{
    const f=await m3Fixture(t,{responder:task=>{const answer=fixtureAnswer(task);return{...answer,items:[{kind:'suggestion',category:'feature_request',title:'增加多人模式',description:'希望加入多人模式',requestedOutcome:'加入多人模式',confidence:0.9,evidence:answer.items[0].evidence.map(e=>({...e,...(bad?{quote:'不存在的原文'}:{})}))}]};}}),s=await source(t,f);
    await s.receive('kind','/bug 希望加入多人模式');f.runtime.tick();await f.worker.tick();assert.equal(count(f.runtime.store,'issues'),0);assert.equal(count(f.runtime.store,'suggestions'),bad?0:1);
  });
});
test('QQ feature migrations are idempotent and coexist with a later main migration without rewriting either ledger',t=>{
  const f=fixture(t),prefix=f.runtime.store.all('SELECT * FROM schema_migrations ORDER BY name');
  const store=new SqliteStore(f.filename,{migrations:[...bundledMigrations(),{name:'013_parallel_feature.sql',sql:'CREATE TABLE parallel_013_fixture(id TEXT PRIMARY KEY);'}]});
  try{ensureQQFeatures(store);ensureQQFeatures(store);assert.deepEqual(store.all('SELECT * FROM schema_migrations ORDER BY name').slice(0,prefix.length),prefix);assert.equal(store.get('SELECT count(*) n FROM qq_feature_migrations').n,2);assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE name='parallel_013_fixture'"));}finally{store.close();}
});
