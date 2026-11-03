import { randomUUID } from 'node:crypto';
import { SqliteStore, stableId, systemClock, timestamp, addMilliseconds } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';

export interface MessageRecallPort {
  recallMessage(messageId:string):Promise<{status:'accepted'|'blocked'|'unknown';errorCode?:string}>;
}
interface SentCard {operation_id:string;message_id:string;accepted_at:string;send_order:number}
interface Recall {recall_id:string;old_delivery_id:string;replacement_delivery_id:string;message_id:string;expires_at:string;state:string}

/** Host owns message provenance, replacement ordering and the one-attempt recall ledger. */
export class QQCardRetirementService {
  constructor(readonly store:SqliteStore,private readonly port:MessageRecallPort,private readonly options:{pluginId:string;projectId:string;recipientRef:string;bindingId:string;authorize:()=>void;allowWrites?:boolean;clock?:Clock;timeoutMs?:number;leaseMs?:number}){
    if((options.leaseMs??60_000)<=(options.timeoutMs??15_000))throw new Error('INVALID_RECALL_CONFIGURATION');
    const bound=store.get<{binding_id:string}>('SELECT binding_id FROM plugin_delivery_bindings WHERE plugin_id=? AND project_id=? AND recipient_ref=?',options.pluginId,options.projectId,options.recipientRef);
    if(!bound||bound.binding_id!==options.bindingId)throw new Error('RECALL_RECIPIENT_BINDING_CHANGED');
  }
  private now():string{return timestamp((this.options.clock??systemClock)());}
  private scope():string[]{return[this.options.pluginId,this.options.projectId,this.options.recipientRef,this.options.bindingId];}
  // Scheduled reports and report pages are permanent chat entry points. The title
  // fallback also protects pages accepted before retainMessage was introduced.
  private protectedMessage(operation:string):string{return `EXISTS(SELECT 1 FROM plugin_delivery_requests d LEFT JOIN operator_reply_plans p ON p.operation_id=d.operation_id WHERE d.operation_id=${operation} AND (d.purpose='report' OR json_extract(p.message_options_json,'$.retainMessage')=1 OR json_extract(d.request_json,'$.title')='社区反馈半日报'))`;}
  prepare():number{
    return this.store.transaction(()=>{
      const cards=this.store.all<SentCard>(`SELECT d.operation_id,o.provider_object_id message_id,o.updated_at accepted_at,coalesce(a.rowid,o.rowid) send_order
        FROM plugin_delivery_requests d JOIN external_operations o USING(operation_id)
        LEFT JOIN external_operation_attempts a ON a.operation_id=o.operation_id AND a.attempt_number=o.attempt
        WHERE d.plugin_id=? AND d.project_id=? AND d.recipient_ref=? AND d.purpose IN ('report','interaction') AND o.kind='qq.c2c.send' AND o.state='succeeded' AND o.provider_object_id IS NOT NULL
        AND json_extract(d.result_json,'$.status')='accepted'
        AND NOT EXISTS(SELECT 1 FROM qq_sent_messages c WHERE c.operation_id=d.operation_id) ORDER BY o.updated_at,send_order LIMIT 100`,...this.scope().slice(0,3));
      for(const c of cards)this.store.run('INSERT INTO qq_sent_messages VALUES(?,?,?,?,?,?,?,?)',c.operation_id,...this.scope(),c.message_id,c.accepted_at,c.send_order);
      const stale=this.store.all<{old_id:string;new_id:string;accepted_at:string}>(`SELECT old.operation_id old_id,new.operation_id new_id,old.accepted_at FROM qq_sent_messages old JOIN qq_sent_messages new ON new.operation_id=(
        SELECT n.operation_id FROM qq_sent_messages n WHERE n.plugin_id=old.plugin_id AND n.project_id=old.project_id AND n.recipient_ref=old.recipient_ref AND n.binding_id=old.binding_id AND (n.accepted_at>old.accepted_at OR (n.accepted_at=old.accepted_at AND n.send_order>old.send_order)) ORDER BY n.accepted_at DESC,n.send_order DESC LIMIT 1)
        WHERE old.plugin_id=? AND old.project_id=? AND old.recipient_ref=? AND old.binding_id=? AND NOT ${this.protectedMessage('old.operation_id')} AND NOT EXISTS(SELECT 1 FROM qq_message_retirements r WHERE r.old_delivery_id=old.operation_id) ORDER BY old.accepted_at,old.send_order LIMIT 50`,...this.scope());
      for(const c of stale){const id=stableId('qq-recall',...this.scope(),c.old_id),expires=addMilliseconds(c.accepted_at,120_000);this.store.run('INSERT INTO qq_message_retirements VALUES(?,?,?,?,0,?,NULL,NULL,?,?,?)',id,c.old_id,c.new_id,expires<=this.now()?'expired':'prepared',expires,expires<=this.now()?'QQ_RECALL_WINDOW_EXPIRED':null,this.now(),this.now());}
      return stale.length;
    });
  }
  async tick():Promise<{processed:boolean;recallId?:string;state?:string}>{
    this.prepare();
    const scoped=`SELECT r.recall_id FROM qq_message_retirements r JOIN qq_sent_messages c ON c.operation_id=r.old_delivery_id WHERE c.plugin_id=? AND c.project_id=? AND c.recipient_ref=? AND c.binding_id=?`;
    this.store.run(`UPDATE qq_message_retirements SET state='blocked',last_error='QQ_REPORT_RETAINED',updated_at=? WHERE state='prepared' AND recall_id IN (${scoped}) AND ${this.protectedMessage('qq_message_retirements.old_delivery_id')}`,this.now(),...this.scope());
    this.store.run(`UPDATE qq_message_retirements SET state='unknown',last_error='QQ_RECALL_SEND_WINDOW_EXPIRED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state='in_flight' AND lease_until<=? AND recall_id IN (${scoped})`,this.now(),this.now(),...this.scope());
    this.store.run(`UPDATE qq_message_retirements SET state='expired',last_error='QQ_RECALL_WINDOW_EXPIRED',updated_at=? WHERE state='prepared' AND expires_at<=? AND recall_id IN (${scoped})`,this.now(),this.now(),...this.scope());
    if(!this.options.allowWrites)return{processed:false,state:'write_disabled'};
    const row=this.store.get<Recall>(`SELECT r.*,c.message_id FROM qq_message_retirements r JOIN qq_sent_messages c ON c.operation_id=r.old_delivery_id JOIN external_operations replacement ON replacement.operation_id=r.replacement_delivery_id WHERE c.plugin_id=? AND c.project_id=? AND c.recipient_ref=? AND c.binding_id=? AND r.state='prepared' AND r.attempt=0 AND r.expires_at>? AND replacement.state='succeeded' ORDER BY c.accepted_at,c.send_order LIMIT 1`,...this.scope(),this.now());
    if(!row)return{processed:false};
    try{const bound=this.store.get<{binding_id:string}>('SELECT binding_id FROM plugin_delivery_bindings WHERE plugin_id=? AND project_id=? AND recipient_ref=?',...this.scope().slice(0,3));if(bound?.binding_id!==this.options.bindingId)throw new Error('BINDING_CHANGED');this.options.authorize();}catch{this.store.run("UPDATE qq_message_retirements SET state='blocked',last_error='RECALL_AUTHORIZATION_REVOKED',updated_at=? WHERE recall_id=? AND state='prepared'",this.now(),row.recall_id);return{processed:true,recallId:row.recall_id,state:'blocked'};}
    const owner=randomUUID();const n=this.store.run("UPDATE qq_message_retirements SET state='in_flight',attempt=1,lease_owner=?,lease_until=?,updated_at=? WHERE recall_id=? AND state='prepared' AND attempt=0 AND expires_at>?",owner,addMilliseconds(this.now(),this.options.leaseMs??60_000),this.now(),row.recall_id,this.now());if(!n.changes)return{processed:false};
    let result:{status:string;errorCode?:string},timer:ReturnType<typeof setTimeout>|undefined;
    try{result=await Promise.race([this.port.recallMessage(row.message_id),new Promise<{status:string;errorCode:string}>(resolve=>{timer=setTimeout(()=>resolve({status:'unknown',errorCode:'QQ_RECALL_HOST_TIMEOUT'}),this.options.timeoutMs??15_000);})]);}
    catch{result={status:'unknown',errorCode:'QQ_RECALL_UNKNOWN'};}finally{if(timer)clearTimeout(timer);}
    const state=result.status==='accepted'?'succeeded':result.status==='blocked'?'blocked':'unknown';
    this.store.run("UPDATE qq_message_retirements SET state=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE recall_id=? AND state='in_flight' AND lease_owner=? AND lease_until>?",state,result.errorCode??null,this.now(),row.recall_id,owner,this.now());
    return{processed:true,recallId:row.recall_id,state:this.store.get<{state:string}>('SELECT state FROM qq_message_retirements WHERE recall_id=?',row.recall_id)!.state};
  }
}
