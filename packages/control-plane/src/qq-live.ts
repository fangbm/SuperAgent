import {randomUUID} from 'node:crypto';
import {ensureQQFeatures,canonicalJSON,addMilliseconds} from '@superagent/persistence';
import type {JSONValue} from '@superagent/contracts';
import type {ControlPlane} from './index.js';
import {ControlError} from './auth.js';
import type {Principal} from './auth.js';
export interface QQLiveEntry {kind:'defect'|'suggestion'|'task';id:string;title:string;status:string;category:string;count?:number;last?:string;github?:string;evidenceIds?:string[]}
export interface QQLiveSnapshot {id:string;start:string;end:string;title:string;summary:string;entries:QQLiveEntry[];total:number}
export interface QQMenuOptions {enabled:boolean;autoDeploy?:false;defaultRecentHours?:number;webURL?:string}
type Mode='pending'|'recent'|'all-bugs'|'all-suggestions';
export class QQLiveQueries {
  constructor(private readonly control:ControlPlane){ensureQQFeatures(control.store);}
  create(principal:Principal,project:string,mode:Mode,now:string,hours=24):QQLiveSnapshot {
    this.control.auth.authorize(principal,project);
    if(!['pending','recent','all-bugs','all-suggestions'].includes(mode)||!Number.isInteger(hours)||hours<1||hours>168)throw new ControlError('INVALID_WORK_QUERY');
    return this.control.store.transaction(()=>{
      const id=randomUUID(),store=this.control.store,last=this.control.reports.list(project,1)[0];
      const start=mode==='recent'?(last?.window.endExclusive??addMilliseconds(now,-hours*3600000)):now;
      const counts:Record<string,number>={bugs:0,suggestions:0,verify:0,pending:0,running:0,retry:0,failed:0,rate_limited:0};let total=0;
      const append=(entry:QQLiveEntry)=>store.run('INSERT INTO qq_query_members VALUES(?,?,?,?,?)',id,total++,entry.kind,entry.id,canonicalJSON(entry as unknown as JSONValue));
      // Bounded keyset reads materialize members once. Navigation later uses
      // ordinal PK seeks, never changing live OFFSET pages or truncating all-work lists.
      for(const kind of ['defect','suggestion'] as const){
        if(mode==='all-bugs'&&kind!=='defect'||mode==='all-suggestions'&&kind!=='suggestion')continue;
        const table=kind==='defect'?'issues':'suggestions',key=kind==='defect'?'issue_id':'suggestion_id';
        const filter=mode==='pending'?(kind==='defect'?" AND t.status IN ('candidate','open','investigating','fixed')":" AND t.status IN ('candidate','reviewing')"):'';
        let afterTime='9999',afterId='';
        for(;;){
          const rows=store.all<{id:string;title:string;status:string;created_at:string;updated_at:string;content_json:string}>(`SELECT t.${key} id,t.title,t.status,t.created_at,t.updated_at,m.content_json FROM ${table} t JOIN work_metadata m ON m.work_kind=? AND m.work_id=t.${key} AND m.project_id=t.project_id WHERE t.project_id=? AND m.merged_into IS NULL AND t.created_at<=?${filter} AND (t.updated_at,t.${key})<(?,?) ORDER BY t.updated_at DESC,t.${key} DESC LIMIT 256`,kind,project,now,afterTime,afterId);
          if(!rows.length)break;
          for(const row of rows){
            const evidence=store.all<{received_at:string}>(`SELECT min((SELECT min(first.received_at) FROM source_events first WHERE first.source_id=p.source_id AND json_extract(first.payload_json,'$.data.object.externalId')=p.external_id)) received_at FROM work_feedback_links l JOIN feedback_items f USING(feedback_item_id) JOIN feedback_primary_objects p USING(feedback_item_id) JOIN source_events e ON e.event_id=p.event_id AND e.project_id=? WHERE l.work_kind=? AND l.work_id=? AND f.active=1 GROUP BY p.source_id,p.external_id ORDER BY received_at DESC`,project,kind,row.id);
            const fresh=evidence.filter(e=>e.received_at>=start&&e.received_at<=now);
            if(mode==='recent'&&row.created_at<start&&!fresh.length)continue;
            const github=store.get<{external_issue_id:string}>('SELECT external_issue_id FROM external_work_links WHERE work_kind=? AND work_id=? AND provider=\'github\' LIMIT 1',kind,row.id);
            const anchors=(JSON.parse(row.content_json) as {evidence:{role:string;eventId:string}[]}).evidence;
            const evidenceIds=[...new Set(anchors.filter(e=>e.role==='primary').map(e=>e.eventId))].sort();
            append({kind,id:row.id,title:row.title,status:row.status,evidenceIds,category:mode==='recent'?(row.created_at>=start?'新增工作项':'已有问题新增反馈'):row.status==='fixed'?'待验证':kind==='suggestion'?'待复核建议':'Bug',count:mode==='recent'?fresh.length:evidence.length,...(evidence[0]?{last:evidence[0].received_at}:{}),...(github?{github:github.external_issue_id}:{})});
            if(kind==='suggestion')counts.suggestions!++;else if(row.status==='fixed')counts.verify!++;else counts.bugs!++;
          }
          afterTime=rows.at(-1)!.updated_at;afterId=rows.at(-1)!.id;
        }
      }
      if(mode==='pending'||mode==='recent'){
        let afterTime='9999',afterId='';
        for(;;){
          const tasks=store.all<{event_id:string;received_at:string;rationale_code:string|null;status:string|null}>(`SELECT e.event_id,e.received_at,a.rationale_code,coalesce(j.status,aj.status) status FROM source_events e LEFT JOIN admission_decisions a ON a.event_id=e.event_id AND a.rowid=(SELECT max(latest.rowid) FROM admission_decisions latest WHERE latest.event_id=e.event_id) LEFT JOIN jobs aj ON aj.project_id=e.project_id AND aj.idempotency_key='admit:admission-v1:'||e.event_id LEFT JOIN jobs j ON j.job_id=(SELECT jj.job_id FROM batch_events b JOIN jobs jj ON jj.project_id=e.project_id AND jj.kind IN ('feedback.batch.triage','feedback.extract.v2') AND json_extract(jj.payload_json,'$.batchId')=b.batch_id WHERE b.event_id=e.event_id AND b.role='candidate' ORDER BY jj.created_at DESC,jj.rowid DESC LIMIT 1) WHERE e.project_id=? AND e.received_at<=? AND e.event_type NOT LIKE 'com.superagent.source.%' AND (?='pending' OR e.received_at>=?) AND (e.received_at,e.event_id)<(?,?) AND (a.event_id IS NULL OR a.rationale_code LIKE 'QQ_EXPLICIT_RATE_%' OR a.decision<>'archive_only' AND (j.status IS NULL OR j.status NOT IN ('completed','cancelled'))) ORDER BY e.received_at DESC,e.event_id DESC LIMIT 256`,project,now,mode,start,afterTime,afterId);
          if(!tasks.length)break;
          for(const task of tasks){
            const state=task.rationale_code?.startsWith('QQ_EXPLICIT_RATE_')?'rate_limited':task.status==='dead_letter'?'failed':task.status==='retry_wait'?'retry':['leased','running'].includes(task.status??'')?'running':'pending';
            counts[state]!++;append({kind:'task',id:task.event_id,title:state==='rate_limited'?'限流归档，未分析':'等待分析的反馈',status:state,category:'待分析',last:task.received_at});
          }
          afterTime=tasks.at(-1)!.received_at;afterId=tasks.at(-1)!.event_id;
        }
      }
      const snapshot:QQLiveSnapshot={id,start,end:now,title:mode==='pending'?'实时待办':mode==='recent'?'实时新增':mode==='all-bugs'?'全部 Bug':'全部建议',summary:`未处理 Bug ${counts.bugs} · 待复核建议 ${counts.suggestions} · 待验证 ${counts.verify}\n待分析 ${counts.pending} · 运行中 ${counts.running} · 等待重试 ${counts.retry} · 失败 ${counts.failed} · 限流未分析 ${counts.rate_limited}`,entries:[],total};
      store.run('DELETE FROM qq_query_snapshots WHERE expires_at<?',now);
      store.run('INSERT INTO qq_query_snapshots VALUES(?,?,?,?,?,?)',id,project,principal.actorRef,now,addMilliseconds(now,3600000),canonicalJSON(snapshot as unknown as JSONValue));
      return{...snapshot,entries:this.page(principal,project,id,now,0)};
    });
  }
  private metadata(principal:Principal,project:string,id:string,now:string):QQLiveSnapshot {
    this.control.auth.authorize(principal,project);const row=this.control.store.get<{payload_json:string}>('SELECT payload_json FROM qq_query_snapshots WHERE snapshot_id=? AND project_id=? AND actor_ref=? AND expires_at>?',id,project,principal.actorRef,now);
    if(!row)throw new ControlError('TOKEN_EXPIRED_OR_USED',410);return JSON.parse(row.payload_json) as QQLiveSnapshot;
  }
  read(principal:Principal,project:string,id:string,now:string):QQLiveSnapshot {return{...this.metadata(principal,project,id,now),entries:this.page(principal,project,id,now,0)};}
  page(principal:Principal,project:string,id:string,now:string,offset:number,limit=3):QQLiveEntry[]{
    const snapshot=this.metadata(principal,project,id,now);if(!Number.isInteger(offset)||offset<0||offset>snapshot.total||!Number.isInteger(limit)||limit<1||limit>50)throw new ControlError('INVALID_FEEDBACK_PAGE');
    return this.control.store.all<{payload_json:string}>('SELECT payload_json FROM qq_query_members WHERE snapshot_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal',id,offset,offset+limit).map(r=>JSON.parse(r.payload_json) as QQLiveEntry);
  }
  entry(principal:Principal,project:string,id:string,now:string,kind:string,workId:string):QQLiveEntry {
    this.metadata(principal,project,id,now);const row=this.control.store.get<{payload_json:string}>('SELECT payload_json FROM qq_query_members WHERE snapshot_id=? AND kind=? AND entry_id=?',id,kind,workId);
    if(!row)throw new ControlError('WORK_NOT_FOUND',404);return JSON.parse(row.payload_json) as QQLiveEntry;
  }
}
