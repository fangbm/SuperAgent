import assert from 'node:assert/strict';
import test from 'node:test';
import {QQSource,QQC2CDelivery} from '@superagent/qq-official';
import {createApplication} from '../../scripts/application.mjs';
import {appFixture,eventually} from './application-helpers.mjs';
import {modelServer} from './m3-helpers.mjs';
import {qqSecrets,qqEvent,signed} from './qq-helpers.mjs';
test('unified QQ signed HTTP ingress → isolated M1 → real HTTP model → Domain → passive C2C live menu, no group/menu writes',async t=>{
  for(const withDelivery of [false,true])await t.test(withDelivery?'Source and Delivery':'Source only',async t=>{
    const f=appFixture(t),clock=()=> '2026-11-02T00:00:00.000Z',server=await modelServer({after:f.after}),calls=[];
    for(const entry of f.config.sources)entry.enabled=false;const entry=f.config.sources.find(e=>e.plugin==='qq-official');entry.enabled=true;entry.port=0;entry.config={...entry.config,transport:'webhook',feedbackCommands:{enabled:true}};
    const delivery=f.config.deliveries[0];delivery.enabled=withDelivery;delivery.allowWrites=withDelivery;delivery.config.operatorMenu={enabled:true,autoDeploy:false};
    f.config.analysis={enabled:true,allowExternalCalls:true,baseURL:server.baseURL,model:'fixture-model',allowLoopbackHTTP:true};f.config.runtime.probeIntervalMs=50;f.config.runtime.stopTimeoutMs=2000;
    const secrets={...qqSecrets,QQ_OPERATOR_OPENID:qqSecrets.QQ_RECIPIENT_OPENID},env={};for(const p of [entry,...(withDelivery?[delivery]:[])])for(const [key,name]of Object.entries(p.secrets))if(withDelivery||key!=='QQ_OPERATOR_OPENID')env[name]=secrets[key];
    const api=async(url,init)=>{const path=new URL(url).pathname;if(path==='/app/getAppAccessToken')return Response.json({access_token:'fixture',expires_in:7200});if(path==='/users/@me')return Response.json({id:'fixture-bot'});if(path.endsWith('/bot_state'))return Response.json({member_openid:'fixture-bot'});calls.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(init.body):null});assert.ok(!path.includes('/groups/')&&!path.includes('/menu'));return Response.json({id:`message-${calls.length}`});};
    const app=await createApplication(f.config,{access:f.access,policy:{...f.policy,maxCandidateMessages:10},clock,env,sourceFactories:{'qq-official':c=>new QQSource({...c,now:()=>Date.parse(clock()),api:{fetch:api}})},deliveryFactory:c=>new QQC2CDelivery({...c,api:{fetch:api}})});f.after(()=>app.close());await app.start();await eventually(()=>app.plugins.status()[entry.id]?.state==='running');
    const receive=async payload=>{const [headers,body]=signed(payload,clock);const response=await fetch(`http://127.0.0.1:${app.status().sourcePorts[entry.id]}/qq/events`,{method:'POST',headers,body});assert.equal(response.status,200);};
    await receive(qqEvent('normal',{text:'普通联机错误，需要继续排查',type:'GROUP_MESSAGE_CREATE'}));app.runtime.tick();assert.equal(app.runtime.store.get("SELECT count(*) n FROM feedback_batches").n,0);
    const command=qqEvent('explicit',{text:'/bug Windows 1.2.0 联机载入90%时崩溃',type:'GROUP_MESSAGE_CREATE'});await receive(command);await receive({...command,t:'GROUP_AT_MESSAGE_CREATE'});await app.tick();
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM feedback_batches').n,1);assert.equal(app.runtime.store.get('SELECT count(*) n FROM issues').n,1);assert.equal(server.requests.length,1);assert.equal(app.runtime.store.get("SELECT count(*) n FROM conversation_segments WHERE state='open'").n,1);assert.equal(calls.length,0);
    if(withDelivery){await receive({op:0,t:'C2C_MESSAGE_CREATE',d:{id:'native-menu-message',content:'/pending',author:{user_openid:qqSecrets.QQ_RECIPIENT_OPENID}}});await app.tick();assert.equal(calls.length,1);assert.equal(calls[0].body.msg_id,'native-menu-message');assert.match(calls[0].body.markdown.content,/实时待办/);assert.ok(calls[0].body.keyboard);assert.equal(app.runtime.store.get('SELECT count(*) n FROM operator_inbox').n,1);}
    assert.equal(app.signal.aborted,false);
  });
});
