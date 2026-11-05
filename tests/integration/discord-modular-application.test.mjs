import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordPlatform } from '@superagent/connector-discord';
import { createApplication } from '../../scripts/application.mjs';
import { appFixture,eventually } from './application-helpers.mjs';
import { CommunityAPI,ModuleSocket,interaction } from './discord-module-helpers.mjs';
import { modelServer,fixtureAnswer } from './m3-helpers.mjs';
import { nativeFixture } from './m4-helpers.mjs';

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
