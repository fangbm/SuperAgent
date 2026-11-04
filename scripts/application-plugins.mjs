import { setTimeout as delay } from 'node:timers/promises';
import { builtinSources } from './source-registry.mjs';
import { validatePlugin,bounded } from './plugin-validation.mjs';
import { scopedSourceHost } from './application-plugin-host.mjs';

const healthy=coverage=>['partial','complete'].includes(coverage);
/** Keep provider error codes, not arbitrary exception bodies or credentials. */
export function sourceFailure(error,fallback='PLUGIN_FAILED') {
  const raw=typeof error==='string'?error:error?.reason??error?.code??error?.message??'';
  const code=error?.name==='ContractValidationError'?(error.contract==='plugin-manifest-v1'?'INVALID_PLUGIN_MANIFEST':'INVALID_SOURCE_EVENT'):String(raw).match(/^([A-Z][A-Z0-9_]{0,99})(?=:|\s|$)/)?.[1]??fallback;
  // This QQ budget is transient network exhaustion even though its SDK outcome is blocked.
  const detail=String(raw).match(/^[A-Z][A-Z0-9_]{0,99}:([A-Z][A-Z0-9_]{0,99})(?:\s|$)/)?.[1];
  const reason=detail?`${code}:${detail}`:code;
  if(code==='QQ_GATEWAY_RECONNECT_BUDGET')return {code,reason,retryable:true};
  const permanent=/^(?:INVALID_CONFIG|INVALID_PLUGIN_|INVALID_SOURCE_EVENT|PLUGIN_API_INCOMPATIBLE|PLUGIN_PERMISSION_|PLUGIN_SECRET_|UNAUTHORIZED|PERMISSION_DENIED|PLATFORM_BLOCKED|UNSUPPORTED_CAPABILITY|SECRET_NOT_AUTHORIZED|SOURCE_.*MISMATCH|CHECKPOINT_SOURCE_MISMATCH|INVALID_CHECKPOINT|APPLICATION_OWNERSHIP_LOST|ERR_INVALID_URL|QQ_SOURCE_(?:SECRETS_REQUIRED|BINDING_CHANGED)|QQ_INVALID_SOURCE_CONFIG|QQ_HTTP_(?:400|401|403|404)$|QQ_GATEWAY_CLOSE_(?:4001|4002|4004|4010|4011|4012|4013|4014|4914|4915)$)/.test(code);
  return {code,reason,retryable:!permanent&&error?.outcome!=='blocked'&&error?.retryable!==false};
}

/** One supervisor, one bound Host per live instance. Registry owns platform construction. */
export class ApplicationPlugins {
  constructor(runtime,config,owner,{env=process.env,factories={},operator,log=()=>{},registry=builtinSources,timing={}}={}) {
    Object.assign(this,{runtime,config,owner,env,factories,operator,log,registry});
    this.timing={now:()=>Date.now(),random:Math.random,wait:(ms,signal)=>delay(ms,undefined,{signal}),...timing};
    this.elapsed=timing.monotonicNow??timing.now??(()=>performance.now());
    this.controller=new AbortController();this.tasks=[];this.instances=new Map();this.states=new Map();this.prepared=new Map();this.closed=false;
    for(const entry of config.sources.filter(e=>e.enabled)) {
      this.prepared.set(entry.id,this.make(entry));
      this.states.set(entry.id,{state:'configured',restarts:0,recoveries:0,coverage:'unknown',consecutiveFailures:0,lastSuccessAt:null,lastFailureAt:null,error:null,nextRetryAt:null,stableSince:null,stableResetDone:false,shortRetriesUsed:0,budgetResets:0,lastBudgetResetAt:null});
    }
  }
  make(entry) {
    const definition=this.registry.get(entry.plugin),factory=this.factories[entry.plugin]??definition.factory;
    const config=definition.configure?definition.configure(entry.config,{operator:this.operator}):entry.config;
    return validatePlugin(factory(config),entry,{id:definition.id,kind:'source'});
  }
  status() {return Object.fromEntries([...this.states].map(([id,state])=>[id,structuredClone(state)]));}
  update(entry,change) {const s={...this.states.get(entry.id),...change};this.states.set(entry.id,s);this.log({kind:'plugin',sourceId:entry.id,...s});}
  start() {
    if(this.tasks.length||this.closed)throw new Error('PLUGIN_MANAGER_ALREADY_STARTED');
    const entries=this.config.sources.filter(e=>e.enabled);
    const binding=entry=>({projectId:this.config.projectId,sourceId:entry.id,sourceUri:entry.config.sourceUri,platform:this.registry.get(entry.plugin).platform});
    for(const entry of entries)this.runtime.ingress.registerSource(binding(entry));
    for(const entry of entries)this.tasks.push(this.supervise(entry,binding(entry)).catch(error=>{
      const failure=sourceFailure(error);this.update(entry,{state:'failed',coverage:'unavailable',error:failure.code,retryable:false,nextRetryAt:null});
    }));
  }
  async supervise(entry,binding) {
    const p=this.config.runtime,definition=this.registry.get(entry.plugin);
    let attempt=0,shortRetries=0,recoveries=0,budgetResets=0;
    while(!this.controller.signal.aborted) {
      const controller=new AbortController(),signal=AbortSignal.any([this.controller.signal,controller.signal]);
      let plugin,capabilityHost,run,settled=false,startFailure,stopping=false,failure,unavailable=null;
      let stableStart=null,lastStableSignal=null,stableSignals=0,stableGap=0,stableResetDone=false;
      const now=()=>new Date(this.timing.now()).toISOString();
      const clearStable=()=>{
        stableStart=null;lastStableSignal=null;stableSignals=0;stableResetDone=false;
        if(this.states.get(entry.id).stableSince!==null||this.states.get(entry.id).stableResetDone)this.update(entry,{stableSince:null,stableResetDone:false});
      };
      const checkStable=()=>{
        if(stableStart===null)return;
        const elapsed=this.elapsed();
        if(elapsed<lastStableSignal||elapsed-lastStableSignal>stableGap){clearStable();return;}
        if(!stableResetDone&&stableSignals>=2&&elapsed-stableStart>=p.stableResetMs){
          stableResetDone=true;
          const restored=shortRetries>0;shortRetries=0;if(restored)budgetResets++;
          this.update(entry,{stableResetDone:true,shortRetriesUsed:0,budgetResets,...(restored?{lastBudgetResetAt:now()}:{})});
        }
      };
      const stableHealth=health=>{
        const rule=definition.stability?.(entry.config,health);
        if(health.coverage==='unavailable'||rule?.interrupted){clearStable();return false;}
        if(rule?.confirmed){
          checkStable();
          if(stableStart===null){stableStart=this.elapsed();this.update(entry,{stableSince:now(),stableResetDone:false});}
          stableGap=rule.maxGapMs;lastStableSignal=this.elapsed();stableSignals++;
          checkStable();
        }
        return true;
      };
      const success=()=>{if(!stopping&&!this.controller.signal.aborted)this.update(entry,{lastSuccessAt:now(),consecutiveFailures:0,error:null});};
      const observedHealth=health=>{
        if(stopping||this.controller.signal.aborted)return;
        const continuous=stableHealth(health);
        unavailable=health.coverage==='unavailable'?{since:unavailable?.since??this.timing.now(),failure:sourceFailure(health.reason,'PLUGIN_HEALTH_UNAVAILABLE'),origin:'host'}:null;
        if(continuous&&healthy(health.coverage))success();
        this.update(entry,{coverage:health.coverage,state:health.coverage==='unavailable'?'unavailable':'running',healthReason:health.reason??null});
      };
      try {
        plugin=attempt===0?this.prepared.get(entry.id):this.make(entry);
        capabilityHost=scopedSourceHost(this.runtime,binding,entry,this.owner,{env:this.env,onHealth:observedHealth,onCommit:result=>{if(result.accepted>0)success();}});
        const host=capabilityHost.host;
        this.instances.set(entry.id,{plugin,host,signal});this.update(entry,{state:'probing',restarts:attempt,recoveries,nextRetryAt:null,shortRetriesUsed:shortRetries});
        const initial=await bounded(plugin.probe(),p.stopTimeoutMs);signal.throwIfAborted();
        this.update(entry,{coverage:initial.coverage,capability:initial});
        const probeFailure=cap=>sourceFailure(definition.unavailableCode?.(entry.config)??cap.reason,'PLUGIN_CAPABILITY_UNAVAILABLE');
        if(initial.coverage==='unavailable')throw probeFailure(initial);
        this.update(entry,{state:'starting'});
        run=Promise.resolve().then(()=>plugin.start(host,signal)).then(()=>{settled=true;},error=>{settled=true;startFailure=error;});
        while(!signal.aborted) {
          if(startFailure)throw startFailure;
          if(settled&&definition.mode==='blocking')throw new Error('PLUGIN_EXITED');
          if(unavailable&&!unavailable.failure.retryable)throw unavailable.failure;
          if(settled&&definition.mode==='background'&&this.states.get(entry.id).state==='starting')this.update(entry,{state:'running'});
          // Never erase a dead background connection's health with an unrelated successful sync/probe.
          if(settled&&!unavailable&&definition.mode==='background')await bounded(plugin.sync(host,signal),p.stopTimeoutMs);
          const cap=await bounded(plugin.probe(),p.stopTimeoutMs);signal.throwIfAborted();
          this.update(entry,{capability:cap});
          if(startFailure)throw startFailure;
          if(cap.coverage==='unavailable'){
            clearStable();
            const problem=probeFailure(cap);
            unavailable??={since:this.timing.now(),failure:problem,origin:'probe'};
            if(!problem.retryable)throw problem;
            this.update(entry,{coverage:'unavailable',healthReason:problem.code});
          }else if(unavailable?.origin==='probe'){
            unavailable=null;this.update(entry,{coverage:cap.coverage});
          }
          if(settled&&!unavailable&&healthy(cap.coverage)&&cap.readMessages)success();
          if(unavailable&&this.timing.now()-unavailable.since>=p.healthGraceMs)throw unavailable.failure;
          checkStable();
          await this.timing.wait(p.probeIntervalMs,signal);
        }
      }catch(error){clearStable();if(!this.controller.signal.aborted)failure=sourceFailure(error);}
      finally {
        stopping=true;clearStable();controller.abort();
        if(plugin)try{await bounded(Promise.resolve().then(()=>plugin.stop()),p.stopTimeoutMs,'PLUGIN_STOP_TIMEOUT');}catch(error){this.update(entry,{stopError:sourceFailure(error).code});}
        capabilityHost?.revoke();
        if(run)await bounded(run,p.stopTimeoutMs).catch(()=>{});
        this.instances.delete(entry.id);
      }
      if(this.controller.signal.aborted)break;
      failure??=sourceFailure('PLUGIN_EXITED');
      this.update(entry,{coverage:'unavailable',error:failure.code,lastFailureReason:failure.reason,healthReason:failure.reason,retryable:failure.retryable,
        lastFailureAt:now(),consecutiveFailures:this.states.get(entry.id).consecutiveFailures+1});
      this.runtime.ingress.reportHealth(binding,{coverage:'unavailable',reason:failure.reason,checkedAt:now()});
      if(!failure.retryable){this.update(entry,{state:'failed',nextRetryAt:null});return;}
      const short=shortRetries<p.maxRestarts;
      const ms=short?Math.min(p.maxBackoffMs,p.backoffMs*2**shortRetries):Math.floor(p.recoveryIntervalMs*(1+p.recoveryJitterRatio*Math.max(0,Math.min(1,this.timing.random()))));
      this.update(entry,{state:short?'retry_wait':'recovery_wait',nextRetryAt:new Date(this.timing.now()+ms).toISOString()});
      try{await this.timing.wait(ms,this.controller.signal);}catch(error){if(!this.controller.signal.aborted)throw error;}
      if(this.controller.signal.aborted)break;
      if(short)shortRetries++;else recoveries++;
      attempt++;
    }
    this.update(entry,{state:'stopped',coverage:'unavailable',nextRetryAt:null});
    this.runtime.ingress.reportHealth(binding,{coverage:'unavailable',reason:'APPLICATION_STOPPED',checkedAt:new Date(this.timing.now()).toISOString()});
  }
  async close(){if(this.closed)return;this.closed=true;this.controller.abort();await Promise.allSettled(this.tasks);}
}
