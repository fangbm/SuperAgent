import { CompatibleChatModel } from '@superagent/llm';
import { AnalysisWorker } from '@superagent/agent-workers';
import { GitHubSyncManager } from '@superagent/issue-tracker';

/** Same workers as worker:m3; application supplies the shared runtime/domain/memory. */
export function createM3Services(runtime,{projectId,analysis:config,model:providedModel,memory,domain,github,githubWrite=false,clock,p0Enabled=false,reportBuilder}) {
  const model=config.enabled?(providedModel??new CompatibleChatModel({baseURL:config.baseURL,model:config.model,
    ...(config.apiKey?{apiKey:config.apiKey}:{}),thinking:'disabled',allowLoopbackHTTP:config.allowLoopbackHTTP===true})):null;
  const timeoutMs=config.timeoutMs??30000;
  const analysis=model?new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{timeoutMs,leaseMs:timeoutMs+30000,
    ...(clock?{clock}:{}),...(config.maxCalls?{maxCalls:config.maxCalls}:{}),...(config.maxInputCharacters?{maxInputCharacters:config.maxInputCharacters}:{})}):null;
  const sync=github?new GitHubSyncManager(runtime.store,domain,github,{allowWrites:githubWrite,...(clock?{clock}:{}),...(reportBuilder?{reportBuilder}:{})}):null;
  const urgent=p0Enabled&&model?new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{urgentOnly:true,timeoutMs,leaseMs:timeoutMs+30000,...(clock?{clock}:{}),...(config.maxCalls?{maxCalls:config.maxCalls}:{}),...(config.maxInputCharacters?{maxInputCharacters:config.maxInputCharacters}:{})}):null;
  let lastStatus=0;
  return {analysis,sync,urgent,model,async tick(signal){
    const result=analysis?await analysis.tick(signal):{processed:false,status:'analysis_disabled'};
    const remote=sync?await sync.tick():{processed:false,state:'github_disabled'};
    if(sync&&Date.now()-lastStatus>=300000){
      for(const row of runtime.store.all('SELECT work_kind,work_id FROM external_work_links WHERE repository=? LIMIT 10',github.repository)){
        try{await sync.syncStatus(projectId,row.work_kind,row.work_id);}catch{/* Keep last confirmed state; a failed read never changes local work. */}
      }
      lastStatus=Date.now();
    }
    return {analysis:result,github:remote};
  }};
}
