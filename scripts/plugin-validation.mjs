import { createRequire } from 'node:module';
import { parseContract } from '@superagent/contract-validation';

const require=createRequire(import.meta.url),Ajv=require('ajv/dist/2020').default;
const ajv=new Ajv({strict:true,strictRequired:false,allErrors:true});require('ajv-formats')(ajv);
export async function bounded(task,ms,label='PLUGIN_TIMEOUT') {
  let timer;try{return await Promise.race([Promise.resolve(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}
}
export function validatePlugin(plugin,entry,{id,kind}) {
  const m=parseContract('plugin-manifest-v1',plugin.manifest);
  if(m.id!==id||m.kind!==kind||!['^0.1.0','~0.1.0','0.1.0'].includes(m.engine.sdk))throw new Error('PLUGIN_API_INCOMPATIBLE');
  if(kind==='source'&&(!m.permissions.eventPublish||m.permissions.deliverySend)||kind==='delivery'&&(!m.permissions.deliverySend||m.permissions.eventPublish))throw new Error('PLUGIN_PERMISSION_MISMATCH');
  for(const key of ['networkHosts','secretKeys'])if(m.permissions[key].some(v=>!entry.permissions[key].includes(v))||entry.permissions[key].some(v=>!m.permissions[key].includes(v)))throw new Error('PLUGIN_PERMISSION_DENIED');
  if(!ajv.compile(m.configSchema)(entry.config))throw new Error('INVALID_PLUGIN_CONFIGURATION');
  for(const name of kind==='source'?['probe','start','sync','stop']:['probe','send'])if(typeof plugin[name]!=='function')throw new Error('INVALID_PLUGIN_IMPLEMENTATION');
  return plugin;
}
