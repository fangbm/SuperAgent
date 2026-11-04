import { createHash } from 'node:crypto';
import type { InternalEventId, JSONValue, NormalizedEventV1, ReportNavigationEntryV1, ReportSectionV1, ReportV2, ReportWindowV1, SteamNegativeReviewSnapshotMemberV1, SuggestionStatusV1 } from '@superagent/contracts';
import { parseContract } from '@superagent/contract-validation';
import { canonicalJSON, SqliteStore, stableId, systemClock, timestamp, isRestrictedProject } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import { DomainService } from '@superagent/domain';
import { DurableJobQueue } from '@superagent/job-queue';
import { latestClosedWindow, nextReportEnd, reportWindow } from './windows.js';
export { latestClosedWindow, nextReportEnd, reportWindow } from './windows.js';
export { qqReport,qqList,qqWork,qqFeedback,qqEvidence,qqNotice,qqStatus,qqActionLabel,qqLiteral,beijingTime } from './presentation.js';
export type { QQMessageView } from './presentation.js';
const json = (v: unknown) => canonicalJSON(v as JSONValue);
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const title = (v: string) => v.replace(/[\r\n]/g,' ').replace(/[<>\[\]()]/g,'').slice(0,160);
interface EventRow { event_id: InternalEventId; source_id: string; received_at: string; payload_json: string }
export class ReportService {
  constructor(readonly store: SqliteStore, readonly domain: DomainService, readonly queue: DurableJobQueue, private readonly options: { clock?: Clock; recipients?: readonly string[]; graceSeconds?: number } = {}) {}
  private now(): string { return timestamp((this.options.clock ?? systemClock)()); }
  async requestReport(window:ReportWindowV1):Promise<{reportId:string;revision:number}>{const report=this.generate(window);return{reportId:report.reportId,revision:report.revision};}
  generate(window: ReportWindowV1, options: { revise?: boolean; expectedRevision?: number } = {}): ReportV2 {
    if(isRestrictedProject(this.store,window.projectId))throw new Error('PRIVATE_PROJECT_REPORT_NOT_AUTHORIZED');
    const valid = reportWindow(window.projectId, window.endExclusive);
    if (json(valid) !== json({ ...window, startInclusive: timestamp(window.startInclusive), endExclusive: timestamp(window.endExclusive) })) throw new Error('REPORT_WINDOW_MISMATCH');
    if (Date.parse(valid.endExclusive) + (this.options.graceSeconds ?? 180) * 1000 > Date.parse(this.now())) throw new Error('REPORT_WINDOW_NOT_DUE');
    if (!this.store.get('SELECT 1 FROM projects WHERE project_id=?', window.projectId)) throw new Error('PROJECT_NOT_FOUND');
    return this.store.transaction(() => {
      const reportId = stableId('report', window.projectId, valid.startInclusive, valid.endExclusive);
      const latest = this.store.get<{ revision: number }>('SELECT max(revision) revision FROM report_revision_seals WHERE report_id=?', reportId)?.revision ?? 0;
      if (latest && !options.revise) return this.getExact(window.projectId, reportId, latest)!;
      if (options.revise && (!latest || options.expectedRevision !== latest)) throw new Error('REPORT_REVISION_CONFLICT');
      const revision = latest + 1, cutoff = this.now();
      const eventRows = this.store.all<EventRow>("SELECT event_id,source_id,received_at,payload_json FROM source_events WHERE project_id=? AND received_at>=? AND received_at<? AND received_at<=? AND event_type<>'com.superagent.source.coverage.changed.v1' ORDER BY received_at,rowid", window.projectId, valid.startInclusive, valid.endExclusive, cutoff);
      const itemRows = this.store.all<{ feedback_item_id: string; kind: 'defect'|'suggestion'; work_id: string }>(`SELECT DISTINCT f.feedback_item_id,f.kind,l.work_id FROM feedback_items f JOIN feedback_item_metadata m USING(feedback_item_id)
        JOIN work_feedback_links l USING(feedback_item_id) JOIN feedback_primary_objects p USING(feedback_item_id) JOIN source_events e ON e.event_id=p.event_id
        WHERE m.project_id=? AND f.active=1 AND f.created_at<=? AND e.received_at>=? AND e.received_at<? AND e.received_at<=?`, window.projectId, cutoff, valid.startInclusive, valid.endExclusive, cutoff);
      const pending = eventRows.filter(e => {
        const admission = this.store.get<{ decision: string }>('SELECT decision FROM admission_decisions WHERE event_id=?', e.event_id);
        if (!admission) return true; if (admission.decision === 'archive_only') return false;
        return !this.store.get(`SELECT 1 FROM batch_events b JOIN triage_extractions t USING(batch_id) WHERE b.event_id=? AND b.role='candidate' AND t.created_at<=?`, e.event_id, cutoff);
      }).length;
      const works = [...new Set(itemRows.map(i => `${i.kind}:${i.work_id}`))].flatMap(key => {
        const index = key.indexOf(':'); const kind = key.slice(0,index) as 'defect'|'suggestion'; const work = this.domain.getWork(window.projectId, kind, key.slice(index+1)); return work ? [work] : [];
      }).sort((a,b) => b.priority-a.priority || a.id.localeCompare(b.id));
      const steam = this.steamMembers(window.projectId, eventRows, cutoff);
      const coverage = this.store.all<{ source_id: string; coverage: ReportV2['coverage'][number]['status']; health_reason: string|null }>('SELECT source_id,coverage,health_reason FROM sources WHERE project_id=? ORDER BY source_id', window.projectId).map(r => ({ sourceId:r.source_id,status:r.coverage,...(r.health_reason?{reason:r.health_reason}:{}) }));
      const report: ReportV2 = { schemaVersion:'2.1',reportId,revision,window:valid,generatedAt:cutoff,snapshotCutoffAt:cutoff,...(latest?{supersedesRevision:latest}:{}),coverage,
        counts:{newFeedbackItems:itemRows.length,newDefectItems:itemRows.filter(i=>i.kind==='defect').length,newSuggestionItems:itemRows.filter(i=>i.kind==='suggestion').length,uniqueDefects:works.filter(w=>w.kind==='defect').length,uniqueSuggestions:works.filter(w=>w.kind==='suggestion').length,pendingAnalysis:pending},
        issueIds:works.filter(w=>w.kind==='defect').map(w=>w.id),suggestionIds:works.filter(w=>w.kind==='suggestion').map(w=>w.id),uniqueSourceEventCount:eventRows.length,steamNegativeReviews:steam,markdown:'' };
      const lines = ['# 社区反馈半日报',`${this.local(valid.startInclusive)} — ${this.local(valid.endExclusive)} · 北京时间`,`修订 ${revision} · 独立来源事件 ${eventRows.length} · 待分析 ${pending}`,
        `\n## Bug · ${report.counts.uniqueDefects}`, ...works.filter(w=>w.kind==='defect').slice(0,5).map(w=>`- ${title(w.title)} · 本期反馈 ${itemRows.filter(i=>i.work_id===w.id).length} · ${w.status}${this.store.get('SELECT 1 FROM p0_alerts WHERE issue_id=?',w.id)?' · 已有 P0 告警记录':''}`),
        `\n## 建议 · ${report.counts.uniqueSuggestions}`, ...works.filter(w=>w.kind==='suggestion').slice(0,5).map(w=>`- ${title(w.title)} · ${w.status}`),
        `\n## Steam 差评 · ${steam.length}`,'按来源评价去重；原文通过授权详情查询。', '\n## 覆盖与待处理', ...coverage.map(c=>`- ${c.sourceId}: ${c.status}${c.reason?' · '+c.reason:''}`), '仅统计已接入来源；空列表不代表没有反馈。', '查看 Bug / 查看建议 / 查看 Steam 差评'];
      report.markdown=lines.join('\n'); parseContract('report-v2',report);
      if (!latest) this.store.run('INSERT INTO report_series VALUES(?,?,?,?)',reportId,window.projectId,valid.startInclusive,valid.endExclusive);
      this.store.run("INSERT INTO report_revisions VALUES(?,?,?,?,?,'2.1',?,?,?,?)",reportId,revision,window.projectId,valid.startInclusive,valid.endExclusive,cutoff,cutoff,latest||null,json(report));
      for (const kind of ['defect','suggestion'] as const) {
        const members=works.filter(w=>w.kind===kind);
        members.forEach((work,ordinal)=>{
          const entry:ReportNavigationEntryV1=kind==='defect'?{kind:'bug',id:work.id,title:work.title,newFeedbackCount:itemRows.filter(i=>i.work_id===work.id).length,priority:String(work.priority)}:{kind:'suggestion',id:work.id,title:work.title,newFeedbackCount:itemRows.filter(i=>i.work_id===work.id).length,status:work.status as SuggestionStatusV1};
          this.store.run('INSERT INTO report_snapshot_entries VALUES(?,?,?,?,?,?)',reportId,revision,kind==='defect'?'bugs':'suggestions',ordinal,work.id,json(entry));
          [...new Set(work.evidence.filter(e=>e.role==='primary').map(e=>e.eventId))].forEach((id,n)=>{if(this.domain.evidence(window.projectId,id))this.store.run('INSERT INTO report_work_evidence VALUES(?,?,?,?,?,?)',reportId,revision,kind,work.id,n,id);});
        });
      }
      steam.forEach((m,ordinal)=>{
        this.store.run("INSERT INTO report_steam_negative_reviews VALUES(?,?,?,?,?,?,?,?,?,'negative',?)",reportId,revision,ordinal,m.sourceId,m.reviewExternalId,m.evidenceEventId,m.observedAt,m.occurredAt,m.updatedInWindow?1:0,m.originalUrl??null);
        for(const id of m.triggerEventIds)this.store.run('INSERT INTO report_steam_review_trigger_events VALUES(?,?,?,?,?)',reportId,revision,m.sourceId,m.reviewExternalId,id);
      });
      this.validateMembers(report);
      this.store.run('INSERT INTO report_revision_seals VALUES(?,?,?,?)',reportId,revision,cutoff,this.snapshotHash(report));
      // Corrections are archived, not automatically sent as extra off-schedule reports.
      if (!latest) for(const recipient of this.options.recipients??[]) this.store.run("INSERT INTO report_delivery_plans(plan_id,project_id,report_id,revision,recipient_ref,created_at) VALUES(?,?,?,?,?,?)",stableId('report-plan',reportId,String(revision),recipient),window.projectId,reportId,revision,recipient,cutoff);
      return report;
    });
  }
  private local(value:string):string{return new Date(Date.parse(value)+8*3_600_000).toISOString().slice(0,16).replace('T',' ');}
  private steamMembers(projectId:string,rows:EventRow[],cutoff:string):SteamNegativeReviewSnapshotMemberV1[]{
    const triggers=new Map<string,{sourceId:string;externalId:string;ids:InternalEventId[];last:string}>();
    for(const row of rows){const e=JSON.parse(row.payload_json) as NormalizedEventV1;if(e.data.platform!=='steam-reviews'||!['com.superagent.feedback.review.created.v1','com.superagent.feedback.review.updated.v1'].includes(e.type)||e.type==='com.superagent.source.coverage.changed.v1')continue;
      const key=json([row.source_id,e.data.object.externalId]);const prior=triggers.get(key);if(prior){prior.ids.push(row.event_id);prior.last=row.received_at;}else triggers.set(key,{sourceId:row.source_id,externalId:e.data.object.externalId,ids:[row.event_id],last:row.received_at});}
    return [...triggers.values()].sort((a,b)=>b.last.localeCompare(a.last)||a.sourceId.localeCompare(b.sourceId)||a.externalId.localeCompare(b.externalId)).flatMap(t=>{
      const versions=this.store.all<EventRow>("SELECT event_id,source_id,received_at,payload_json FROM source_events WHERE project_id=? AND source_id=? AND json_extract(payload_json,'$.data.object.externalId')=? AND received_at<=? ORDER BY received_at,rowid",projectId,t.sourceId,t.externalId,cutoff);
      let chosen:{row:EventRow;e:Exclude<NormalizedEventV1,{type:'com.superagent.source.coverage.changed.v1'}>;rank:number}|undefined;
      for(const row of versions){const e=JSON.parse(row.payload_json) as NormalizedEventV1;if(e.type==='com.superagent.source.coverage.changed.v1'||e.data.object.kind!=='review')continue;const rank=e.type.includes('.deleted.')?2:e.type.includes('.updated.')?1:0;if(!chosen||e.time>chosen.e.time||e.time===chosen.e.time&&rank>chosen.rank)chosen={row,e,rank};}
      if(!chosen||chosen.rank===2||!(chosen.e.data.attributes?.sentiment==='negative'||chosen.e.data.attributes?.votedUp===false||chosen.e.data.attributes?.voted_up===false))return [];
      let originalUrl:string|undefined;try{const u=new URL(chosen.e.data.origin?.permalink??'');if(u.protocol==='https:'&&!u.username&&!u.password&&['steamcommunity.com','store.steampowered.com'].includes(u.hostname))originalUrl=u.href;}catch{/* No trusted original URL. */}
      return [{sourceId:t.sourceId,reviewExternalId:t.externalId,evidenceEventId:chosen.row.event_id,triggerEventIds:t.ids,observedAt:chosen.row.received_at,occurredAt:chosen.e.time,updatedInWindow:t.ids.some(id=>JSON.parse(rows.find(r=>r.event_id===id)!.payload_json).type.includes('.updated.')),sentimentAtSnapshot:'negative' as const,...(originalUrl?{originalUrl}:{})}];
    });
  }
  private validateMembers(report:ReportV2):void{
    const entries=this.store.all<{section:string;entity_id:string}>('SELECT section,entity_id FROM report_snapshot_entries WHERE report_id=? AND revision=? ORDER BY section,ordinal',report.reportId,report.revision);
    if(json(entries.filter(e=>e.section==='bugs').map(e=>e.entity_id))!==json(report.issueIds)||json(entries.filter(e=>e.section==='suggestions').map(e=>e.entity_id))!==json(report.suggestionIds))throw new Error('REPORT_MEMBERSHIP_MISMATCH');
    const steam=this.store.all<{source_id:string;review_external_id:string;evidence_event_id:string}>('SELECT source_id,review_external_id,evidence_event_id FROM report_steam_negative_reviews WHERE report_id=? AND revision=? ORDER BY ordinal',report.reportId,report.revision);
    if(json(steam)!==json(report.steamNegativeReviews.map(m=>({source_id:m.sourceId,review_external_id:m.reviewExternalId,evidence_event_id:m.evidenceEventId}))))throw new Error('REPORT_STEAM_MEMBERSHIP_MISMATCH');
    for(const member of report.steamNegativeReviews){
      const actual=this.store.get<{observed_at:string;occurred_at:string;updated_in_window:number;original_url:string|null}>('SELECT observed_at,occurred_at,updated_in_window,original_url FROM report_steam_negative_reviews WHERE report_id=? AND revision=? AND source_id=? AND review_external_id=?',report.reportId,report.revision,member.sourceId,member.reviewExternalId)!;
      const evidence=this.store.get<EventRow>('SELECT event_id,source_id,received_at,payload_json FROM source_events WHERE project_id=? AND event_id=?',report.window.projectId,member.evidenceEventId);if(!evidence)throw new Error('REPORT_STEAM_EVIDENCE_INVALID');
      const source=JSON.parse(evidence.payload_json) as NormalizedEventV1;
      if(source.type==='com.superagent.source.coverage.changed.v1'||source.data.platform!=='steam-reviews'||source.data.object.externalId!==member.reviewExternalId||evidence.source_id!==member.sourceId||source.type.includes('.deleted.')||source.time!==member.occurredAt||evidence.received_at!==member.observedAt||evidence.received_at>report.snapshotCutoffAt||actual.observed_at!==member.observedAt||actual.occurred_at!==member.occurredAt||Boolean(actual.updated_in_window)!==member.updatedInWindow||actual.original_url!==(member.originalUrl??null))throw new Error('REPORT_STEAM_EVIDENCE_INVALID');
      const triggers=this.store.all<EventRow>(`SELECT e.event_id,e.source_id,e.received_at,e.payload_json FROM report_steam_review_trigger_events t JOIN source_events e USING(event_id) WHERE t.report_id=? AND t.revision=? AND t.source_id=? AND t.review_external_id=? ORDER BY e.event_id`,report.reportId,report.revision,member.sourceId,member.reviewExternalId);
      if(json(triggers.map(t=>t.event_id))!==json([...member.triggerEventIds].sort()))throw new Error('REPORT_STEAM_TRIGGER_MISMATCH');
      for(const trigger of triggers){const event=JSON.parse(trigger.payload_json) as NormalizedEventV1;if(event.type==='com.superagent.source.coverage.changed.v1'||event.data.projectId!==report.window.projectId||trigger.source_id!==member.sourceId||event.data.object.externalId!==member.reviewExternalId||trigger.received_at<report.window.startInclusive||trigger.received_at>=report.window.endExclusive)throw new Error('REPORT_STEAM_TRIGGER_INVALID');}
    }
  }
  private snapshotHash(report:ReportV2):string{return digest(json({report,entries:this.store.all('SELECT * FROM report_snapshot_entries WHERE report_id=? AND revision=? ORDER BY section,ordinal',report.reportId,report.revision),steam:this.store.all('SELECT * FROM report_steam_negative_reviews WHERE report_id=? AND revision=? ORDER BY ordinal',report.reportId,report.revision),triggers:this.store.all('SELECT * FROM report_steam_review_trigger_events WHERE report_id=? AND revision=? ORDER BY source_id,review_external_id,event_id',report.reportId,report.revision),evidence:this.store.all('SELECT * FROM report_work_evidence WHERE report_id=? AND revision=? ORDER BY work_kind,work_id,ordinal',report.reportId,report.revision)}));}
  getExact(projectId:string,id:string,revision:number):ReportV2|null{
    const row=this.store.get<{report_json:string;content_hash:string}>('SELECT r.report_json,s.content_hash FROM report_revisions r JOIN report_revision_seals s USING(report_id,revision) WHERE r.project_id=? AND r.report_id=? AND r.revision=?',projectId,id,revision);if(!row)return null;
    const report=parseContract('report-v2',JSON.parse(row.report_json));if(this.snapshotHash(report)!==row.content_hash)throw new Error('REPORT_SEAL_MISMATCH');this.validateMembers(report);return report;
  }
  list(projectId:string,limit=30):ReportV2[]{return this.store.all<{report_id:string;revision:number}>('SELECT r.report_id,r.revision FROM report_revisions r JOIN report_revision_seals s USING(report_id,revision) WHERE r.project_id=? ORDER BY window_end DESC,r.revision DESC LIMIT ?',projectId,Math.max(1,Math.min(100,limit))).map(r=>this.getExact(projectId,r.report_id,r.revision)!);}
  section(projectId:string,id:string,revision:number,section:ReportSectionV1,offset=0,limit=3):{entries:ReportNavigationEntryV1[];total:number;nextOffset?:number}{
    const report=this.getExact(projectId,id,revision);if(!report)throw new Error('REPORT_NOT_FOUND');if(!['bugs','suggestions','steam_negative_reviews'].includes(section)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('INVALID_REPORT_PAGE');
    let entries:ReportNavigationEntryV1[];
    if(section==='steam_negative_reviews')entries=report.steamNegativeReviews.map(m=>{const e=this.domain.evidence(projectId,m.evidenceEventId);return {kind:'steam_negative_review',id:stableId('steam',m.sourceId,m.reviewExternalId),sourceId:m.sourceId,reviewExternalId:m.reviewExternalId,evidenceEventId:m.evidenceEventId,originalText:e&&!e.deleted?e.originalText:'[原文已删除或不可见]',occurredAt:m.occurredAt,updatedInWindow:m.updatedInWindow,...(m.originalUrl?{originalUrl:m.originalUrl}:{})};});
    else entries=this.store.all<{entry_json:string}>('SELECT entry_json FROM report_snapshot_entries WHERE report_id=? AND revision=? AND section=? ORDER BY ordinal',id,revision,section).map(e=>JSON.parse(e.entry_json) as ReportNavigationEntryV1);
    return {entries:entries.slice(offset,offset+limit),total:entries.length,...(offset+limit<entries.length?{nextOffset:offset+limit}:{})};
  }
  registerSchedule(projectId:string,startAt?:string):void{
    const first=startAt?nextReportEnd(startAt):latestClosedWindow(projectId,this.now(),this.options.graceSeconds??180).endExclusive;
    this.store.run('INSERT INTO report_schedules(project_id,next_end) VALUES(?,?) ON CONFLICT(project_id) DO NOTHING',projectId,first);
  }
  scheduleDue(maxWindows=20):number{
    let n=0;for(const row of this.store.all<{project_id:string;next_end:string}>('SELECT project_id,next_end FROM report_schedules WHERE enabled=1 ORDER BY next_end')){
      let end=row.next_end;while(Date.parse(end)+(this.options.graceSeconds??180)*1000<=Date.parse(this.now())&&n<maxWindows){this.store.transaction(()=>{const current=this.store.get<{next_end:string}>('SELECT next_end FROM report_schedules WHERE project_id=?',row.project_id)!;if(current.next_end!==end)return;this.queue.create(row.project_id,'report.generate',JSON.parse(json({window:reportWindow(row.project_id,end)})) as JSONValue,`report:${end}`);this.store.run('UPDATE report_schedules SET next_end=? WHERE project_id=?',nextReportEnd(end),row.project_id);});end=nextReportEnd(end);n++;}
    }return n;
  }
  tick():{processed:boolean;status?:string}{const job=this.queue.claim('m5-report','report',30_000,['report.generate']);if(!job)return{processed:false};this.queue.start(job.jobId,job.leaseToken!);try{const payload=job.payload as unknown as {window:ReportWindowV1};if(payload.window.projectId!==job.projectId)throw new Error('REPORT_PROJECT_MISMATCH');this.store.transaction(()=>{this.generate(payload.window);this.queue.complete(job.jobId,job.leaseToken!);});return{processed:true,status:'succeeded'};}catch{this.queue.fail(job.jobId,job.leaseToken!,'REPORT_GENERATION_FAILED',true);return{processed:true,status:'failed'};}}
}
