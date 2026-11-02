// No network or external writes: a deterministic model adapter illustrates the
// production domain pipeline. Use worker:m3 for configured HTTP model inference.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
mkdirSync('.artifacts',{recursive:true});const file=path.join(mkdtempSync(path.resolve('.artifacts/m3-demo-')),'state.sqlite');
const policy=JSON.parse(readFileSync('config/batching.default.json','utf8')).feedbackBatching;
const runtime=new M1Runtime(file,{policy});
const memory=new HybridMemory(runtime.store);const domain=new DomainService(runtime.store,memory);
const adapter={modelId:'deterministic-demo-adapter',generate:async request=>{const input=JSON.parse(request.prompt);const message=input.messages[0];return{modelId:'deterministic-demo-adapter',usage:{inputTokens:0,outputTokens:0},value:{schemaVersion:'2.0',batchId:input.batchId,pipelineVersion:input.pipelineVersion,revision:input.revision,requiresHumanReview:true,items:[{kind:'suggestion',category:'feature_request',title:'自动重连',description:'希望断线后自动重连',confidence:0.9,requestedOutcome:'断线后自动重连',evidence:[{eventId:message.eventId,role:'primary',quote:message.text}]}]}};}};
try{
  const binding={projectId:'m3-demo',sourceId:'qq-demo',sourceUri:'urn:superagent:source:qq-demo',platform:'qq-official'};runtime.ingress.registerSource(binding);
  runtime.ingress.commitBatch(binding,[{specversion:'1.0',id:'demo',source:binding.sourceUri,type:'com.superagent.feedback.message.created.v1',time:new Date().toISOString(),datacontenttype:'application/json',data:{schemaVersion:'1.0',projectId:binding.projectId,sourceId:binding.sourceId,platform:binding.platform,object:{kind:'message',externalId:'one',revision:'original'},content:{text:'希望断线后自动重连'}}}]);runtime.tick();
  for(const row of runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))runtime.buffer.flushSync(row.segment_id,'replay');
  const result=await new AnalysisWorker(runtime.store,runtime.queue,domain,memory,adapter).tick();
  console.log(JSON.stringify({scope:'deterministic adapter; no real inference, no external writes',database:file,result,works:runtime.store.all('SELECT work_kind,content_json FROM work_metadata')},null,2));
}finally{runtime.close();}
