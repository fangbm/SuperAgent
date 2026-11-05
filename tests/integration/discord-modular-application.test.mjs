import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordPlatform } from '@superagent/connector-discord';
import { createApplication } from '../../scripts/application.mjs';
import { appFixture,eventually } from './application-helpers.mjs';
import { CommunityAPI,ModuleSocket,interaction } from './discord-module-helpers.mjs';
import { modelServer,fixtureAnswer } from './m3-helpers.mjs';
import { nativeFixture } from './m4-helpers.mjs';
import { parseApplicationConfig } from '../../scripts/application-config.mjs';

test('unified app shares one Gateway/Core while private ticket is archived and public message follows M1/M3/M5',async t=>{
  const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin==='discord'),api=new CommunityAPI();let now='2026-11-02T00:00:00.000Z',connections=0;
  const server=await modelServer({after:f.after},task=>{assert.equal(JSON.stringify(task).includes('Private original'),false);return fixtureAnswer(task);});
  f.config.analysis={enabled:true,allowExternalCalls:true,baseURL:server.baseURL,model:'fixture',allowLoopbackHTTP:true};f.config.reports.enabled=true;
  entry.enabled=true;entry.config={sourceUri:entry.config.sourceUri,guildId:'100',channelIds:['200'],tickets:{enabled:true,allowWrites:true,projectId:'staff-isolated',categoryId:'400',staffRoleIds:['500']}};
  api.channels.set('200',{id:'200',guild_id:'100',type:0,permission_overwrites:[]});
  const app=await createApplication(f.config,{access:f.access,policy:f.policy,clock:()=>now,env:{SA_DISCORD_BOT_TOKEN:'fixture-only'},sourceFactories:{discord:c=>new DiscordPlatform(c,{api,webSocket:()=>{connections++;return new ModuleSocket((p,s)=>{if(p.op===2){s.dispatch('READY',1,{session_id:'unified-discord',resume_gateway_url:'wss://gateway.discord.gg/'});s.dispatch('MESSAGE_CREATE',2,{...nativeFixture('discord-message'),channel_id:'200'});s.dispatch('INTERACTION_CREATE',3,interaction().data);}});}})}});
  const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});
  await eventually(()=>app.runtime.store.get("SELECT count(*) n FROM discord_module_state WHERE state_key LIKE 'ticket:%'").n===1&&server.requests.length===1&&app.runtime.store.get('SELECT count(*) n FROM issues').n===1);
  assert.equal(connections,1);assert.equal(app.m5.runtime,app.runtime);assert.equal(app.m3.analysis.store,app.runtime.store);
  const privateRow=app.runtime.store.get('SELECT event_id FROM source_events WHERE project_id=?','staff-isolated');assert.ok(privateRow);assert.equal(app.domain.evidence('staff-isolated',privateRow.event_id),undefined);
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM jobs WHERE project_id='staff-isolated' AND kind='feedback.batch.triage'").n,0);
  now='2026-11-02T10:04:00.000Z';await eventually(()=>app.runtime.store.get("SELECT 1 FROM report_revisions WHERE window_end='2026-11-02T10:00:00.000Z'"));
  const report=JSON.parse(app.runtime.store.get("SELECT report_json FROM report_revisions WHERE window_end='2026-11-02T10:00:00.000Z'").report_json);assert.equal(report.uniqueSourceEventCount,1);assert.equal(JSON.stringify(report).includes('Private original'),false);
  const sourceEvent=app.runtime.store.get('SELECT payload_json FROM source_events WHERE project_id=?',f.config.projectId);assert.equal(sourceEvent.payload_json.includes('Private original'),false);
});
test('Ticket permission failure remains module-local and public Source plus Core keep running',async t=>{
  const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin==='discord'),api=new CommunityAPI();let socket;
  entry.enabled=true;entry.config={sourceUri:entry.config.sourceUri,guildId:'100',channelIds:['200'],tickets:{enabled:true,allowWrites:true,projectId:'staff-isolated',categoryId:'400',staffRoleIds:['500']}};
  api.channels.set('200',{id:'200',guild_id:'100',type:0,permission_overwrites:[]});api.channels.get('400').permission_overwrites=[];
  const app=await createApplication(f.config,{access:f.access,policy:f.policy,env:{SA_DISCORD_BOT_TOKEN:'fixture-only'},sourceFactories:{discord:c=>new DiscordPlatform(c,{api,webSocket:()=>socket=new ModuleSocket((p,s)=>{if(p.op===2)s.dispatch('READY',1,{session_id:'isolated',resume_gateway_url:'wss://gateway.discord.gg/'});})})}});
  const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});
  await eventually(()=>app.plugins.status()[entry.id]?.modules?.tickets?.state==='blocked');socket.dispatch('MESSAGE_CREATE',2,{...nativeFixture('discord-message'),channel_id:'200'});
  await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.config.projectId).n===1);assert.equal(app.signal.aborted,false);assert.equal(app.plugins.status()[entry.id].restarts,0);
});
test('Source/Ticket/Voice independently enable in every combination with at most one Gateway and no unauthorized writes',async t=>{
  for(const source of [false,true])for(const tickets of [false,true])for(const voice of [false,true])await t.test(`${Number(source)}${Number(tickets)}${Number(voice)}`,async t=>{
    const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin==='discord'),api=new CommunityAPI();let connections=0;
    entry.enabled=source||tickets||voice;entry.config={sourceUri:entry.config.sourceUri,guildId:'100',sourceEnabled:source,channelIds:source?['200']:[],tickets:{enabled:tickets,allowWrites:false,projectId:'staff-isolated',categoryId:'400',staffRoleIds:['500']},voice:{enabled:voice,allowWrites:false,categoryId:'600',creatorChannelIds:['610','611','612','613']}};
    api.channels.set('200',{id:'200',guild_id:'100',type:0,permission_overwrites:[]});
    const app=await createApplication(f.config,{access:f.access,policy:f.policy,env:{SA_DISCORD_BOT_TOKEN:'fixture-only'},sourceFactories:{discord:c=>new DiscordPlatform(c,{api,webSocket:()=>{connections++;return new ModuleSocket((p,s)=>{if(p.op===2){s.dispatch('READY',1,{session_id:'combination',resume_gateway_url:'wss://gateway.discord.gg/'});s.dispatch('GUILD_CREATE',2,{id:'100',voice_states:[]});if(tickets)s.dispatch('INTERACTION_CREATE',3,interaction().data);if(source)s.dispatch('MESSAGE_CREATE',4,{...nativeFixture('discord-message'),channel_id:'200'});}});}})}});
    const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});
    if(entry.enabled)await eventually(()=>connections===1&&app.runtime.store.get('SELECT cursor_json FROM sync_cursors WHERE source_id=?',entry.id));
    if(tickets){await eventually(()=>app.runtime.store.get("SELECT count(*) n FROM discord_module_state WHERE state_key LIKE 'ticket:%'").n===1);assert.equal(app.runtime.store.get("SELECT count(*) n FROM discord_module_inbox WHERE event_id='interaction:10001'").n,1);}
    if(source)await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.config.projectId).n===1);
    assert.equal(connections,entry.enabled?1:0);assert.equal(api.calls.filter(c=>c.method!=='GET').length,0);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.config.projectId).n,source?1:0);
  });
});
test('duplicate bot credentials are rejected before opening multiple Gateway sessions, even under different env names',async t=>{
  const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin==='discord');entry.enabled=true;
  f.config.sources.push({...structuredClone(entry),id:'discord-second',config:{...entry.config,sourceUri:'urn:superagent:source:discord-second'}});
  assert.throws(()=>parseApplicationConfig(f.config),/DISCORD_DUPLICATE_GATEWAY_CREDENTIAL/);
  f.config.sources.at(-1).secrets.DISCORD_BOT_TOKEN='SECOND_TOKEN';
  await assert.rejects(createApplication(f.config,{access:f.access,env:{SA_DISCORD_BOT_TOKEN:'same-fixture-token',SECOND_TOKEN:'same-fixture-token'}}),/DISCORD_DUPLICATE_GATEWAY_CREDENTIAL/);
});
test('Voice permission failure does not stop Ticket archival, Source admission or the shared Gateway',async t=>{
  const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin==='discord'),api=new CommunityAPI();let socket;
  entry.enabled=true;entry.config={sourceUri:entry.config.sourceUri,guildId:'100',channelIds:['200'],tickets:{enabled:true,allowWrites:false,projectId:'staff-isolated',categoryId:'400',staffRoleIds:['500']},voice:{enabled:true,allowWrites:true,categoryId:'600',creatorChannelIds:['610']}};
  api.channels.set('200',{id:'200',guild_id:'100',type:0,permission_overwrites:[]});api.channels.set('600',{id:'600',guild_id:'100',type:4,permission_overwrites:[]});api.channels.set('610',{id:'610',guild_id:'100',type:2,parent_id:'600',permission_overwrites:[]});
  const app=await createApplication(f.config,{access:f.access,policy:f.policy,env:{SA_DISCORD_BOT_TOKEN:'fixture-only'},sourceFactories:{discord:c=>new DiscordPlatform(c,{api,webSocket:()=>socket=new ModuleSocket((p,s)=>{if(p.op===2){s.dispatch('READY',1,{session_id:'voice-failure',resume_gateway_url:'wss://gateway.discord.gg/'});s.dispatch('GUILD_CREATE',2,{id:'100',voice_states:[{user_id:'111',channel_id:'610'}]});}})})}});
  const running=app.run();running.catch(()=>{});f.after(async()=>{await app.close();await running;});
  await eventually(()=>app.plugins.status()[entry.id]?.modules?.voice?.state==='blocked');socket.dispatch('INTERACTION_CREATE',3,interaction().data);socket.dispatch('MESSAGE_CREATE',4,{...nativeFixture('discord-message'),channel_id:'200'});
  await eventually(()=>app.runtime.store.get("SELECT count(*) n FROM discord_module_state WHERE state_key LIKE 'ticket:%'").n===1&&app.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.config.projectId).n===1);
  assert.equal(app.plugins.status()[entry.id].restarts,0);assert.equal(app.signal.aborted,false);assert.equal(api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,0);
});
