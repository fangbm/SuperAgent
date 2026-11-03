import { CompatibleChatModel, CompatibleEmbeddings } from '@superagent/llm';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
import { GitHubREST, GitHubSyncManager } from '@superagent/issue-tracker';

export function createAnalysisServices(runtime,{projectId,env=process.env,githubWrite=false,memory:providedMemory,domain:providedDomain,domainOptions={},model:providedModel}={}){
  if(!runtime)throw new Error('M3_RUNTIME_REQUIRED');
  const baseURL=env.SA_LLM_BASE_URL,modelName=env.SA_LLM_MODEL;
  if(!providedModel&&(!baseURL||!modelName))throw new Error('LLM_BASE_URL_MODEL_REQUIRED');
  const repository=env.SA_GITHUB_REPOSITORY;
  if(repository&&!projectId)throw new Error('GITHUB_PROJECT_SCOPE_REQUIRED');
  if(githubWrite&&(!repository||!env.SA_GITHUB_TOKEN))throw new Error('GITHUB_WRITE_CONFIGURATION_REQUIRED');
  const model=providedModel??new CompatibleChatModel({baseURL,model:modelName,...(env.SA_LLM_API_KEY?{apiKey:env.SA_LLM_API_KEY}:{}),thinking:'disabled',allowLoopbackHTTP:env.SA_ALLOW_LOOPBACK_HTTP==='1'});
  const embeddings=env.SA_EMBED_BASE_URL&&env.SA_EMBED_MODEL?new CompatibleEmbeddings({baseURL:env.SA_EMBED_BASE_URL,model:env.SA_EMBED_MODEL,...(env.SA_EMBED_API_KEY?{apiKey:env.SA_EMBED_API_KEY}:{}),allowLoopbackHTTP:env.SA_ALLOW_LOOPBACK_HTTP==='1'}):undefined;
  const memory=providedMemory??new HybridMemory(runtime.store,embeddings);
  const domain=providedDomain??new DomainService(runtime.store,memory,{...domainOptions,...(repository?{repositories:{...domainOptions.repositories,[projectId]:repository}}:{})});
  const analysis=new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model);
  const sync=repository&&env.SA_GITHUB_TOKEN?new GitHubSyncManager(runtime.store,domain,new GitHubREST({repository,token:env.SA_GITHUB_TOKEN}),{allowWrites:githubWrite}):undefined;
  let lastStatus=0;
  const tick=async(signal)=>{
    let embeddingStatus='disabled';
    if(embeddings){try{embeddingStatus=`indexed:${await memory.drainEmbeddings(signal)}`;}catch{embeddingStatus='unavailable';}}
    const result=await analysis.tick(signal);const github=sync?await sync.tick():{processed:false,state:'not_configured'};
    if(sync&&Date.now()-lastStatus>300_000){for(const row of runtime.store.all("SELECT work_kind,work_id FROM external_work_links WHERE repository=? LIMIT 10",repository)){try{await sync.syncStatus(projectId,row.work_kind,row.work_id);}catch{/* Retain current local state until a trusted read succeeds. */}}lastStatus=Date.now();}
    return{analysis:result,github,embeddings:embeddingStatus};
  };
  return{memory,domain,analysis,sync,tick};
}
