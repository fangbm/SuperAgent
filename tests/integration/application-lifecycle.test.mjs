import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync,writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplication } from '../../scripts/application.mjs';
import { parseApplicationConfig } from '../../scripts/application-config.mjs';
import { appFixture,sourceDouble,eventually,material } from './application-helpers.mjs';

test('configuration rejects source processing policy, unauthorized permissions, unsupported API and unapproved model calls',async t=>{
  const f=appFixture(t);const invalid=structuredClone(f.config);invalid.analysis.enabled=true;
  assert.throws(()=>parseApplicationConfig(invalid),/APPLICATION_SERVICES/);
  invalid.analysis.enabled=false;invalid.sources[0].processing_mode='archive_only';assert.throws(()=>parseApplicationConfig(invalid),/APPLICATION_PLUGIN/);
  f.config.sources[0].enabled=true;f.config.sources[0].permissions.secretKeys.push('EXTRA_DATABASE_KEY');
  await assert.rejects(createApplication(f.config,{access:f.access}),/PLUGIN_PERMISSION_DENIED/);
  f.config.sources[0].permissions.secretKeys.pop();
  await assert.rejects(createApplication(f.config,{access:f.access,sourceFactories:{'qq-official':()=>{const p=sourceDouble(f.config.sources[0]);p.manifest=structuredClone(p.manifest);p.manifest.engine.sdk='^9.0.0';return p;}}}),/API_INCOMPATIBLE/);
  assert.equal(f.config.sources.some(s=>s.policy),false);
});

test('enabled instances start under scoped SDK Hosts; blocking starts never get duplicate supervisor sync',async t=>{
  const f=appFixture(t),seen=new Map(),hosts=[];
  for(const entry of f.config.sources)entry.enabled=true;
  const factories=Object.fromEntries(f.config.sources.map(entry=>[entry.plugin,()=>sourceDouble(entry,{
    start:async host=>{hosts.push(host);seen.set(entry.id,{start:1,sync:0,stop:0});await host.commitBatch([material(entry,f.config.projectId)],{sourceId:entry.id,cursor:{n:1}});},
    sync:async()=>{seen.get(entry.id).sync++;},stop:async()=>{if(seen.has(entry.id))seen.get(entry.id).stop++;},
  })]));
  const app=await createApplication(f.config,{access:f.access,sourceFactories:factories,policy:f.policy});t.after(()=>app.close());await app.start();
  await eventually(()=>seen.size===4&&seen.get('qq-main').sync>0);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,4);
  for(const entry of f.config.sources)if(entry.plugin!=='qq-official')assert.equal(seen.get(entry.id).sync,0);
  assert.deepEqual(Object.keys(hosts[0]).sort(),['projectId','sourceId','logger','getCheckpoint','commitBatch','getSecret','reportHealth'].sort());
  assert.equal(hosts[0].database,undefined);assert.equal(hosts[0].setSourcePolicy,undefined);
  await assert.rejects(hosts[0].getSecret('OTHER_SOURCE_SECRET'),/SECRET_NOT_AUTHORIZED/);
  const forged=material(f.config.sources[1],f.config.projectId,'forged');await assert.rejects(hosts[0].commitBatch([forged]));
  await assert.rejects(hosts[0].commitBatch([],{sourceId:'other-source',cursor:{}}));
  await assert.rejects(hosts[0].commitBatch([{invalid:'event'}]));
  await app.close();for(const v of seen.values())assert.equal(v.stop,1);
  await assert.rejects(hosts[0].getCheckpoint(),/PLUGIN_HOST_CLOSED/);
});

test('failed source is recreated within bounded budget; another source keeps committed material',async t=>{
  const f=appFixture(t);const [qq,discord]=f.config.sources;qq.enabled=discord.enabled=true;let tries=0,stops=0;
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{
    'qq-official':()=>sourceDouble(qq,{start:async host=>{if(++tries===1)throw new Error('RATE_LIMITED');await host.commitBatch([material(qq,f.config.projectId)]);},stop:()=>{stops++;}}),
    discord:()=>sourceDouble(discord,{start:host=>host.commitBatch([material(discord,f.config.projectId)])}),
  }});t.after(()=>app.close());await app.start();await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===2);
  assert.equal(tries,2);assert.equal(app.plugins.status()['qq-main'].restarts,1);assert.equal(stops,1);
  await app.tick();assert.equal(app.runtime.store.get('SELECT count(*) n FROM event_outbox WHERE status=?','pending').n,0);
});

test('unsupported plugin stays unavailable without automatic retries or stopping Core',async t=>{
  const f=appFixture(t),entry=f.config.sources[3];entry.enabled=true;let starts=0;
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{'steam-discussions':()=>sourceDouble(entry,{start:()=>{starts++;},overrides:{probe:async()=>({connection:'poll',coverage:'unavailable',readMessages:false,readHistory:false,readEdits:false,readAttachments:false})}})}});
  t.after(()=>app.close());await app.start();await eventually(()=>app.plugins.status()[entry.id].state==='failed');
  assert.equal(starts,0);assert.equal(app.plugins.status()[entry.id].restarts,0);assert.equal(app.plugins.status()[entry.id].error,'UNSUPPORTED_CAPABILITY');await app.tick();assert.equal(app.runtime.store.get('SELECT coverage FROM sources WHERE source_id=?',entry.id).coverage,'unavailable');
});

test('background health failure is supervised and is not overwritten by successful sync',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;let starts=0;
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:async host=>{starts++;await host.reportHealth({coverage:'unavailable',reason:'QQ_GATEWAY_FAILED',checkedAt:new Date().toISOString()});},sync:async host=>host.reportHealth({coverage:'partial',checkedAt:new Date().toISOString()})})}});
  t.after(()=>app.close());await app.start();await eventually(()=>app.plugins.status()[entry.id].state==='recovery_wait');assert.equal(starts,2);
});

test('SQLite owner excludes second main instance and releases after normal shutdown',async t=>{
  const f=appFixture(t),first=await createApplication(f.config,{access:f.access});t.after(()=>first.close());
  await assert.rejects(createApplication(f.config,{access:f.access}),/APPLICATION_ALREADY_RUNNING/);
  await first.tick();await first.close();const next=await createApplication(f.config,{access:f.access});await next.tick();await next.close();
});

test('official pnpm entry boots core with no extra workers and exits cleanly; offline check creates no DB',async t=>{
  const f=appFixture(t),filename=f.directory+'/config.json';writeFileSync(filename,JSON.stringify(f.config));
  const cli=async args=>{const child=spawn(process.execPath,['scripts/superagent.mjs','--config',filename,...args],{cwd:new URL('../..',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const [exit]=await once(child,'exit');assert.equal(exit,0,output);return output;};
  assert.match(await cli(['--check-config']),/config_valid/);assert.equal(existsSync(f.config.database),false);
  assert.match(await cli(['--run-for-ms','200']),/"state":"started"/);
});
