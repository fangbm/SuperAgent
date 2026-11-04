import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { parseContract } from '@superagent/contract-validation';
import { createApplication } from '../../scripts/application.mjs';
import { builtinSources,createSourceRegistry } from '../../scripts/source-registry.mjs';
import { parseApplicationConfig } from '../../scripts/application-config.mjs';
import { sourceFailure } from '../../scripts/application-plugins.mjs';
import { appFixture,eventually,material } from './application-helpers.mjs';

function extraFixture(t,{manifestId='example.source',permissionKeys=[]}={}) {
  const f=appFixture(t),entry={id:'extra-main',plugin:'extra',enabled:true,config:{sourceUri:'urn:source:extra'},permissions:{networkHosts:[],secretKeys:permissionKeys},secrets:{}};
  f.config.sources=[entry];f.config.deliveries=[];
  const manifest={apiVersion:'superagent.io/plugin/v1',id:manifestId,version:'0.1.0',displayName:'Trusted example',kind:'source',engine:{sdk:'^0.1.0'},permissions:{networkHosts:[],secretKeys:[],eventPublish:true},configSchema:{type:'object',additionalProperties:false,properties:{sourceUri:{type:'string',format:'uri'}},required:['sourceUri']}};
  let created=0;
  const registry=createSourceRegistry({extra:{id:'example.source',platform:'discord',mode:'background',factory:()=>{
    created++;return {manifest,probe:async()=>({connection:'push',coverage:'partial',readMessages:true,readHistory:false,readEdits:false,readAttachments:false}),
      start:async host=>{const event=material(entry,f.config.projectId);event.data.platform='discord';await host.commitBatch([event],{sourceId:entry.id,cursor:{offset:1}});},sync:async()=>{},stop:async()=>{}};
  }}});
  return {...f,entry,registry,created:()=>created};
}

test('trusted registry resolves the four builtins and rejects unknown executable module names',t=>{
  const f=appFixture(t);
  for(const key of ['qq-official','discord','steam-reviews','steam-discussions'])assert.equal(typeof builtinSources.get(key).factory,'function');
  assert.throws(()=>builtinSources.get('file:///untrusted.mjs'),/UNKNOWN_SOURCE_PLUGIN/);
  assert.throws(()=>builtinSources.get('__proto__'),/UNKNOWN_SOURCE_PLUGIN/);
  f.config.sources[0].plugin='file:///untrusted.mjs';assert.throws(()=>parseApplicationConfig(f.config),/INVALID_APPLICATION_PLUGIN/);
  f.config.sources[0].plugin='qq-official';f.config.sources[0].module='./anything.mjs';assert.throws(()=>parseApplicationConfig(f.config),/INVALID_APPLICATION_PLUGIN/);
  assert.throws(()=>createSourceRegistry({extra:{factory:'./file.mjs'}}),/INVALID_SOURCE_REGISTRATION/);
});

test('registering one trusted Source plus configuration requires no supervisor or parser platform changes',async t=>{
  const f=extraFixture(t);const app=await createApplication(f.config,{access:f.access,sourceRegistry:f.registry});f.after(()=>app.close());await app.start();
  await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===1);
  assert.equal(f.created(),1);assert.equal(app.runtime.store.get('SELECT platform FROM sources WHERE source_id=?',f.entry.id).platform,'discord');
  assert.deepEqual(await app.plugins.instances.get(f.entry.id).host.getCheckpoint(),{offset:1});
});

test('registry manifest ID mismatch is rejected before archive initialization',async t=>{
  const f=extraFixture(t,{manifestId:'example.wrong'});await assert.rejects(createApplication(f.config,{access:f.access,sourceRegistry:f.registry}),/PLUGIN_API_INCOMPATIBLE/);assert.equal(existsSync(f.config.database),false);
});

test('registry loading still enforces Manifest permissions and platform config Schema',async t=>{
  const f=extraFixture(t,{permissionKeys:['UNDECLARED_KEY']});await assert.rejects(createApplication(f.config,{access:f.access,sourceRegistry:f.registry}),/PLUGIN_PERMISSION_DENIED/);
  f.entry.permissions.secretKeys=[];f.entry.config.businessPolicy='archive_only';await assert.rejects(createApplication(f.config,{access:f.access,sourceRegistry:f.registry}),/INVALID_PLUGIN_CONFIGURATION/);
});

test('recovery configuration rejects intervals below five minutes and missing jitter',t=>{
  const f=appFixture(t);f.config.runtime.recoveryIntervalMs=299999;assert.throws(()=>parseApplicationConfig(f.config),/INVALID_APPLICATION_RUNTIME/);
  f.config.runtime.recoveryIntervalMs=300000;
  for(const ratio of [0,0.09,0.51,NaN,'0.2']){f.config.runtime.recoveryJitterRatio=ratio;assert.throws(()=>parseApplicationConfig(f.config),/INVALID_APPLICATION_RUNTIME/);}
  f.config.runtime.recoveryJitterRatio=0.2;assert.equal(parseApplicationConfig(f.config).runtime.recoveryIntervalMs,300000);
});

test('failure classification preserves permanent provider codes and transient exhausted connection budgets',()=>{
  for(const error of [new Error('UNAUTHORIZED: do-not-log-secret'),new Error('PERMISSION_DENIED: missing intent'),new Error('INVALID_CONFIG: source'),new Error('QQ_HTTP_401'),new Error('QQ_GATEWAY_CLOSE_4004'),new Error('INVALID_CHECKPOINT')])assert.equal(sourceFailure(error).retryable,false);
  assert.deepEqual(sourceFailure('PLATFORM_BLOCKED:QQ_API_11253'),{code:'PLATFORM_BLOCKED',reason:'PLATFORM_BLOCKED:QQ_API_11253',retryable:false});
  assert.equal(sourceFailure(Object.assign(new Error('QQ_GATEWAY_RECONNECT_BUDGET'),{outcome:'blocked'})).retryable,true);
  assert.equal(sourceFailure(new Error('TRANSIENT_NETWORK')).retryable,true);
  assert.equal(JSON.stringify(sourceFailure(new Error('UNAUTHORIZED: do-not-log-secret'))).includes('do-not-log-secret'),false);
  for(const [contract,expected] of [['plugin-manifest-v1','INVALID_PLUGIN_MANIFEST'],['normalized-event-v1','INVALID_SOURCE_EVENT']]){
    let error;try{parseContract(contract,{});}catch(caught){error=caught;}assert.ok(error);assert.equal(sourceFailure(error).code,expected);assert.equal(sourceFailure(error).retryable,false);
  }
});
