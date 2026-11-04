import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync,readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { createApplication } from '../../scripts/application.mjs';
import { bounded } from '../../scripts/plugin-validation.mjs';
import { appFixture,sourceDouble,material,eventually } from './application-helpers.mjs';

test('actual process crash recovers SQLite main ownership, committed checkpoint, outbox and jobs without replay',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;
  const filename=f.directory+'/crash.json';writeFileSync(filename,JSON.stringify(f.config));
  writeFileSync(f.directory+'/policy.json',JSON.stringify(f.policy));
  const child=spawn(process.execPath,['tests/integration/application-crash-child.mjs',filename,f.directory+'/policy.json'],{cwd:new URL('../..',import.meta.url),windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let error='';child.stderr.on('data',b=>error+=b);
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const [message]=await bounded(Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(error);})]),10000,'CRASH_CHILD_TIMEOUT');assert.equal(message.ready,true);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  let checkpoint;
  const app=await createApplication(f.config,{access:f.access,policy:f.policy,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:async host=>{checkpoint=await host.getCheckpoint();}})}});t.after(()=>app.close());
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM event_outbox WHERE status='pending'").n,1);
  await app.start();await eventually(()=>checkpoint);assert.deepEqual(checkpoint,{offset:1});await app.tick();
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,1);
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM event_outbox WHERE status='pending'").n,0);
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage' AND status='pending'").n,1);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM model_calls').n,0);
  const jobs=app.runtime.store.get('SELECT count(*) n FROM jobs').n;await app.tick();assert.equal(app.runtime.store.get('SELECT count(*) n FROM jobs').n,jobs);
});

test('backlog remains archived under disabled analysis and normal per-message archive_only filtering survives',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;
  const events=Array.from({length:200},(_,i)=>material(entry,f.config.projectId,'backlog-'+i));
  const chatter=material(entry,f.config.projectId,'chatter');chatter.data.content.text='你好';events.push(chatter);
  const make=()=>sourceDouble(entry,{start:async host=>{await host.commitBatch([...events,...events],{sourceId:entry.id,cursor:{offset:201}});}});
  let app=await createApplication(f.config,{access:f.access,policy:f.policy,sourceFactories:{'qq-official':make}});t.after(()=>app.close());await app.start();await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===201);await app.tick();
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM admission_decisions WHERE decision='archive_only'").n,1);
  assert.equal(app.runtime.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage' AND status='pending'").n,200);
  await app.close();app=await createApplication(f.config,{access:f.access,policy:f.policy,sourceFactories:{'qq-official':make}});await app.start();await eventually(()=>app.plugins.status()[entry.id].state==='running');await app.tick();
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,201);assert.equal(app.runtime.store.get('SELECT count(*) n FROM model_calls').n,0);assert.equal(app.runtime.store.get('PRAGMA quick_check').quick_check,'ok');
});

test('real Steam connector handles API 429 backoff and commits one atomic checkpoint under main supervision',async t=>{
  const f=appFixture(t),entry=f.config.sources[2];entry.enabled=true;let requests=0,backoffs=0;
  const review=JSON.parse(readFileSync(new URL('../fixtures/m4/steam-review.json',import.meta.url),'utf8'));
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{'steam-reviews':c=>new SteamReviewsConnector(c,{
    fetch:async url=>{if(++requests===1)return new Response('',{status:429,headers:{'retry-after':'1'}});const cursor=JSON.parse(url.searchParams.get('input_json')).cursor;return Response.json({response:{reviews:cursor==='*'?[review]:[],cursor:'end'}});},
    sleep:async(ms,signal)=>{if(ms===1000){backoffs++;return;}await delay(ms,undefined,{signal});},
  })}});t.after(()=>app.close());await app.start();await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===1);
  assert.equal(backoffs,1);await app.tick();assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n,1);
  assert.ok(await app.plugins.instances.get(entry.id).host.getCheckpoint());
});

test('uncooperative source cannot use Host after bounded shutdown or keep SQLite ownership',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;f.config.runtime.stopTimeoutMs=20;let saved;
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:host=>{saved=host;},overrides:{stop:()=>new Promise(()=>{})}})}});
  await app.start();await eventually(()=>saved);await app.close();await assert.rejects(saved.commitBatch([material(entry,f.config.projectId)]),/PLUGIN_HOST_CLOSED/);
  const next=await createApplication({...f.config,sources:[]},{access:f.access});await next.close();
});
