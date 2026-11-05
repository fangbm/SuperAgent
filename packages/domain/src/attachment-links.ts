import {createHash} from 'node:crypto';
import {SqliteStore} from '@superagent/persistence';
import type {DomainService} from './index.js';

const schema=`
CREATE TABLE attachment_links(project_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES source_events(event_id),asset_ref TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',feedback_item_id TEXT REFERENCES feedback_items(feedback_item_id),candidates_json TEXT NOT NULL DEFAULT '[]',
 method TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',actor_ref TEXT,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,next_check_at TEXT NOT NULL,
 PRIMARY KEY(event_id,asset_ref));
CREATE INDEX attachment_links_pending ON attachment_links(project_id,next_check_at);
CREATE INDEX attachment_links_feedback ON attachment_links(feedback_item_id,status);
CREATE INDEX attachment_source_time ON source_events(project_id,source_id,json_extract(payload_json,'$.time'),event_id);
CREATE TABLE attachment_link_history(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL REFERENCES source_events(event_id),asset_ref TEXT NOT NULL,old_feedback_item_id TEXT,new_feedback_item_id TEXT,status TEXT NOT NULL,method TEXT NOT NULL,reason TEXT NOT NULL,actor_ref TEXT,version INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER attachment_links_discover AFTER INSERT ON source_events WHEN NEW.event_type='com.superagent.feedback.message.created.v1' BEGIN
 INSERT OR IGNORE INTO attachment_links(project_id,event_id,asset_ref,updated_at,next_check_at)
 SELECT NEW.project_id,NEW.event_id,json_extract(a.value,'$.assetRef'),NEW.received_at,NEW.received_at FROM json_each(NEW.payload_json,'$.data.content.attachments') a
 WHERE json_type(a.value,'$.assetRef')='text' AND length(json_extract(a.value,'$.assetRef'))>0;
END;
INSERT OR IGNORE INTO attachment_links(project_id,event_id,asset_ref,updated_at,next_check_at)
 SELECT e.project_id,e.event_id,json_extract(a.value,'$.assetRef'),e.received_at,e.received_at FROM source_events e,json_each(e.payload_json,'$.data.content.attachments') a
 WHERE e.event_type='com.superagent.feedback.message.created.v1' AND json_type(a.value,'$.assetRef')='text' AND length(json_extract(a.value,'$.assetRef'))>0;
`;
export interface AttachmentLinkRow {project_id:string;event_id:string;asset_ref:string;status:string;feedback_item_id:string|null;candidates_json:string;method:string;reason:string;actor_ref:string|null;version:number;updated_at:string;next_check_at:string}
interface Target {feedback_item_id:string;event_id:string;title:string;work_kind:string;work_id:string}
export class AttachmentLinks {
  onChanged?:(eventId:string,feedbackIds:string[])=>void;
  constructor(readonly store:SqliteStore,readonly domain:DomainService,private readonly now:()=>string){
    const hash=createHash('sha256').update(schema).digest('hex');store.transaction(()=>{store.exec('CREATE TABLE IF NOT EXISTS attachment_link_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');const old=store.get<{sha256:string}>('SELECT sha256 FROM attachment_link_migrations WHERE name=?','attachment-links-v1');if(old){if(old.sha256!==hash)throw new Error('ATTACHMENT_LINK_HISTORY_MISMATCH');return;}store.exec(schema);store.run('INSERT INTO attachment_link_migrations VALUES(?,?)','attachment-links-v1',hash);});
  }
  private evidence(project:string,event:string){const e=this.domain.evidence(project,event);return e?.current&&!e.deleted&&e.event.type!=='com.superagent.source.coverage.changed.v1'?{...e,event:e.event}:undefined;}
  private targets(project:string,eventId:string,nearby=false):Target[]{
    const source=this.evidence(project,eventId);if(!source)return[];const data=source.event.data;
    const since=new Date(Date.parse(source.event.time)-300000).toISOString(),until=new Date(Date.parse(source.event.time)+300000).toISOString();
    const rows=this.store.all<Target>(`SELECT DISTINCT f.feedback_item_id,e.event_id,f.title,l.work_kind,l.work_id FROM feedback_items f JOIN feedback_item_metadata m USING(feedback_item_id) JOIN feedback_item_evidence e USING(feedback_item_id) JOIN source_events s ON s.event_id=e.event_id JOIN source_objects o ON o.source_id=s.source_id AND o.external_id=json_extract(s.payload_json,'$.data.object.externalId') AND o.event_id=s.event_id AND o.deleted=0 JOIN work_feedback_links l USING(feedback_item_id) JOIN work_metadata w ON w.work_kind=l.work_kind AND w.work_id=l.work_id WHERE m.project_id=? AND w.project_id=? AND s.project_id=? AND f.active=1 AND e.role='primary' AND s.source_id=? AND ${nearby?"json_extract(s.payload_json,'$.time')>=? AND json_extract(s.payload_json,'$.time')<=?":"e.event_id=?"} ORDER BY s.received_at DESC,e.event_id,f.feedback_item_id LIMIT 65`,project,project,project,data.sourceId,...(nearby?[since,until]:[eventId]));
    return rows.filter(t=>{const target=this.evidence(project,t.event_id);return target&&(target.event.data.object.threadExternalId??'')===(data.object.threadExternalId??'')&&!!target.originalText.trim();});
  }
  private valid(project:string,eventId:string,feedbackId:string):boolean{
    const source=this.evidence(project,eventId);if(!source)return false;
    return this.store.all<{event_id:string}>(`SELECT DISTINCT e.event_id FROM feedback_item_evidence e JOIN feedback_items f USING(feedback_item_id) JOIN feedback_item_metadata m USING(feedback_item_id) WHERE f.feedback_item_id=? AND f.active=1 AND m.project_id=? AND e.role='primary'`,feedbackId,project).some(t=>{const e=this.evidence(project,t.event_id);return e&&e.event.data.sourceId===source.event.data.sourceId&&(e.event.data.object.threadExternalId??'')===(source.event.data.object.threadExternalId??'')&&!!e.originalText.trim();});
  }
  private update(row:AttachmentLinkRow,status:string,target:string|null,candidates:Target[],method:string,reason:string,actor:string|null=null){
    const ids=[...new Set(candidates.map(t=>t.feedback_item_id))],serialized=JSON.stringify(ids),changed=row.status!==status||row.feedback_item_id!==target||row.candidates_json!==serialized||row.method!==method||row.reason!==reason;
    this.store.run('UPDATE attachment_links SET status=?,feedback_item_id=?,candidates_json=?,method=?,reason=?,actor_ref=?,version=version+?,updated_at=?,next_check_at=? WHERE event_id=? AND asset_ref=?',status,target,serialized,method,reason,actor,changed?1:0,this.now(),new Date(Date.parse(this.now())+5000).toISOString(),row.event_id,row.asset_ref);
    if(changed){this.store.run('INSERT INTO attachment_link_history(event_id,asset_ref,old_feedback_item_id,new_feedback_item_id,status,method,reason,actor_ref,version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',row.event_id,row.asset_ref,row.feedback_item_id,target,status,method,reason,actor,row.version+1,this.now());this.onChanged?.(row.event_id,[...new Set([row.feedback_item_id,target].filter((x):x is string=>!!x))]);}
  }
  refresh(project:string):void{
    this.store.transaction(()=>{for(const row of this.store.all<AttachmentLinkRow>('SELECT * FROM attachment_links WHERE project_id=? AND next_check_at<=? ORDER BY next_check_at,event_id,asset_ref LIMIT 50',project,this.now())){
      if(row.actor_ref||row.status==='confirmed'){if(row.feedback_item_id&&!this.valid(project,row.event_id,row.feedback_item_id))this.update(row,'review',null,[],'invalidated','SOURCE_OR_FEEDBACK_CHANGED',row.actor_ref);else this.store.run('UPDATE attachment_links SET next_check_at=? WHERE event_id=? AND asset_ref=?',new Date(Date.parse(this.now())+30000).toISOString(),row.event_id,row.asset_ref);continue;}
      const source=this.evidence(project,row.event_id);if(!source){this.update(row,'review',null,[],'invalidated','SOURCE_NOT_VISIBLE');continue;}
      let candidates=this.targets(project,row.event_id),method='same_message';
      if(!candidates.length&&source.event.data.object.parentExternalId){const parent=this.store.get<{event_id:string}>('SELECT event_id FROM source_objects WHERE source_id=? AND external_id=? AND deleted=0',source.event.data.sourceId,source.event.data.object.parentExternalId);candidates=parent?this.targets(project,parent.event_id):[];method='reply';}
      if(method==='same_message'&&!candidates.length){candidates=this.targets(project,row.event_id,true).filter(t=>{const target=this.evidence(project,t.event_id);return !!source.event.data.actor?.opaqueId&&source.event.data.actor.opaqueId===target?.event.data.actor?.opaqueId;});method='same_author_window';}
      const unique=[...new Map(candidates.filter(t=>this.valid(project,row.event_id,t.feedback_item_id)).map(t=>[t.feedback_item_id,t])).values()];
      if(unique.length===1&&method!=='same_author_window')this.update(row,'confirmed',unique[0]!.feedback_item_id,unique,method,'EXPLICIT_SOURCE_RELATION');
      else this.update(row,unique.length?'review':'pending',null,unique,method,unique.length?'ATTACHMENT_TARGET_REQUIRES_CONFIRMATION':'WAITING_FOR_FEEDBACK');
    }});
  }
  review(project:string,eventId:string,assetRef:string,feedbackId:string|null,version:number,reason:string,actor:string,authorize:()=>void):void{
    authorize();if(!reason.trim()||reason.length>2000||!actor)throw new Error('ATTACHMENT_REVIEW_REASON_REQUIRED');
    this.store.transaction(()=>{const row=this.store.get<AttachmentLinkRow>('SELECT * FROM attachment_links WHERE project_id=? AND event_id=? AND asset_ref=?',project,eventId,assetRef);if(!row)throw new Error('ATTACHMENT_LINK_NOT_FOUND');if(row.version!==version)throw new Error('ATTACHMENT_LINK_VERSION_CONFLICT');if(feedbackId&&!this.valid(project,eventId,feedbackId))throw new Error('ATTACHMENT_TARGET_NOT_VISIBLE');authorize();this.update(row,feedbackId?'confirmed':'rejected',feedbackId,[],'manual',reason,actor);});
  }
  forWork(project:string,kind:string,id:string):{eventId:string;assetRef:string;method:string}[]{
    return this.store.all<AttachmentLinkRow>(`SELECT a.* FROM attachment_links a JOIN feedback_items f ON f.feedback_item_id=a.feedback_item_id AND f.active=1 JOIN work_feedback_links l USING(feedback_item_id) WHERE a.project_id=? AND a.status='confirmed' AND l.work_kind=? AND l.work_id=? ORDER BY a.event_id,a.asset_ref`,project,kind,id).filter(r=>!!r.feedback_item_id&&this.valid(project,r.event_id,r.feedback_item_id)).map(r=>({eventId:r.event_id,assetRef:r.asset_ref,method:r.method}));
  }
  confirmed(project:string,eventId:string,assetRef:string):boolean{const row=this.store.get<AttachmentLinkRow>("SELECT * FROM attachment_links WHERE project_id=? AND event_id=? AND asset_ref=? AND status='confirmed'",project,eventId,assetRef);return !!row?.feedback_item_id&&this.valid(project,eventId,row.feedback_item_id);}
  list(project:string,limit=50,before?:string){
    let cursor:string[]|undefined;if(before){try{cursor=JSON.parse(Buffer.from(before,'base64url').toString()) as string[];if(!Array.isArray(cursor)||cursor.length!==2||cursor.some(v=>typeof v!=='string'||v.length>512))throw new Error();}catch{throw new Error('ATTACHMENT_CURSOR_INVALID');}}
    this.refresh(project);const count=Math.max(1,Math.min(100,limit)),rows=this.store.all<AttachmentLinkRow>(`SELECT * FROM attachment_links WHERE project_id=? ${cursor?'AND (event_id<? OR (event_id=? AND asset_ref<?))':''} ORDER BY event_id DESC,asset_ref DESC LIMIT ?`,project,...(cursor?[cursor[0]!,cursor[0]!,cursor[1]!]:[]),count+1),items=rows.slice(0,count).map(row=>{const targets=this.targets(project,row.event_id,true);if(row.feedback_item_id&&this.valid(project,row.event_id,row.feedback_item_id)){const target=this.store.get<Target>('SELECT f.feedback_item_id,f.title,l.work_kind,l.work_id FROM feedback_items f JOIN work_feedback_links l USING(feedback_item_id) WHERE f.feedback_item_id=?',row.feedback_item_id);if(target)targets.push(target);}return{...row,source:this.evidence(project,row.event_id)?.originalText.slice(0,1000)??'',candidates:targets.map(t=>({feedbackItemId:t.feedback_item_id,title:t.title,kind:t.work_kind,workId:t.work_id})).filter((t,i,all)=>all.findIndex(a=>a.feedbackItemId===t.feedbackItemId)===i)};}),last=items.at(-1);return{items,nextCursor:rows.length>count&&last?Buffer.from(JSON.stringify([last.event_id,last.asset_ref])).toString('base64url'):null};
  }
}
