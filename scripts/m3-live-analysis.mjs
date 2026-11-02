// The secret is read once from stdin or the process environment, never persisted.
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';
import { CompatibleChatModel } from '@superagent/llm';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';

let config={apiKey:process.env.SA_LLM_API_KEY,baseURL:process.env.SA_LLM_BASE_URL,model:process.env.SA_LLM_MODEL,repository:process.env.SA_GITHUB_REPOSITORY};
if(!config.apiKey){const input=createInterface({input:process.stdin});const line=await new Promise((resolve,reject)=>{input.once('line',resolve);input.once('close',()=>reject(new Error('LIVE_CONFIGURATION_REQUIRED')));});config=JSON.parse(line);input.close();process.stdin.destroy();}
if(!config.apiKey||!config.baseURL||!config.model||!config.repository)throw new Error('LIVE_CONFIGURATION_REQUIRED');
mkdirSync('.artifacts',{recursive:true});const directory=mkdtempSync(path.resolve('.artifacts/m3-live-'));const database=path.join(directory,'state.sqlite');
const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
const runtime=new M1Runtime(database,{policy});
const model=new CompatibleChatModel({baseURL:config.baseURL,model:config.model,apiKey:config.apiKey,thinking:'disabled'});
const memory=new HybridMemory(runtime.store);const projectId='m3-live-acceptance';
const domain=new DomainService(runtime.store,memory,{repositories:{[projectId]:config.repository}});
const worker=new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{timeoutMs:30_000,leaseMs:60_000});
try{
  const statuses=[];
  for(const [platform,id,text] of [
    ['qq-official','qq-demo','M3验收合成样例：Windows 1.2.0，多人联机加载到90%时崩溃。希望断线后能够自动重连。'],
    ['discord','discord-demo','M3验收合成样例：Windows 1.2.0，多人联机载入90%时直接崩溃退出，与前面反馈相同。'],
  ]){
    const binding={projectId,sourceId:id,sourceUri:`urn:superagent:source:${id}`,platform};runtime.ingress.registerSource(binding);
    const event={specversion:'1.0',id:'synthetic-message-1',source:binding.sourceUri,type:'com.superagent.feedback.message.created.v1',time:new Date().toISOString(),datacontenttype:'application/json',
      data:{schemaVersion:'1.0',projectId,sourceId:id,platform,object:{kind:'message',externalId:'synthetic-object-1',revision:'original'},content:{text}}};
    runtime.ingress.commitBatch({projectId,sourceId:id},[event]);runtime.tick();
    for(const segment of runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))runtime.buffer.flushSync(segment.segment_id,'replay');
    const result=await worker.tick();statuses.push(result);console.log(JSON.stringify({stage:'analysis',platform,...result}));
    if(result.status!=='succeeded')break;
  }
  const works=runtime.store.all('SELECT work_kind,work_id,content_json FROM work_metadata').map(row=>({kind:row.work_kind,id:row.work_id,...JSON.parse(row.content_json)}));
  const report={database,repository:config.repository,model:config.model,baseURL:config.baseURL,input:'synthetic QQ/Discord messages, not live platform collection',statuses,works,
    modelCalls:runtime.store.all('SELECT schema_id,model_id,status,usage_json,error_code FROM model_calls'),outbox:runtime.store.all('SELECT * FROM github_sync_outbox'),remoteWritesPerformed:false};
  writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync('.artifacts/m3-live-latest.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({stage:'result',database,resultFile:path.join(directory,'result.json'),works:works.map(w=>({id:w.id,kind:w.kind,title:w.title,feedbackCount:w.feedbackCount,reviewRequired:w.reviewRequired})),modelCalls:report.modelCalls}));
  if(statuses.some(s=>s.status!=='succeeded'))process.exitCode=1;
}finally{runtime.close();}
