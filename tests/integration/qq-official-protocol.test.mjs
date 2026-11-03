import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { QQSource, QQC2CDelivery } from '@superagent/qq-official';
import { QQOperatorService } from '@superagent/control-plane';
import { DurableDeliveryService, ReportDeliveryCoordinator, deliveryHost } from '@superagent/plugin-host';
import { m5Fixture } from './m5-helpers.mjs';
import { binding,scope,count } from './helpers.mjs';
import { qqSecrets,readSecret,signed } from './qq-helpers.mjs';

test('official envelope flows through signed Source, durable inbox, ACK and passive C2C HTTP reply',async t=>{
  const f=await m5Fixture(t);f.add('original');await f.worker.tick();const report=f.generate();const qq=new QQOperatorService(f.control,{projectId:binding.projectId,actorRef:'developer',recipientRef:'developer',clock:f.clock});const calls=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw||'{}');
    if(req.url==='/app/getAppAccessToken'){res.end(JSON.stringify({access_token:'fixture-token',expires_in:7200}));return;}
    calls.push({method:req.method,path:req.url,body});
    if(req.method==='PUT'&&req.url==='/interactions/ack-uuid'){
      assert.equal(req.headers['x-callback-appid'],qqSecrets.QQ_APP_ID);assert.deepEqual(body,{code:0});assert.equal(f.runtime.store.get("SELECT state FROM operator_inbox WHERE json_extract(request_json,'$.interactionId')=?",'button:ack-uuid').state,'pending');res.end();return;
    }
    if(req.method==='POST'&&req.url===`/v2/users/${qqSecrets.QQ_RECIPIENT_OPENID}/messages`){
      if(body.event_id!=='INTERACTION_CREATE:outer-event'||body.msg_id){res.writeHead(400);res.end(JSON.stringify({err_code:40034025}));return;}
      assert.equal(body.msg_type,2);assert.equal(body.content,undefined);assert.equal(body.msg_seq,1);assert.ok(body.keyboard.content.rows.flatMap(r=>r.buttons).every(b=>b.action.unsupport_tips&&b.action.permission.type===2));res.end(JSON.stringify({id:'fixture-delivered'}));return;
    }
    res.writeHead(400);res.end(JSON.stringify({err_code:630001}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const api={baseURL:`http://127.0.0.1:${server.address().port}`,allowLoopbackHTTP:true};
  let coordinator;const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',api,messageOptions:async r=>coordinator.messageOptions(r.deliveryId)});
  const delivery=new DurableDeliveryService(f.runtime.store,plugin,deliveryHost(plugin,readSecret),{projectId:binding.projectId,recipientRef:'developer',recipientBindingId:'official-protocol-fixture',clock:f.clock,allowWrites:true,authorizeInteraction:r=>coordinator.authorizeReply(r)});coordinator=new ReportDeliveryCoordinator(f.runtime.store,delivery,{getReport:(p,id,rev)=>f.reports.getExact(p,id,rev),clock:f.clock});
  const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(f.clock()),api,operator:{receive:r=>Promise.resolve(qq.receive(r))}});await source.start(f.runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:key=>key==='QQ_OPERATOR_OPENID'?Promise.resolve(qqSecrets.QQ_RECIPIENT_OPENID):readSecret(key)}),new AbortController().signal);
  try{
    qq.receive({interactionId:'initial-local-query',kind:'command',content:'/bugs',reply:{messageId:'initial-incoming'}});const list=qq.tick();const options=JSON.parse(f.runtime.store.get('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=?',list.deliveryId).message_options_json);const token=options.buttons.find(b=>b.label==='详情 1').token;
    // The local setup query is not part of this HTTP send; only the button reply is enqueued below.
    const callback={op:0,id:'INTERACTION_CREATE:outer-event',t:'INTERACTION_CREATE',d:{id:'ack-uuid',application_id:qqSecrets.QQ_APP_ID,scene:'c2c',chat_type:2,type:11,user_openid:qqSecrets.QQ_RECIPIENT_OPENID,data:{type:11,resolved:{button_data:token}}}};
    assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);assert.equal((await source.handleWebhook(...signed(callback,f.clock))).statusCode,200);assert.equal(calls.length,1);
    const detail=qq.tick();coordinator.enqueueReplies(binding.projectId,'developer');const operation=f.runtime.store.get('SELECT operation_id FROM operator_reply_plans WHERE delivery_id=?',detail.deliveryId);assert.equal((await delivery.tick({purpose:'interaction',operationId:operation.operation_id})).state,'succeeded');assert.equal(calls.length,2);assert.equal(count(f.runtime.store,'source_events'),1);assert.equal(report.revision,1);
  }finally{await source.stop();}
});
