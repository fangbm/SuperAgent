import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordConnector,DiscordREST } from '@superagent/connector-discord';
import { connectorFixture,nativeFixture,signal } from './m4-helpers.mjs';
import { eventually } from './application-helpers.mjs';

export class DiscordSocket extends EventTarget {
  readyState=1;
  constructor(onSend=()=>{}){super();this.onSend=onSend;queueMicrotask(()=>this.receive({op:10,d:{heartbeat_interval:10000}}));}
  receive(packet){if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(packet)}));}
  dispatch(type,s,data){this.receive({op:0,t:type,s,d:data});}
  send(raw){const p=JSON.parse(raw);if(p.op===1)this.receive({op:11});this.onSend(p,this);}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.defineProperty(e,'code',{value:code});queueMicrotask(()=>this.dispatchEvent(e));}
}
export function discordFixtureAPI(options={}){
  const calls=[];let archivedCalls=0;
  const channel=(id,type=0,parent_id)=>({id,guild_id:'100',type,...(parent_id?{parent_id}:{}),permission_overwrites:options.denied?.has(id)?[{id:'100',type:0,allow:'0',deny:'1024'}]:[]});
  const thread=(id,parent='200',type=11)=>({...channel(id,type,parent),thread_metadata:{archive_timestamp:'2026-11-01T00:00:00.000Z'}});
  const fetch=async(url,init={})=>{
    const u=new URL(url),p=u.pathname.replace('/api/v10','');calls.push(p+u.search);
    if(options.handle){const result=await options.handle(p,u,init);if(result)return result;}
    if(p==='/oauth2/applications/@me')return Response.json({flags:1<<19});
    if(p==='/users/@me')return Response.json({id:'999'});
    if(p==='/guilds/100/members/999')return Response.json({user:{id:'999'},roles:[]});
    if(p==='/guilds/100/roles')return Response.json([{id:'100',permissions:'66560'}]);
    if(p==='/guilds/100/threads/active')return Response.json({threads:[thread('301'),thread('302','201'),thread('303','200',12)]});
    if(p.endsWith('/threads/archived/public')){archivedCalls++;return Response.json(options.archived?.(u,archivedCalls)??{threads:p.includes('/200/')?[thread('304')]:[],has_more:false});}
    if(p.endsWith('/messages')){const id=p.split('/')[2];return Response.json(options.messages?.(id,u)??[{...nativeFixture('discord-message'),id:'900'+id,channel_id:id}]);}
    if(p==='/gateway/bot')return Response.json({url:'wss://gateway.discord.gg/'});
    const match=p.match(/^\/channels\/(\d+)$/);if(match){const id=match[1];return Response.json(id.startsWith('3')?thread(id):channel(id));}
    throw new Error('UNEXPECTED_DISCORD_ROUTE');
  };
  return {fetch,calls,thread};
}
test('discovery is opt-in and only authorized public threads under configured parents are archived',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),api=discordFixtureAPI();
  const c=new DiscordConnector({sourceUri:f.binding.sourceUri,guildId:'100',channelIds:['200'],discoverThreads:true},{fetch:api.fetch});await c.sync(f.host,signal());
  assert.deepEqual(f.events(f.runtime).map(e=>e.data.attributes.channelId).sort(),['200','301','304']);
  assert.equal(api.calls.some(p=>p==='/guilds/100/channels'),false);assert.equal(api.calls.some(p=>p.includes('/302/')),false);assert.equal(api.calls.some(p=>p.includes('/303/')),false);
  const cp=await f.host.getCheckpoint();assert.equal(cp.knownThreads['301'],'200');assert.equal(cp.history['304'].after,'900304');assert.equal((await c.probe()).coverage,'partial');
  const g=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),other=discordFixtureAPI();await new DiscordConnector({sourceUri:g.binding.sourceUri,guildId:'100',channelIds:['200']},{fetch:other.fetch}).sync(g.host,signal());assert.equal(other.calls.some(p=>p.includes('/threads/')),false);
});
test('archived thread pagination is committed, resumes in a fresh instance and preserves removed scopes for re-addition',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']);
  const api=discordFixtureAPI({archived:u=>u.searchParams.has('before')||!u.pathname.includes('/200/')?{threads:[],has_more:false}:{threads:[{id:'304',guild_id:'100',parent_id:'200',type:11,thread_metadata:{archive_timestamp:'2026-11-01T00:00:00.000Z'}}],has_more:true}});
  const config={sourceUri:f.binding.sourceUri,guildId:'100',channelIds:['200'],discoverThreads:true,threadPagesPerSync:1};await new DiscordConnector(config,{fetch:api.fetch}).sync(f.host,signal());
  assert.equal((await f.host.getCheckpoint()).archives['200'].before,'2026-11-01T00:00:00.000Z');
  f.runtime.close();const runtime=f.open(),host=f.getHost(runtime);await new DiscordConnector(config,{fetch:api.fetch}).sync(host,signal());
  assert.ok(api.calls.some(p=>p.includes('before=2026-11-01T00%3A00%3A00.000Z')));
  const before=JSON.stringify((await host.getCheckpoint()).history['200']);
  await new DiscordConnector({...config,channelIds:['201']},{fetch:api.fetch}).sync(host,signal());assert.equal(JSON.stringify((await host.getCheckpoint()).history['200']),before);
});
test('permission loss and inaccessible known threads keep gaps and do not advance their history',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),denied=new Set(),api=discordFixtureAPI({denied});
  const config={sourceUri:f.binding.sourceUri,guildId:'100',channelIds:['200','201'],discoverThreads:true};const c=new DiscordConnector(config,{fetch:api.fetch});await c.sync(f.host,signal());
  const before=(await f.host.getCheckpoint()).history['200'];denied.add('200');await c.sync(f.host,signal());const cp=await f.host.getCheckpoint();assert.equal(cp.gaps['200'],'PERMISSION_DENIED');assert.deepEqual(cp.history['200'],before);assert.ok(cp.history['201']);
});
test('history/discovery failed commit never advances the saved page; foreign/private threads fail closed',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),api=discordFixtureAPI();const config={sourceUri:f.binding.sourceUri,guildId:'100',channelIds:['200'],discoverThreads:true};
  await assert.rejects(new DiscordConnector(config,{fetch:api.fetch}).sync({...f.host,commitBatch:async()=>{throw new Error('DISK_FAILED');}},signal()),/DISK_FAILED/);assert.equal(await f.host.getCheckpoint(),null);
  const malicious=discordFixtureAPI({archived:()=>({threads:[{id:'399',guild_id:'elsewhere',parent_id:'200',type:11,thread_metadata:{archive_timestamp:'2026-11-01T00:00:00Z'}}],has_more:false})});await assert.rejects(new DiscordConnector(config,{fetch:malicious.fetch}).sync(f.host,signal()),/archived thread scope/);assert.equal(f.events(f.runtime).length,0);
});
test('shared dispatch journals before sequence advance, uses one Gateway and source-disabled mode publishes no feedback',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),api=discordFixtureAPI(),controller=new AbortController(),packets=[];let connections=0,identified;
  const c=new DiscordConnector({sourceUri:f.binding.sourceUri,guildId:'100',channelIds:[],sourceEnabled:false},{fetch:api.fetch,additionalIntents:128,onDispatch:async packet=>{packets.push(packet);},webSocket:()=>{connections++;return new DiscordSocket((p,s)=>{if(p.op===2){identified=p;s.dispatch('READY',1,{session_id:'one',resume_gateway_url:'wss://gateway.discord.gg/'});s.dispatch('VOICE_STATE_UPDATE',2,{guild_id:'100',user_id:'123',channel_id:'200'});s.dispatch('MESSAGE_CREATE',3,{...nativeFixture('discord-message'),guild_id:'100'});}});}});
  const running=c.start(f.host,controller.signal);t.after(async()=>{controller.abort();await c.stop();await running;});await eventually(async()=>((await f.host.getCheckpoint())?.gateway?.sequence)===3);
  assert.equal(connections,1);assert.equal(identified.d.intents,129);assert.equal(f.events(f.runtime).length,0);assert.equal(packets.length,3);assert.equal((await c.probe()).readMessages,false);
});
test('shared REST does not blindly repeat an ambiguous mutation, bounds responses and remains cancellable during rate limits',async()=>{
  let calls=0;const rest=new DiscordREST(async()=>'fixture',{fetch:async()=>{calls++;throw new Error('LOST');}});await assert.rejects(rest.request('POST','/guilds/100/channels',{}),/OUTCOME_UNKNOWN/);assert.equal(calls,1);
  const abort=new AbortController();const limited=new DiscordREST(async()=>'fixture',{fetch:async()=>Response.json({retry_after:300},{status:429}),sleep:async(_ms,s)=>{abort.abort();s.throwIfAborted();}});await assert.rejects(limited.request('GET','/users/@me',undefined,abort.signal));
  await assert.rejects(rest.request('GET','//attacker.invalid/path'),/INVALID_REQUEST/);
});
test('new public thread Gateway event is tracked before its message; private thread and other guild remain excluded',async t=>{
  const f=connectorFixture(t,'discord',['DISCORD_BOT_TOKEN']),api=discordFixtureAPI({messages:()=>[]}),controller=new AbortController();
  const c=new DiscordConnector({sourceUri:f.binding.sourceUri,guildId:'100',channelIds:['200'],discoverThreads:true},{fetch:api.fetch,webSocket:()=>new DiscordSocket((p,s)=>{if(p.op===2){s.dispatch('READY',1,{session_id:'threads',resume_gateway_url:'wss://gateway.discord.gg/'});s.dispatch('THREAD_CREATE',2,{id:'399',guild_id:'100',parent_id:'200',type:11});s.dispatch('MESSAGE_CREATE',3,{...nativeFixture('discord-message'),channel_id:'399'});s.dispatch('MESSAGE_CREATE',4,{...nativeFixture('discord-message'),guild_id:'elsewhere'});s.dispatch('MESSAGE_CREATE',5,{...nativeFixture('discord-message'),channel_id:'303'});}})});
  const running=c.start(f.host,controller.signal);t.after(async()=>{controller.abort();await c.stop();await running;});await eventually(async()=>((await f.host.getCheckpoint())?.gateway?.sequence)===5);
  assert.equal(f.events(f.runtime).length,1);assert.equal(f.events(f.runtime)[0].data.object.threadExternalId,'399');
});
