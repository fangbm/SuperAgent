import { parseContract } from '@superagent/contract-validation';
import { SqliteStore, canonicalJSON, stableId, systemClock, timestamp, addMilliseconds } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { HybridMemory } from '@superagent/memory';
import type { WorkKind, WorkSnapshot } from '@superagent/memory';
import type { EvidenceAnchorV2, FeedbackItemV2, InternalEventId, JSONValue, NormalizedEventV1, TriageResultV2, FeedbackBatchV1 } from '@superagent/contracts';

export interface MatchProposal { candidateId:string; relationship:'same'|'related'|'different'|'uncertain'; evidenceIds:string[]; conflicts:string[]; missing:string[]; rationale:string; raw:JSONValue }
export interface Resolution { item:FeedbackItemV2; matches:MatchProposal[]; targetId?:string; reviewRequired:boolean }
export interface AnalysisIdentity {triageId:string;batchId:string;pipelineVersion:string;revision:number;projectId:string}
const json=(v:unknown)=>canonicalJSON(v as JSONValue);
export function itemFingerprint(item:FeedbackItemV2):string {
  const {evidence:_e,confidence:_c,description:_d,...content}=item;
  return stableId('fingerprint',json(content));
}
export class DomainService {
  constructor(readonly store:SqliteStore,readonly memory:HybridMemory,private readonly options:{clock?:Clock;automaticConfidence?:number;repositories?:Readonly<Record<string,string>>;authorizedActors?:readonly string[];syncDebounceMs?:number}={}){
    const threshold=options.automaticConfidence??0.8;
    if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('INVALID_AUTOMATIC_CONFIDENCE');
  }
  private now():string{return timestamp((this.options.clock??systemClock)());}
  expectedWorkId(identity:AnalysisIdentity,index:number):string{return stableId('work',identity.triageId,String(index));}
  prepare(batchId:string,pipelineVersion:string,revision:number):AnalysisIdentity {
    if(!pipelineVersion.trim()||!Number.isSafeInteger(revision)||revision<1)throw new Error('INVALID_ANALYSIS_IDENTITY');
    return this.store.transaction(()=>{
      const batch=this.store.get<{project_id:string}>('SELECT project_id FROM feedback_batches WHERE batch_id=?',batchId);if(!batch)throw new Error('BATCH_NOT_FOUND');
      const triageId=stableId('triage',batchId,pipelineVersion,String(revision));
      const old=this.store.get<{triage_id:string}>('SELECT triage_id FROM analysis_requests WHERE batch_id=? AND revision=?',batchId,revision);
      if(old&&old.triage_id!==triageId)throw new Error('ANALYSIS_REVISION_CONFLICT');
      if(!old){const last=this.store.get<{n:number}>('SELECT coalesce(max(revision),0) n FROM analysis_requests WHERE batch_id=?',batchId)!.n;if(revision!==last+1)throw new Error('ANALYSIS_REVISION_GAP');
        this.store.run('INSERT INTO analysis_requests VALUES(?,?,?,?,?)',triageId,batchId,pipelineVersion,revision,this.now());}
      return {triageId,batchId,pipelineVersion,revision,projectId:batch.project_id};
    });
  }
  evidence(projectId:string,eventId:string):{event:NormalizedEventV1;text:string;current:boolean;deleted:boolean}|undefined {
    const row=this.store.get<{payload_json:string}>('SELECT payload_json FROM source_events WHERE event_id=? AND project_id=?',eventId,projectId);if(!row)return undefined;
    const event=JSON.parse(row.payload_json) as NormalizedEventV1;if(event.type==='com.superagent.source.coverage.changed.v1')return undefined;
    const projection=this.store.get<{event_id:string;deleted:number}>('SELECT event_id,deleted FROM source_objects WHERE source_id=? AND external_id=?',event.data.sourceId,event.data.object.externalId);
    return {event,text:event.data.content?.text??'',current:projection?.event_id===eventId,deleted:projection?.deleted===1};
  }
  validateEvidence(projectId:string,item:FeedbackItemV2,batch:FeedbackBatchV1):void{
    const allowed=new Set([...batch.candidateEventIds,...batch.contextEventIds]);let primary=false;
    for(const anchor of item.evidence){
      if(!allowed.has(anchor.eventId))throw new Error('EVIDENCE_OUTSIDE_BATCH');
      const stored=this.evidence(projectId,anchor.eventId);if(!stored||stored.deleted)throw new Error('EVIDENCE_NOT_VISIBLE');
      if(anchor.role==='primary'){
        if(!batch.candidateEventIds.includes(anchor.eventId))throw new Error('CONTEXT_CANNOT_CREATE_FEEDBACK');
        if(!stored.current)throw new Error('STALE_EVIDENCE');primary=true;
      }
      const title = stored.event.data.object.kind === 'thread' && typeof stored.event.data.attributes?.title === 'string'
        ? stored.event.data.attributes.title.slice(0, 2048) : '';
      if(anchor.quote!==undefined&&(!anchor.quote||!(stored.text.includes(anchor.quote)||title.includes(anchor.quote))))
        throw new Error('EVIDENCE_QUOTE_MISMATCH');
      if(anchor.start!==undefined||anchor.end!==undefined){
        if(!Number.isInteger(anchor.start)||!Number.isInteger(anchor.end)||anchor.start!<0||anchor.end!<=anchor.start!||anchor.end!>stored.text.length)throw new Error('EVIDENCE_SPAN_INVALID');
        if(anchor.quote!==undefined&&stored.text.slice(anchor.start,anchor.end)!==anchor.quote)throw new Error('EVIDENCE_SPAN_QUOTE_MISMATCH');
      }
    }
    if(!primary)throw new Error('PRIMARY_CANDIDATE_EVIDENCE_REQUIRED');
  }
  getWork(projectId:string,kind:WorkKind,id:string):WorkSnapshot|undefined{return this.memory.get(projectId,kind,id);}
  private objectKeys(projectId:string,item:FeedbackItemV2):string[]{return [...new Set(item.evidence.filter(e=>e.role==='primary').map(e=>{const stored=this.evidence(projectId,e.eventId)!;if(stored.event.type==='com.superagent.source.coverage.changed.v1')throw new Error('NOT_FEEDBACK');return json([stored.event.data.sourceId,stored.event.data.object.externalId]);}))].sort();}
  private refresh(projectId:string,kind:WorkKind,id:string):WorkSnapshot{
    const table=kind==='defect'?'issues':'suggestions';const key=kind==='defect'?'issue_id':'suggestion_id';
    const row=this.store.get<{title:string;summary:string;status:string;version:number}>(`SELECT * FROM ${table} WHERE ${key}=? AND project_id=?`,id,projectId);if(!row)throw new Error('WORK_NOT_FOUND');
    const meta=this.store.get<{review_required:number;content_json:string}>("SELECT * FROM work_metadata WHERE project_id=? AND work_kind=? AND work_id=?",projectId,kind,id)!;
    const previous=JSON.parse(meta.content_json) as WorkSnapshot;
    const evidence=this.store.all<{event_id:InternalEventId;role:EvidenceAnchorV2['role'];quote:string|null;span_start:number|null;span_end:number|null}>(`SELECT DISTINCT e.event_id,e.role,e.quote,e.span_start,e.span_end FROM feedback_item_evidence e JOIN feedback_items f USING(feedback_item_id)
      JOIN work_feedback_links l USING(feedback_item_id) WHERE l.work_kind=? AND l.work_id=? AND f.active=1`,kind,id).map(e=>({eventId:e.event_id,role:e.role,...(e.quote!==null?{quote:e.quote}:{}),...(e.span_start!==null?{start:e.span_start,end:e.span_end!}:{})}));
    const feedbackCount=this.store.get<{n:number}>(`SELECT count(*) n FROM (SELECT DISTINCT p.source_id,p.external_id FROM feedback_primary_objects p JOIN feedback_items f USING(feedback_item_id)
      JOIN work_feedback_links l USING(feedback_item_id) WHERE l.work_kind=? AND l.work_id=? AND f.active=1)`,kind,id)!.n;
    const urgent=this.store.get<{n:number}>(`SELECT count(*) n FROM work_feedback_links l JOIN feedback_item_evidence e USING(feedback_item_id) JOIN admission_decisions a ON a.event_id=e.event_id
      WHERE l.work_kind=? AND l.work_id=? AND a.decision='urgent_candidate'`,kind,id)!.n>0;
    const work:WorkSnapshot={...previous,title:row.title,summary:row.summary,status:row.status,version:row.version,id,kind,projectId,reviewRequired:meta.review_required===1,feedbackCount,evidence,priority:Math.min(100,(urgent?80:20)+feedbackCount)};
    this.store.run('UPDATE work_metadata SET content_json=?,priority=? WHERE work_kind=? AND work_id=?',json(work),work.priority,kind,id);
    if(feedbackCount===0)this.store.run('DELETE FROM work_identity_claims WHERE project_id=? AND work_kind=? AND work_id=?',projectId,kind,id);
    this.memory.index(work);return work;
  }
  private schedule(work:WorkSnapshot):void{
    const repository=this.options.repositories?.[work.projectId];if(!repository)return;
    if(work.reviewRequired||work.feedbackCount===0){this.store.run("UPDATE github_sync_outbox SET state='held' WHERE work_kind=? AND work_id=? AND repository=?",work.kind,work.id,repository);return;}
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('INVALID_GITHUB_REPOSITORY');
    const linked=this.store.get('SELECT 1 FROM external_work_links WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,repository);
    const due=addMilliseconds(this.now(),linked?(this.options.syncDebounceMs??60_000):0);
    this.store.run(`INSERT INTO github_sync_outbox VALUES(?,?,?,?,?,0,?,'pending') ON CONFLICT(work_kind,work_id,repository) DO UPDATE SET desired_version=excluded.desired_version,
      available_at=CASE WHEN github_sync_outbox.state='idle' THEN excluded.available_at ELSE min(github_sync_outbox.available_at,excluded.available_at) END,state='pending'`,work.projectId,work.kind,work.id,repository,work.version,due);
  }
  commit(identity:AnalysisIdentity,result:TriageResultV2,resolutions:Resolution[],modelId:string):string[]{
    parseContract('triage-result-v2',result);
    if(result.batchId!==identity.batchId||result.pipelineVersion!==identity.pipelineVersion||result.revision!==identity.revision||resolutions.length!==result.items.length)throw new Error('ANALYSIS_RESULT_IDENTITY_MISMATCH');
    return this.store.transaction(()=>{
      const existing=this.store.get('SELECT 1 FROM triage_extractions WHERE triage_id=?',identity.triageId);if(existing)return [];
      const row=this.store.get<{batch_json:string}>('SELECT batch_json FROM feedback_batches WHERE batch_id=?',identity.batchId)!;const batch=JSON.parse(row.batch_json) as FeedbackBatchV1;
      const request=this.store.get<{triage_id:string;pipeline_version:string;revision:number}>('SELECT * FROM analysis_requests WHERE triage_id=? AND batch_id=?',identity.triageId,identity.batchId);
      if(!request||request.pipeline_version!==identity.pipelineVersion||request.revision!==identity.revision||batch.projectId!==identity.projectId)throw new Error('ANALYSIS_IDENTITY_NOT_AUTHORIZED');
      const previous=this.store.get<{triage_id:string;revision:number}>('SELECT triage_id,revision FROM triage_extractions WHERE batch_id=? ORDER BY revision DESC LIMIT 1',identity.batchId);
      if(previous&&identity.revision<=previous.revision)throw new Error('STALE_ANALYSIS_REVISION');
      const duplicates=new Set<string>();
      for(const item of result.items){this.validateEvidence(identity.projectId,item,batch);const signature=itemFingerprint(item)+json(item.evidence.filter(e=>e.role==='primary').map(e=>e.eventId).sort());if(duplicates.has(signature))throw new Error('DUPLICATE_EXTRACTED_ITEM');duplicates.add(signature);}
      const affected=new Map<string,{kind:WorkKind;id:string}>();
      const deactivate=(itemId:string)=>{for(const l of this.store.all<{work_kind:WorkKind;work_id:string}>('SELECT * FROM work_feedback_links WHERE feedback_item_id=?',itemId))affected.set(`${l.work_kind}:${l.work_id}`,{kind:l.work_kind,id:l.work_id});this.store.run('UPDATE feedback_items SET active=0 WHERE feedback_item_id=?',itemId);};
      if(previous)for(const item of this.store.all<{feedback_item_id:string}>('SELECT feedback_item_id FROM feedback_items WHERE triage_id=? AND active=1',previous.triage_id))deactivate(item.feedback_item_id);
      // Edits/deletions supersede older evidence for the same source object.
      for(const id of batch.candidateEventIds){const e=this.evidence(identity.projectId,id);if(!e?.current||e.event.type==='com.superagent.source.coverage.changed.v1')continue;
        for(const p of this.store.all<{feedback_item_id:string}>(`SELECT DISTINCT p.feedback_item_id FROM feedback_primary_objects p JOIN feedback_items f USING(feedback_item_id) WHERE p.source_id=? AND p.external_id=? AND p.event_id<>? AND f.active=1`,e.event.data.sourceId,e.event.data.object.externalId,id))deactivate(p.feedback_item_id);}
      this.store.run('INSERT INTO triage_extractions(triage_id,batch_id,pipeline_version,revision,result_schema_version,result_json,supersedes_triage_id,created_at) VALUES(?,?,?,?,?,?,?,?)',identity.triageId,identity.batchId,identity.pipelineVersion,identity.revision,'2.0',json(result),previous?.triage_id??null,this.now());
      const workIds:string[]=[];
      for(const [index,item] of result.items.entries()){
        const resolution=resolutions[index]!;if(json(resolution.item)!==json(item))throw new Error('RESOLUTION_ITEM_MISMATCH');
        const fingerprint=itemFingerprint(item);const objectKeys=json(this.objectKeys(identity.projectId,item));
        const override=this.store.get<{work_kind:WorkKind;work_id:string}>('SELECT work_kind,work_id FROM manual_work_overrides WHERE project_id=? AND object_keys_json=? AND fingerprint=?',identity.projectId,objectKeys,fingerprint);
        let target=override?.work_id??resolution.targetId;let review=resolution.reviewRequired||result.requiresHumanReview||item.confidence<(this.options.automaticConfidence??0.8)||resolution.matches.some(m=>m.relationship==='uncertain'||m.conflicts.length>0||m.missing.length>0)||resolution.matches.filter(m=>m.relationship==='same').length>1;
        if(override&&override.work_kind!==item.kind)throw new Error('MANUAL_OVERRIDE_KIND_CONFLICT');
        if(target){const work=this.getWork(identity.projectId,item.kind,target);if(!work)throw new Error('RESOLUTION_TARGET_NOT_AUTHORIZED');
          if(!override){const match=resolution.matches.find(m=>m.candidateId===target&&m.relationship==='same');const newIds=new Set(item.evidence.filter(e=>e.role==='primary').map(e=>e.eventId));const oldIds=new Set(work.evidence.filter(e=>e.role==='primary').map(e=>e.eventId));
            if(!match||match.conflicts.length||match.missing.length||!match.evidenceIds.some(id=>newIds.has(id as InternalEventId))||!match.evidenceIds.some(id=>oldIds.has(id as InternalEventId)))throw new Error('MATCH_EVIDENCE_INSUFFICIENT');}
          review=review||work.reviewRequired;if(['fixed','verified','dismissed','implemented','declined','archived'].includes(work.status))review=true;
          const table=item.kind==='defect'?'issues':'suggestions';const key=item.kind==='defect'?'issue_id':'suggestion_id';this.store.run(`UPDATE ${table} SET version=version+1,updated_at=? WHERE ${key}=?`,this.now(),target);
          if(review)this.store.run('UPDATE work_metadata SET review_required=1 WHERE work_kind=? AND work_id=?',item.kind,target);
        }else{
          target=this.expectedWorkId(identity,index);
          const claim=this.store.get<{work_id:string}>('SELECT work_id FROM work_identity_claims WHERE project_id=? AND work_kind=? AND fingerprint=?',identity.projectId,item.kind,fingerprint);
          if(claim&&!resolution.matches.some(m=>m.candidateId===claim.work_id))throw new Error('RESOLUTION_STALE_RETRIEVE_AGAIN');
          if(!claim)this.store.run('INSERT INTO work_identity_claims VALUES(?,?,?,?)',identity.projectId,item.kind,fingerprint,target);
          const status=item.kind==='defect'?(review?'candidate':'open'):'candidate';
          if(item.kind==='defect')this.store.run('INSERT INTO issues VALUES(?,?,?,?,?,1,?,?)',target,identity.projectId,item.title,item.description,status,this.now(),this.now());
          else this.store.run('INSERT INTO suggestions(suggestion_id,project_id,title,summary,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',target,identity.projectId,item.title,item.description,status,this.now(),this.now());
          const work:WorkSnapshot={id:target,projectId:identity.projectId,kind:item.kind,title:item.title,summary:item.description,status,version:1,reviewRequired:review,priority:0,feedbackCount:0,evidence:[],content:item};
          this.store.run('INSERT INTO work_metadata(work_kind,work_id,project_id,fingerprint,content_json,review_required) VALUES(?,?,?,?,?,?)',item.kind,target,identity.projectId,fingerprint,json(work),review?1:0);
        }
        const itemId=stableId('feedback',identity.triageId,String(index));
        this.store.run('INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)',itemId,identity.triageId,index,item.kind,item.category,item.title,item.description,item.confidence,this.now());
        this.store.run('INSERT INTO feedback_item_metadata VALUES(?,?,?,?,?)',itemId,identity.projectId,fingerprint,json(item),modelId);
        for(const [eIndex,e] of item.evidence.entries()){
          this.store.run('INSERT INTO feedback_item_evidence VALUES(?,?,?,?,?,?,?)',itemId,eIndex,e.eventId,e.role,e.quote??null,e.start??null,e.end??null);
          if(e.role==='primary'){const source=this.evidence(identity.projectId,e.eventId)!;if(source.event.type==='com.superagent.source.coverage.changed.v1')throw new Error('INVALID_EVIDENCE');this.store.run('INSERT INTO feedback_primary_objects VALUES(?,?,?,?) ON CONFLICT DO NOTHING',itemId,source.event.data.sourceId,source.event.data.object.externalId,e.eventId);}
        }
        this.store.run('INSERT INTO work_feedback_links VALUES(?,?,?)',item.kind,target,itemId);
        if(item.kind==='suggestion')this.store.run("INSERT INTO suggestion_feedback_items VALUES(?,?,'same_request',?)",target,itemId,this.now());
        for(const m of resolution.matches)this.store.run('INSERT INTO work_match_decisions VALUES(?,?,?,?,?,?,?)',identity.triageId,index,item.kind,m.candidateId,m.relationship,json(m.raw),this.now());
        affected.set(`${item.kind}:${target}`,{kind:item.kind,id:target});workIds.push(target);
        this.refresh(identity.projectId,item.kind,target);
        this.history(identity.projectId,item.kind,target,'analysis_applied','agent',{triageId:identity.triageId,itemId});
      }
      for(const {kind,id} of affected.values()){const work=this.refresh(identity.projectId,kind,id);this.schedule(work);}
      return workIds;
    });
  }
  private history(projectId:string,kind:WorkKind,id:string,action:string,actor:string,details:JSONValue):void{this.store.run('INSERT INTO work_history(project_id,work_kind,work_id,action,actor_ref,details_json,created_at) VALUES(?,?,?,?,?,?,?)',projectId,kind,id,action,actor,json(details),this.now());}
  moveFeedback(projectId:string,itemId:string,targetId:string,expectedVersion:number,actor:string,reason:string):void{
    if(!this.options.authorizedActors?.includes(actor)||!reason.trim())throw new Error('DEVELOPER_NOT_AUTHORIZED');
    this.store.transaction(()=>{
      const meta=this.store.get<{item_json:string;fingerprint:string}>('SELECT item_json,fingerprint FROM feedback_item_metadata WHERE feedback_item_id=? AND project_id=?',itemId,projectId);if(!meta)throw new Error('FEEDBACK_NOT_FOUND');
      const item=JSON.parse(meta.item_json) as FeedbackItemV2;const target=this.getWork(projectId,item.kind,targetId);if(!target||target.version!==expectedVersion)throw new Error('WORK_VERSION_CONFLICT');
      const old=this.store.all<{work_id:string}>('SELECT work_id FROM work_feedback_links WHERE feedback_item_id=? AND work_kind=?',itemId,item.kind);
      this.store.run('DELETE FROM work_feedback_links WHERE feedback_item_id=?',itemId);this.store.run('INSERT INTO work_feedback_links VALUES(?,?,?)',item.kind,targetId,itemId);
      if(item.kind==='suggestion'){this.store.run('DELETE FROM suggestion_feedback_items WHERE feedback_item_id=?',itemId);this.store.run("INSERT INTO suggestion_feedback_items VALUES(?,?,'same_request',?)",targetId,itemId,this.now());}
      this.store.run('INSERT INTO manual_work_overrides VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,object_keys_json,fingerprint) DO UPDATE SET work_id=excluded.work_id,actor_ref=excluded.actor_ref,reason=excluded.reason',projectId,json(this.objectKeys(projectId,item)),meta.fingerprint,item.kind,targetId,actor,reason);
      for(const id of new Set([...old.map(o=>o.work_id),targetId])){const table=item.kind==='defect'?'issues':'suggestions';const key=item.kind==='defect'?'issue_id':'suggestion_id';this.store.run(`UPDATE ${table} SET version=version+1,updated_at=? WHERE ${key}=?`,this.now(),id);const work=this.refresh(projectId,item.kind,id);this.schedule(work);this.history(projectId,item.kind,id,'manual_relink',actor,{itemId,targetId,reason});}
    });
  }
  splitFeedback(projectId:string,itemId:string,expectedVersion:number,requestId:string,actor:string,reason:string):string{
    if(!this.options.authorizedActors?.includes(actor)||!requestId||!reason.trim())throw new Error('DEVELOPER_NOT_AUTHORIZED');
    return this.store.transaction(()=>{
      const payload=stableId('command',projectId,itemId,String(expectedVersion),actor,reason);
      const old=this.store.get<{payload_hash:string;result_json:string}>('SELECT * FROM manual_work_commands WHERE request_id=?',requestId);
      if(old){if(old.payload_hash!==payload)throw new Error('MANUAL_COMMAND_CONFLICT');return JSON.parse(old.result_json) as string;}
      const meta=this.store.get<{item_json:string;fingerprint:string}>('SELECT item_json,fingerprint FROM feedback_item_metadata WHERE feedback_item_id=? AND project_id=?',itemId,projectId);if(!meta)throw new Error('FEEDBACK_NOT_FOUND');
      const item=JSON.parse(meta.item_json) as FeedbackItemV2;const link=this.store.get<{work_id:string}>('SELECT work_id FROM work_feedback_links WHERE work_kind=? AND feedback_item_id=?',item.kind,itemId);
      if(!link||this.getWork(projectId,item.kind,link.work_id)?.version!==expectedVersion)throw new Error('WORK_VERSION_CONFLICT');
      const id=stableId('split',projectId,requestId);const status='candidate';
      if(item.kind==='defect')this.store.run('INSERT INTO issues VALUES(?,?,?,?,?,1,?,?)',id,projectId,item.title,item.description,status,this.now(),this.now());
      else this.store.run('INSERT INTO suggestions(suggestion_id,project_id,title,summary,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,projectId,item.title,item.description,status,this.now(),this.now());
      const work:WorkSnapshot={id,projectId,kind:item.kind,title:item.title,summary:item.description,status,version:1,reviewRequired:true,priority:0,feedbackCount:0,evidence:[],content:item};
      this.store.run('INSERT INTO work_metadata(work_kind,work_id,project_id,fingerprint,content_json,review_required) VALUES(?,?,?,?,?,1)',item.kind,id,projectId,meta.fingerprint,json(work));
      this.moveFeedback(projectId,itemId,id,1,actor,reason);
      this.store.run('INSERT INTO manual_work_commands VALUES(?,?,?)',requestId,payload,json(id));return id;
    });
  }
  mergeWorks(projectId:string,kind:WorkKind,fromId:string,toId:string,fromVersion:number,toVersion:number,requestId:string,actor:string,reason:string):void{
    if(!this.options.authorizedActors?.includes(actor)||!requestId||!reason.trim()||fromId===toId)throw new Error('DEVELOPER_NOT_AUTHORIZED');
    this.store.transaction(()=>{
      const payload=stableId('merge',projectId,kind,fromId,toId,String(fromVersion),String(toVersion),actor,reason);
      const old=this.store.get<{payload_hash:string}>('SELECT * FROM manual_work_commands WHERE request_id=?',requestId);if(old){if(old.payload_hash!==payload)throw new Error('MANUAL_COMMAND_CONFLICT');return;}
      const from=this.getWork(projectId,kind,fromId);const to=this.getWork(projectId,kind,toId);if(from?.version!==fromVersion||to?.version!==toVersion)throw new Error('WORK_VERSION_CONFLICT');
      this.store.run('UPDATE work_metadata SET review_required=1 WHERE work_kind=? AND work_id IN (?,?)',kind,fromId,toId);
      for(const row of this.store.all<{feedback_item_id:string}>('SELECT feedback_item_id FROM work_feedback_links WHERE work_kind=? AND work_id=?',kind,fromId))this.moveFeedback(projectId,row.feedback_item_id,toId,this.getWork(projectId,kind,toId)!.version,actor,reason);
      this.store.run('UPDATE work_metadata SET merged_into=? WHERE work_kind=? AND work_id=?',toId,kind,fromId);
      const table=kind==='defect'?'issues':'suggestions';const key=kind==='defect'?'issue_id':'suggestion_id';this.store.run(`UPDATE ${table} SET status=?,version=version+1,updated_at=? WHERE ${key}=?`,kind==='defect'?'merged':'archived',this.now(),fromId);
      this.store.run('DELETE FROM work_fts WHERE project_id=? AND work_kind=? AND work_id=?',projectId,kind,fromId);this.store.run('DELETE FROM embedding_outbox WHERE project_id=? AND work_kind=? AND work_id=?',projectId,kind,fromId);
      this.store.run("UPDATE github_sync_outbox SET state='held' WHERE work_kind=? AND work_id IN (?,?)",kind,fromId,toId);
      this.history(projectId,kind,toId,'manual_merge',actor,{fromId,toId,reason});this.store.run('INSERT INTO manual_work_commands VALUES(?,?,?)',requestId,payload,json(toId));
    });
  }
  statusActions(projectId:string,kind:WorkKind,id:string):string[]{
    const work=this.getWork(projectId,kind,id);if(!work)return [];
    const transitions=kind==='defect'?{
      investigate:['candidate','open'],fix:['open','investigating'],verify:['fixed'],reopen:['fixed','verified','dismissed'],dismiss:['candidate','open','investigating'],
    }:{review:['candidate'],accept:['candidate','reviewing'],plan:['accepted'],start:['planned'],implement:['planned','in_progress'],verify:['implemented'],decline:['candidate','reviewing','accepted','planned','in_progress'],archive:['implemented','verified','declined'],reopen:['declined','archived']};
    return Object.entries(transitions).filter(([,states])=>states.includes(work.status)).map(([action])=>action);
  }
  applyStatusAction(projectId:string,kind:WorkKind,id:string,action:string,expectedVersion:number,actor:string,commandId:string,rationale?:string,confirmedOperationId?:string):WorkSnapshot{
    if(!this.options.authorizedActors?.includes(actor))throw new Error('DEVELOPER_NOT_AUTHORIZED');
    return this.store.transaction(()=>{
      const work=this.getWork(projectId,kind,id);if(!work)throw new Error('WORK_NOT_FOUND');if(work.version!==expectedVersion)throw new Error('WORK_VERSION_CONFLICT');
      if(!this.statusActions(projectId,kind,id).includes(action))throw new Error('STATUS_TRANSITION_NOT_ALLOWED');
      if(kind==='defect'&&['fix','reopen','dismiss'].includes(action)&&this.store.get('SELECT 1 FROM external_work_links WHERE work_kind=? AND work_id=? AND provider=?',kind,id,'github')){
        const proof=this.store.get(`SELECT 1 FROM external_operations o JOIN github_action_operations a USING(operation_id) WHERE o.operation_id=? AND o.state='succeeded' AND a.project_id=? AND a.issue_id=? AND a.action=? AND a.expected_version=?`,confirmedOperationId??'',projectId,id,action,expectedVersion);
        if(!proof)throw new Error('GITHUB_STATUS_CONFIRMATION_REQUIRED');
      }
      const to:Record<string,string>=kind==='defect'?{investigate:'investigating',fix:'fixed',verify:'verified',reopen:'open',dismiss:'dismissed'}:{review:'reviewing',accept:'accepted',plan:'planned',start:'in_progress',implement:'implemented',verify:'verified',decline:'declined',archive:'archived',reopen:'reviewing'};
      const table=kind==='defect'?'issues':'suggestions',key=kind==='defect'?'issue_id':'suggestion_id';
      const changed=this.store.run(`UPDATE ${table} SET status=?,version=version+1,updated_at=? WHERE ${key}=? AND project_id=? AND version=?`,to[action]!,this.now(),id,projectId,expectedVersion);if(!changed.changes)throw new Error('WORK_VERSION_CONFLICT');
      if(kind==='suggestion')this.store.run('INSERT INTO suggestion_status_history VALUES(?,?,?,?,?,?,?,?,?)',commandId,id,work.status,to[action]!,actor,'operator',commandId,rationale??null,this.now());
      this.history(projectId,kind,id,'developer_status',actor,{commandId,action,from:work.status,to:to[action]!,rationale:rationale??null});
      const updated=this.refresh(projectId,kind,id);this.schedule(updated);return updated;
    });
  }
  remoteStatus(projectId:string,kind:WorkKind,id:string,state:'open'|'closed',reason:string|null):void{
    this.store.transaction(()=>{const work=this.getWork(projectId,kind,id);if(!work)throw new Error('WORK_NOT_FOUND');
      const prior=this.store.get<{remote_state:string|null;remote_state_reason:string|null;review_required:number}>('SELECT remote_state,remote_state_reason,review_required FROM work_metadata WHERE work_kind=? AND work_id=?',kind,id)!;
      const ambiguous=state==='closed'&&!['completed','not_planned'].includes(reason??'');
      const next=kind==='defect'?(state==='open'?(work.status==='investigating'?'investigating':'open'):reason==='not_planned'?'dismissed':reason==='completed'?(work.status==='verified'&&prior.remote_state==='closed'&&prior.remote_state_reason==='completed'?'verified':'fixed'):work.status):work.status;
      const review=work.reviewRequired||ambiguous||kind==='suggestion'&&state==='closed';
      if(prior.remote_state===state&&prior.remote_state_reason===reason&&next===work.status&&review===work.reviewRequired)return;
      this.store.run('UPDATE work_metadata SET remote_state=?,remote_state_reason=? WHERE work_kind=? AND work_id=?',state,reason,kind,id);
      if(kind==='defect'){if(ambiguous)this.store.run('UPDATE work_metadata SET review_required=1 WHERE work_kind=? AND work_id=?',kind,id);this.store.run('UPDATE issues SET status=?,version=version+1,updated_at=? WHERE issue_id=?',next,this.now(),id);}
      else if(state==='closed')this.store.run('UPDATE work_metadata SET review_required=1 WHERE work_kind=? AND work_id=?',kind,id);
      this.refresh(projectId,kind,id);this.history(projectId,kind,id,'remote_status','github',{state,reason});});
  }
}
