import { randomUUID } from 'node:crypto';
import type { DeliveryRequestV1, JSONValue, ReportSectionV1, ReportV2 } from '@superagent/contracts';
import { canonicalJSON, stableId, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { Principal } from './auth.js';
import { ControlError, hash } from './auth.js';
import type { ControlPlane } from './index.js';
import type { StatusCommand } from './index.js';
import { qqReport,qqList,qqWork,qqFeedback,qqEvidence,qqNotice,qqStatus,qqActionLabel } from '@superagent/reporting';
export interface QQOperatorRequest {interactionId:string;kind:'command'|'button';content:string;reply:{messageId?:string;eventId?:string}}
export interface QQButton {label:string;token:string}
export interface QQReplyOptions {replyTo?:{messageId?:string;eventId?:string;sequence:number};requireReplyContext?:boolean;buttons:QQButton[];format?:'markdown'|'text';literalText?:boolean;bodyIncludesTitle?:boolean;retainMessage?:boolean;card?:{kind:'defect'|'suggestion';workId:string;version:number}}
interface Navigation {route:'report'|'browse'|'section'|'work'|'evidence';reportId:string;revision:number;section?:ReportSectionV1;entryOffset?:number;kind?:'defect'|'suggestion';workId?:string;cursor?:string;sectionOffset?:number;itemOffset?:number;charOffset?:number;steamOrdinal?:number}
interface Message {title:string;text:string;buttons:QQButton[];report?:ReportV2;format?:'markdown'|'text';literalText?:boolean;bodyIncludesTitle?:boolean;retainMessage?:boolean;card?:QQReplyOptions['card']}
export class QQOperatorService {
  constructor(readonly control:ControlPlane,private readonly options:{projectId:string;actorRef:string;recipientRef:string;clock?:Clock}){}
  private now():string{return timestamp((this.options.clock??systemClock)());}
  private principal():Principal{return this.control.auth.principal(this.options.actorRef);}
  navigationTokens(request:DeliveryRequestV1):readonly string[]{
    const principal=this.principal();this.control.auth.authorize(principal,this.options.projectId);
    if(request.projectId!==this.options.projectId||request.recipientRef!==this.options.recipientRef||!request.reportRevision||!this.control.reports.getExact(request.projectId,request.reportId,request.reportRevision))throw new ControlError('REPORT_NOT_AUTHORIZED',403);
    return(['bugs','suggestions','steam_negative_reviews'] as const).map(section=>this.navToken(principal,{route:'browse',reportId:request.reportId,revision:request.reportRevision!,section,entryOffset:0},request.deliveryId+':browse:'+section));
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
      try{message=this.resolve(principal,request,row.inbox_id);}catch(error){const reasons:Record<string,string>={FORBIDDEN:'当前账号没有执行此操作的权限。',TOKEN_EXPIRED_OR_USED:'操作卡片已失效，请重新打开详情。',WORK_VERSION_CONFLICT:'处理状态已变化，请刷新详情后重试。',REPORT_NOT_FOUND:'这份报告暂时不可用，请从报告入口重新查询。'};message={...qqNotice('操作未完成',error instanceof ControlError?reasons[error.code]??'请求未能完成，请重新打开卡片。':'当前无法处理该请求，请稍后查询。','也可在 Web 工作台查看当前进展。'),buttons:[]};}
      const deliveryId=randomUUID();const delivery:DeliveryRequestV1={deliveryId,idempotencyKey:`qq-reply:${row.inbox_id}`,projectId:this.options.projectId,reportId:message.report?.reportId??'operator-response',...(message.report?{reportRevision:message.report.revision}:{}),recipientRef:this.options.recipientRef,title:message.title,text:message.text,requestedAt:this.now()};
      // d.id identifies the ACK; the outer payload.id identifies the passive event reply.
      const reply=request.kind==='command'&&request.reply.messageId?{messageId:request.reply.messageId}:request.kind==='button'&&request.reply.eventId?{eventId:request.reply.eventId}:undefined;
      const sequence=reply&&'messageId' in reply?1+(this.control.store.get<{n:number|null}>("SELECT max(json_extract(message_options_json,'$.replyTo.sequence')) n FROM operator_reply_plans WHERE project_id=? AND recipient_ref=? AND json_extract(message_options_json,'$.replyTo.messageId')=?",this.options.projectId,this.options.recipientRef,reply.messageId)?.n??0):1;
      const messageOptions:QQReplyOptions={...(reply?{replyTo:{...reply,sequence}}:{}),requireReplyContext:true,buttons:message.buttons,...(message.format?{format:message.format}:{}),...(message.literalText?{literalText:true}:{}),...(message.bodyIncludesTitle?{bodyIncludesTitle:true}:{}),...(message.retainMessage?{retainMessage:true}:{}),...(message.card?{card:message.card}:{})};
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
        const report=this.control.reports.list(this.options.projectId,1)[0];if(!report)return{...qqNotice('报告尚未生成','还没有已归档的报告。','请在 Web 工作台生成最近已结束的报告。'),buttons:[]};
        if(command==='/reports')return{...qqReport(report),buttons:this.sectionButtons(principal,report),report,retainMessage:true};
        const section=command==='/bugs'?'bugs':command==='/suggestions'?'suggestions':'steam_negative_reviews';return this.render(principal,{route:'browse',reportId:report.reportId,revision:report.revision,section,entryOffset:0});
      }
    }
    if(!token)throw new ControlError('QQ_TOKEN_REQUIRED');
    const row=this.control.store.get<{purpose:string}>('SELECT purpose FROM operator_tokens WHERE token_hash=?',hash(token));
    if(row?.purpose==='qq_command_result'){
      const payload=this.control.tokens.read(principal,this.options.projectId,'qq_command_result',token) as unknown as {commandId:string;navigation?:Navigation};
      return this.actionResult(payload.commandId,payload.navigation);
    }
    if(row?.purpose==='qq_action'){
      const payload=this.control.tokens.read(principal,this.options.projectId,'qq_action',token) as unknown as {actionToken:string;navigation:Navigation};
      const command=this.control.tokens.read(principal,this.options.projectId,'status_action',payload.actionToken) as unknown as StatusCommand;
      const result=this.control.executeAction(principal,this.options.projectId,command,payload.actionToken,'qq',inboxId) as {commandId:string};
      return this.actionResult(result.commandId,payload.navigation);
    }
    if(row?.purpose==='status_action'){
      const command=this.control.tokens.read(principal,this.options.projectId,'status_action',token) as unknown as StatusCommand;
      const result=this.control.executeAction(principal,this.options.projectId,command,token,'qq',inboxId) as {commandId:string};
      return this.actionResult(result.commandId);
    }
    return this.render(principal,this.control.tokens.read(principal,this.options.projectId,'qq_navigation',token) as unknown as Navigation);
  }
  private sectionButtons(principal:Principal,report:ReportV2):QQButton[]{return(['bugs','suggestions','steam_negative_reviews'] as const).map((section,i)=>({label:['查看 Bug','查看建议','查看 Steam 差评'][i]!,token:this.navToken(principal,{route:'browse',reportId:report.reportId,revision:report.revision,section,entryOffset:0})}));}
  private reportButton(principal:Principal,report:ReportV2):QQButton{return{label:'返回半日报',token:this.navToken(principal,{route:'report',reportId:report.reportId,revision:report.revision})};}
  private actionButton(principal:Principal,command:StatusCommand,navigation:Navigation):QQButton{
    const actionToken=this.control.issueActionToken(principal,this.options.projectId,command);
    return{label:qqActionLabel(command.action),token:this.control.tokens.issue(principal,this.options.projectId,'qq_action',{actionToken,navigation} as unknown as JSONValue)};
  }
  private render(principal:Principal,nav:Navigation):Message{
    const project=this.options.projectId,report=this.control.reports.getExact(project,nav.reportId,nav.revision);if(!report)throw new ControlError('REPORT_NOT_FOUND',404);
    if(nav.route==='report')return{...qqReport(report),buttons:this.sectionButtons(principal,report),report,retainMessage:true};
    if(nav.route==='browse'){
      const section=nav.section,offset=nav.entryOffset??0;
      if(!section||!['bugs','suggestions','steam_negative_reviews'].includes(section)||!Number.isSafeInteger(offset)||offset<0)throw new ControlError('INVALID_FEEDBACK_PAGE');
      const total=section==='bugs'?report.issueIds.length:section==='suggestions'?report.suggestionIds.length:report.steamNegativeReviews.length;
      if(!total){if(offset)throw new ControlError('INVALID_FEEDBACK_PAGE');return{...qqNotice(section==='bugs'?'Bug':section==='suggestions'?'建议':'Steam 差评','本期暂无此类记录。','仅统计已接入来源；没有记录不代表没有反馈。'),buttons:[this.reportButton(principal,report)],report};}
      if(offset>=total)throw new ControlError('INVALID_FEEDBACK_PAGE');
      const buttons:QQButton[]=[];
      if(offset>0)buttons.push({label:'上一条',token:this.navToken(principal,{...nav,entryOffset:offset-1})});
      if(offset+1<total)buttons.push({label:'下一条',token:this.navToken(principal,{...nav,entryOffset:offset+1})});
      buttons.push(this.reportButton(principal,report));
      let original:{originalText:string;platform:string;createdAt:string}|undefined,originals=1,title='',summary:string|undefined,status:string|undefined,feedbackCount:number|undefined,card:QQReplyOptions['card'];
      let evidenceNav:Navigation;
      if(section==='steam_negative_reviews'){
        const member=report.steamNegativeReviews[offset]!;const e=this.control.domain.evidence(project,member.evidenceEventId);
        original={originalText:e&&!e.deleted?e.text:'[原文已删除或不可见]',platform:'steam-reviews',createdAt:member.occurredAt};title='玩家差评';
        evidenceNav={...nav,route:'evidence',steamOrdinal:offset,charOffset:800};
      }else{
        const kind=section==='bugs'?'defect':'suggestion',id=(kind==='defect'?report.issueIds:report.suggestionIds)[offset]!;
        const page=this.control.evidence(principal,project,kind,id,{reportId:report.reportId,revision:report.revision,limit:1});original=page.items[0];originals=page.total;
        const work=this.control.work(principal,project,kind,id);({title,summary,status,feedbackCount}=work);card={kind,workId:id,version:work.version};
        evidenceNav={...nav,route:'evidence',kind,workId:id,itemOffset:0,charOffset:800};
        for(const action of work.allowedActions){const command:StatusCommand={kind,id,action,expectedVersion:work.version,...(['decline','dismiss'].includes(action)?{rationale:'开发者通过 QQ 明确选择此操作'}:{})};buttons.push(this.actionButton(principal,command,{...nav,kind,workId:id}));}
      }
      // Reading never requires an intermediate list or work-detail message.
      if(Array.from(original?.originalText??'').length>800)buttons.splice(buttons.findIndex(b=>b.label==='返回半日报')+1,0,{label:'继续原文',token:this.navToken(principal,evidenceNav)});
      else if(originals>1)buttons.splice(buttons.findIndex(b=>b.label==='返回半日报')+1,0,{label:'下一条原文',token:this.navToken(principal,{...evidenceNav,itemOffset:1,charOffset:0})});
      return{...qqFeedback(report,{section,index:offset,total,title,...(summary!==undefined?{summary}:{}),...(status!==undefined?{status}:{}),...(feedbackCount!==undefined?{feedbackCount}:{}),...(original?{original}:{}),originals}),buttons,report,format:'markdown',...(card?{card}:{})};
    }
    if(nav.route==='section'){
      const page=this.control.reportPage(principal,project,report.reportId,report.revision,nav.section!,nav.cursor,3);const buttons:QQButton[]=[];
      page.entries.forEach((entry,i)=>{
        if(entry.kind==='steam_negative_review'){
          const position=report.steamNegativeReviews.findIndex(m=>m.sourceId===entry.sourceId&&m.reviewExternalId===entry.reviewExternalId);
          buttons.push({label:`原文 ${i+1}`,token:this.navToken(principal,{...nav,route:'evidence',workId:entry.id,steamOrdinal:position,charOffset:0})});return;
        }
        const kind=entry.kind==='bug'?'defect':'suggestion';buttons.push({label:`详情 ${i+1}`,token:this.navToken(principal,{route:'work',reportId:report.reportId,revision:report.revision,kind,workId:entry.id})});
      });
      const offset=nav.sectionOffset??0;
      if(offset>0){const previous=Math.max(0,offset-3);buttons.push({label:'上一页',token:this.navToken(principal,{...nav,sectionOffset:previous,cursor:this.control.tokens.cursor(principal,{projectId:project,id:report.reportId,revision:report.revision,section:nav.section!,limit:3},previous)})});}
      if(page.nextCursor)buttons.push({label:'下一页',token:this.navToken(principal,{...nav,sectionOffset:offset+3,cursor:page.nextCursor})});buttons.push(...this.sectionButtons(principal,report));
      return{...qqList(report,nav.section!,page.entries,offset,page.coverageWarning??'仅展示已接入来源；空列表不表示没有反馈。'),buttons,report};
    }
    if(nav.route==='work'){
      const kind=nav.kind!,id=nav.workId!;
      // Membership check before exposing live status or issuing actions.
      this.control.evidence(principal,project,kind,id,{reportId:report.reportId,revision:report.revision,limit:1});
      const work=this.control.work(principal,project,kind,id);const buttons:QQButton[]=[{label:'查看原文',token:this.navToken(principal,{...nav,route:'evidence',itemOffset:0,charOffset:0})}];
      for(const action of work.allowedActions){const command:StatusCommand={kind,id,action,expectedVersion:work.version,...(['decline','dismiss'].includes(action)?{rationale:'开发者通过 QQ 明确选择此操作'}:{})};buttons.push(this.actionButton(principal,command,nav));}
      return{...qqWork(report,kind,work,work.allowedActions.length>0),buttons,report,card:{kind,workId:id,version:work.version}};
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
      if(!item)return{...qqNotice('玩家原文','暂无可见原文。','可以返回半日报查看其他反馈。'),buttons:[this.reportButton(principal,report)],report};
      const chars=Array.from(item.originalText),snippet=chars.slice(charOffset,charOffset+1200).join('');const buttons:QQButton[]=[];
      if(charOffset>0)buttons.push({label:'上一段',token:this.navToken(principal,{...nav,charOffset:Math.max(0,charOffset-1200)})});
      else if(itemOffset>0)buttons.push({label:'上一条原文',token:this.navToken(principal,{...nav,itemOffset:itemOffset-1,charOffset:0})});
      if(charOffset+1200<chars.length)buttons.push({label:'继续阅读',token:this.navToken(principal,{...nav,charOffset:charOffset+1200})});
      else if(itemOffset+1<total)buttons.push({label:'下一条原文',token:this.navToken(principal,{...nav,itemOffset:itemOffset+1,charOffset:0})});
      if(nav.entryOffset!==undefined)buttons.push({label:'返回反馈',token:this.navToken(principal,{route:'browse',reportId:report.reportId,revision:report.revision,section:nav.section!,entryOffset:nav.entryOffset})},this.reportButton(principal,report));
      return{...qqEvidence({platform:item.platform,createdAt:item.createdAt,original:snippet,item:itemOffset+1,items:total,start:chars.length?charOffset+1:0,end:Math.min(charOffset+1200,chars.length),characters:chars.length,revision:report.revision,hasNavigation:buttons.length>0}),buttons,report,format:'markdown'};
    }
    throw new ControlError('QQ_NAVIGATION_INVALID');
  }
  replyOptions(deliveryId:string):QQReplyOptions{
    const row=this.control.store.get<{message_options_json:string}>('SELECT message_options_json FROM operator_reply_plans WHERE delivery_id=? AND project_id=? AND recipient_ref=?',deliveryId,this.options.projectId,this.options.recipientRef);if(!row)throw new ControlError('QQ_REPLY_NOT_AUTHORIZED',403);return JSON.parse(row.message_options_json) as QQReplyOptions;
  }
  /** Read-only result view; ownership and current project access are checked on every query. */
  actionResult(commandId:string,navigation?:Navigation):Message{
    const principal=this.principal();this.control.auth.authorize(principal,this.options.projectId);
    const row=this.control.store.get<{state:string;request_json:string;result_json:string|null}>("SELECT state,request_json,result_json FROM operator_commands WHERE command_id=? AND actor_ref=? AND project_id=? AND source='qq'",commandId,principal.actorRef,this.options.projectId);
    if(!row)throw new ControlError('COMMAND_NOT_FOUND',404);
    const request=JSON.parse(row.request_json) as StatusCommand,result=row.result_json?JSON.parse(row.result_json) as {status?:string;remoteConfirmed?:boolean}:{};
    if(!navigation){const context=this.control.store.get<{payload_json:string}>("SELECT payload_json FROM operator_tokens WHERE actor_ref=? AND project_id=? AND purpose='qq_command_result' AND json_extract(payload_json,'$.commandId')=? ORDER BY rowid LIMIT 1",principal.actorRef,this.options.projectId,commandId);if(context)navigation=(JSON.parse(context.payload_json) as {navigation?:Navigation}).navigation;}
    if(navigation&&(!['browse','work'].includes(navigation.route)||navigation.kind!==request.kind||navigation.workId!==request.id))throw new ControlError('ACTION_CONTEXT_MISMATCH');
    const token=this.control.tokens.issue(principal,this.options.projectId,'qq_command_result',{commandId,...(navigation?{navigation}: {})} as unknown as JSONValue,{ttlMs:7*24*3_600_000,stableKey:`qq-command-result:${commandId}`});
    const buttons=[{label:'查看结果',token}];
    if(row.state==='succeeded'){
      if(navigation)return this.render(principal,navigation);
      const current=this.control.work(principal,this.options.projectId,request.kind,request.id);
      return{...qqNotice(result.remoteConfirmed?'GitHub 已确认':'操作已完成',`${qqActionLabel(request.action)}已完成。\n本次结果：${qqStatus(result.status??'')}。\n当前状态：${qqStatus(current.status)}。`,'可发送 /bugs 或 /suggestions 查看当前反馈卡片。'),buttons};
    }
    const remote=this.control.store.get<{state:string}>('SELECT o.state FROM github_action_operations a JOIN external_operations o USING(operation_id) WHERE a.command_id=?',commandId);
    const review=row.state==='manual_review'||['blocked','manual_review'].includes(remote?.state??'');
    const uncertain=['unknown','reconciling'].includes(remote?.state??'');
    return{...qqNotice(review?'需要人工复核':uncertain?'结果待核对':'等待 GitHub 确认',review?'本次操作尚未取得最终确认，需要人工复核。':uncertain?'本次操作的远端结果仍在核对，请勿重复提交。':'请求已提交，GitHub 确认可能稍后完成。','点击「查看结果」读取最新状态；查询不会再次修改 GitHub。'),buttons};
  }
  /** Only refresh plans that have never entered the durable delivery outbox. */
  refreshActionReplies():number{
    return this.control.store.transaction(()=>{
      const rows=this.control.store.all<{delivery_id:string;request_json:string;message_options_json:string;command_id:string}>("SELECT p.delivery_id,p.request_json,p.message_options_json,c.command_id FROM operator_reply_plans p JOIN operator_commands c ON c.source='qq' AND c.interaction_id=p.inbox_id AND c.actor_ref=? AND c.project_id=? WHERE p.project_id=? AND p.recipient_ref=? AND p.operation_id IS NULL ORDER BY p.rowid LIMIT 20",this.options.actorRef,this.options.projectId,this.options.projectId,this.options.recipientRef);
      let updated=0;
      for(const row of rows){const message=this.actionResult(row.command_id),request=JSON.parse(row.request_json) as DeliveryRequestV1,options=JSON.parse(row.message_options_json) as QQReplyOptions;
        updated+=Number(this.control.store.run('UPDATE operator_reply_plans SET report_id=?,revision=?,request_json=?,message_options_json=? WHERE delivery_id=? AND operation_id IS NULL',message.report?.reportId??null,message.report?.revision??null,canonicalJSON({...request,reportId:message.report?.reportId??request.reportId,...(message.report?{reportRevision:message.report.revision}:{}),title:message.title,text:message.text} as unknown as JSONValue),canonicalJSON({...options,buttons:message.buttons,bodyIncludesTitle:true,...(message.card?{card:message.card}:{})} as unknown as JSONValue),row.delivery_id).changes);
      }return updated;
    });
  }
}
