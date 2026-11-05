import { SqliteStore, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { EvidenceRefV1, NotificationPolicyV1, NotificationSignalV1, P0AlertV1 } from '@superagent/contracts';
import type { WorkSnapshot } from '@superagent/memory';
import { DomainService } from './index.js';
import { parseContract } from '@superagent/contract-validation';

export type CriticalImpact = 'irreversible_save_loss' | 'account_compromise' | 'service_unavailable';
export interface P0Assessment { verdict:'confirmed'|'review'|'not_p0'; impact:CriticalImpact|'none'; rationale:string; evidence:{eventId:string;quote:string}[] }
// Conservative initial project policy. A model proposal is never sufficient by itself.
const patterns:Record<CriticalImpact,RegExp>={
  irreversible_save_loss:/(?:存档|存檔|save).*(?:丢失|损坏|消失|无法恢复|lost|corrupt|deleted)|(?:lost|corrupt|deleted).*save/iu,
  account_compromise:/(?:账号|账户|account).*(?:被盗|泄露|接管|compromis|stolen|takeover)|(?:stolen|compromis).*account/iu,
  service_unavailable:/(?:所有|全部|全服|everyone|all players).*(?:无法登录|无法登陆|无法连接|宕机|cannot log|can't log|unavailable)/iu,
};
const actualImpact=(impact:CriticalImpact,text:string)=>patterns[impact].test(text)
  &&!/(?:如果|假如|希望|担心|可能会|是否|\bif\b|\bwish\b|\bmight\b)/iu.test(text)
  &&(impact!=='irreversible_save_loss'||/(?:无法恢复|不可恢复|永久|irreversib|unrecoverab|permanent)/iu.test(text));
export class P0NotificationPolicy implements NotificationPolicyV1 {
  async decide(signal:NotificationSignalV1){
    const base={projectId:signal.projectId,policyVersion:'p0-digest-v1'};
    if(signal.kind!=='defect')return {...base,route:'digest_only' as const,reason:signal.kind==='suggestion'?'suggestion' as const:'steam_review' as const};
    if(signal.severity!=='P0')return {...base,route:'digest_only' as const,reason:'non_p0_defect' as const};
    if(!signal.evidence.length)return {...base,route:'digest_only' as const,reason:'not_confirmed_p0' as const};
    return {...base,route:'p0_realtime' as const,issueId:signal.issueId,severity:'P0' as const,reason:'confirmed_critical_impact'};
  }
}
export class P0Service {
  constructor(readonly store:SqliteStore,readonly domain:DomainService,private readonly clock:Clock=systemClock){}
  now():string{return timestamp(this.clock());}
  /** Only current primary evidence already attached to this defect is eligible. */
  evidence(work:WorkSnapshot):{eventId:EvidenceRefV1['eventId'];quote:string;objectKey:string}[]{
    return work.evidence.filter(e=>e.role==='primary').flatMap(anchor=>{
      const e=this.domain.evidence(work.projectId,anchor.eventId);
      if(!e||!e.current||e.deleted||e.event.type==='com.superagent.source.coverage.changed.v1')return [];
      return [{eventId:anchor.eventId,quote:e.originalText.slice(0,6000),objectKey:stableId('object',e.event.data.sourceId,e.event.data.object.externalId)}];
    }).filter((e,i,a)=>a.findIndex(x=>x.eventId===e.eventId)===i);
  }
  fingerprint(work:WorkSnapshot):string{return stableId('p0-evidence',JSON.stringify(this.evidence(work)));}
  stateFingerprint(projectId:string,issueId:string):string{return stableId('p0-state',JSON.stringify(this.store.all('SELECT i.incident_id,i.state,i.last_changed_at,a.alert_id FROM p0_incidents i LEFT JOIN p0_alerts a USING(incident_id) WHERE i.project_id=? AND i.issue_id=? ORDER BY i.incident_id,a.alert_generation',projectId,issueId)));}
  eligible(work:WorkSnapshot):boolean{return work.kind==='defect'&&!work.reviewRequired&&!['fixed','verified','dismissed','merged'].includes(work.status)&&this.evidence(work).length>0;}
  candidate(work:WorkSnapshot):boolean{return this.eligible(work)&&this.evidence(work).some(e=>Object.values(patterns).some(p=>p.test(e.quote)));}
  assess(work:WorkSnapshot,assessment:P0Assessment):P0AlertV1|undefined {
    if(!this.eligible(work)||assessment.verdict!=='confirmed'||assessment.impact==='none')return;
    const available=this.evidence(work),pattern=patterns[assessment.impact];
    if(!pattern||!assessment.evidence.length)return;
    const evidence=assessment.evidence.flatMap(ref=>{
      const e=available.find(e=>e.eventId===ref.eventId);
      return e&&ref.quote.trim()&&ref.quote.length<=2000&&e.quote.includes(ref.quote)&&actualImpact(assessment.impact as CriticalImpact,ref.quote)?[{eventId:e.eventId,excerpt:ref.quote,objectKey:e.objectKey}]:[];
    });
    // Two distinct archived source objects corroborate the actual critical impact.
    if(evidence.length!==assessment.evidence.length||new Set(evidence.map(e=>e.objectKey)).size<2)return;
    const resolved=this.store.get<{resolved_at:string}>('SELECT resolved_at FROM p0_incidents WHERE project_id=? AND issue_id=? AND state=\'resolved\' ORDER BY resolved_at DESC LIMIT 1',work.projectId,work.id);
    if(resolved&&!evidence.some(e=>this.store.get<{received_at:string}>('SELECT received_at FROM source_events WHERE event_id=?',e.eventId)!.received_at>resolved.resolved_at))return;
    return this.confirm(work,evidence.map(({objectKey:_key,...e})=>e),assessment.impact,'automatic');
  }
  confirm(work:WorkSnapshot,evidence:EvidenceRefV1[],impact:CriticalImpact,actor:string,realert=false):P0AlertV1|undefined {
    return this.store.transaction(()=>{
      const current=this.domain.getWork(work.projectId,'defect',work.id);
      if(!current||current.version!==work.version||!this.eligible(current)||this.fingerprint(current)!==this.fingerprint(work))throw new Error('P0_WORK_CHANGED');
      const available=this.evidence(current);
      if(!evidence.length||evidence.some(ref=>!ref.excerpt?.trim()||!available.some(e=>e.eventId===ref.eventId&&e.quote.includes(ref.excerpt!))))throw new Error('P0_EVIDENCE_INVALID');
      let incident=this.store.get<{incident_id:string}>('SELECT incident_id FROM p0_incidents WHERE project_id=? AND issue_id=? AND state=\'active\'',work.projectId,work.id);
      if(incident&&!realert&&this.store.get('SELECT 1 FROM p0_incident_impacts WHERE incident_id=? AND impact=?',incident.incident_id,impact))return;
      if(!incident){incident={incident_id:stableId('incident',work.projectId,work.id,this.now(),String(this.store.get<{n:number}>('SELECT count(*) n FROM p0_incidents WHERE project_id=? AND issue_id=?',work.projectId,work.id)!.n))};
        this.store.run("INSERT INTO p0_incidents VALUES(?,?,?,'active',?,?,NULL)",incident.incident_id,work.projectId,work.id,this.now(),this.now());}
      const generation=this.store.get<{n:number}>('SELECT coalesce(max(alert_generation),0)+1 n FROM p0_alerts WHERE incident_id=?',incident.incident_id)!.n;
      const alert:P0AlertV1={schemaVersion:'1.0',alertId:stableId('p0-alert',incident.incident_id,String(generation)),incidentId:incident.incident_id,issueId:work.id,projectId:work.projectId,severity:'P0',alertGeneration:generation,title:work.title.slice(0,200),summary:work.summary.slice(0,1000),evidence,detectedAt:this.now(),policyVersion:'p0-digest-v1',deliveryRequested:true};
      parseContract('p0-alert-v1',alert);
      this.store.run('INSERT INTO p0_alerts VALUES(?,?,?,?,?,?,?,?,?,?)',alert.alertId,alert.incidentId,generation,work.id,alert.title,alert.summary,JSON.stringify(evidence),alert.policyVersion,alert.detectedAt,this.now());
      this.store.run('INSERT INTO p0_incident_impacts VALUES(?,?) ON CONFLICT DO NOTHING',alert.incidentId,impact);
      this.store.run('UPDATE p0_incidents SET last_changed_at=? WHERE incident_id=?',this.now(),alert.incidentId);
      this.store.run("INSERT INTO work_history(project_id,work_kind,work_id,action,actor_ref,details_json,created_at) VALUES(?,'defect',?,'p0.confirm',?,?,?)",work.projectId,work.id,actor,JSON.stringify({alertId:alert.alertId,impact,realert}),this.now());
      return alert;
    });
  }
  resolve(projectId:string,issueId:string,actor:string):void{
    this.store.transaction(()=>{
      const n=this.store.run("UPDATE p0_incidents SET state='resolved',resolved_at=?,last_changed_at=? WHERE project_id=? AND issue_id=? AND state='active'",this.now(),this.now(),projectId,issueId).changes;
      if(n)this.store.run("INSERT INTO work_history(project_id,work_kind,work_id,action,actor_ref,details_json,created_at) VALUES(?,'defect',?,'p0.resolve',?,'{}',?)",projectId,issueId,actor,this.now());
    });
  }
  reconcile(projectId:string):void{
    for(const row of this.store.all<{issue_id:string}>("SELECT issue_id FROM p0_incidents WHERE project_id=? AND state='active'",projectId)){
      const work=this.domain.getWork(projectId,'defect',row.issue_id);
      if(!work||!this.eligible(work))this.resolve(projectId,row.issue_id,'system');
    }
  }
  list(projectId:string){return this.store.all("SELECT a.*,i.state incident_state,i.project_id,d.status delivery_status,o.last_error FROM p0_alerts a JOIN p0_incidents i USING(incident_id) LEFT JOIN p0_alert_deliveries d USING(alert_id) LEFT JOIN external_operations o USING(operation_id) WHERE i.project_id=? ORDER BY a.created_at DESC LIMIT 100",projectId);}
}
