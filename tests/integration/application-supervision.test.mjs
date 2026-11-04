import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplication } from '../../scripts/application.mjs';
import { bounded } from '../../scripts/plugin-validation.mjs';
import { appFixture,sourceDouble,material,eventually,SupervisorClock as Clock } from './application-helpers.mjs';

test('short network failure restores a fresh instance and records successful collection',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;let starts=0;
  const app=await createApplication(f.config,{access:f.access,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:async host=>{if(++starts===1)throw new Error('TRANSIENT_NETWORK');await host.commitBatch([material(entry,f.config.projectId)],{sourceId:entry.id,cursor:{offset:1}});await host.reportHealth({coverage:'partial',checkedAt:new Date().toISOString()});}})}});
  t.after(()=>app.close());await app.start();await eventually(()=>app.plugins.status()[entry.id].lastSuccessAt!==null);
  const state=app.plugins.status()[entry.id];assert.equal(starts,2);assert.equal(state.restarts,1);assert.equal(state.consecutiveFailures,0);assert.equal(state.error,null);assert.equal(state.coverage,'partial');assert.equal(state.nextRetryAt,null);
});

test('after short budget, low-frequency recovery uses committed checkpoint; old Host fenced, Core and another Source stay active',async t=>{
  const f=appFixture(t),[entry,other]=f.config.sources;entry.enabled=other.enabled=true;f.config.reports.enabled=true;f.config.runtime.recoveryIntervalMs=300000;
  const clock=new Clock(),hosts=[];let created=0;
  const app=await createApplication(f.config,{access:f.access,policy:f.policy,supervisorTiming:clock,sourceFactories:{
    'qq-official':()=>{const n=++created;return sourceDouble(entry,{start:async host=>{
      hosts.push(host);const checkpoint=await host.getCheckpoint();
      if(n===1){assert.equal(checkpoint,null);await host.commitBatch([material(entry,f.config.projectId,'one')],{sourceId:entry.id,cursor:{offset:1}});}
      else assert.deepEqual(checkpoint,{offset:1});
      if(n<=2)throw new Error('TRANSIENT_NETWORK');
      const result=await host.commitBatch([material(entry,f.config.projectId,'one'),material(entry,f.config.projectId,'two')],{sourceId:entry.id,cursor:{offset:2}});
      assert.equal(result.accepted,1);assert.equal(result.duplicates,1);await host.reportHealth({coverage:'partial',checkedAt:new Date().toISOString()});
    }});},
    discord:()=>sourceDouble(other,{start:host=>host.commitBatch([material(other,f.config.projectId,'healthy')])}),
  }});
  const running=app.run();running.catch(()=>{});t.after(async()=>{await app.close();await running;});
  await clock.until(()=>app.plugins.status()[entry.id].state==='recovery_wait');
  const failure=app.plugins.status()[entry.id];assert.equal(created,2);assert.equal(failure.consecutiveFailures,2);assert.equal(failure.error,'TRANSIENT_NETWORK');assert.equal(failure.coverage,'unavailable');assert.ok(failure.lastSuccessAt);assert.equal(Date.parse(failure.nextRetryAt)-clock.now(),330000);
  await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM report_revisions').n>0&&app.runtime.store.get('SELECT count(*) n FROM admission_decisions').n>=2);
  await assert.rejects(hosts[0].commitBatch([material(entry,f.config.projectId,'retired')]),/PLUGIN_HOST_CLOSED/);
  await assert.rejects(hosts[1].getCheckpoint(),/PLUGIN_HOST_CLOSED/);
  await clock.advance(329999);assert.equal(created,2);await clock.advance(1);await clock.until(()=>app.plugins.status()[entry.id].state==='running');
  const state=app.plugins.status()[entry.id];assert.equal(created,3);assert.equal(state.recoveries,1);assert.equal(state.consecutiveFailures,0);assert.ok(state.lastSuccessAt>failure.lastSuccessAt);
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?',entry.id).n,2);assert.deepEqual(await app.plugins.instances.get(entry.id).host.getCheckpoint(),{offset:2});
  assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?',other.id).n,1);
  await app.close();await running;assert.equal(clock.pending.size,0);
});

test('persistent outage respects long recovery interval/jitter and shutdown cancels every future attempt',async t=>{
  const f=appFixture(t),entry=f.config.sources[0];entry.enabled=true;f.config.runtime.maxRestarts=0;f.config.runtime.recoveryIntervalMs=300000;
  const clock=new Clock();let created=0;
  const app=await createApplication(f.config,{access:f.access,supervisorTiming:clock,sourceFactories:{'qq-official':()=>{created++;return sourceDouble(entry,{start:()=>{throw new Error('RATE_LIMITED');}});}}});
  t.after(()=>app.close());await app.start();await clock.until(()=>app.plugins.status()[entry.id].state==='recovery_wait');
  assert.equal(created,1);await clock.advance(329999);assert.equal(created,1);await clock.advance(1);await clock.until(()=>app.plugins.status()[entry.id].state==='recovery_wait'&&created===2);
  assert.equal(app.plugins.status()[entry.id].consecutiveFailures,2);assert.equal(Date.parse(app.plugins.status()[entry.id].nextRetryAt)-clock.now(),330000);
  await app.close();assert.equal(clock.pending.size,0);await clock.advance(86400000);assert.equal(created,2);assert.equal(app.plugins.status()[entry.id].state,'stopped');
});

test('explicit permanent config/auth/permission failures do not retry while another Source and Core run',async t=>{
  for(const reason of ['INVALID_CONFIG','UNAUTHORIZED','PERMISSION_DENIED'])await t.test(reason,async t=>{
    const f=appFixture(t),[entry,other]=f.config.sources;entry.enabled=other.enabled=true;const clock=new Clock();let starts=0;
    const app=await createApplication(f.config,{access:f.access,supervisorTiming:clock,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:()=>{starts++;throw new Error(reason);}}),discord:()=>sourceDouble(other,{start:host=>host.commitBatch([material(other,f.config.projectId)])})}});
    t.after(()=>app.close());await app.start();await clock.until(()=>app.plugins.status()[entry.id].state==='failed');await clock.advance(86400000);await app.tick();
    assert.equal(starts,1);const state=app.plugins.status()[entry.id];assert.equal(state.error,reason);assert.equal(state.retryable,false);assert.equal(state.nextRetryAt,null);assert.equal(state.consecutiveFailures,1);assert.equal(state.lastSuccessAt,null);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM admission_decisions').n,1);
  });
});

test('SIGTERM handling exits a child with a pending long recovery timer without another attempt',async t=>{
  const f=appFixture(t);f.config.sources[0].enabled=true;f.config.runtime.maxRestarts=0;const file=f.directory+'/signal.json';writeFileSync(file,JSON.stringify(f.config));
  const child=spawn(process.execPath,['tests/integration/application-supervision-signal-child.mjs',file],{cwd:new URL('../..',import.meta.url),windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const [ready]=await bounded(Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(stderr);})]),10000);assert.equal(ready.state,'recovery_wait');
  const messages=[];child.on('message',m=>messages.push(m));const exited=once(child,'exit');
  // Windows cannot deliver POSIX SIGTERM handlers via kill; exercise that handler
  // in the child over IPC. POSIX runs receive the actual operating-system signal.
  if(process.platform==='win32')child.send({type:'test-sigterm'});else child.kill('SIGTERM');
  const [status]=await bounded(exited,5000);assert.equal(status,0,stderr);assert.ok(messages.some(m=>m.closed&&m.attempts===1&&m.state==='stopped'));
});
