import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordVoice,DiscordREST } from '@superagent/connector-discord';
import { DiscordModuleHost,discordPacketKey } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';
import { CommunityAPI,interaction } from './discord-module-helpers.mjs';

function voiceFixture(t,options={}){
  const f=fixture(t),api=new CommunityAPI(),binding={namespace:'voice-fixture',kind:'voice',guildId:'100',projectId:'game-test',publicProjectId:'game-test',sourceId:'voice-module',sourceUri:'urn:superagent:module:voice'};
  api.channels.set('600',{id:'600',guild_id:'100',type:4,permission_overwrites:[]});for(const id of ['610','611','612','613'])api.channels.set(id,{id,guild_id:'100',type:2,parent_id:'600',permission_overwrites:[]});
  const request=api.request.bind(api);api.request=async(method,route,body,signal)=>{
    if(route==='/guilds/100/roles')return[{id:'100',permissions:String(66560n|(1n<<20n))},{id:'600',permissions:String(16n|(1n<<28n)|(1n<<24n)|1024n)}];
    if(method==='PATCH'&&/^\/channels\/\d+$/.test(route)){api.calls.push({method,route,body});const channel=api.channels.get(route.split('/').at(-1));if(!channel)throw new Error('NOT_FOUND');Object.assign(channel,body);return channel;}
    return request(method,route,body,signal);
  };
  let host=new DiscordModuleHost(f.runtime.store,binding,{clock:f.clock,assertOwner:()=>{}}),module=new DiscordVoice('100',{enabled:true,allowWrites:true,categoryId:'600',creatorChannelIds:['610','611','612','613'],emptyRoomMs:1000,...options},host.port(),api),seq=0;
  t.after(()=>module.stop());
  const packet=(type,data={},sessionId='voice-session')=>({type,data,sessionId,sequence:++seq,receivedAt:f.clock()});
  const handle=async p=>{const safe=await module.sanitize(p);host.receive(safe);try{await module.handle(safe,new AbortController().signal);}catch(e){host.fail(discordPacketKey(safe),e.message,true);throw e;}};
  const snapshot=async presence=>handle(packet('GUILD_CREATE',{id:'100',voice_states:Object.entries(presence).map(([user_id,channel_id])=>({user_id,channel_id}))}));
  const join=async(user,channel)=>handle(packet('VOICE_STATE_UPDATE',{guild_id:'100',user_id:user,channel_id:channel}));
  const tick=()=>module.tick(new AbortController().signal),rooms=()=>host.list('room:');
  const control=async(action,user,id,extra={})=>{const p=interaction(String(20000+ ++seq),user,action,{room:id,...extra});p.data.data.name='sa-voice';p.sequence=seq;p.sessionId='voice-session';await handle(p);};
  return{...f,api,get host(){return host;},get module(){return module;},packet,handle,snapshot,join,tick,rooms,control,async restart(){module.stop();host.revoke();f.runtime.close();const runtime=f.open();host=new DiscordModuleHost(runtime.store,binding,{clock:f.clock,assertOwner:()=>{}});module=new DiscordVoice('100',{enabled:true,allowWrites:true,categoryId:'600',creatorChannelIds:['610','611','612','613'],emptyRoomMs:1000,...options},host.port(),api);return runtime;}};
}
test('four creator entrances create independent durable rooms, move users and never publish voice feedback',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610',112:'611',113:'612',114:'613'});await f.tick();assert.equal(f.rooms().length,4);assert.ok(f.rooms().every(r=>r.value.status==='active'));
  await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='PATCH'&&c.route.includes('/members/')).length,4);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events').n,0);assert.equal(f.runtime.store.get('SELECT count(*) n FROM jobs').n,0);
  assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,4);
  assert.ok(f.api.calls.every(c=>!c.route.includes('/voice/')&&!c.route.includes('/roles/')));
});
test('duplicate voice updates and restarted unknown creates reconcile once without duplicate channels',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.join('111','610');f.api.mode='lost_create';await f.tick();assert.equal(f.rooms()[0].value.status,'unknown_create');
  await f.restart();await f.handle(f.packet('RESUMED',{}));await f.tick();assert.equal(f.rooms()[0].value.status,'active');assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,1);assert.equal(f.host.list('owner:').length,1);
});
test('restart waits for confirmed snapshot/Resume continuity and never cleans a room using stale occupancy',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const channel=f.rooms()[0].value.channelId;await f.join('111',channel);await f.tick();
  await f.restart();f.advance(3600000);await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);
  await f.handle(f.packet('RESUMED',{}));await f.tick();assert.equal(f.rooms()[0].value.status,'active');assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);
  f.module.disconnect();await f.tick();assert.equal(f.module.diagnostics().occupancy,'unknown');
});
test('owner-only limit/lock/transfer checks current membership and persists multi-key ownership atomically',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.join('222',r.channelId);
  await assert.rejects(f.control('lock','333',r.id),/DISCORD_VOICE_FORBIDDEN/);await assert.rejects(f.control('limit','111',r.id,{limit:100}),/DISCORD_VOICE_INPUT_INVALID/);
  await f.control('limit','111',r.id,{limit:8});await f.control('lock','111',r.id);await f.tick();assert.equal(f.api.channels.get(r.channelId).user_limit,8);assert.ok(BigInt(f.api.channels.get(r.channelId).permission_overwrites.find(x=>x.id==='100').deny)&(1n<<20n));
  await f.control('unlock','111',r.id);await f.tick();await f.control('transfer','111',r.id,{target:'222'});assert.equal(f.rooms()[0].value.ownerId,'222');assert.equal(f.host.get('owner:610:111').value.id,'');assert.equal(f.host.get('owner:610:222').value.id,r.id);
});
test('owner departure transfers to an eligible occupant and occupied rooms are not deleted',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.join('222',r.channelId);await f.join('111',null);await f.tick();assert.equal(f.rooms()[0].value.ownerId,'222');f.advance(3600000);await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);
});
async function emptyCleanup(f){
  await f.snapshot({});await f.tick();await f.tick();f.advance(1001);await f.tick();await f.tick();f.advance(1001);await f.tick();
}
test('empty-room reclamation locks joins, waits for fresh occupancy, deletes only exact owned channel and recovers an unknown DELETE',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.tick();f.api.mode='delete_fail';await emptyCleanup(f);
  assert.equal(f.rooms()[0].value.status,'unknown_delete');assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,1);
  await f.tick();assert.equal(f.rooms()[0].value.status,'blocked');assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,1);
  assert.ok(f.api.channels.has('610'));assert.ok(f.api.channels.has('600'));
});
test('foreign/relabelled channels and nonempty pending occupancy prevent cleanup',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;f.api.channels.get(r.channelId).parent_id='foreign';await emptyCleanup(f);assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);assert.equal(f.rooms()[0].value.status,'blocked');
});
test('unavailable or different-session snapshot cannot authorize creation or cleanup; no audio/session payload is stored',async t=>{
  const f=voiceFixture(t);await f.handle(f.packet('READY',{}));await f.join('111','610');await f.tick();assert.equal(f.rooms().length,0);
  await f.handle(f.packet('GUILD_CREATE',{id:'100',unavailable:true}));await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='POST').length,0);
  await f.handle(f.packet('VOICE_STATE_UPDATE',{guild_id:'100',user_id:'111',channel_id:'610',session_id:'voice-secret',self_stream:true,token:'private-audio-token'}));
  const stored=JSON.stringify(f.runtime.store.all('SELECT payload_json FROM discord_module_inbox'));assert.equal(stored.includes('voice-secret'),false);assert.equal(stored.includes('private-audio-token'),false);assert.equal(stored.includes('self_stream'),false);
});
test('a fresh full snapshot retains occupants of a room whose creation response was lost before local channel adoption',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});f.api.mode='lost_create';await f.tick();const actual=[...f.api.channels.values()].find(c=>c.type===2&&c.name?.startsWith('sa-room-'));
  await f.restart();await f.snapshot({222:actual.id});await f.tick();await f.tick();assert.equal(f.rooms()[0].value.ownerId,'222');f.advance(3600000);await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);
});
test('crash before channel POST remains uncertain and is never blindly retried after restart',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});const row=f.rooms()[0];await f.host.port().commit([{key:row.key,expectedVersion:row.version,value:{...row.value,status:'creating'}}]);
  await f.restart();await f.handle(f.packet('RESUMED',{}));await f.tick();assert.equal(f.rooms()[0].value.status,'unknown_create');assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,0);
});
test('successful empty cleanup retires ownership atomically while a new occupant cancels a pending cleanup',async t=>{
  for(const arrives of [false,true])await t.test(String(arrives),async t=>{
    const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.tick();
    await f.snapshot({});await f.tick();await f.tick();f.advance(1001);await f.tick();await f.tick();
    if(arrives)await f.join('222',r.channelId);f.advance(1001);await f.tick();await f.tick();
    if(arrives){assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);assert.equal(f.rooms()[0].value.ownerId,'222');}
    else{assert.equal(f.rooms()[0].value.status,'retired');assert.equal(f.host.get('owner:610:111').value.id,'');assert.equal(f.api.channels.has(r.channelId),false);}
  });
});
test('owner losing guild access transfers control without editing roles or operating another guild',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.join('222',r.channelId);
  const request=f.api.request.bind(f.api);f.api.request=async(method,route,body,signal)=>{if(route==='/guilds/100/members/111')throw new Error('NOT_FOUND');return request(method,route,body,signal);};await f.tick();assert.equal(f.rooms()[0].value.ownerId,'222');
  assert.equal(await f.module.owns(f.packet('VOICE_STATE_UPDATE',{guild_id:'9999',user_id:'111',channel_id:'610'})),false);assert.equal(f.api.calls.some(c=>c.method!=='GET'&&c.route.includes('/roles/')),false);
});
test('a failed occupancy event invalidates persisted Resume continuity and cannot authorize later cleanup',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const bad=f.packet('VOICE_STATE_UPDATE',{guild_id:'100',user_id:'not-an-id',channel_id:null});await assert.rejects(f.handle(bad),/INVALID_EVENT/);
  assert.equal(f.host.get('snapshot').value.valid,false);await f.restart();await f.handle(f.packet('RESUMED',{}));f.advance(3600000);await f.tick();assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,0);assert.equal(f.module.diagnostics().occupancy,'unknown');
});
test('transfer to an occupant already owning another room preserves that room index and does not create another channel',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610',222:'610'});await f.tick();const first=f.rooms().find(r=>r.value.ownerId==='111').value,other=f.rooms().find(r=>r.value.ownerId==='222').value;
  await f.join('111',first.channelId);await f.join('222',first.channelId);await f.control('transfer','111',first.id,{target:'222'});assert.equal(f.rooms().find(r=>r.value.id===first.id).value.ownerId,'222');assert.equal(f.host.get('owner:610:222').value.id,other.id);assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,2);
});
test('lost DELETE response after remote success reconciles absence and releases ownership without replay',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});await f.tick();const r=f.rooms()[0].value;await f.join('111',r.channelId);await f.tick();
  const request=f.api.request.bind(f.api);f.api.request=async(method,route,body,signal)=>{const response=await request(method,route,body,signal);if(method==='DELETE')throw new Error('OUTCOME_UNKNOWN');return response;};
  await emptyCleanup(f);assert.equal(f.rooms()[0].value.status,'unknown_delete');await f.tick();assert.equal(f.rooms()[0].value.status,'retired');assert.equal(f.host.get('owner:610:111').value.id,'');assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,1);
});
test('Voice checks Manage Roles for channel overwrites without requesting Administrator or editing guild roles',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});const request=f.api.request.bind(f.api);
  f.api.request=async(method,route,body,signal)=>{const result=await request(method,route,body,signal);return route==='/guilds/100/roles'?result.map(r=>({...r,permissions:String(BigInt(r.permissions)&~(1n<<28n))})):result;};
  await assert.rejects(f.tick(),/PERMISSION_DENIED/);assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,0);
  assert.equal(f.api.calls.some(c=>c.method!=='GET'&&c.route.includes('/roles/')),false);
});
test('an in-flight creation deadline is unknown and never triggers a second POST',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});let sends=0;const controller=new AbortController();
  const transport=new DiscordREST(async()=>'fixture',{fetch:async(_url,init)=>{sends++;return await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('DEADLINE_EXCEEDED')),{once:true}));}});
  const request=f.api.request.bind(f.api);f.api.request=async(method,route,body,signal)=>{if(method==='POST'&&route==='/guilds/100/channels'){const timer=setTimeout(()=>controller.abort(),10);try{return await transport.request(method,route,body,AbortSignal.any([signal,controller.signal]));}finally{clearTimeout(timer);}}return request(method,route,body,signal);};
  await f.tick();assert.equal(f.rooms()[0].value.status,'unknown_create');await f.tick();assert.equal(sends,1);
});
test('removing a creator from current configuration blocks its saved creation intent instead of operating outside scope',async t=>{
  const f=voiceFixture(t);await f.snapshot({111:'610'});f.module.config.creatorChannelIds=['611'];await f.tick();assert.equal(f.rooms()[0].value.lastError,'DISCORD_VOICE_CREATOR_REMOVED');assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,0);
});
