import { randomUUID } from 'node:crypto';
import type { DeliveryRequestV1, JSONValue, ReportSectionV1, ReportV2 } from '@superagent/contracts';
import { canonicalJSON, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { Principal } from './auth.js';
import { ControlError, hash } from './auth.js';
import type { ControlPlane } from './index.js';
import type { StatusCommand } from './index.js';
export interface QQOperatorRequest {interactionId:string;kind:'command'|'button';content:string;reply:{messageId?:string;eventId?:string}}
export interface QQButton {label:string;token:string}
export interface QQReplyOptions {replyTo?:{messageId?:string;eventId?:string;sequence:number};requireReplyContext?:boolean;buttons:QQButton[];format?:'markdown'|'text';literalText?:boolean}
interface Navigation {route:'section'|'work'|'evidence';reportId:string;revision:number;section?:ReportSectionV1;kind?:'defect'|'suggestion';workId?:string;cursor?:string;sectionOffset?:number;itemOffset?:number;charOffset?:number;steamOrdinal?:number}
interface Message {title:string;text:string;buttons:QQButton[];report?:ReportV2;format?:'markdown'|'text';literalText?:boolean}
export class QQOperatorService {
  constructor(readonly control:ControlPlane,private readonly options:{projectId:string;actorRef:string;recipientRef:string;clock?:Clock}){}
  private now():string{return timestamp((this.options.clock??systemClock)());}
  private principal():Principal{return this.control.auth.principal(this.options.actorRef);}
  navigationTokens(request:DeliveryRequestV1):readonly string[]{
    const principal=this.principal();this.control.auth.authorize(principal,this.options.projectId);
    if(request.projectId!==this.options.projectId||request.recipientRef!==this.options.recipientRef||!request.reportRevision||!this.control.reports.getExact(request.projectId,request.reportId,request.reportRevision))throw new ControlError('REPORT_NOT_AUTHORIZED',403);
    return(['bugs','suggestions','steam_negative_reviews'] as const).map(section=>this.navToken(principal,{route:'section',reportId:request.reportId,revision:request.reportRevision!,section},request.deliveryId+':'+section));
  }
  private navToken(principal:Principal,payload:Navigation,stableKey?:string):string{return this.control.tokens.issue(principal,this.options.projectId,'qq_navigation',payload as unknown as JSONValue,{ttlMs:7*24*3_600_000,...(stableKey?{stableKey}:{})});}
  receive(request:QQOperatorRequest):{accepted:boolean;duplicate:boolean}{
    const principal=this.principal();this.control.auth.authorize(principal,this.options.projectId);
    if(typeof request.interactionId!=='string'||request.interactionId.length>512||!request.interactionId||!['command','button'].includes(request.kind)||typeof request.content!=='string'||request.content.length>512)throw new ControlError('INVALID_QQ_OPERATOR_REQUEST');
    if(request.kind==='command'&&!/^\/(reports|bugs|suggestions|steam-negative|open)(?:\s|$)/.test(request.content.trim()))return{accepted:false,duplicate:false};
    const inboxId=stableId('qq-inbox',this.options.projectId,principal.actorRef,request.interactionId);const requestHash=hash(canonicalJSON(request as unknown as JSONValue));
    return this.control.store.transaction(()=>{
      const existing=this.control.store.get<{request_hash:string;request_json:string}>('SELECT request_hash,request_json FROM operator_inbox WHERE inbox_id=?',inboxId);if(existing){if(existing.request_hash!==requestHash){const prior=JSON.parse(existing.request_json) as QQOperatorRequest;if(prior.interactionId!==request.interactionId||prior.kind!==request.kind||prior.content!==request.content)throw new ControlError('QQ_INTERACTION_REPLAY_CONFLICT',409);}return{accepted:true,duplicate:true};} // A duplicate never replaces its saved reply context or outbox.
      this.control.store.run('INSERT INTO operator_inbox(inbox_id,project_id,actor_ref,interaction_id,request_hash,request_json,created_at) VALUES(?,?,?,?,?,?,?)',inboxId,this.options.projectId,principal.actorRef,inboxId,requestHash,canonicalJSON(request as unknown as JSONValue),this.now());return{accepted:true,duplicate:false};
    });
  }
  tick():{processed:boolean;deliveryId?:string}{
    // Processing is synchronous and all local changes + reply plan share one transaction.
    return this.control.store.transaction(()=>{
      const row=this.control.store.get<{inbox_id:string;request_json:string}>("SELECT inbox_id,request_json FROM operator_inbox WHERE project_id=? AND actor_ref=? AND state='pending' ORDER BY created_at,rowid LIMIT 1",this.options.projectId,this.options.actorRef);if(!row)return{processed:false};
      const principal=this.principal();this.control.auth.authorize(principal,this.options.projectId);const request=JSON.parse(row.request_json) as QQOperatorRequest;
      let message:Message;
      try{message=this.resolve(principal,request,row.inbox_id);}catch(error){message={title:'操作未完成',text:error instanceof ControlError?`请求已拒绝：${error.code}。请刷新卡片或在 Web 查看当前状态。`:'当前无法处理该请求，请稍后查询。',buttons:[]};}
      const deliveryId=randomUUID();const delivery:DeliveryRequestV1={deliveryId,idempotencyKey:`qq-reply:${row.inbox_id}`,projectId:this.options.projectId,reportId:message.report?.reportId??'operator-response',...(message.report?{reportRevision:message.report.revision}:{}),recipientRef:this.options.recipientRef,title:message.title,text:message.text,requestedAt:this.now()};
      // d.id identifies the ACK; the outer payload.id identifies the passive event reply.
      const reply=request.kind==='command'&&request.reply.messageId?{messageId:request.reply.messageId}:request.kind==='button'&&request.reply.eventId?{eventId:request.reply.eventId}:undefined;
      const sequence=reply&&'messageId' in reply?1+(this.control.store.get<{n:number|null}>("SELECT max(json_extract(message_options_json,'$.replyTo.sequence')) n FROM operator_reply_plans WHERE project_id=? AND recipient_ref=? AND json_extract(message_options_json,'$.replyTo.messageId')=?",this.options.projectId,this.options.recipientRef,reply.messageId)?.n??0):1;
      const messageOptions:QQReplyOptions={...(reply?{replyTo:{...reply,sequence}}:{}),requireReplyContext:true,buttons:message.buttons,...(message.format?{format:message.format}:{}),...(message.literalText?{literalText:true}:{})};
      this.control.store.run('INSERT INTO operator_reply_plans(delivery_id,inbox_id,project_id,recipient_ref,report_id,revision,request_json,message_options_json) VALUES(?,?,?,?,?,?,?,?)',deliveryId,row.inbox_id,this.options.projectId,this.options.recipientRef,message.report?.reportId??null,message.report?.revision??null,canonicalJSON(delivery as unknown as JSONValue),canonicalJSON(messageOptions as unknown as JSONValue));
      this.control.store.run("UPDATE operator_inbox SET state='processed',response_json=? WHERE inbox_id=?",canonicalJSON({deliveryId}),row.inbox_id);return{processed:true,deliveryId};
    });
  }
  private resolve(principal:Principal,request:QQOperatorRequest,inboxId:string):Message{
    let token=request.kind==='button'?request.content:undefined;
    if(request.kind==='command'){
      const [command,arg,...rest]=request.content.trim().split(/\s+/);if(rest.length)throw new ControlError('QQ_COMMAND_INVALID');
      if(command==='/open'){if(!arg)throw new ControlError('QQ_TOKEN_REQUIRED');token=arg;}
      else{
        const report=this.control.reports.list(this.options.projectId,1)[0];if(!report)return{title:'报告尚未生成',text:'还没有已归档的报告。请在 Web 工作台生成最近已结束的固定窗口。',buttons:[]};
        if(command==='/reports')return{title:'社区反馈报告',text:report.markdown,buttons:this.sectionButtons(principal,report),report};
        const section=command==='/bugs'?'bugs':command==='/suggestions'?'suggestions':'steam_negative_reviews';return this.render(principal,{route:'section',reportId:report.reportId,revision:report.revision,section});
      }
    }
    if(!token)throw new ControlError('QQ_TOKEN_REQUIRED');
    const row=this.control.store.get<{purpose:string}>('SELECT purpose FROM operator_tokens WHERE token_hash=?',hash(token));
    if(row?.purpose==='status_action'){
      const command=this.control.tokens.read(principal,this.options.projectId,'status_action',token) as unknown as StatusCommand;
      const result=this.control.executeAction(principal,this.options.projectId,command,token,'qq',inboxId) as {state:string;status?:string};
      return{title:result.state==='succeeded'?'状态已更新':'等待 GitHub 确认',text:result.state==='succeeded'?`操作 ${command.action} 已完成，当前状态 ${result.status}。`:'已记录请求。GitHub 确认前，当前状态保持原样。',buttons:[]};
    }
    return this.render(principal,this.control.tokens.read(principal,this.options.projectId,'qq_navigation',token) as unknown as Navigation);
  }
  private sectionButtons(principal:Principal,report:ReportV2):QQButton[]{return(['bugs','suggestions','steam_negative_reviews'] as const).map((section,i)=>({label:['查看 Bug','查看建议','查看 Steam 差评'][i]!,token:this.navToken(principal,{route:'section',reportId:report.reportId,revision:report.revision,section})}));}
  private render(principal:Principal,nav:Navigation):Message{
    const project=this.options.projectId,report=this.control.reports.getExact(project,nav.reportId,nav.revision);if(!report)throw new ControlError('REPORT_NOT_FOUND',404);
    if(nav.route==='section'){
      const page=this.control.reportPage(principal,project,report.reportId,report.revision,nav.section!,nav.cursor,3);const buttons:QQButton[]=[];
      const text=page.entries.map((entry,i)=>{
        if(entry.kind==='steam_negative_review'){
          const position=report.steamNegativeReviews.findIndex(m=>m.sourceId===entry.sourceId&&m.reviewExternalId===entry.reviewExternalId);
          buttons.push({label:`原文 ${i+1}`,token:this.navToken(principal,{...nav,route:'evidence',workId:entry.id,steamOrdinal:position,charOffset:0})});return`${i+1}. Steam 差评 · 原文请点“原文 ${i+1}”逐段查看。`;
        }
        const kind=entry.kind==='bug'?'defect':'suggestion';buttons.push({label:`详情 ${i+1}`,token:this.navToken(principal,{route:'work',reportId:report.reportId,revision:report.revision,kind,workId:entry.id})});return`${i+1}. ${entry.title.slice(0,180)}\n本期反馈 ${entry.newFeedbackCount}${entry.kind==='suggestion'?' · '+entry.status:''}`;
      }).join('\n\n')||'该快照没有此栏目成员。';
      const offset=nav.sectionOffset??0;
      if(offset>0){const previous=Math.max(0,offset-3);buttons.push({label:'上一页',token:this.navToken(principal,{...nav,sectionOffset:previous,cursor:this.control.tokens.cursor(principal,{projectId:project,id:report.reportId,revision:report.revision,section:nav.section!,limit:3},previous)})});}
      if(page.nextCursor)buttons.push({label:'下一页',token:this.navToken(principal,{...nav,sectionOffset:offset+3,cursor:page.nextCursor})});buttons.push(...this.sectionButtons(principal,report));
      return{title:`报告修订 ${report.revision} · ${nav.section}`,text:text+'\n\n'+page.coverageWarning,buttons,report};
    }
    if(nav.route==='work'){
      const kind=nav.kind!,id=nav.workId!;
      // Membership check before exposing live status or issuing actions.
      this.control.evidence(principal,project,kind,id,{reportId:report.reportId,revision:report.revision,limit:1});
      const work=this.control.work(principal,project,kind,id);const buttons:QQButton[]=[{label:'Details 原文',token:this.navToken(principal,{...nav,route:'evidence',itemOffset:0,charOffset:0})}];
      for(const action of work.allowedActions){const command:StatusCommand={kind,id,action,expectedVersion:work.version,...(['decline','dismiss'].includes(action)?{rationale:'开发者通过 QQ 明确选择此操作'}:{})};buttons.push({label:({investigate:'Investigating',fix:'Fixed',verify:'Verified',reopen:'Reopen',dismiss:'Dismiss',review:'Review',accept:'Accept',plan:'Planned',start:'Start',implement:'Implemented',decline:'Decline',archive:'Archive'} as Record<string,string>)[action]??action,token:this.control.issueActionToken(principal,project,command)});}
      return{title:work.title.slice(0,180),text:`当前状态：${work.status} · 版本 ${work.version}\n${work.summary.slice(0,1000)}\n原文固定于报告修订 ${report.revision}。`,buttons,report};
    }
    if(nav.route==='evidence'){
      const itemOffset=nav.itemOffset??0,charOffset=nav.charOffset??0;
      if(!Number.isSafeInteger(itemOffset)||itemOffset<0||!Number.isSafeInteger(charOffset)||charOffset<0)throw new ControlError('INVALID_EVIDENCE_PAGE');
      let item:{originalText:string;platform:string;createdAt:string}|undefined;let total=1;
      if(nav.section==='steam_negative_reviews'){
        const member=report.steamNegativeReviews[nav.steamOrdinal??0];if(!member)throw new ControlError('STEAM_MEMBER_NOT_FOUND');const e=this.control.domain.evidence(project,member.evidenceEventId);item={originalText:e&&!e.deleted?e.text:'[原文已删除或不可见]',platform:'steam-reviews',createdAt:member.occurredAt};
      }else{
        const scope={projectId:project,kind:nav.kind!,id:nav.workId!,reportId:report.reportId,revision:report.revision,limit:1};
        const page=this.control.evidence(principal,project,nav.kind!,nav.workId!,{reportId:report.reportId,revision:report.revision,limit:1,...(itemOffset?{cursor:this.control.tokens.cursor(principal,scope,itemOffset)}:{})});total=page.total;item=page.items[0];
      }
      if(!item)return{title:'来源原文',text:'暂无可见原文。',buttons:[],report,format:'text'};
      const chars=Array.from(item.originalText),snippet=chars.slice(charOffset,charOffset+1200).join('');const buttons:QQButton[]=[];
      if(charOffset>0)buttons.push({label:'Previous',token:this.navToken(principal,{...nav,charOffset:Math.max(0,charOffset-1200)})});
      else if(itemOffset>0)buttons.push({label:'上一条原文',token:this.navToken(principal,{...nav,itemOffset:itemOffset-1,charOffset:0})});
      if(charOffset+1200<chars.length)buttons.push({label:'Next 续文',token:this.navToken(principal,{...nav,charOffset:charOffset+1200})});
      else if(itemOffset+1<total)buttons.push({label:'下一条原文',token:this.navToken(principal,{...nav,itemOffset:itemOffset+1,charOffset:0})});
      return{title:`原文 ${itemOffset+1}/${total} · ${item.platform}`,text:`时间：${item.createdAt}\n原文第 ${charOffset+1}—${Math.min(charOffset+1200,chars.length)} 字：\n\n${snippet}\n\n[本段结束]`,buttons,report,format:'markdown',literalText:true};
    }
    throw new ControlError('QQ_NAVIGATION_INVALID');
  }
  replyOptions(deliveryId:string):QQReplyOptions{
    const row=this.control.store.get<{message_options_json:string}>('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=? AND project_id=? AND recipient_ref=?',deliveryId,this.options.projectId,this.options.recipientRef);if(!row)throw new ControlError('QQ_REPLY_NOT_AUTHORIZED',403);return JSON.parse(row.message_options_json) as QQReplyOptions;
  }
}
