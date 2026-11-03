import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { M1Runtime } from '@superagent/agent-core';
import { createAnalysisServices } from './m3-services.mjs';

const {values}=parseArgs({options:{database:{type:'string'},once:{type:'boolean',default:false},project:{type:'string'},'github-write':{type:'boolean',default:false},'poll-ms':{type:'string',default:'1000'}}});
const baseURL=process.env.SA_LLM_BASE_URL,modelName=process.env.SA_LLM_MODEL;
if(!values.database||!baseURL||!modelName)throw new Error('DATABASE_AND_LLM_BASE_URL_MODEL_REQUIRED');
const interval=Number(values['poll-ms']);if(!Number.isInteger(interval)||interval<10||interval>60_000)throw new Error('INVALID_POLL_INTERVAL');
const repository=process.env.SA_GITHUB_REPOSITORY;
if(repository&&!values.project)throw new Error('GITHUB_PROJECT_SCOPE_REQUIRED');
if(values['github-write']&&(!repository||!process.env.SA_GITHUB_TOKEN))throw new Error('GITHUB_WRITE_CONFIGURATION_REQUIRED');
const filename=path.resolve(values.database);mkdirSync(path.dirname(filename),{recursive:true});
const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
const runtime=new M1Runtime(filename,{policy});
const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  const services=createAnalysisServices(runtime,{projectId:values.project,env:process.env,githubWrite:values['github-write']});
  do{
    const ingress=runtime.tick();const result=await services.tick(controller.signal);
    if(values.once||result.analysis.processed||result.github.processed||Object.values(ingress).some(n=>n>0))console.log(JSON.stringify({ingress,...result}));
    if(values.once||controller.signal.aborted)break;
    try{await delay(interval,undefined,{signal:controller.signal});}catch(error){if(!controller.signal.aborted)throw error;}
  }while(!controller.signal.aborted);
}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);runtime.close();}
