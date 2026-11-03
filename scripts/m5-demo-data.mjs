import { readFileSync } from 'node:fs';
import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
import { ReportService, reportWindow } from '@superagent/reporting';
import { OperatorAuth, TokenService, ControlPlane } from '@superagent/control-plane';
export const demoKey='superagent-demo-access-key-for-local-review';
export const demoProject='starport-demo';
export async function createDemo(filename){
  let now='2026-11-02T01:00:00.000Z';const clock=()=>now;
  const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
  const runtime=new M1Runtime(filename,{policy,clock});const memory=new HybridMemory(runtime.store);const domain=new DomainService(runtime.store,memory,{clock,authorizedActors:['web-developer','qq-developer']});
  const model={modelId:'deterministic-m5-demo-not-live-inference',generate:async request=>{
    const task=JSON.parse(request.prompt);
    if(task.task!=='extract'){
      const same=task.item.title===task.candidate.title;const refs=[{eventId:task.item.evidence[0].eventId},{eventId:task.candidate.evidence[0].eventId}];
      return{modelId:model.modelId,usage:{inputTokens:0,outputTokens:0},value:task.task==='match_bug'?{candidateIssueId:task.candidateId,relationship:same?'same_issue':'different',supportingEvidence:refs,conflictingEvidence:[],missingInformation:[],rationale:'演示用确定性关系'}:{candidateSuggestionId:task.candidateId,relationship:same?'same_request':'distinct',evidence:refs,matchingOutcome:[],conflictingRequirements:[],distinguishingDetails:[],rationale:'演示用确定性关系'}};
    }
    const message=task.messages.find(m=>m.role==='candidate');const text=message.text;const evidence=[{eventId:message.eventId,role:'primary',quote:text}];const items=[];
    if(text.includes('崩溃')||text.includes('黑屏')||text.includes('消失'))items.push({kind:'defect',category:'bug',title:text.includes('90%')?'多人联机加载至 90% 时闪退':text.includes('黑屏')?'读取存档后出现黑屏':'切换场景后装备消失',description:text,confidence:.95,observedBehavior:text,evidence});
    if(text.includes('自动重连')||text.includes('字体')||text.includes('色盲'))items.push({kind:'suggestion',category:'feature_request',title:text.includes('自动重连')?'断线后自动重连':text.includes('字体')?'增加界面字体大小选项':'提供色盲友好的标记配色',description:text,confidence:.95,requestedOutcome:text,evidence});
    return{modelId:model.modelId,usage:{inputTokens:0,outputTokens:0},value:{schemaVersion:'2.0',batchId:task.batchId,pipelineVersion:task.pipelineVersion,revision:task.revision,requiresHumanReview:false,items}};
  }};
  const worker=new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{clock});
  const sources=[{projectId:demoProject,sourceId:'QQ · 玩家测试群',sourceUri:'urn:superagent:source:m5-qq-demo',platform:'qq-official'},{projectId:demoProject,sourceId:'Discord · 反馈频道',sourceUri:'urn:superagent:source:m5-discord-demo',platform:'discord'},{projectId:demoProject,sourceId:'Steam · 商店评价',sourceUri:'urn:superagent:source:m5-steam-demo',platform:'steam-reviews'}];
  sources.forEach(s=>runtime.ingress.registerSource(s));
  const messages=['Windows 1.2.0 多人联机加载90%时崩溃，希望断线后自动重连。','读取昨天的存档后一直黑屏，重新启动也没有恢复。','切换到新场景后装备消失，背包里也找不到。','希望设置中增加字体大小选项，小字在高分屏上很难读。','建议为地图标记提供色盲友好的配色。','Windows 1.2.0 多人联机加载90%时崩溃。'];
  try{
    for(const [i,text]of messages.entries()){
      now=new Date(Date.parse(now)+60_000).toISOString();const source=sources[i===5?1:0];
      runtime.ingress.commitBatch(source,[{specversion:'1.0',id:`demo-${i}`,source:source.sourceUri,type:'com.superagent.feedback.message.created.v1',time:now,datacontenttype:'application/json',data:{schemaVersion:'1.0',projectId:demoProject,sourceId:source.sourceId,platform:source.platform,object:{kind:'message',externalId:`message-${i}`,revision:'original'},content:{text}}}]);runtime.tick();
      for(const row of runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))runtime.buffer.flushSync(row.segment_id,'replay');
      const result=await worker.tick();if(result.status!=='succeeded')throw new Error('M5_DEMO_ANALYSIS_FAILED');
    }
    now='2026-11-02T09:30:00.000Z';const source=sources[2];runtime.ingress.commitBatch(source,[{specversion:'1.0',id:'steam-demo-review',source:source.sourceUri,type:'com.superagent.feedback.review.created.v1',time:now,datacontenttype:'application/json',data:{schemaVersion:'1.0',projectId:demoProject,sourceId:source.sourceId,platform:'steam-reviews',object:{kind:'review',externalId:'review-demo',revision:'original'},content:{text:'联机连接不稳定，但美术和音乐很喜欢。希望团队优先改善网络体验。'},attributes:{sentiment:'negative'}}}]);runtime.tick();
    runtime.ingress.reportHealth(sources[0],{coverage:'partial',reason:'QQ_MENTIONS_ONLY_OBSERVED_NO_HISTORY_OR_EDITS',checkedAt:now});runtime.ingress.reportHealth(sources[1],{coverage:'unknown',reason:'SYNTHETIC_DEMO_NOT_LIVE_DISCORD',checkedAt:now});runtime.ingress.reportHealth(sources[2],{coverage:'partial',reason:'SYNTHETIC_DEMO_NOT_LIVE_STEAM',checkedAt:now});
    now='2026-11-02T10:04:00.000Z';const reports=new ReportService(runtime.store,domain,runtime.queue,{clock});reports.generate(reportWindow(demoProject,'2026-11-02T10:00:00.000Z'));
    const auth=new OperatorAuth(runtime.store,clock);auth.register({actorRef:'web-developer',role:'developer',projects:[demoProject]},demoKey);const tokens=new TokenService(runtime.store,'separate-demo-cursor-signing-key-32-bytes',clock);const control=new ControlPlane(runtime.store,domain,reports,auth,tokens,clock);
    return{runtime,domain,reports,control,clock};
  }catch(error){runtime.close();throw error;}
}
