import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { createApplication } from '../../scripts/application.mjs';
import { parseApplicationConfig } from '../../scripts/application-config.mjs';
import { builtinSources } from '../../scripts/source-registry.mjs';
import { appFixture,sourceDouble,SupervisorClock as Clock } from './application-helpers.mjs';

const QQ={coverage:'unknown',reason:'QQ_GATEWAY_HEARTBEAT_ACK'},DISCORD={coverage:'partial',reason:'DISCORD_GATEWAY_HEARTBEAT_ACK'};
const REVIEW={coverage:'partial',reason:'Review scan completed; public snapshots only'};
const SNAPSHOT={coverage:'partial',reason:'Operator snapshot committed; remote coverage unknown'};
async function runningFixture(t,{plugin='qq-official',failures=4,signal=QQ,probeCoverage='unknown',initialSignal=true}={}) {
  const f=appFixture(t),entry=f.config.sources.find(e=>e.plugin===plugin);entry.enabled=true;f.config.runtime.maxRestarts=3;f.config.runtime.recoveryIntervalMs=300000;
  if(plugin==='steam-discussions'){entry.config.mode='snapshot';entry.config.snapshotPath=f.directory+'/snapshot.json';writeFileSync(entry.config.snapshotPath,JSON.stringify({schemaVersion:'1.0',appId:570,records:[]}));}
  const clock=new Clock();let created=0,currentHost;const state={outage:false};
  const app=await createApplication(f.config,{access:f.access,supervisorTiming:clock,sourceFactories:{[plugin]:()=>{
    const n=++created;
    return sourceDouble(entry,{start:async host=>{if(n<=failures)throw new Error('TRANSIENT_NETWORK');currentHost=host;if(initialSignal)await host.reportHealth({...signal,checkedAt:new Date(clock.now()).toISOString()});},overrides:{probe:async()=>{
      if(state.outage&&n>failures)throw new Error('TRANSIENT_NETWORK');
      return {connection:plugin==='qq-official'?'push':'poll',coverage:probeCoverage,readMessages:probeCoverage==='partial',readHistory:false,readEdits:false,readAttachments:false};
    }}});
  }}});
  t.after(()=>app.close());await app.start();
  if(failures>=4){await clock.until(()=>app.plugins.status()[entry.id].state==='recovery_wait');await clock.advance(330000);}
  await clock.until(()=>!!currentHost&&app.plugins.status()[entry.id].state==='running');
  const health=async info=>currentHost.reportHealth({...info,checkedAt:new Date(clock.now()).toISOString()});
  const advanceHealthy=async ms=>{while(ms>0){const step=Math.min(60000,ms);await clock.advance(step);await health(signal);ms-=step;}};
  return {...f,entry,clock,app,state,health,advanceHealthy,created:()=>created,status:()=>app.plugins.status()[entry.id]};
}

test('stableResetMs defaults to one hour and accepts an explicit validated duration',t=>{
  const f=appFixture(t);assert.equal(parseApplicationConfig(f.config).runtime.stableResetMs,3600000);
  for(const value of [0,-1,59999,NaN,'3600000',86400001]){f.config.runtime.stableResetMs=value;assert.throws(()=>parseApplicationConfig(f.config),/INVALID_APPLICATION_RUNTIME/);}
  f.config.runtime.stableResetMs=1800000;assert.equal(parseApplicationConfig(f.config).runtime.stableResetMs,1800000);
});

test('idle QQ connection restores all three retries only after sixty healthy minutes, once per stable run',async t=>{
  const f=await runningFixture(t);assert.equal(f.status().shortRetriesUsed,3);assert.equal(f.status().recoveries,1);
  await f.advanceHealthy(3599999);assert.equal(f.status().shortRetriesUsed,3);assert.equal(f.status().budgetResets,0);
  await f.advanceHealthy(1);assert.equal(f.status().shortRetriesUsed,0);assert.equal(f.status().budgetResets,1);assert.equal(f.status().stableResetDone,true);
  assert.equal(f.status().coverage,'unknown');assert.equal(f.app.runtime.store.get('SELECT count(*) n FROM source_events').n,0);
  await f.advanceHealthy(3600000);assert.equal(f.status().budgetResets,1);
  f.state.outage=true;await f.clock.advance(10);await f.clock.until(()=>f.status().state==='recovery_wait'&&f.created()===8);
  assert.equal(f.status().shortRetriesUsed,3);assert.equal(f.status().stableSince,null);assert.equal(f.status().budgetResets,1);
});

test('idle Discord connection uses live heartbeat evidence and partial-coverage disconnect restarts the whole hour',async t=>{
  const f=await runningFixture(t,{plugin:'discord',signal:DISCORD,probeCoverage:'partial'});
  await f.advanceHealthy(3540000);const first=f.status().stableSince;
  await f.health({coverage:'partial',reason:'Gateway disconnected; resuming only from committed sequence'});assert.equal(f.status().stableSince,null);
  await f.health({coverage:'partial',reason:'DISCORD_GATEWAY_CONNECTED'});assert.notEqual(f.status().stableSince,first);
  await f.advanceHealthy(60000);assert.equal(f.status().shortRetriesUsed,3);await f.advanceHealthy(3540000);assert.equal(f.status().shortRetriesUsed,0);
  assert.equal(f.app.runtime.store.get('SELECT count(*) n FROM source_events').n,0);
});

test('unknown or successful capability probes alone never refill the budget',async t=>{
  for(const probeCoverage of ['unknown','partial'])await t.test(probeCoverage,async t=>{
    const f=await runningFixture(t,{failures:3,probeCoverage,initialSignal:false});await f.clock.advance(3600000);
    assert.equal(f.status().stableSince,null);assert.equal(f.status().budgetResets,0);assert.equal(f.status().shortRetriesUsed,3);
  });
});

test('a single connection event cannot bridge a missing-heartbeat hour or reuse a stale stable window',async t=>{
  const f=await runningFixture(t);await f.clock.advance(3600000);assert.equal(f.status().budgetResets,0);assert.equal(f.status().stableSince,null);
  await f.health(QQ);assert.ok(f.status().stableSince);await f.advanceHealthy(3599999);assert.equal(f.status().budgetResets,0);await f.advanceHealthy(1);assert.equal(f.status().budgetResets,1);
});

test('Steam poll rate limits and checkpoint failures reset the continuous-success clock',async t=>{
  for(const interruption of [{coverage:'partial',reason:'STEAM_REVIEWS_POLL_INTERRUPTED:RATE_LIMITED'},{coverage:'unavailable',reason:'Review sync failed; committed checkpoint retained'}])await t.test(interruption.reason,async t=>{
    const f=await runningFixture(t,{plugin:'steam-reviews',signal:REVIEW,probeCoverage:'partial'});await f.advanceHealthy(3540000);
    await f.health(interruption);assert.equal(f.status().stableSince,null);await f.health(REVIEW);await f.advanceHealthy(60000);assert.equal(f.status().shortRetriesUsed,3);
    await f.advanceHealthy(3540000);assert.equal(f.status().budgetResets,1);assert.equal(f.status().shortRetriesUsed,0);
  });
});

test('only valid snapshot-mode commits count as stable Steam Discussions operation',async t=>{
  const policy=builtinSources.get('steam-discussions').stability;assert.equal(policy({mode:'unavailable'},SNAPSHOT).confirmed,false);
  const f=await runningFixture(t,{plugin:'steam-discussions',signal:SNAPSHOT,probeCoverage:'partial'});await f.advanceHealthy(3599999);assert.equal(f.status().shortRetriesUsed,3);await f.advanceHealthy(1);assert.equal(f.status().budgetResets,1);
});
