import { createRequire } from 'node:module';
import { SqliteStore, canonicalJSON, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DurableJobQueue } from '@superagent/job-queue';
import type { JobView } from '@superagent/job-queue';
import { parseContract } from '@superagent/contract-validation';
import { DomainService } from '@superagent/domain';
import type { AnalysisIdentity, MatchProposal, Resolution } from '@superagent/domain';
import { HybridMemory } from '@superagent/memory';
import type { WorkSnapshot } from '@superagent/memory';
import { ModelError, validateStructured } from '@superagent/llm';
import type { StructuredModel } from '@superagent/llm';
import type { AgentContextV2, AgentRunViewV1, FeedbackBatchV1, FeedbackItemV2, InternalEventId, JSONValue, TriageResultV2 } from '@superagent/contracts';

const require=createRequire(import.meta.url);
const extractionSchema:object=require('@superagent/contracts/schemas/triage-result-v2.schema.json');
const json=(v:unknown)=>canonicalJSON(v as JSONValue);
const objectSchema=(properties:Record<string,object>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const strings={type:'array',items:{type:'string'}};
function matchSchema(kind:FeedbackItemV2['kind'],candidate:WorkSnapshot,ids:string[]):object {
  const evidence={type:'array',minItems:1,items:objectSchema({eventId:{type:'string',enum:ids}})};
  return kind==='defect'?objectSchema({candidateIssueId:{const:candidate.id},relationship:{enum:['same_issue','related','different','uncertain']},supportingEvidence:evidence,conflictingEvidence:strings,missingInformation:strings,rationale:{type:'string',minLength:1}})
    :objectSchema({candidateSuggestionId:{const:candidate.id},relationship:{enum:['same_request','related','distinct','uncertain']},evidence,matchingOutcome:{...strings,description:'Shared requested outcomes; put confirmations and similarities here or in rationale.'},conflictingRequirements:{...strings,description:'Actual conflicting requirements only. Use [] when there are none.'},distinguishingDetails:{...strings,description:'Only actual differences or unresolved missing information that prevent confident identity. Use [] if the requests are identical. Shared evidence, identical outcomes, paraphrases and confirmations are not distinctions.'},rationale:{type:'string',minLength:1}});
}
export class AnalysisWorker {
  private readonly clock:Clock;
  constructor(readonly store:SqliteStore,readonly queue:DurableJobQueue,readonly domain:DomainService,readonly memory:HybridMemory,readonly model:StructuredModel,
    private readonly options:{clock?:Clock;pipelineVersion?:string;timeoutMs?:number;leaseMs?:number;maxCalls?:number;maxItems?:number;maxInputCharacters?:number;urgentOnly?:boolean}={}){
    this.clock=options.clock??systemClock;
    if((options.timeoutMs??30_000)<1||(options.leaseMs??60_000)<(options.timeoutMs??30_000)+1_000)throw new Error('MODEL_TIMEOUT_MUST_FIT_LEASE');
  }
  private now():string{return timestamp(this.clock());}
  reanalyze(projectId:string,batchId:string,pipelineVersion:string):string{
    const batch=this.store.get<{project_id:string}>('SELECT project_id FROM feedback_batches WHERE batch_id=?',batchId);if(batch?.project_id!==projectId)throw new Error('BATCH_NOT_AUTHORIZED');
    return this.store.transaction(()=>{const revision=this.store.get<{n:number}>('SELECT coalesce(max(revision),0)+1 n FROM analysis_requests WHERE batch_id=?',batchId)!.n;
      this.domain.prepare(batchId,pipelineVersion,revision);
      return this.queue.create(projectId,'feedback.extract.v2',{batchId,pipelineVersion,revision},`reanalyze:${batchId}:${pipelineVersion}:${revision}`).jobId;});
  }
  async tick(signal:AbortSignal=new AbortController().signal):Promise<{processed:boolean;status?:string;runId?:string}>{
    if(signal.aborted)return {processed:false};
    this.store.run("UPDATE agent_runs SET status='failed',ended_at=?,error_code='WORKER_LEASE_EXPIRED' WHERE status='running' AND EXISTS(SELECT 1 FROM jobs j WHERE j.job_id=agent_runs.job_id AND (j.attempt<>agent_runs.attempt OR j.status NOT IN ('leased','running') OR j.lease_until<=?))",this.now(),this.now());
    this.store.run("UPDATE model_calls SET status='interrupted',ended_at=?,error_code='WORKER_LEASE_EXPIRED' WHERE status='running' AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.run_id=model_calls.run_id AND r.error_code='WORKER_LEASE_EXPIRED')",this.now());
    const job=this.queue.claim(this.options.urgentOnly?'m3-urgent-analysis':'m3-analysis','full_agent',this.options.leaseMs??60_000,['feedback.batch.triage','feedback.extract.v2'],this.options.urgentOnly?100:undefined,!this.options.urgentOnly);if(!job)return {processed:false};
    this.queue.start(job.jobId,job.leaseToken!);
    let runId:string|undefined;
    try{
      if(!job.payload||typeof job.payload!=='object'||Array.isArray(job.payload)||typeof job.payload.batchId!=='string')throw new Error('INVALID_ANALYSIS_TASK');
      const revision=typeof job.payload.revision==='number'?job.payload.revision:1;
      const existing=this.store.get<{pipeline_version:string}>('SELECT pipeline_version FROM analysis_requests WHERE batch_id=? AND revision=?',job.payload.batchId,revision);
      const pipelineVersion=typeof job.payload.pipelineVersion==='string'?job.payload.pipelineVersion:(existing?.pipeline_version??this.options.pipelineVersion??'triage-v2.2');
      const identity=this.domain.prepare(job.payload.batchId,pipelineVersion,revision);
      if(identity.projectId!==job.projectId)throw new Error('BATCH_PROJECT_MISMATCH');
      if(this.store.get('SELECT 1 FROM triage_extractions WHERE triage_id=?',identity.triageId)){this.queue.complete(job.jobId,job.leaseToken!);return {processed:true,status:'already_completed'};}
      const batch=JSON.parse(this.store.get<{batch_json:string}>('SELECT batch_json FROM feedback_batches WHERE batch_id=?',identity.batchId)!.batch_json) as FeedbackBatchV1;
      runId=stableId('run',job.jobId,String(job.attempt));
      this.store.run("INSERT INTO agent_runs(run_id,job_id,project_id,worker_id,triage_id,attempt,status,queued_at,started_at,input_event_ids_json,model_id) VALUES(?,?,?,?,?,?,'running',?,?,?,?)",runId,job.jobId,job.projectId,'m3-analysis',identity.triageId,job.attempt,this.now(),this.now(),json(batch.candidateEventIds),this.model.modelId);
      const context=this.context(identity,runId,job,signal);
      const messages=[...batch.candidateEventIds.map(id=>({id,role:'candidate'})),...batch.contextEventIds.map(id=>({id,role:'context'}))].flatMap(({id,role})=>{
        const e=this.domain.evidence(job.projectId,id);if(!e||e.deleted||(role==='candidate'&&!e.current))return [];
        if(e.event.type==='com.superagent.source.coverage.changed.v1')return [];
        // Preserve body as the evidence text; thread titles are explicit source
        // evidence and may be quoted separately (checked by DomainService).
        const title=e.event.data.object.kind==='thread'&&typeof e.event.data.attributes?.title==='string'
          ? e.event.data.attributes.title.trim().slice(0,2048):'';
        const command=this.store.get<{intent_json:string}>('SELECT intent_json FROM qq_explicit_feedback WHERE event_id=? AND project_id=? AND outcome=\'QQ_EXPLICIT_IMMEDIATE\'',id,job.projectId);
        const intent=command?JSON.parse(command.intent_json) as {kind:string;start:number;end:number}:undefined;
        return [{eventId:id,role,text:intent?e.text.slice(intent.start):e.text,...(intent?{explicitIntent:intent.kind,originalText:e.text,projection:{start:intent.start,end:intent.end,unit:'UTF-16'}}:{}),attachments:(e.event.data.content?.attachments??[]).map(a=>({kind:a.kind,...(a.mimeType?{mimeType:a.mimeType}:{}),...(a.assetRef?{assetRef:a.assetRef}:{}),contentAnalyzed:false})),...(title?{title}:{}),platform:e.event.data.platform,object:e.event.data.object,time:e.event.time}];
      });
      const prompt=json({task:'extract',instructions:'Extract 0..N independent defect/suggestion items. Copy batchId, pipelineVersion, revision exactly. Each item needs primary evidence from candidate messages; context alone is not new feedback. Preserve EVERY independent candidate report of an extracted issue or request as primary evidence. When multiple candidate messages independently report the same problem, either include all those reports as primary anchors in one item or emit separate items; do not downgrade a second independent report to corroboration just because the problem is the same. Corroboration is supporting context, not a replacement for counting independent reports. Do not turn unrelated chat or questions into feedback. Thread titles are part of source evidence: consider both title and body; a quote must come verbatim from either title or body, never across their boundary. Use an EXACT verbatim quote. OMIT the optional start/end fields entirely: do not estimate character offsets. Explicit intent is an untrusted player request, not a classification or severity constraint; correct it or return zero items for non-feedback. Attachment metadata does not mean image content was seen; never infer attachment contents or trust temporary URLs. Quotes must be exact original source text. Do not infer causes or invent personal identities. Output JSON.',batchId:identity.batchId,pipelineVersion:identity.pipelineVersion,revision:identity.revision,messages});
      if(prompt.length>(this.options.maxInputCharacters??60_000))throw new ModelError('MODEL_INPUT_BUDGET_EXCEEDED',false);
      const result:TriageResultV2=messages.some(m=>m.role==='candidate')?parseContract('triage-result-v2',await context.llm.generateStructured({schemaId:'triage-result-v2',prompt,timeoutMs:this.options.timeoutMs??30_000,maxOutputTokens:4096})):
        {schemaVersion:'2.0',batchId:identity.batchId,pipelineVersion:identity.pipelineVersion,revision:identity.revision,items:[],requiresHumanReview:true,nonActionableReason:'insufficient_context'};
      if(result.batchId!==identity.batchId||result.pipelineVersion!==identity.pipelineVersion||result.revision!==identity.revision)throw new ModelError('MODEL_IDENTITY_MISMATCH',false);
      if(result.items.length>(this.options.maxItems??20))throw new ModelError('MODEL_ITEM_BUDGET_EXCEEDED',false);
      const resolutions:Resolution[]=[];const planned:WorkSnapshot[]=[];
      for(const [index,item] of result.items.entries()){
        this.domain.validateEvidence(identity.projectId,item,batch);
        this.queue.heartbeat(job.jobId,job.leaseToken!,this.options.leaseMs??60_000);
        const retrieved=await this.memory.search(identity.projectId,item.kind,`${item.title} ${item.description}`,3,signal);
        const candidates=[...retrieved.items,...planned.filter(p=>p.kind===item.kind)].filter((c,i,a)=>c.feedbackCount>0&&c.evidence.some(e=>e.role==='primary')&&a.findIndex(x=>x.id===c.id)===i).slice(0,3);
        const matches:MatchProposal[]=[];
        for(const candidate of candidates){
          const chosen=candidate.evidence.filter(e=>e.role==='primary'&&!this.domain.evidence(identity.projectId,e.eventId)?.deleted).filter((e,i,a)=>a.findIndex(x=>x.eventId===e.eventId)===i).slice(0,5);
          const ids=[...new Set([...item.evidence.map(e=>e.eventId),...chosen.map(e=>e.eventId)])];
          if(!ids.length)continue;
          const schema=matchSchema(item.kind,candidate,ids);
          // Match against the player's actual source evidence, not only the
          // previously generated work summary. Thread title is a separate field.
          const evidence=chosen.flatMap(anchor=>{
            const e=this.domain.evidence(identity.projectId,anchor.eventId);
            return e&&!e.deleted?[{eventId:anchor.eventId,text:e.text,...(e.title?{title:e.title.trim().slice(0,2048)}:{})}]:[];
          });
          const {evidence:_historical,confidence:_confidence,...content}=candidate.content;
          const instructions='Compare triggering conditions, observed/requested outcome, versions, platform and evidence. Related is not identical. For thread evidence consider original title as well as body, not just the generated summary. Cite evidence from both the new item and candidate. Missing/conflicting information means uncertain. '+(item.kind==='suggestion'?'For the same request without genuine differences, conflictingRequirements and distinguishingDetails must both be []. Put shared evidence, identical wording, confirmations and reasoning in matchingOutcome or rationale, never in distinguishingDetails. A title paraphrase or the same primary event is not a difference. If important information is actually missing or conflicting, report it and do not declare same_request. ':'')+'Return JSON.';
          const raw=await this.call(identity,runId,job,item.kind==='defect'?'bug-match-v1':'suggestion-match-v1',schema,json({task:item.kind==='defect'?'match_bug':'match_suggestion',instructions,item,candidate:{id:candidate.id,kind:candidate.kind,title:candidate.title,summary:candidate.summary,status:candidate.status,feedbackCount:candidate.feedbackCount,content,evidence,evidenceTruncated:candidate.evidence.length>chosen.length},candidateId:candidate.id}),signal);
          const value=raw as Record<string,JSONValue>;
          const relation=String(value.relationship);const refs=(value.supportingEvidence??value.evidence) as Array<{eventId:string}>;
          const normalized:MatchProposal={candidateId:candidate.id,relationship:relation==='same_issue'||relation==='same_request'?'same':relation==='distinct'?'different':relation as MatchProposal['relationship'],evidenceIds:refs.map(e=>e.eventId),conflicts:(value.conflictingEvidence??value.conflictingRequirements??[]) as string[],missing:(value.missingInformation??value.distinguishingDetails??[]) as string[],rationale:String(value.rationale),raw};
          if(normalized.relationship==='same'&&(!normalized.evidenceIds.some(id=>item.evidence.some(e=>e.role==='primary'&&e.eventId===id))||!normalized.evidenceIds.some(id=>candidate.evidence.some(e=>e.role==='primary'&&e.eventId===id))))normalized.relationship='uncertain';
          matches.push(normalized);
        }
        const same=matches.filter(m=>m.relationship==='same'&&!m.conflicts.length&&!m.missing.length);
        const review=result.requiresHumanReview||same.length>1||matches.some(m=>m.relationship==='uncertain'||m.conflicts.length||m.missing.length)||retrieved.semanticPoolTruncated;
        const target=same.length===1?same[0]!.candidateId:undefined;
        resolutions.push({item,matches,reviewRequired:review,...(target?{targetId:target}:{})});
        if(!target)planned.push({id:this.domain.expectedWorkId(identity,index),projectId:identity.projectId,kind:item.kind,title:item.title,summary:item.description,status:'candidate',version:1,reviewRequired:review,priority:0,feedbackCount:1,evidence:item.evidence,content:item});
      }
      this.store.transaction(()=>{this.domain.commit(identity,result,resolutions,this.model.modelId);this.queue.complete(job.jobId,job.leaseToken!);this.store.run("UPDATE agent_runs SET status='succeeded',ended_at=? WHERE run_id=?",this.now(),runId!);});
      return {processed:true,status:'succeeded',runId};
    }catch(error){
      const code=error instanceof ModelError?error.code:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'ANALYSIS_FAILED';
      const retry=code==='MODEL_CANCELLED'||(error instanceof ModelError?error.retryable:['RESOLUTION_STALE_RETRIEVE_AGAIN','STALE_EVIDENCE'].includes(code));
      try{this.queue.fail(job.jobId,job.leaseToken!,code,retry);}catch{/* A lost lease must never acknowledge a replacement worker. */}
      if(runId)this.store.run("UPDATE agent_runs SET status=?,ended_at=?,error_code=? WHERE run_id=?",code==='MODEL_CANCELLED'?'cancelled':'failed',this.now(),code,runId);
      return {processed:true,status:code,...(runId?{runId}:{})};
    }
  }
  private async call(identity:AnalysisIdentity,runId:string,job:JobView,schemaId:string,schema:object,prompt:string,signal:AbortSignal):Promise<JSONValue>{
    signal.throwIfAborted();this.queue.heartbeat(job.jobId,job.leaseToken!,this.options.leaseMs??60_000);
    if(prompt.length>(this.options.maxInputCharacters??60_000))throw new ModelError('MODEL_INPUT_BUDGET_EXCEEDED',false);
    const hash=stableId('request',this.model.modelId,schemaId,json(schema),prompt);
    const cached=this.store.get<{result_json:string}>("SELECT result_json FROM model_calls WHERE triage_id=? AND request_hash=? AND status='succeeded' ORDER BY call_index DESC LIMIT 1",identity.triageId,hash);
    if(cached)return validateStructured(schema,JSON.parse(cached.result_json));
    const fast=this.store.get<{config_json:string}>('SELECT x.config_json FROM qq_explicit_feedback x WHERE x.batch_id=? AND x.project_id=? LIMIT 1',identity.batchId,identity.projectId);
    if(fast){const config=JSON.parse(fast.config_json) as {rateWindowMs:number;maxModelCallsPerWindow:number};const cutoff=new Date(Date.parse(this.now())-config.rateWindowMs).toISOString();
      const used=this.store.get<{n:number}>('SELECT count(*) n FROM model_calls c JOIN agent_runs r USING(run_id) WHERE r.project_id=? AND c.started_at>?',identity.projectId,cutoff)!.n;
      if(used>=config.maxModelCallsPerWindow)throw new ModelError('QQ_EXPLICIT_MODEL_BUDGET',true);
    }
    const callIndex=this.store.get<{n:number}>('SELECT count(*) n FROM model_calls WHERE triage_id=?',identity.triageId)!.n;
    if(callIndex>=(this.options.maxCalls??12))throw new ModelError('MODEL_CALL_BUDGET_EXCEEDED',false);
    this.store.run("INSERT INTO model_calls(triage_id,request_hash,call_index,run_id,schema_id,model_id,status,started_at) VALUES(?,?,?,?,?,?,'running',?)",identity.triageId,hash,callIndex,runId,schemaId,this.model.modelId,this.now());
    const hostSignal=AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs??30_000)]);
    let abortListener:()=>void=()=>{};
    const deadline=new Promise<never>((_resolve,reject)=>{abortListener=()=>reject(new ModelError(signal.aborted?'MODEL_CANCELLED':'MODEL_TIMEOUT',!signal.aborted));hostSignal.addEventListener('abort',abortListener,{once:true});});
    try{const response=await Promise.race([this.model.generate({schemaId,schema,prompt,timeoutMs:this.options.timeoutMs??30_000,maxOutputTokens:4096,signal:hostSignal}),deadline]);const value=validateStructured(schema,response.value);
      this.store.run("UPDATE model_calls SET status='succeeded',model_id=?,result_json=?,usage_json=?,ended_at=? WHERE triage_id=? AND request_hash=? AND call_index=?",response.modelId,json(value),json(response.usage),this.now(),identity.triageId,hash,callIndex);return value;
    }catch(error){this.store.run("UPDATE model_calls SET status='failed',error_code=?,ended_at=? WHERE triage_id=? AND request_hash=? AND call_index=?",error instanceof ModelError?error.code:'MODEL_FAILED',this.now(),identity.triageId,hash,callIndex);throw error;}
    finally{hostSignal.removeEventListener('abort',abortListener);}
  }
  private context(identity:AnalysisIdentity,runId:string,job:JobView,signal:AbortSignal):AgentContextV2{
    const proposals=(kind:string)=>async(change:JSONValue,evidence:Array<{eventId:InternalEventId}>)=>{
      if(!evidence.length||evidence.some(e=>!this.domain.evidence(identity.projectId,e.eventId)))throw new Error('PROPOSAL_EVIDENCE_NOT_AUTHORIZED');
      const id=stableId('proposal',runId,kind,json(change),json(evidence));this.store.run('INSERT INTO agent_proposals VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',id,runId,identity.projectId,kind,json(change),json(evidence),this.now());return id;
    };
    return {runId,projectId:identity.projectId,signal,
      evidence:{get:async id=>{const e=this.domain.evidence(identity.projectId,id);return e&&!e.deleted?e.event:null;},search:async(query,limit)=>{const works=await this.memory.search(identity.projectId,'defect',query,limit,signal);return works.items.flatMap(w=>w.evidence.map(e=>({eventId:e.eventId}))).slice(0,limit);}},
      issues:{search:async(query,limit)=>(await this.memory.search(identity.projectId,'defect',query,limit,signal)).items.map(w=>({id:w.id,title:w.title})),proposeChange:proposals('defect')},
      suggestions:{search:async(query,limit)=>(await this.memory.search(identity.projectId,'suggestion',query,limit,signal)).items.map(w=>({id:w.id,title:w.title,status:w.status as 'candidate'})),proposeChange:proposals('suggestion')},
      llm:{generateStructured:async<T extends JSONValue>(request:{schemaId:string;prompt:string;timeoutMs:number;maxOutputTokens:number})=>{
        if(request.schemaId!=='triage-result-v2')throw new Error('WORKER_SCHEMA_NOT_ALLOWED');
        return await this.call(identity,runId,job,request.schemaId,extractionSchema,request.prompt,signal) as T;
      }},
    };
  }
  getRun(runId:string):AgentRunViewV1|null{
    const r=this.store.get<{job_id:string;project_id:string;worker_id:string;status:AgentRunViewV1['status'];attempt:number;input_event_ids_json:string;queued_at:string;started_at:string;ended_at:string|null;model_id:string;error_code:string|null}>('SELECT * FROM agent_runs WHERE run_id=?',runId);if(!r)return null;
    return {runId,jobId:r.job_id,projectId:r.project_id,workerId:r.worker_id,status:r.status,attempt:r.attempt,inputEventIds:JSON.parse(r.input_event_ids_json) as InternalEventId[],queuedAt:r.queued_at,startedAt:r.started_at,modelId:r.model_id,...(r.ended_at?{endedAt:r.ended_at}:{}),...(r.error_code?{error:{code:r.error_code,message:r.error_code,retryable:false}}:{})};
  }
}
