import type { DeliveryRequestV1, ReportV2, JSONValue } from '@superagent/contracts';
import { canonicalJSON, SqliteStore, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { DurableDeliveryService } from './index.js';
interface Plan {plan_id:string;project_id:string;report_id:string;revision:number;recipient_ref:string;stage:number;operation_id:string|null;created_at:string}
function uuid(key:string):string{const h=stableId('uuid',key).slice(-32);return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20)}`;}
export class ReportDeliveryCoordinator {
  constructor(readonly store:SqliteStore,readonly delivery:DurableDeliveryService,private readonly options:{getReport:(projectId:string,id:string,revision:number)=>ReportV2|null;clock?:Clock}){}
  private now():string{return timestamp((this.options.clock??systemClock)());}
  prepare(projectId:string,recipientRef:string):{prepared:number}{
    return this.store.transaction(()=>{
      const plan=this.store.get<Plan>("SELECT * FROM report_delivery_plans WHERE project_id=? AND recipient_ref=? AND state='pending' ORDER BY created_at,plan_id LIMIT 1",projectId,recipientRef);if(!plan)return{prepared:0};
      if(plan.operation_id){
        const result=this.delivery.get(plan.operation_id);if(!result)throw new Error('REPORT_DELIVERY_OPERATION_MISSING');
        if(result.state==='succeeded'){this.finish(plan,'accepted');return{prepared:0};}
        if(['unknown','manual_review'].includes(result.state)){this.finish(plan,result.state);return{prepared:0};}
        if(result.state==='blocked'){
          const error=result.result?.errorCode;let stage:number|undefined;
          if(plan.stage<2&&['QQ_API_40034127','QQ_API_40034011','QQ_API_304036'].includes(error??''))stage=2;
          else if(plan.stage===0&&['QQ_API_40034106','QQ_API_40034029','QQ_API_304037'].includes(error??''))stage=1;
          if(stage===undefined){this.finish(plan,'blocked');return{prepared:0};}
          this.store.run('UPDATE report_delivery_plans SET stage=?,operation_id=NULL WHERE plan_id=?',stage,plan.plan_id);plan.stage=stage;plan.operation_id=null;
        }else return{prepared:0};
      }
      const report=this.options.getReport(plan.project_id,plan.report_id,plan.revision);if(!report)throw new Error('SEALED_REPORT_NOT_FOUND');
      const deliveryId=uuid(plan.plan_id+':'+plan.stage);
      const local=(v:string)=>new Date(Date.parse(v)+8*3_600_000).toISOString().slice(0,16).replace('T',' ');
      const text=[`# 社区反馈半日报`,`北京时间 ${local(report.window.startInclusive)} — ${local(report.window.endExclusive)}`,`修订 ${report.revision} · 来源事件 ${report.uniqueSourceEventCount}`,`\nBug ${report.counts.uniqueDefects} · 建议 ${report.counts.uniqueSuggestions} · Steam 差评 ${report.steamNegativeReviews.length}`,`新反馈项 ${report.counts.newFeedbackItems} · 待分析 ${report.counts.pendingAnalysis}`,`\n覆盖：${report.coverage.filter(c=>c.status==='full').length}/${report.coverage.length} 个来源完整。仅统计已接入来源。`,...(plan.stage?['\n私聊命令：/bugs /suggestions /steam-negative /reports']:[])].join('\n');
      const request:DeliveryRequestV1={deliveryId,idempotencyKey:`report-delivery:${plan.plan_id}:${plan.stage}`,projectId:plan.project_id,reportId:plan.report_id,reportRevision:plan.revision,recipientRef:plan.recipient_ref,title:'社区反馈半日报',text,requestedAt:plan.created_at,...(plan.stage===0?{presentation:{schemaVersion:'1.0',kind:'report_summary',format:'markdown',reportId:plan.report_id,revision:plan.revision,actions:[{kind:'report.open_section',section:'bugs',label:'查看 Bug'},{kind:'report.open_section',section:'suggestions',label:'查看建议'},{kind:'report.open_section',section:'steam_negative_reviews',label:'查看 Steam 差评'}]}}:{})};
      this.store.run('INSERT INTO report_delivery_requests VALUES(?,?,?,?)',deliveryId,plan.plan_id,plan.stage,canonicalJSON({format:plan.stage===2?'text':'markdown'}));
      const operationId=this.delivery.enqueue(request,'report');
      this.store.run('UPDATE report_delivery_plans SET operation_id=? WHERE plan_id=?',operationId,plan.plan_id);
      const existing=this.store.get('SELECT 1 FROM deliveries WHERE report_id=? AND channel=? AND recipient_ref=?',plan.report_id,'qq-c2c',plan.recipient_ref);
      if(existing)this.store.run("UPDATE deliveries SET operation_id=?,status='pending',provider_message_id=NULL WHERE report_id=? AND channel='qq-c2c' AND recipient_ref=?",operationId,plan.report_id,plan.recipient_ref);
      else this.store.run("INSERT INTO deliveries(delivery_id,report_id,channel,recipient_ref,operation_id,status) VALUES(?,?,'qq-c2c',?,?,'pending')",deliveryId,plan.report_id,plan.recipient_ref,operationId);
      return{prepared:1};
    });
  }
  private finish(plan:Plan,state:string):void{
    this.store.run('UPDATE report_delivery_plans SET state=? WHERE plan_id=?',state,plan.plan_id);
    const result=plan.operation_id?this.delivery.get(plan.operation_id)?.result:null;
    this.store.run("UPDATE deliveries SET status=?,provider_message_id=? WHERE report_id=? AND channel='qq-c2c' AND recipient_ref=?",state,result?.providerMessageId??null,plan.report_id,plan.recipient_ref);
  }
  enqueueReplies(projectId:string,recipientRef:string):number{
    return this.store.transaction(()=>{const rows=this.store.all<{delivery_id:string;request_json:string}>('SELECT delivery_id,request_json FROM operator_reply_plans WHERE project_id=? AND recipient_ref=? AND operation_id IS NULL ORDER BY rowid LIMIT 20',projectId,recipientRef);for(const row of rows){const id=this.delivery.enqueue(JSON.parse(row.request_json) as DeliveryRequestV1,'interaction');this.store.run('UPDATE operator_reply_plans SET operation_id=? WHERE delivery_id=?',id,row.delivery_id);}return rows.length;});
  }
  messageOptions(deliveryId:string):{format?:'markdown'|'text';literalText?:boolean;replyTo?:{messageId?:string;eventId?:string;sequence:number};requireReplyContext?:boolean;buttons?:readonly {label:string;token:string}[]}{
    const reply=this.store.get<{message_options_json:string}>('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=?',deliveryId);if(reply)return JSON.parse(reply.message_options_json) as ReturnType<ReportDeliveryCoordinator['messageOptions']>;
    const report=this.store.get<{options_json:string}>('SELECT options_json FROM report_delivery_requests WHERE delivery_id=?',deliveryId);return report?JSON.parse(report.options_json) as {format:'markdown'|'text'}:{};
  }
  authorizeReply(request:DeliveryRequestV1):void{
    const row=this.store.get<{request_json:string}>('SELECT request_json FROM operator_reply_plans WHERE delivery_id=? AND project_id=? AND recipient_ref=?',request.deliveryId,request.projectId,request.recipientRef);
    if(!row||row.request_json!==canonicalJSON(request as unknown as JSONValue))throw new Error('QQ_REPLY_NOT_AUTHORIZED');
  }
}
