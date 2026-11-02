import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { M1Runtime } from '@superagent/agent-core';
import { CompatibleChatModel, CompatibleEmbeddings } from '@superagent/llm';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
import { GitHubREST, GitHubSyncManager } from '@superagent/issue-tracker';

const {values}=parseArgs({options:{database:{type:'string'},once:{type:'boolean',default:false},project:{type:'string'},'github-write':{type:'boolean',default:false},'poll-ms':{type:'string',default:'1000'}}});
const baseURL=process.env.SA_LLM_BASE_URL,model=process.env.SA_LLM_MODEL;
if(!values.database||!baseURL||!model)throw new Error('DATABASE_AND_LLM_BASE_URL_MODEL_REQUIRED');
const interval=Number(values['poll-ms']);if(!Number.isInteger(interval)||interval<10||interval>60_000)throw new Error('INVALID_POLL_INTERVAL');
const repository=process.env.SA_GITHUB_REPOSITORY;
if(repository&&!values.project)throw new Error('GITHUB_PROJECT_SCOPE_REQUIRED');
if(values['github-write']&&(!repository||!process.env.SA_GITHUB_TOKEN))throw new Error('GITHUB_WRITE_CONFIGURATION_REQUIRED');
const filename=path.resolve(values.database);mkdirSync(path.dirname(filename),{recursive:true});
const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
const runtime=new M1Runtime(filename,{policy});
const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  const llm=new CompatibleChatModel({baseURL,model,...(process.env.SA_LLM_API_KEY?{apiKey:process.env.SA_LLM_API_KEY}:{}),thinking:'disabled',allowLoopbackHTTP:process.env.SA_ALLOW_LOOPBACK_HTTP==='1'});
  const embeddings=process.env.SA_EMBED_BASE_URL&&process.env.SA_EMBED_MODEL?new CompatibleEmbeddings({baseURL:process.env.SA_EMBED_BASE_URL,model:process.env.SA_EMBED_MODEL,...(process.env.SA_EMBED_API_KEY?{apiKey:process.env.SA_EMBED_API_KEY}:{}),allowLoopbackHTTP:process.env.SA_ALLOW_LOOPBACK_HTTP==='1'}):undefined;
  const memory=new HybridMemory(runtime.store,embeddings);
  const domain=new DomainService(runtime.store,memory,{...(repository?{repositories:{[values.project]:repository}}:{})});
  const analysis=new AnalysisWorker(runtime.store,runtime.queue,domain,memory,llm);
  const sync=repository&&process.env.SA_GITHUB_TOKEN?new GitHubSyncManager(runtime.store,domain,new GitHubREST({repository,token:process.env.SA_GITHUB_TOKEN}),{allowWrites:values['github-write']}):undefined;
  let lastStatus=0;
  do{
    const ingress=runtime.tick();let embeddingStatus='disabled';
    if(embeddings){try{embeddingStatus=`indexed:${await memory.drainEmbeddings(controller.signal)}`;}catch{embeddingStatus='unavailable';}}
    const result=await analysis.tick(controller.signal);const github=sync?await sync.tick():{processed:false,state:'not_configured'};
    if(sync&&Date.now()-lastStatus>300_000){for(const row of runtime.store.all("SELECT work_kind,work_id FROM external_work_links WHERE repository=? LIMIT 10",repository)){try{await sync.syncStatus(values.project,row.work_kind,row.work_id);}catch{/* Retain current local state until a trusted read succeeds. */}}lastStatus=Date.now();}
    if(values.once||result.processed||github.processed||Object.values(ingress).some(n=>n>0))console.log(JSON.stringify({ingress,analysis:result,github,embeddings:embeddingStatus}));
    if(values.once||controller.signal.aborted)break;
    try{await delay(interval,undefined,{signal:controller.signal});}catch(error){if(!controller.signal.aborted)throw error;}
  }while(!controller.signal.aborted);
}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);runtime.close();}
