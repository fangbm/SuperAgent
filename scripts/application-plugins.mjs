import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { parseContract } from '@superagent/contract-validation';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { QQSource, QQC2CDelivery } from '@superagent/qq-official';
import { configuredSecrets } from './qq-common.mjs';

const require=createRequire(import.meta.url), Ajv=require('ajv/dist/2020').default;
// Existing schemas use conditional required fields declared in their parent object.
const ajv=new Ajv({strict:true,strictRequired:false,allErrors:true});require('ajv-formats')(ajv);
export const sourceCatalog={
  'qq-official':{factory:c=>new QQSource(c),id:'qq-official-source',mode:'background'},
  discord:{factory:c=>new DiscordConnector(c),id:'superagent.discord',mode:'blocking'},
  'steam-reviews':{factory:c=>new SteamReviewsConnector(c),id:'superagent.steam-reviews',mode:'blocking'},
  'steam-discussions':{factory:c=>new SteamDiscussionsConnector(c),id:'superagent.steam-discussions',mode:'blocking'},
};
export const createDelivery=c=>new QQC2CDelivery(c);
const code = error => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'PLUGIN_FAILED';
export async function bounded(task,ms,label='PLUGIN_TIMEOUT') {
  let timer;try{return await Promise.race([Promise.resolve(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}
}
export function validatePlugin(plugin,entry,kind) {
  const m=parseContract('plugin-manifest-v1',plugin.manifest);
  const expected=kind==='source'?sourceCatalog[entry.plugin].id:'qq-official-c2c-delivery';
  if(m.id!==expected||m.kind!==kind||!['^0.1.0','~0.1.0','0.1.0'].includes(m.engine.sdk))throw new Error('PLUGIN_API_INCOMPATIBLE');
  if(kind==='source'&&(!m.permissions.eventPublish||m.permissions.deliverySend)||kind==='delivery'&&(!m.permissions.deliverySend||m.permissions.eventPublish))throw new Error('PLUGIN_PERMISSION_MISMATCH');
  for(const key of ['networkHosts','secretKeys'])if(m.permissions[key].some(v=>!entry.permissions[key].includes(v))||entry.permissions[key].some(v=>!m.permissions[key].includes(v)))throw new Error('PLUGIN_PERMISSION_DENIED');
  if(!ajv.compile(m.configSchema)(entry.config))throw new Error('INVALID_PLUGIN_CONFIGURATION');
  for(const name of kind==='source'?['probe','start','sync','stop']:['probe','send'])if(typeof plugin[name]!=='function')throw new Error('INVALID_PLUGIN_IMPLEMENTATION');
  return plugin;
}
export function secretReader(entry,env=process.env) {
  let protectedReader;
  return async key=>{
    if(!entry.permissions.secretKeys.includes(key))throw new Error('SECRET_NOT_AUTHORIZED');
    const name=entry.secrets?.[key];
    if(name){if(!env[name])throw new Error('PLUGIN_SECRET_MISSING');return env[name];}
    if(entry.protectedConfig){protectedReader??=configuredSecrets({'protected-config':entry.protectedConfig});return protectedReader(key==='QQ_OPERATOR_OPENID'?'QQ_RECIPIENT_OPENID':key);}
    throw new Error('PLUGIN_SECRET_MISSING');
  };
}

/** Trusted in-process plugins get only the frozen, scoped Host. Not a JavaScript sandbox. */
export class ApplicationPlugins {
  constructor(runtime,config,owner,{env=process.env,factories={},operator,log=()=>{}}={}) {
    Object.assign(this,{runtime,config,owner,env,factories,operator,log});this.controller=new AbortController();this.tasks=[];this.instances=new Map();this.states=new Map();this.prepared=new Map();this.closed=false;
    for(const entry of config.sources.filter(e=>e.enabled)) {
      this.prepared.set(entry.id,this.make(entry)); // Validate before any Source is registered/started.
      this.states.set(entry.id,{state:'configured',restarts:0,coverage:'unknown'});
    }
  }
  make(entry) {
    const factory=this.factories[entry.plugin]??sourceCatalog[entry.plugin].factory;
    return validatePlugin(factory({...entry.config,...(entry.plugin==='qq-official'&&this.operator?{operator:this.operator}:{})}),entry,'source');
  }
  status() { return Object.fromEntries([...this.states].map(([id,state])=>[id,{...state}])); }
  update(entry,change) {const s={...this.states.get(entry.id),...change};this.states.set(entry.id,s);this.log({kind:'plugin',sourceId:entry.id,...s});}
  start() {
    if(this.tasks.length||this.closed)throw new Error('PLUGIN_MANAGER_ALREADY_STARTED');
    // Resolve every persisted binding before opening any connection.
    for(const entry of this.config.sources.filter(e=>e.enabled)) {
      const binding={projectId:this.config.projectId,sourceId:entry.id,sourceUri:entry.config.sourceUri,platform:entry.plugin};
      this.runtime.ingress.registerSource(binding);
    }
    for(const entry of this.config.sources.filter(e=>e.enabled)) {
      const binding={projectId:this.config.projectId,sourceId:entry.id,sourceUri:entry.config.sourceUri,platform:entry.plugin};
      this.tasks.push(this.supervise(entry,binding).catch(error=>{this.update(entry,{state:'failed',error:code(error)});}));
    }
  }
  async supervise(entry,binding) {
    const p=this.config.runtime;
    for(let attempt=0;attempt<=p.maxRestarts&&!this.controller.signal.aborted;attempt++) {
      const plugin=attempt===0?this.prepared.get(entry.id):this.make(entry), controller=new AbortController(),signal=AbortSignal.any([this.controller.signal,controller.signal]);
      let open=true,run,settled=false,failure,unavailableSince=null;
      const assert=()=>{if(!open)throw new Error('PLUGIN_HOST_CLOSED');this.owner.assert();};
      const base=this.runtime.ingress.sourceHost({projectId:binding.projectId,sourceId:binding.sourceId},{secretKeys:plugin.manifest.permissions.secretKeys,getSecret:secretReader(entry,this.env)});
      const host=Object.freeze({...base,
        getSecret:async key=>{assert();return base.getSecret(key);},
        getCheckpoint:async()=>{assert();return base.getCheckpoint();},
        commitBatch:async(events,cp)=>{assert();return base.commitBatch(events,cp);},
        reportHealth:async health=>{assert();await base.reportHealth(health);unavailableSince=health.coverage==='unavailable'?(unavailableSince??Date.now()):null;this.update(entry,{coverage:health.coverage,state:health.coverage==='unavailable'?'unavailable':'running'});},
      });
      this.instances.set(entry.id,{plugin,host,signal});this.update(entry,{state:'probing',restarts:attempt});
      try {
        const initial=await bounded(plugin.probe(),p.stopTimeoutMs);
        signal.throwIfAborted();
        this.update(entry,{coverage:initial.coverage,capability:initial});
        if(initial.coverage==='unavailable')throw new Error('PLUGIN_CAPABILITY_UNAVAILABLE');
        this.update(entry,{state:'starting'});
        run=Promise.resolve().then(()=>plugin.start(host,signal)).then(()=>{settled=true;},error=>{settled=true;failure=error;});
        while(!signal.aborted) {
          if(failure)throw failure;
          if(settled&&sourceCatalog[entry.plugin].mode==='blocking')throw new Error('PLUGIN_EXITED');
          if(settled&&sourceCatalog[entry.plugin].mode==='background'&&this.states.get(entry.id).state==='starting')this.update(entry,{state:'running'});
          // A background failure reported through Host health must not be erased by sync().
          if(settled&&unavailableSince===null&&sourceCatalog[entry.plugin].mode==='background')await bounded(plugin.sync(host,signal),p.stopTimeoutMs);
          const capability=await bounded(plugin.probe(),p.stopTimeoutMs);
          this.update(entry,{capability});
          if(capability.coverage==='unavailable')unavailableSince??=Date.now();
          if(unavailableSince!==null&&Date.now()-unavailableSince>=p.healthGraceMs)throw new Error('PLUGIN_HEALTH_UNAVAILABLE');
          await delay(p.probeIntervalMs,undefined,{signal});
        }
      }catch(error){if(!this.controller.signal.aborted){
        await host.reportHealth({coverage:'unavailable',reason:code(error),checkedAt:new Date().toISOString()}).catch(()=>{});
        this.update(entry,{state:attempt===p.maxRestarts?'failed':'retry_wait',error:code(error)});
      }}
      finally {
        controller.abort();
        // Let stop flush accepted work; fence the Host before releasing the shared SQLite owner.
        try{await bounded(Promise.resolve().then(()=>plugin.stop()),p.stopTimeoutMs,'PLUGIN_STOP_TIMEOUT');}catch(error){this.update(entry,{state:'failed',error:code(error)});}
        open=false;
        if(run)await bounded(run,p.stopTimeoutMs).catch(()=>{});
        this.instances.delete(entry.id);
      }
      if(!this.controller.signal.aborted&&attempt<p.maxRestarts)await delay(Math.min(p.maxBackoffMs,p.backoffMs*2**attempt),undefined,{signal:this.controller.signal}).catch(()=>{});
    }
    if(this.controller.signal.aborted)this.update(entry,{state:'stopped'});
    this.runtime.ingress.reportHealth({projectId:binding.projectId,sourceId:binding.sourceId},{coverage:'unavailable',reason:this.controller.signal.aborted?'APPLICATION_STOPPED':'PLUGIN_RESTART_BUDGET_EXHAUSTED',checkedAt:new Date().toISOString()});
  }
  async close() {if(this.closed)return;this.closed=true;this.controller.abort();await Promise.allSettled(this.tasks);}
}
