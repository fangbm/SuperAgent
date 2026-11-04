import { configuredSecrets } from './qq-common.mjs';

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
/** Revocation belongs to the Host; a retired task cannot advance another instance's cursor. */
export function scopedSourceHost(runtime,binding,entry,owner,{env,onHealth=()=>{},onCommit=()=>{}}={}) {
  let open=true;
  const assert=()=>{if(!open)throw new Error('PLUGIN_HOST_CLOSED');owner.assert();};
  const base=runtime.ingress.sourceHost({projectId:binding.projectId,sourceId:binding.sourceId},{secretKeys:entry.permissions.secretKeys,getSecret:secretReader(entry,env)});
  return {revoke:()=>{open=false;},host:Object.freeze({...base,
    getSecret:async key=>{assert();return base.getSecret(key);},
    getCheckpoint:async()=>{assert();return base.getCheckpoint();},
    commitBatch:async(events,cp)=>{assert();const result=await base.commitBatch(events,cp);onCommit(result);return result;},
    reportHealth:async health=>{assert();await base.reportHealth(health);onHealth(health);},
  })};
}
