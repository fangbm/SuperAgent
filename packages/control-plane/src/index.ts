import type { JSONValue, ReportNavigationPageV1, ReportSectionV1 } from '@superagent/contracts';
import { canonicalJSON, SqliteStore, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DomainService } from '@superagent/domain';
import type { WorkKind, WorkSnapshot } from '@superagent/memory';
import { ReportService } from '@superagent/reporting';
import { ControlError, hash, OperatorAuth, TokenService } from './auth.js';
import type { Principal } from './auth.js';
export { ControlError, hash, OperatorAuth, TokenService } from './auth.js';
export type { Principal } from './auth.js';
export { QQOperatorService } from './qq.js';
export {QQLiveQueries} from './qq-live.js';
export type { QQOperatorRequest, QQReplyOptions, QQButton } from './qq.js';
const json=(v:unknown)=>canonicalJSON(v as JSONValue);
export interface StatusCommand {kind:WorkKind;id:string;action:string;expectedVersion:number;rationale?:string}
export interface CorrectionCommand {kind:WorkKind;id:string;action:'move'|'split'|'merge';expectedVersion:number;feedbackItemId?:string;targetId?:string;targetVersion?:number;reason:string}
export class ControlPlane {
  constructor(readonly store:SqliteStore,readonly domain:DomainService,readonly reports:ReportService,readonly auth:OperatorAuth,readonly tokens:TokenService,private readonly clock:Clock=systemClock){}
  private now():string{return timestamp(this.clock());}
  work(principal:Principal,projectId:string,kind:WorkKind,id:string):WorkSnapshot&{allowedActions:string[];mergedInto?:string}{const current=this.auth.authorize(principal,projectId);if(!['defect','suggestion'].includes(kind))throw new ControlError('INVALID_WORK_KIND');let work=this.domain.getWork(projectId,kind,id);if(!work){const table=kind==='defect'?'issues':'suggestions',key=kind==='defect'?'issue_id':'suggestion_id';const merged=this.store.get<{content_json:string;merged_into:string;status:string;version:number}>(`SELECT m.content_json,m.merged_into,t.status,t.version FROM work_metadata m JOIN ${table} t ON t.${key}=m.work_id WHERE m.project_id=? AND m.work_kind=? AND m.work_id=? AND m.merged_into IS NOT NULL`,projectId,kind,id);if(!merged)throw new ControlError('WORK_NOT_FOUND',404);return{...JSON.parse(merged.content_json) as WorkSnapshot,status:merged.status,version:merged.version,allowedActions:[],mergedInto:merged.merged_into};}return{...work,allowedActions:current.role==='developer'?this.domain.statusActions(projectId,kind,id):[]};}
  listWorks(principal:Principal,projectId:string,kind:WorkKind,query='',limit=100){this.auth.authorize(principal,projectId);if(!['defect','suggestion'].includes(kind)||query.length>200)throw new ControlError('INVALID_WORK_QUERY');const table=kind==='defect'?'issues':'suggestions',key=kind==='defect'?'issue_id':'suggestion_id';return this.store.all<{id:string}>(`SELECT t.${key} id FROM ${table} t JOIN work_metadata m ON m.work_id=t.${key} AND m.work_kind=? WHERE t.project_id=? AND m.merged_into IS NULL AND (t.title LIKE ? OR t.summary LIKE ?) ORDER BY t.updated_at DESC,t.${key} LIMIT ?`,kind,projectId,`%${query}%`,`%${query}%`,Math.max(1,Math.min(200,limit))).map(w=>this.work(principal,projectId,kind,w.id));}
  linkedItems(principal:Principal,projectId:string,kind:WorkKind,id:string){this.work(principal,projectId,kind,id);return this.store.all<{feedbackItemId:string;title:string;createdAt:string}>(`SELECT f.feedback_item_id feedbackItemId,f.title,f.created_at createdAt FROM feedback_items f JOIN work_feedback_links l USING(feedback_item_id) WHERE l.work_kind=? AND l.work_id=? AND f.active=1 ORDER BY f.created_at,f.feedback_item_id`,kind,id);}
  history(principal:Principal,projectId:string,kind:WorkKind,id:string){this.work(principal,projectId,kind,id);return this.store.all<{action:string;actor_ref:string;details_json:string;created_at:string}>('SELECT action,actor_ref,details_json,created_at FROM work_history WHERE project_id=? AND work_kind=? AND work_id=? ORDER BY rowid DESC LIMIT 100',projectId,kind,id).map(r=>({action:r.action,actorRef:r.actor_ref,createdAt:r.created_at,details:JSON.parse(r.details_json) as JSONValue}));}
  correctionToken(principal:Principal,projectId:string,request:CorrectionCommand):string{this.auth.authorize(principal,projectId,true);this.validateCorrection(principal,projectId,request);return this.tokens.issue(principal,projectId,'link_correction',request as unknown as JSONValue);}
  private validateCorrection(principal:Principal,projectId:string,request:CorrectionCommand):void{
    if(!request||!['move','split','merge'].includes(request.action)||!['defect','suggestion'].includes(request.kind)||typeof request.reason!=='string'||!request.reason.trim()||request.reason.length>2000||!Number.isSafeInteger(request.expectedVersion))throw new ControlError('INVALID_CORRECTION');
    const from=this.work(principal,projectId,request.kind,request.id);if(from.mergedInto||from.version!==request.expectedVersion)throw new ControlError('WORK_VERSION_CONFLICT',409);
    if(request.action!=='merge'&&!this.linkedItems(principal,projectId,request.kind,request.id).some(i=>i.feedbackItemId===request.feedbackItemId))throw new ControlError('FEEDBACK_NOT_MEMBER',403);
    if(request.action!=='split'){const target=this.work(principal,projectId,request.kind,request.targetId??'');if(target.mergedInto||target.id===from.id||target.version!==request.targetVersion)throw new ControlError('WORK_VERSION_CONFLICT',409);}
  }
  correct(principal:Principal,projectId:string,request:CorrectionCommand,token:string,interactionId:string):JSONValue{
    this.auth.authorize(principal,projectId,true);if(!interactionId||interactionId.length>256)throw new ControlError('INVALID_INTERACTION');const payloadHash=hash(json({actor:principal.actorRef,projectId,request,tokenHash:hash(token)}));
    return this.store.transaction(()=>{
      const old=this.store.get<{payload_hash:string;result_json:string}>('SELECT payload_hash,result_json FROM operator_commands WHERE source=? AND interaction_id=?','web-correction',interactionId);if(old){if(old.payload_hash!==payloadHash)throw new ControlError('INTERACTION_REPLAY_CONFLICT',409);return JSON.parse(old.result_json) as JSONValue;}
      this.validateCorrection(principal,projectId,request);if(json(this.tokens.read(principal,projectId,'link_correction',token,true))!==json(request))throw new ControlError('TOKEN_ACTION_MISMATCH',403);
      const commandId=stableId('correction',projectId,interactionId);let workId=request.targetId??request.id;
      if(request.action==='split')workId=this.domain.splitFeedback(projectId,request.feedbackItemId!,request.expectedVersion,commandId,principal.actorRef,request.reason);
      else if(request.action==='move')this.domain.moveFeedback(projectId,request.feedbackItemId!,request.targetId!,request.targetVersion!,principal.actorRef,request.reason);
      else this.domain.mergeWorks(projectId,request.kind,request.id,request.targetId!,request.expectedVersion,request.targetVersion!,commandId,principal.actorRef,request.reason);
      const result={state:'succeeded',workId};this.store.run("INSERT INTO operator_commands VALUES(?,?,?,'web-correction',?,?,?,?, 'succeeded',?)",commandId,projectId,principal.actorRef,interactionId,payloadHash,json(request),json(result),this.now());return result;
    });
  }
  issueActionToken(principal:Principal,projectId:string,request:StatusCommand):string{
    this.auth.authorize(principal,projectId,true);this.validateAction(principal,projectId,request);return this.tokens.issue(principal,projectId,'status_action',JSON.parse(json(request)) as JSONValue);
  }
  private validateAction(principal:Principal,projectId:string,request:StatusCommand):void{
    if(!request||!['defect','suggestion'].includes(request.kind)||typeof request.id!=='string'||typeof request.action!=='string'||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<1||request.rationale!==undefined&&(typeof request.rationale!=='string'||request.rationale.length>2000))throw new ControlError('INVALID_ACTION');
    const work=this.work(principal,projectId,request.kind,request.id);if(work.version!==request.expectedVersion)throw new ControlError('WORK_VERSION_CONFLICT',409);if(!work.allowedActions.includes(request.action))throw new ControlError('STATUS_TRANSITION_NOT_ALLOWED',409);
    if(['decline','dismiss'].includes(request.action)&&!request.rationale?.trim())throw new ControlError('RATIONALE_REQUIRED');
  }
  executeAction(principal:Principal,projectId:string,request:StatusCommand,token:string,source:'web'|'qq',interactionId:string):JSONValue{
    this.auth.authorize(principal,projectId,true);if(!['web','qq'].includes(source)||typeof interactionId!=='string'||!interactionId||interactionId.length>256)throw new ControlError('INVALID_INTERACTION');
    const payloadHash=hash(json({actor:principal.actorRef,projectId,source,interactionId,request,tokenHash:hash(token)}));
    return this.store.transaction(()=>{
      const existing=this.store.get<{project_id:string;actor_ref:string;payload_hash:string;result_json:string|null;state:string}>('SELECT * FROM operator_commands WHERE source=? AND interaction_id=?',source,interactionId);
      if(existing){if(existing.project_id!==projectId||existing.actor_ref!==principal.actorRef||existing.payload_hash!==payloadHash)throw new ControlError('INTERACTION_REPLAY_CONFLICT',409);return existing.result_json?JSON.parse(existing.result_json) as JSONValue:{state:existing.state};}
      this.validateAction(principal,projectId,request);
      if(json(this.tokens.read(principal,projectId,'status_action',token,true))!==json(request))throw new ControlError('TOKEN_ACTION_MISMATCH',403);
      const commandId=stableId('command',source,interactionId);
      const link=request.kind==='defect'&&['fix','reopen','dismiss'].includes(request.action)?this.store.get<{repository:string;external_issue_id:string}>("SELECT repository,external_issue_id FROM external_work_links WHERE work_kind='defect' AND work_id=? AND provider='github'",request.id):undefined;
      if(link){
        const result={state:'pending_remote',commandId,message:'等待 GitHub 确认；当前状态尚未修改。'};
        this.store.run("INSERT INTO operator_commands VALUES(?,?,?,?,?,?,?,?,'pending_remote',?)",commandId,projectId,principal.actorRef,source,interactionId,payloadHash,json(request),json(result),this.now());
        const operationId=stableId('external',commandId);const desired=request.action==='reopen'?'open':'closed';const reason=request.action==='fix'?'completed':request.action==='dismiss'?'not_planned':null;
        this.store.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES(?,'github.issue.update',?,?,?,'prepared',?,?)",operationId,request.id,`status:${commandId}`,payloadHash,this.now(),this.now());
        this.store.run('INSERT INTO github_action_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)',operationId,commandId,projectId,request.id,link.repository,link.external_issue_id,request.expectedVersion,request.action,desired,reason,this.now());return result;
      }
      const work=this.domain.applyStatusAction(projectId,request.kind,request.id,request.action,request.expectedVersion,principal.actorRef,commandId,request.rationale);
      const result={state:'succeeded',commandId,status:work.status,version:work.version};
      this.store.run("INSERT INTO operator_commands VALUES(?,?,?,?,?,?,?,?,'succeeded',?)",commandId,projectId,principal.actorRef,source,interactionId,payloadHash,json(request),json(result),this.now());return result;
    });
  }
  reportPage(principal:Principal,projectId:string,id:string,revision:number,section:ReportSectionV1,cursor?:string,limit=3):ReportNavigationPageV1{
    this.auth.authorize(principal,projectId);const scope={projectId,id,revision,section,limit};const offset=this.tokens.offset(principal,scope,cursor);const page=this.reports.section(projectId,id,revision,section,offset,limit);
    return{schemaVersion:'1.0',reportId:id,reportRevision:revision,section,entries:page.entries,...(page.nextOffset!==undefined?{nextCursor:this.tokens.cursor(principal,scope,page.nextOffset)}:{}),coverageWarning:'仅展示已接入来源；空列表不表示没有反馈。'};
  }
  evidence(principal:Principal,projectId:string,kind:WorkKind,id:string,options:{reportId?:string;revision?:number;cursor?:string;limit?:number}={}){
    this.auth.authorize(principal,projectId);const limit=options.limit??3;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ControlError('INVALID_PAGE_LIMIT');
    const scope={projectId,kind,id,reportId:options.reportId??null,revision:options.revision??null,limit};const offset=this.tokens.offset(principal,scope,options.cursor);
    let ids:string[];
    if(options.reportId){
      if(!options.revision||!this.reports.getExact(projectId,options.reportId,options.revision))throw new ControlError('REPORT_NOT_FOUND',404);
      if(!this.store.get('SELECT 1 FROM report_snapshot_entries WHERE report_id=? AND revision=? AND section=? AND entity_id=?',options.reportId,options.revision,kind==='defect'?'bugs':'suggestions',id))throw new ControlError('REPORT_WORK_NOT_MEMBER',403);
      ids=this.store.all<{event_id:string}>('SELECT event_id FROM report_work_evidence WHERE report_id=? AND revision=? AND work_kind=? AND work_id=? ORDER BY ordinal',options.reportId,options.revision,kind,id).map(e=>e.event_id);
    }else ids=[...new Set(this.work(principal,projectId,kind,id).evidence.filter(e=>e.role==='primary').map(e=>e.eventId))];
    const items=ids.slice(offset,offset+limit).map(eventId=>{const e=this.domain.evidence(projectId,eventId);return{evidenceId:eventId,platform:e?.event.data.platform??'unknown',originalText:e&&!e.deleted?e.originalText:'[原文已删除或不可见]',createdAt:e?.event.time??'',visible:Boolean(e&&!e.deleted)};});
    return{total:ids.length,items,...(offset+limit<ids.length?{nextCursor:this.tokens.cursor(principal,scope,offset+limit)}:{})};
  }
  metrics(principal:Principal,projectId:string){this.auth.authorize(principal,projectId);return{sources:this.store.all('SELECT source_id,platform,coverage,health_reason FROM sources WHERE project_id=? ORDER BY source_id',projectId),queue:this.store.all('SELECT kind,status,count(*) count FROM jobs WHERE project_id=? GROUP BY kind,status',projectId),operations:this.store.all(`SELECT o.state,count(*) count FROM external_operations o WHERE o.operation_id IN (SELECT operation_id FROM plugin_delivery_requests WHERE project_id=? UNION SELECT operation_id FROM external_operation_payloads WHERE project_id=? UNION SELECT operation_id FROM github_action_operations WHERE project_id=?) GROUP BY o.state`,projectId,projectId,projectId),pendingCommands:this.store.all('SELECT command_id,state,created_at FROM operator_commands WHERE project_id=? AND state<>? ORDER BY created_at DESC LIMIT 20',projectId,'succeeded')};}
}
