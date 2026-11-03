import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { QQOperatorService } from '@superagent/control-plane';
import { QQC2CDelivery } from '@superagent/qq-official';
import { DurableDeliveryService,deliveryHost,ReportDeliveryCoordinator,QQCardRetirementService } from '@superagent/plugin-host';
import { SqliteStore,addMilliseconds,bundledMigrations } from '@superagent/persistence';
import { m5Fixture } from './m5-helpers.mjs';
import { binding } from './helpers.mjs';
import { readSecret } from './qq-helpers.mjs';

async function setup(t){
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const report=f.generate(),qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});let coordinator,sendUnknown=false,n=0;
  const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',navigationTokens:async r=>qq.navigationTokens(r),messageOptions:async r=>coordinator.messageOptions(r.deliveryId),api:{fetch:async(url)=>{if(String(url).endsWith('/app/getAppAccessToken'))return Response.json({access_token:'fixture-token',expires_in:7200});if(sendUnknown)throw new Error('RESPONSE_LOST');return Response.json({id:`message-${++n}`});}}});
  const delivery=new DurableDeliveryService(f.runtime.store,plugin,deliveryHost(plugin,readSecret),{projectId:binding.projectId,recipientRef:'developer',recipientBindingId:'retire-binding',clock:f.clock,allowWrites:true,authorizeInteraction:r=>coordinator.authorizeReply(r)});coordinator=new ReportDeliveryCoordinator(f.runtime.store,delivery,{getReport:(p,id,r)=>f.reports.getExact(p,id,r),clock:f.clock});
  const send=async (id,command='/bugs',kind='command')=>{qq.receive({interactionId:id,kind,content:command,reply:kind==='button'?{eventId:id}:{messageId:id}});const processed=qq.tick();coordinator.enqueueReplies(binding.projectId,'developer');const row=f.runtime.store.get('SELECT operation_id FROM operator_reply_plans WHERE delivery_id=?',processed.deliveryId);return{operationId:row.operation_id,...await delivery.tick({purpose:'interaction',operationId:row.operation_id})};};
  const change=()=>{const w=f.domain.getWork(binding.projectId,'defect',report.issueIds[0]);f.domain.applyStatusAction(binding.projectId,'defect',w.id,w.status==='open'?'investigate':'fix',w.version,'developer',`state-${w.version}`);};
  const calls=[],options={pluginId:plugin.manifest.id,projectId:binding.projectId,recipientRef:'developer',bindingId:'retire-binding',clock:f.clock,allowWrites:true,authorize:()=>{}};
  const service=(behavior=async()=>({status:'accepted'}),overrides={},store=f.runtime.store)=>new QQCardRetirementService(store,{recallMessage:async id=>{calls.push(id);return behavior(id);}},{...options,...overrides});
  const sendReport=async()=>{coordinator.prepare(binding.projectId,'developer');return delivery.tick({purpose:'report'});};
  return{...f,report,send,sendReport,change,calls,service,unknown:()=>{sendUnknown=true;}};
}

test('every accepted replacement retires the previous owned interaction, including the same work version',async t=>{
  const f=await setup(t);const first=await f.send('first');assert.equal(first.state,'succeeded');const service=f.service();assert.equal((await service.tick()).processed,false);assert.deepEqual(f.calls,[]);
  await f.send('same-version');assert.equal((await service.tick()).state,'succeeded');f.change();const replacement=await f.send('new-state');
  assert.equal((await service.tick()).state,'succeeded');assert.deepEqual(f.calls,['message-1','message-2']);assert.equal((await service.tick()).processed,false);assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_message_retirements WHERE replacement_delivery_id=?',replacement.operationId).n,1);assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_message_retirements WHERE old_delivery_id=?',replacement.operationId).n,0);
});

test('an unknown new-card send leaves the prior visible card untouched',async t=>{
  const f=await setup(t);await f.send('old');f.change();f.unknown();assert.equal((await f.send('uncertain-new')).state,'unknown');assert.equal((await f.service().tick()).processed,false);assert.deepEqual(f.calls,[]);assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_message_retirements').n,0);
});

test('half-day reports remain while repeated queries, suggestions, Steam notices and original pages retire',async t=>{
  const f=await setup(t),service=f.service();assert.equal((await f.sendReport()).state,'succeeded');assert.equal((await service.tick()).processed,false);
  for(const [n,command]of ['/reports','/bugs','/bugs','/suggestions','/steam-negative'].entries()){
    assert.equal((await f.send(`all-${n}`,command)).state,'succeeded');const result=await service.tick();assert.equal(result.processed,n>=2);
  }
  const last=f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans ORDER BY rowid DESC LIMIT 1'),token=JSON.parse(last.message_options_json).buttons.find(b=>b.label==='返回半日报').token;
  assert.equal((await f.send('back-report',token,'button')).state,'succeeded');assert.equal((await service.tick()).state,'succeeded');
  const reportOptions=JSON.parse(f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans ORDER BY rowid DESC LIMIT 1').message_options_json);assert.equal(reportOptions.retainMessage,true);
  await f.send('after-report');assert.equal((await service.tick()).processed,false);
  assert.deepEqual(f.calls,['message-3','message-4','message-5','message-6']);assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_sent_messages').n,8);assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_message_retirements').n,4);
  const firstReport=f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans ORDER BY rowid LIMIT 1');assert.equal(JSON.parse(firstReport.message_options_json).retainMessage,true);
});

test('report protection also blocks a previously prepared recall of a legacy report page',async t=>{
  const f=await setup(t),report=await f.send('legacy-report','/reports');f.runtime.store.run("UPDATE operator_reply_plans SET message_options_json=json_remove(message_options_json,'$.retainMessage') WHERE operation_id=?",report.operationId);await f.send('replacement');const service=f.service();service.prepare();assert.equal(f.runtime.store.get('SELECT count(*) n FROM qq_message_retirements').n,0);
  const newer=f.runtime.store.get('SELECT operation_id FROM qq_sent_messages WHERE operation_id<>?',report.operationId);
  f.runtime.store.run("INSERT INTO qq_message_retirements VALUES('old-policy-prepared',?,?,'prepared',0,?,NULL,NULL,NULL,?,?)",report.operationId,newer.operation_id,addMilliseconds(f.clock(),120_000),f.clock(),f.clock());
  assert.equal((await service.tick()).processed,false);assert.deepEqual(f.calls,[]);assert.equal(f.runtime.store.get('SELECT state FROM qq_message_retirements').state,'blocked');assert.equal(f.runtime.store.get('SELECT last_error FROM qq_message_retirements').last_error,'QQ_REPORT_RETAINED');
});

test('migration to all interactions preserves prior successful and unknown recall attempts without replay',async t=>{
  const f=await setup(t);
  for(const state of ['succeeded','unknown']){
    const filename=path.join(f.directory,`old-${state}.sqlite`),migrations=bundledMigrations();let db=new SqliteStore(filename,{migrations:migrations.slice(0,10)});
    db.run("INSERT INTO projects(project_id) VALUES(?)",binding.projectId);db.run("INSERT INTO plugin_delivery_bindings VALUES('qq-official-c2c-delivery',?,'developer','retire-binding')",binding.projectId);
    for(const [index,id]of ['old','new'].entries()){
      db.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,attempt,provider_object_id,created_at,updated_at) VALUES(?,'qq.c2c.send','developer',?,'fixture-hash','succeeded',1,?,?,?)",id,id,`message-${id}`,f.clock(),f.clock());
      db.run("INSERT INTO plugin_delivery_requests VALUES(?,'qq-official-c2c-delivery',?,'developer','interaction','{}',?,?)",id,binding.projectId,JSON.stringify({status:'accepted',providerMessageId:`message-${id}`}),f.clock());
      db.run("INSERT INTO qq_sent_cards VALUES(?,'qq-official-c2c-delivery',?,'developer','retire-binding','defect','fixture-work',?,?,?)",id,binding.projectId,index+1,`message-${id}`,f.clock());
    }
    db.run('INSERT INTO qq_card_retirements VALUES(?,?,?,?,1,?,NULL,NULL,NULL,?,?)','legacy-recall','old','new',state,addMilliseconds(f.clock(),120_000),f.clock(),f.clock());const prior=db.all('SELECT * FROM external_operations');db.close();
    db=new SqliteStore(filename);try{assert.equal((await f.service(undefined,{},db).tick()).processed,false);assert.equal(db.get('SELECT state FROM qq_message_retirements').state,state);assert.equal(db.get('SELECT attempt FROM qq_message_retirements').attempt,1);assert.deepEqual(db.all('SELECT * FROM external_operations'),prior);assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);}finally{db.close();}
  }
  assert.deepEqual(f.calls,[]);
});

test('the documented two-minute window prevents a late DELETE',async t=>{
  const f=await setup(t);await f.send('old');f.advance(120_001);f.change();await f.send('late-new');assert.equal((await f.service().tick()).processed,false);assert.deepEqual(f.calls,[]);assert.equal(f.runtime.store.get('SELECT state FROM qq_message_retirements').state,'expired');
});

test('unknown recall outcomes survive restart without issuing another DELETE',async t=>{
  const f=await setup(t);await f.send('old');f.change();await f.send('new');assert.equal((await f.service(async()=>({status:'unknown',errorCode:'LOST_RESPONSE'})).tick()).state,'unknown');assert.equal(f.calls.length,1);
  const reopened=new SqliteStore(path.join(f.directory,'state.sqlite'));
  try{assert.equal((await f.service(undefined,{},reopened).tick()).processed,false);assert.equal(f.calls.length,1);assert.equal(reopened.get('SELECT state FROM qq_message_retirements').state,'unknown');}finally{reopened.close();}
});

test('expired in-flight recalls recover as unknown and revoked/binding-changed targets cannot dispatch',async t=>{
  const f=await setup(t);await f.send('old');f.change();await f.send('new');const service=f.service();service.prepare();f.runtime.store.run("UPDATE qq_message_retirements SET state='in_flight',attempt=1,lease_owner='crashed',lease_until=?",addMilliseconds(f.clock(),1000));f.advance(1001);assert.equal((await service.tick()).processed,false);assert.equal(f.runtime.store.get('SELECT state FROM qq_message_retirements').state,'unknown');assert.deepEqual(f.calls,[]);
  const g=await setup(t);await g.send('old');g.change();await g.send('new');const disabled=g.service(undefined,{allowWrites:false});assert.equal((await disabled.tick()).state,'write_disabled');assert.deepEqual(g.calls,[]);const changed=g.service();g.runtime.store.run("UPDATE plugin_delivery_bindings SET binding_id='different'");assert.equal((await changed.tick()).state,'blocked');assert.deepEqual(g.calls,[]);assert.throws(()=>g.service(),/BINDING_CHANGED/);
});
