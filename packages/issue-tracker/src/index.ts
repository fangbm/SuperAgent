import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SqliteStore, stableId, canonicalJSON, systemClock, timestamp, addMilliseconds } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DomainService } from '@superagent/domain';
import type { JSONValue } from '@superagent/contracts';
import {WorkReportBuilder,renderWorkReport,workReportHash} from '@superagent/reporting';
import {installIssueAssets} from './issue-assets.js';
export {ArtifactPublisher,GitHubIssueAssets,IssueAssetError,issueAssetURL} from './issue-assets.js';
export type {IssueAssetPort} from './issue-assets.js';

export interface RemoteIssue {number:string;body:string;state:'open'|'closed';stateReason:string|null;pullRequest?:boolean}
export interface RemoteComment {id:string;body:string;authorId:string}
export interface GitHubPort {
  readonly repository:string;
  inspect():Promise<{private:boolean;authorId:string}>;
  createIssue(title:string,body:string):Promise<RemoteIssue>;
  issue(number:string):Promise<RemoteIssue>;
  updateIssueState?(number:string,state:'open'|'closed',reason:'completed'|'not_planned'|null):Promise<RemoteIssue>;
  issues(page:number):Promise<{items:RemoteIssue[];next:boolean}>;
  createComment(number:string,body:string):Promise<RemoteComment>;
  comment(id:string):Promise<RemoteComment>;
  updateComment(id:string,body:string):Promise<RemoteComment>;
  comments(number:string,page:number):Promise<{items:RemoteComment[];next:boolean}>;
}
export class GitHubError extends Error {constructor(readonly code:string,readonly outcome:'blocked'|'safe_retry'|'unknown'|'manual_review'='unknown'){super(code);}}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class GitHubREST implements GitHubPort {
  readonly repository:string;private readonly base:URL;
  constructor(private readonly options:{repository:string;token:string;baseURL?:string;allowLoopbackHTTP?:boolean;timeoutMs?:number;fetch?:typeof fetch}){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)||!options.token)throw new Error('GITHUB_CONFIGURATION_REQUIRED');this.repository=options.repository;
    this.base=new URL(options.baseURL??'https://api.github.com');
    if(this.base.username||this.base.password||this.base.search||this.base.hash||(this.base.protocol!=='https:'&&!(options.allowLoopbackHTTP&&this.base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(this.base.hostname))))throw new Error('INVALID_GITHUB_URL');
  }
  private async request(path:string,method='GET',body?:object):Promise<{data:unknown;next:boolean}>{
    try{const response=await(this.options.fetch??fetch)(new URL(this.base.pathname.replace(/\/$/,'')+path,this.base),{method,redirect:'error',signal:AbortSignal.timeout(this.options.timeoutMs??20_000),
      headers:{Authorization:`Bearer ${this.options.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok){await response.body?.cancel();throw new GitHubError(`GITHUB_HTTP_${response.status}`,[400,401,403,404,422].includes(response.status)?'blocked':response.status===429?'safe_retry':'unknown');}
      if(!response.body)throw new GitHubError('GITHUB_EMPTY_BODY');const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>2_000_000)throw new GitHubError('GITHUB_BODY_LIMIT');chunks.push(r.value);}return{data:JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,next:(response.headers.get('link')??'').includes('rel="next"')};}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }catch(error){if(error instanceof GitHubError)throw error;throw new GitHubError('GITHUB_TRANSPORT_UNKNOWN');}
  }
  private path(suffix=''):string{return `/repos/${this.repository}${suffix}`;}
  private issueData(value:unknown):RemoteIssue{const d=value as {number?:number;body?:string|null;state?:string;state_reason?:string|null;pull_request?:unknown};if(!Number.isSafeInteger(d?.number)||!['open','closed'].includes(d.state??''))throw new GitHubError('GITHUB_INVALID_ISSUE');return{number:String(d.number),body:d.body??'',state:d.state as 'open'|'closed',stateReason:d.state_reason??null,...(d.pull_request?{pullRequest:true}:{})};}
  private commentData(value:unknown):RemoteComment{const d=value as {id?:number;body?:string;user?:{id?:number}};if(!Number.isSafeInteger(d?.id)||typeof d.body!=='string'||!Number.isSafeInteger(d.user?.id))throw new GitHubError('GITHUB_INVALID_COMMENT');return{id:String(d.id),body:d.body,authorId:String(d.user!.id)};}
  async inspect():Promise<{private:boolean;authorId:string}>{const repo=(await this.request(this.path())).data as {private?:boolean};const user=(await this.request('/user')).data as {id?:number};if(!Number.isSafeInteger(user.id))throw new GitHubError('GITHUB_AUTHOR_NOT_VERIFIED','blocked');return{private:repo.private===true,authorId:String(user.id)};}
  async createIssue(title:string,body:string):Promise<RemoteIssue>{return this.issueData((await this.request(this.path('/issues'),'POST',{title,body})).data);}
  async issue(number:string):Promise<RemoteIssue>{if(!/^\d+$/.test(number))throw new GitHubError('INVALID_ISSUE_ID','blocked');return this.issueData((await this.request(this.path(`/issues/${number}`))).data);}
  async updateIssueState(number:string,state:'open'|'closed',reason:'completed'|'not_planned'|null):Promise<RemoteIssue>{if(!/^\d+$/.test(number))throw new GitHubError('INVALID_ISSUE_ID','blocked');return this.issueData((await this.request(this.path(`/issues/${number}`),'PATCH',{state,...(state==='closed'&&reason?{state_reason:reason}:{})})).data);}
  async issues(page:number):Promise<{items:RemoteIssue[];next:boolean}>{const r=await this.request(this.path(`/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`));if(!Array.isArray(r.data))throw new GitHubError('GITHUB_INVALID_LIST');return{items:r.data.map(v=>this.issueData(v)),next:r.next};}
  async createComment(number:string,body:string):Promise<RemoteComment>{return this.commentData((await this.request(this.path(`/issues/${number}/comments`),'POST',{body})).data);}
  async comment(id:string):Promise<RemoteComment>{return this.commentData((await this.request(this.path(`/issues/comments/${id}`))).data);}
  async updateComment(id:string,body:string):Promise<RemoteComment>{return this.commentData((await this.request(this.path(`/issues/comments/${id}`),'PATCH',{body})).data);}
  async comments(number:string,page:number):Promise<{items:RemoteComment[];next:boolean}>{const r=await this.request(this.path(`/issues/${number}/comments?per_page=100&page=${page}`));if(!Array.isArray(r.data))throw new GitHubError('GITHUB_INVALID_LIST');return{items:r.data.map(v=>this.commentData(v)),next:r.next};}
}

interface StatusOperation {operation_id:string;command_id:string;project_id:string;issue_id:string;repository:string;issue_number:string;expected_version:number;action:string;desired_state:'open'|'closed';desired_reason:'completed'|'not_planned'|null;state:string;attempt:number;actor_ref:string;request_json:string}
/** Status-only PATCH, independent of the statistics-comment worker. Never patches body/title/labels. */
export class GitHubActionWorker {
  constructor(readonly store:SqliteStore,readonly domain:DomainService,readonly port:GitHubPort,private readonly options:{authorize:(actor:string,projectId:string)=>void;allowWrites?:boolean;clock?:Clock;leaseMs?:number}){}
  private now():string{return timestamp((this.options.clock??systemClock)());}
  private authorize(row:StatusOperation):void{try{this.options.authorize(row.actor_ref,row.project_id);}catch{throw new GitHubError('ACTION_ACTOR_NOT_AUTHORIZED','blocked');}}
  async tick():Promise<{processed:boolean;state?:string}>{
    this.store.run("UPDATE external_operations SET state='unknown',lease_owner=NULL,lease_until=NULL,last_error='ACTION_SEND_WINDOW_EXPIRED' WHERE state IN ('in_flight','reconciling') AND lease_until<=? AND operation_id IN (SELECT operation_id FROM github_action_operations WHERE repository=?)",this.now(),this.port.repository);
    const row=this.store.get<StatusOperation>(`SELECT a.*,o.state,o.attempt,c.actor_ref,c.request_json FROM github_action_operations a JOIN external_operations o USING(operation_id) JOIN operator_commands c USING(command_id) WHERE a.repository=? AND c.state='pending_remote' AND o.state IN ('prepared','unknown','safe_retry') AND a.next_attempt_at<=? ORDER BY o.created_at LIMIT 1`,this.port.repository,this.now());
    if(!row)return{processed:false};if(!this.options.allowWrites&&row.state!=='unknown')return{processed:false,state:'write_disabled'};
    const token=randomUUID();
    const n=this.store.transaction(()=>{const changed=Number(this.store.run("UPDATE external_operations SET state=?,attempt=attempt+1,lease_owner=?,lease_until=?,updated_at=? WHERE operation_id=? AND state=?",row.state==='unknown'?'reconciling':'in_flight',token,addMilliseconds(this.now(),this.options.leaseMs??120_000),this.now(),row.operation_id,row.state).changes);if(changed)this.store.run('INSERT INTO external_operation_attempts(attempt_id,operation_id,attempt_number,started_at) VALUES(?,?,?,?)',stableId('attempt',row.operation_id,String(row.attempt+1)),row.operation_id,row.attempt+1,this.now());return changed;});
    if(!n)return{processed:false};
    try{
      this.authorize(row);
      if(!(await this.port.inspect()).private)throw new GitHubError('PUBLIC_REPOSITORY_NOT_AUTHORIZED','blocked');
      const work=this.domain.getWork(row.project_id,'defect',row.issue_id);if(!work||work.version!==row.expected_version)throw new GitHubError('ACTION_VERSION_CONFLICT','manual_review');
      let remote=await this.port.issue(row.issue_number);
      const matches=(r:RemoteIssue)=>!r.pullRequest&&r.state===row.desired_state&&(r.state==='open'||r.stateReason===row.desired_reason);
      if(!matches(remote)){
        // A read that does not match cannot prove that an uncertain PATCH was never applied.
        // Keep reconciliation read-only rather than overwrite a later human status change.
        if(row.state==='unknown')return this.release(row,token,row.attempt>=3?'manual_review':'unknown','REMOTE_STATUS_NOT_CONFIRMED');
        if(remote.pullRequest)throw new GitHubError('REMOTE_OBJECT_IS_PR','manual_review');
        const expectedReason=work.status==='dismissed'?'not_planned':'completed';
        if(row.desired_state==='closed'&&remote.state!=='open'||row.desired_state==='open'&&(remote.state!=='closed'||remote.stateReason!==expectedReason))throw new GitHubError('REMOTE_STATUS_CONFLICT','manual_review');
        if(!this.options.allowWrites)return this.release(row,token,'unknown','WRITE_DISABLED_DURING_RECONCILIATION');
        if(row.attempt>=3)throw new GitHubError('ACTION_RETRY_BUDGET','manual_review');
        if(!this.port.updateIssueState)throw new GitHubError('STATUS_PROVIDER_UNAVAILABLE','blocked');
        this.authorize(row);
        await this.port.updateIssueState(row.issue_number,row.desired_state,row.desired_reason);
        remote=await this.port.issue(row.issue_number);
      }
      if(!matches(remote))throw new GitHubError('REMOTE_STATUS_NOT_CONFIRMED');
      this.store.transaction(()=>{
        if(!this.store.get("SELECT 1 FROM external_operations WHERE operation_id=? AND lease_owner=? AND lease_until>? AND state IN ('in_flight','reconciling')",row.operation_id,token,this.now()))throw new GitHubError('EXTERNAL_LEASE_LOST');
        this.authorize(row);
        const latest=this.domain.getWork(row.project_id,'defect',row.issue_id);
        this.store.run("UPDATE external_operations SET state='succeeded',provider_object_id=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=?",remote.number,this.now(),row.operation_id);
        let result:JSONValue;
        if(latest?.version!==row.expected_version)result={state:'manual_review',remoteConfirmed:true,message:'GitHub 已更新，本地版本已变化，需要复核。'};
        else{
          this.store.run('UPDATE work_metadata SET remote_state=?,remote_state_reason=? WHERE work_kind=? AND work_id=?',remote.state,remote.stateReason,'defect',row.issue_id);
          const request=JSON.parse(row.request_json) as {rationale?:string};
          const updated=this.domain.applyStatusAction(row.project_id,'defect',row.issue_id,row.action,row.expected_version,row.actor_ref,row.command_id,request.rationale,row.operation_id);
          result={state:'succeeded',status:updated.status,version:updated.version,remoteConfirmed:true};
        }
        this.store.run('UPDATE operator_commands SET state=?,result_json=? WHERE command_id=?',(result as {state:string}).state,canonicalJSON(result),row.command_id);
        this.store.run("UPDATE external_operation_attempts SET finished_at=?,transport_outcome='succeeded' WHERE operation_id=? AND attempt_number=?",this.now(),row.operation_id,row.attempt+1);
      });return{processed:true,state:'succeeded'};
    }catch(error){const state=error instanceof GitHubError?error.outcome:'unknown';return this.release(row,token,state,error instanceof GitHubError?error.code:'ACTION_FAILED');}
  }
  private release(row:StatusOperation,token:string,state:string,code:string):{processed:boolean;state:string}{
    this.store.transaction(()=>{const changed=this.store.run('UPDATE external_operations SET state=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=? AND lease_owner=?',state,code,this.now(),row.operation_id,token);if(!changed.changes)return;this.store.run('UPDATE github_action_operations SET next_attempt_at=? WHERE operation_id=?',addMilliseconds(this.now(),30_000),row.operation_id);this.store.run('UPDATE external_operation_attempts SET finished_at=?,transport_outcome=? WHERE operation_id=? AND attempt_number=?',this.now(),state,row.operation_id,row.attempt+1);if(['manual_review','blocked'].includes(state))this.store.run("UPDATE operator_commands SET state='manual_review',result_json=? WHERE command_id=?",canonicalJSON({state:'manual_review',errorCode:code}),row.command_id);});return{processed:true,state};
  }
}

interface OperationRow {operation_id:string;kind:string;state:string;attempt:number;lease_owner:string|null;lease_until:string|null;project_id:string;work_kind:'defect'|'suggestion';work_id:string;repository:string;work_version:number;payload_json:string;reconcile_attempt:number;next_attempt_at:string}
interface Payload {title:string;body:string;marker:string;authorId:string;issueNumber?:string;commentId?:string;expectedHash?:string}
export class GitHubSyncManager {
  constructor(readonly store:SqliteStore,readonly domain:DomainService,readonly port:GitHubPort,private readonly options:{clock?:Clock;maxReconciliations?:number;maxPages?:number;leaseMs?:number;allowWrites?:boolean;titlePrefix?:string;reportBuilder?:WorkReportBuilder}={}){installIssueAssets(store);domain.attachments.onChanged=(event,feedbackIds)=>this.attachmentLinkChanged(event,feedbackIds);}
  artifactChanged(eventId:string):void{
    const ids=this.store.all<{feedback_item_id:string}>(`SELECT DISTINCT feedback_item_id FROM attachment_links WHERE event_id=? AND status='confirmed'`,eventId).map(r=>r.feedback_item_id);
    this.attachmentLinkChanged(eventId,ids);
  }
  attachmentLinkChanged(eventId:string,feedbackIds:string[]):void{
    this.store.transaction(()=>{
      const works=this.store.all<{work_kind:string;work_id:string}>(`SELECT DISTINCT l.work_kind,l.work_id FROM work_feedback_links l JOIN feedback_items f USING(feedback_item_id) JOIN github_sync_outbox g ON g.work_kind=l.work_kind AND g.work_id=l.work_id AND g.repository=? WHERE f.active=1 AND (f.feedback_item_id IN (SELECT feedback_item_id FROM feedback_item_evidence WHERE event_id=? AND role='primary') OR f.feedback_item_id IN (SELECT value FROM json_each(?)))`,this.port.repository,eventId,JSON.stringify(feedbackIds));
      for(const work of works){this.store.run('INSERT INTO github_report_revisions(work_kind,work_id,repository,revision) VALUES(?,?,?,1) ON CONFLICT(work_kind,work_id,repository) DO UPDATE SET revision=revision+1',work.work_kind,work.work_id,this.port.repository);this.store.run("UPDATE github_sync_outbox SET state=CASE WHEN state='held' THEN state ELSE 'pending' END,available_at=min(available_at,?) WHERE work_kind=? AND work_id=? AND repository=?",this.now(),work.work_kind,work.work_id,this.port.repository);}
    });
  }
  private now():string{return timestamp((this.options.clock??systemClock)());}
  private operation(id:string):OperationRow|undefined{return this.store.get<OperationRow>('SELECT o.*,p.* FROM external_operations o JOIN external_operation_payloads p USING(operation_id) WHERE operation_id=?',id);}
  private mark(op:OperationRow,state:string,code:string|null=null):void{this.store.run('UPDATE external_operations SET state=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=?',state,code,this.now(),op.operation_id);
    if(['blocked','manual_review'].includes(state))this.store.run("UPDATE github_sync_outbox SET state='held' WHERE work_kind=? AND work_id=? AND repository=?",op.work_kind,op.work_id,op.repository);}
  private prepare(authorId:string):OperationRow|undefined{
    return this.store.transaction(()=>{
      const row=this.store.get<{project_id:string;work_kind:'defect'|'suggestion';work_id:string;repository:string;desired_version:number}>(`SELECT * FROM github_sync_outbox s WHERE repository=? AND state='pending' AND available_at<=?
        AND NOT EXISTS(SELECT 1 FROM external_operations o JOIN external_operation_payloads p USING(operation_id) WHERE p.work_kind=s.work_kind AND p.work_id=s.work_id AND p.repository=s.repository AND o.state IN ('prepared','in_flight','unknown','reconciling','safe_retry'))
        ORDER BY available_at,work_id LIMIT 1`,this.port.repository,this.now());if(!row)return undefined;
      const work=this.domain.getWork(row.project_id,row.work_kind,row.work_id);if(!work||work.reviewRequired||work.feedbackCount===0){this.store.run("UPDATE github_sync_outbox SET state='held' WHERE work_kind=? AND work_id=? AND repository=?",row.work_kind,row.work_id,row.repository);return undefined;}
      const link=this.store.get<{external_issue_id:string}>('SELECT external_issue_id FROM external_work_links WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository);
      const comment=this.store.get<{comment_id:string;body_hash:string;author_id:string}>('SELECT * FROM github_stats_comments WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository);
      const kind=!link?'github.issue.create':!comment?'github.comment.create':'github.issue.update';
      let report;
      try{report=(this.options.reportBuilder??new WorkReportBuilder(this.store,this.domain)).build(work.projectId,work.kind,work.id);}
      catch(error){if(!(error instanceof Error)||!['WORK_REPORT_NOT_AUTHORIZED','WORK_REPORT_NO_VISIBLE_EVIDENCE'].includes(error.message))throw error;this.store.run("UPDATE github_sync_outbox SET state='held' WHERE work_kind=? AND work_id=? AND repository=?",work.kind,work.id,row.repository);return undefined;}
      const reportHash=workReportHash(report),revision=this.store.get<{revision:number}>('SELECT revision FROM github_report_revisions WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository)?.revision??0;
      this.store.run('INSERT INTO github_report_revisions(work_kind,work_id,repository) VALUES(?,?,?) ON CONFLICT DO NOTHING',work.kind,work.id,row.repository);
      if(kind==='github.issue.update'&&this.store.get<{synced_hash:string|null}>('SELECT synced_hash FROM github_report_revisions WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository)?.synced_hash===reportHash){this.store.run('UPDATE github_report_revisions SET synced_revision=revision WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository);this.store.run("UPDATE github_sync_outbox SET state='idle' WHERE work_kind=? AND work_id=? AND repository=? AND desired_version<=?",work.kind,work.id,row.repository,work.version);return undefined;}
      const key=`${kind}:${row.repository}:${work.kind}:${work.id}:${kind==='github.issue.update'?`${work.version}:${reportHash}:r${revision}`:'initial'}`;
      const id=stableId('external',key);const existing=this.operation(id);if(existing){
        if(kind==='github.issue.update'&&existing.state==='succeeded'){this.store.run('UPDATE github_report_revisions SET synced_revision=revision WHERE work_kind=? AND work_id=? AND repository=?',work.kind,work.id,row.repository);this.store.run("UPDATE github_sync_outbox SET state='idle' WHERE work_kind=? AND work_id=? AND repository=? AND desired_version<=?",work.kind,work.id,row.repository,work.version);return undefined;}
        return existing;
      }
      const marker=`<!-- superagent-operation:${id} -->`;
      const body=`${marker}\n\n${renderWorkReport(report)}\n\n原始反馈由授权渠道查询。本条由 SuperAgent 维护。`;
      const payload:Payload={title:(this.options.titlePrefix??'')+work.title,body,marker,authorId,...(link?{issueNumber:link.external_issue_id}:{}),...(comment?{commentId:comment.comment_id,expectedHash:comment.body_hash}:{})};
      this.store.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,correlation_marker,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?)",id,kind,`${work.kind}:${work.id}`,key,marker,hash(canonicalJSON(payload as unknown as JSONValue)),this.now(),this.now());
      this.store.run('INSERT INTO external_operation_payloads VALUES(?,?,?,?,?,?,?,0,?)',id,work.projectId,work.kind,work.id,row.repository,work.version,canonicalJSON(payload as unknown as JSONValue),this.now());
      this.store.run('INSERT INTO github_report_operations VALUES(?,?,?)',id,reportHash,revision);
      this.store.run("UPDATE github_sync_outbox SET state='processing' WHERE work_kind=? AND work_id=? AND repository=?",work.kind,work.id,row.repository);
      return this.operation(id);
    });
  }
  async preview():Promise<Array<{operationId:string;kind:string;title:string;body:string;repository:string}>>{
    const info=await this.port.inspect();if(!info.private)throw new GitHubError('PUBLIC_REPOSITORY_NOT_AUTHORIZED','blocked');
    for(let i=0;i<20;i++)if(!this.prepare(info.authorId))break;
    return this.store.all<OperationRow>("SELECT o.*,p.* FROM external_operations o JOIN external_operation_payloads p USING(operation_id) WHERE repository=? AND state='prepared' ORDER BY created_at,operation_id",this.port.repository).map(op=>{const p=JSON.parse(op.payload_json) as Payload;return{operationId:op.operation_id,kind:op.kind,title:p.title,body:p.body,repository:op.repository};});
  }
  private finish(op:OperationRow,token:string,result:{issue?:RemoteIssue;comment?:RemoteComment}):void{
    this.store.transaction(()=>{
      const own=this.store.get('SELECT 1 FROM external_operations WHERE operation_id=? AND lease_owner=? AND state IN (\'in_flight\',\'reconciling\') AND lease_until>?',op.operation_id,token,this.now());if(!own)throw new GitHubError('EXTERNAL_LEASE_LOST');
      if(result.issue){if(result.issue.pullRequest)throw new GitHubError('REMOTE_OBJECT_IS_PR','manual_review');this.store.run("INSERT INTO external_work_links VALUES(?,?,'github',?,?,?)",op.work_kind,op.work_id,op.repository,result.issue.number,op.operation_id);}
      if(result.comment)this.store.run('INSERT INTO github_stats_comments VALUES(?,?,?,?,?,?) ON CONFLICT(work_kind,work_id,repository) DO UPDATE SET comment_id=excluded.comment_id,body_hash=excluded.body_hash,author_id=excluded.author_id',op.work_kind,op.work_id,op.repository,result.comment.id,hash(result.comment.body),result.comment.authorId);
      this.store.run("UPDATE external_operations SET state='succeeded',provider_object_id=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=?",result.issue?.number??result.comment?.id??null,this.now(),op.operation_id);
      const sentReport=this.store.get<{revision:number;report_hash:string}>('SELECT revision,report_hash FROM github_report_operations WHERE operation_id=?',op.operation_id),sent=sentReport?.revision??0,current=this.store.get<{revision:number}>('SELECT revision FROM github_report_revisions WHERE work_kind=? AND work_id=? AND repository=?',op.work_kind,op.work_id,op.repository)?.revision??0;
      this.store.run('UPDATE github_report_revisions SET synced_revision=max(synced_revision,?),synced_hash=coalesce(?,synced_hash) WHERE work_kind=? AND work_id=? AND repository=?',sent,sentReport?.report_hash??null,op.work_kind,op.work_id,op.repository);
      this.store.run(`UPDATE github_sync_outbox SET synced_version=?,state=CASE WHEN desired_version>? OR ?>? THEN 'pending' ELSE 'idle' END,available_at=? WHERE work_kind=? AND work_id=? AND repository=?`,op.work_version,op.work_version,current,sent,addMilliseconds(this.now(),60000),op.work_kind,op.work_id,op.repository);
    });
  }
  async tick():Promise<{processed:boolean;state?:string;operationId?:string}>{
    this.store.run("UPDATE external_operations SET state='unknown',lease_owner=NULL,lease_until=NULL,last_error='SEND_WINDOW_EXPIRED' WHERE state IN ('in_flight','reconciling') AND lease_until<=? AND operation_id IN (SELECT operation_id FROM external_operation_payloads WHERE repository=?)",this.now(),this.port.repository);
    let info:{private:boolean;authorId:string};
    try{info=await this.port.inspect();}catch{return {processed:false,state:'inspection_unavailable'};}
    if(!info.private)throw new GitHubError('PUBLIC_REPOSITORY_NOT_AUTHORIZED','blocked');
    let op=this.store.get<OperationRow>(`SELECT o.*,p.* FROM external_operations o JOIN external_operation_payloads p USING(operation_id) WHERE p.repository=? AND o.state IN ('unknown','safe_retry','prepared') AND p.next_attempt_at<=? ORDER BY o.created_at LIMIT 1`,this.port.repository,this.now())??this.prepare(info.authorId);
    if(!op)return {processed:false};
    if(['succeeded','blocked','manual_review','in_flight','reconciling'].includes(op.state))return {processed:false,state:op.state,operationId:op.operation_id};
    if(op.state!=='unknown'&&!this.options.allowWrites)return {processed:false,state:'write_disabled',operationId:op.operation_id};
    const work=this.domain.getWork(op.project_id,op.work_kind,op.work_id);if(!work||(op.state!=='unknown'&&(work.reviewRequired||work.feedbackCount===0))){this.mark(op,'manual_review','WORK_REQUIRES_REVIEW');return {processed:true,state:'manual_review',operationId:op.operation_id};}
    if(op.state==='safe_retry'&&op.attempt>=3){this.mark(op,'manual_review','RETRY_BUDGET_EXHAUSTED');return{processed:true,state:'manual_review',operationId:op.operation_id};}
    const token=randomUUID();const reconciling=op.state==='unknown';
    const claimed=this.store.transaction(()=>{const n=Number(this.store.run("UPDATE external_operations SET state=?,attempt=attempt+?,lease_owner=?,lease_until=?,updated_at=? WHERE operation_id=? AND state=?",reconciling?'reconciling':'in_flight',reconciling?0:1,token,addMilliseconds(this.now(),this.options.leaseMs??60_000),this.now(),op.operation_id,op.state).changes);
      if(n&&!reconciling)this.store.run('INSERT INTO external_operation_attempts(attempt_id,operation_id,attempt_number,started_at) VALUES(?,?,?,?)',stableId('attempt',op!.operation_id,String(op!.attempt+1)),op!.operation_id,op!.attempt+1,this.now());return n;});
    if(!claimed)return {processed:false};
    const payload=JSON.parse(op.payload_json) as Payload;
    try{
      if(payload.authorId!==info.authorId)throw new GitHubError('GITHUB_AUTHOR_CHANGED','manual_review');
      if(reconciling)await this.reconcile(op,token,payload);
      else if(op.kind==='github.issue.create'){const issue=await this.port.createIssue(payload.title,payload.body);this.finish(op,token,{issue});}
      else if(op.kind==='github.comment.create'){const comment=await this.port.createComment(payload.issueNumber!,payload.body);if(comment.authorId!==payload.authorId)throw new GitHubError('COMMENT_AUTHOR_MISMATCH','manual_review');this.finish(op,token,{comment});}
      else{
        const comment=await this.port.comment(payload.commentId!);
        if(comment.authorId!==payload.authorId)throw new GitHubError('COMMENT_AUTHOR_MISMATCH','manual_review');
        if(comment.body!==payload.body&&hash(comment.body)!==payload.expectedHash)throw new GitHubError('DEVELOPER_EDIT_CONFLICT','manual_review');
        const updated=comment.body===payload.body?comment:await this.port.updateComment(comment.id,payload.body);
        this.finish(op,token,{comment:updated});
      }
    }catch(error){
      const state=error instanceof GitHubError?error.outcome:error instanceof Error&&error.message.includes('UNIQUE constraint')?'manual_review':'unknown';
      const owned=this.store.get('SELECT 1 FROM external_operations WHERE operation_id=? AND lease_owner=?',op.operation_id,token);
      if(owned){this.mark(op,state,error instanceof GitHubError?error.code:'LOCAL_MAPPING_CONFLICT');this.store.run('UPDATE external_operation_payloads SET next_attempt_at=? WHERE operation_id=?',addMilliseconds(this.now(),30_000),op.operation_id);}
    }
    const final=this.operation(op.operation_id)!.state;
    if(!reconciling)this.store.run('UPDATE external_operation_attempts SET finished_at=?,transport_outcome=? WHERE operation_id=? AND attempt_number=?',this.now(),final,op.operation_id,op.attempt+1);
    return {processed:true,state:final,operationId:op.operation_id};
  }
  private async reconcile(op:OperationRow,token:string,payload:Payload):Promise<void>{
    if(op.kind==='github.issue.update'){
      const comment=await this.port.comment(payload.commentId!);
      if(comment.authorId===payload.authorId&&comment.body===payload.body){this.finish(op,token,{comment});return;}
      // An absent update is a repeatable PATCH of a robot-owned comment, but do
      // not retry until unchanged base content is positively observed.
      if(comment.authorId===payload.authorId&&hash(comment.body)===payload.expectedHash){this.mark(op,'safe_retry','PATCH_ABSENCE_CONFIRMED');return;}
      throw new GitHubError('DEVELOPER_EDIT_CONFLICT','manual_review');
    }
    const found=new Map<string,RemoteIssue|RemoteComment>();let complete=false;
    for(let page=1;page<=(this.options.maxPages??100);page++){
      if(op.kind==='github.issue.create'){const result=await this.port.issues(page);for(const issue of result.items)if(!issue.pullRequest&&issue.body.includes(payload.marker))found.set(issue.number,issue);if(!result.next){complete=true;break;}}
      else{const result=await this.port.comments(payload.issueNumber!,page);for(const comment of result.items)if(comment.authorId===payload.authorId&&comment.body.includes(payload.marker))found.set(comment.id,comment);if(!result.next){complete=true;break;}}
    }
    if(complete&&found.size===1){const result=[...found.values()][0]!;this.finish(op,token,'number' in result?{issue:result}:{comment:result});return;}
    if(complete&&found.size>1)throw new GitHubError('MULTIPLE_CORRELATION_MATCHES','manual_review');
    const attempt=op.reconcile_attempt+1;
    this.store.run('UPDATE external_operation_payloads SET reconcile_attempt=?,next_attempt_at=? WHERE operation_id=?',attempt,addMilliseconds(this.now(),30_000),op.operation_id);
    this.mark(op,attempt>=(this.options.maxReconciliations??3)?'manual_review':'unknown',complete?'CORRELATION_NOT_YET_FOUND':'PAGINATION_INCOMPLETE');
  }
  async syncStatus(projectId:string,kind:'defect'|'suggestion',workId:string):Promise<void>{
    const info=await this.port.inspect();if(!info.private)throw new GitHubError('PUBLIC_REPOSITORY_NOT_AUTHORIZED','blocked');
    const link=this.store.get<{external_issue_id:string}>("SELECT external_issue_id FROM external_work_links WHERE work_kind=? AND work_id=? AND repository=?",kind,workId,this.port.repository);
    if(!link||!this.domain.getWork(projectId,kind,workId))throw new Error('WORK_LINK_NOT_AUTHORIZED');const remote=await this.port.issue(link.external_issue_id);this.domain.remoteStatus(projectId,kind,workId,remote.state,remote.stateReason);
  }
  webhook(secret:string,deliveryId:string,signature:string,rawBody:Buffer):void{
    if(!secret||!deliveryId||!/^sha256=[a-f0-9]{64}$/.test(signature))throw new Error('WEBHOOK_SIGNATURE_INVALID');
    const expected=createHmac('sha256',secret).update(rawBody).digest();if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))throw new Error('WEBHOOK_SIGNATURE_INVALID');
    const payload=JSON.parse(rawBody.toString('utf8')) as {repository?:{full_name?:string;private?:boolean};issue?:{number?:number;state?:'open'|'closed';state_reason?:string|null}};
    if(payload.repository?.full_name?.toLowerCase()!==this.port.repository.toLowerCase()||payload.repository.private!==true||!payload.issue?.number||!['open','closed'].includes(payload.issue.state??''))throw new Error('WEBHOOK_SCOPE_INVALID');
    this.store.transaction(()=>{const prior=this.store.get<{payload_hash:string}>('SELECT payload_hash FROM github_webhook_receipts WHERE delivery_id=?',deliveryId);if(prior){if(prior.payload_hash!==hash(rawBody.toString('utf8')))throw new Error('WEBHOOK_REPLAY_CONFLICT');return;}
      const link=this.store.get<{work_kind:'defect'|'suggestion';work_id:string}>("SELECT work_kind,work_id FROM external_work_links WHERE repository=? AND external_issue_id=?",this.port.repository,String(payload.issue!.number));
      if(link){const meta=this.store.get<{project_id:string}>('SELECT project_id FROM work_metadata WHERE work_kind=? AND work_id=?',link.work_kind,link.work_id)!;this.domain.remoteStatus(meta.project_id,link.work_kind,link.work_id,payload.issue!.state!,payload.issue!.state_reason??null);}
      this.store.run('INSERT INTO github_webhook_receipts VALUES(?,?,?,?)',deliveryId,this.port.repository,hash(rawBody.toString('utf8')),this.now());});
  }
}
