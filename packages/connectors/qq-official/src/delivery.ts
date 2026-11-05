import type { DeliveryPluginHostV1, DeliveryPluginV1, DeliveryRequestV1, DeliveryResultV1, PluginManifestV1 } from '@superagent/plugin-sdk';
import type { P0AlertDeliveryPluginV1, P0AlertDeliveryRequestV1 } from '@superagent/plugin-sdk';
import { QQAPI, QQError, text } from './protocol.js';
import type { QQAPIOptions } from './protocol.js';

export const deliveryManifest: PluginManifestV1 = {
  apiVersion: 'superagent.io/plugin/v1', id: 'qq-official-c2c-delivery', version: '0.1.0', displayName: 'QQ Official C2C Delivery', kind: 'delivery', engine: { sdk: '^0.1.0' },
  permissions: { networkHosts: ['api.bot.qq.com'], secretKeys: ['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_RECIPIENT_OPENID'], deliverySend: true },
  configSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' }, recipientRef: { type: 'string' }, format: { enum: ['markdown', 'text'] } }, required: ['projectId', 'recipientRef'] },
};
export interface QQDeliveryOptions {
  projectId: string;
  recipientRef: string;
  format?: 'markdown' | 'text';
  api?: QQAPIOptions;
  /** Host-issued opaque, authenticated navigation tokens. */
  navigationTokens?: (request: DeliveryRequestV1) => Promise<readonly string[]>;
  messageOptions?: (request: DeliveryRequestV1) => Promise<{replyTo?:{messageId?:string;eventId?:string;sequence:number};requireReplyContext?:boolean;buttons?:readonly {label:string;token:string}[];format?:'markdown'|'text';literalText?:boolean;bodyIncludesTitle?:boolean}>;
}
export class QQC2CDelivery implements P0AlertDeliveryPluginV1 {
  readonly manifest = deliveryManifest;
  private readonly clients = new WeakMap<DeliveryPluginHostV1, QQAPI>();
  constructor(private readonly options: QQDeliveryOptions) {
    text(options.projectId); text(options.recipientRef);
  }
  private client(host: DeliveryPluginHostV1): QQAPI {
    let client = this.clients.get(host);
    if (!client) { client = new QQAPI(key => host.getSecret(key), this.options.api); this.clients.set(host, client); }
    return client;
  }
  async probe(): Promise<{ available: boolean; reason?: string }> {
    // No non-mutating QQ endpoint proves active C2C/Markdown entitlement.
    return { available: false, reason: 'QQ_C2C_PERMISSION_REQUIRES_EXPLICIT_SEND_PROBE' };
  }
  /** Explicit P0 capability; never adapts an alert into a fictional report. */
  async sendP0Alert(request:P0AlertDeliveryRequestV1,host:DeliveryPluginHostV1):Promise<DeliveryResultV1>{
    if(request.projectId!==this.options.projectId||request.recipientRef!==this.options.recipientRef)return{status:'blocked',errorCode:'QQ_RECIPIENT_NOT_AUTHORIZED'};
    let dispatched=false;
    try{
      const content=`P0 紧急告警\n\n${request.title}\n\n${request.markdown}`;
      if(!request.alertId||!content.trim()||literalMarkdown(content).length>3500)return{status:'rejected',errorCode:'QQ_CONTENT_LIMIT'};
      const recipient=text(await host.getSecret('QQ_RECIPIENT_OPENID'),256);
      await this.client(host).accessToken();dispatched=true;
      const providerMessageId=await this.client(host).sendC2C(recipient,{msg_type:2,markdown:{content:literalMarkdown(content)}});
      return{status:'accepted',providerMessageId};
    }catch(error){return{status:error instanceof QQError?(dispatched&&error.code==='QQ_INVALID_FIELD'?'unknown':error.outcome):dispatched?'unknown':'blocked',errorCode:error instanceof QQError?error.code:'QQ_P0_DELIVERY_FAILED'};}
  }
  async probeAuthentication(host: DeliveryPluginHostV1): Promise<{ authenticated: boolean; activeSend: 'unverified' }> {
    try { await this.client(host).identity(); return { authenticated: true, activeSend: 'unverified' }; }
    catch { return { authenticated: false, activeSend: 'unverified' }; }
  }
  /** Host-private optional operation: only the Host may select an owned, superseded message. */
  async recallMessage(messageId:string,host:DeliveryPluginHostV1):Promise<{status:'accepted'|'blocked'|'unknown';errorCode?:string}>{
    try{await this.client(host).recallC2C(await host.getSecret('QQ_RECIPIENT_OPENID'),messageId);return{status:'accepted'};}
    catch(error){return{status:error instanceof QQError&&['blocked','rejected','retryable'].includes(error.outcome)?'blocked':'unknown',errorCode:error instanceof QQError?error.code:'QQ_RECALL_UNKNOWN'};}
  }
  async send(request: DeliveryRequestV1, host: DeliveryPluginHostV1): Promise<DeliveryResultV1> {
    if (request.projectId !== this.options.projectId || request.recipientRef !== this.options.recipientRef) return { status: 'blocked', errorCode: 'QQ_RECIPIENT_NOT_AUTHORIZED' };
    let dispatched = false;
    try {
      const custom = this.options.messageOptions ? await this.options.messageOptions(request) : {};
      const content = custom.bodyIncludesTitle?request.text:`${request.title}\n\n${request.text}`;
      // Never silently truncate a report or split it into an untracked set of sends.
      if (!content.trim() || content.length > 3500) return { status: 'rejected', errorCode: 'QQ_CONTENT_LIMIT' };
      if(custom.requireReplyContext&&!custom.replyTo)return{status:'blocked',errorCode:'QQ_REPLY_CONTEXT_REQUIRED'};
      const markdown = (custom.format ?? this.options.format) !== 'text';
      const payload: Record<string, unknown> = markdown ? { msg_type: 2, markdown: { content:custom.literalText?literalMarkdown(content):content } } : { msg_type: 0, content };
      if(custom.replyTo){const r=custom.replyTo;if(Boolean(r.messageId)===Boolean(r.eventId)||!Number.isSafeInteger(r.sequence)||r.sequence<1)return{status:'rejected',errorCode:'QQ_REPLY_CONTEXT_INVALID'};if(r.messageId){if(r.sequence>4)return{status:'blocked',errorCode:'QQ_PASSIVE_REPLY_LIMIT'};payload.msg_id=text(r.messageId,512);}else payload.event_id=text(r.eventId,512);payload.msg_seq=r.sequence;}
      if (request.presentation) {
        if (request.reportRevision !== request.presentation.revision || request.reportId !== request.presentation.reportId || request.presentation.kind !== 'report_summary') return { status: 'rejected', errorCode: 'QQ_REPORT_SNAPSHOT_MISMATCH' };
        const expected = ['bugs', 'suggestions', 'steam_negative_reviews'];
        if (request.presentation.actions.length !== 3 || request.presentation.actions.some((a, i) => a.kind !== 'report.open_section' || a.section !== expected[i])) return { status: 'rejected', errorCode: 'QQ_NAVIGATION_ACTIONS_INVALID' };
        if (markdown && this.options.navigationTokens) {
          const tokens = await this.options.navigationTokens(request);
          if (tokens.length !== 3 || tokens.some(t => !/^[A-Za-z0-9_-]{16,128}$/.test(t))) return { status: 'rejected', errorCode: 'QQ_NAVIGATION_TOKEN_INVALID' };
          // This is a C2C-only adapter: allow the recipient's client to submit the
          // callback. The Source allowlist and Host token enforce authorization;
          // do not reuse a v2 C2C OpenID as a keyboard-specific user identity.
          payload.keyboard = { content: { rows: [{ buttons: request.presentation.actions.map((action, i) => ({ id: String(i + 1), render_data: { label: buttonLabel(action.label), visited_label: buttonLabel(action.label), style: 1 }, action: { type: 1, permission: { type: 2 }, data: tokens[i],unsupport_tips:'请升级 QQ 或私聊发送 /bugs /suggestions /steam-negative' } })) }] } };
        }
        // No handler means no dead or unauthenticated buttons. The text remains explicit.
        else if (markdown) (payload.markdown as { content: string }).content += '\n\n当前未启用报告交互导航。';
      }
      if(custom.buttons?.length){
        if(custom.buttons.length>9||custom.buttons.some(b=>!b.label||b.label.length>20||!/^[A-Za-z0-9_-]{43}$/.test(b.token)))return{status:'rejected',errorCode:'QQ_OPERATOR_BUTTON_INVALID'};
        if(markdown){const rows=[];for(let i=0;i<custom.buttons.length;i+=3)rows.push({buttons:custom.buttons.slice(i,i+3).map((b,n)=>({id:String(i+n+1),render_data:{label:buttonLabel(b.label),visited_label:buttonLabel(b.label),style:1},action:{type:1,permission:{type:2},data:b.token,unsupport_tips:`请私聊发送 /open ${b.token}`}}))});payload.keyboard={content:{rows}};}
        else {const commands=custom.buttons.map(b=>`${b.label}: /open ${b.token}`).join('\n');payload.content=String(payload.content)+'\n\n操作命令：\n'+commands;}
      }
      const rendered=markdown?String((payload.markdown as {content:string}).content):String(payload.content);
      if(rendered.length>3500)return{status:'rejected',errorCode:'QQ_CONTENT_LIMIT'};
      const recipient = text(await host.getSecret('QQ_RECIPIENT_OPENID'), 256);
      // Authentication occurs before dispatch; failure is known to precede message POST.
      await this.client(host).accessToken();
      dispatched = true;
      const providerMessageId = await this.client(host).sendC2C(recipient, payload);
      return { status: 'accepted', providerMessageId };
    } catch (error) {
      const status = error instanceof QQError ? (dispatched && error.code === 'QQ_INVALID_FIELD' ? 'unknown' : error.outcome) : dispatched ? 'unknown' : 'blocked';
      return { status, errorCode: error instanceof QQError ? error.code : 'QQ_DELIVERY_FAILED' };
    }
  }
}
function buttonLabel(label:string):string{return ({'查看 Steam 差评':'Steam 差评','Investigating':'开始调查','Implemented':'标记已实现'} as Record<string,string>)[label]??Array.from(label).slice(0,10).join('');}
// Rendering only: the request and stored evidence remain verbatim. Escape ASCII
// punctuation and use hard breaks so originals cannot turn into Markdown actions.
function literalMarkdown(value:string):string{return value.replace(/[\\`*_{}\[\]()<>!#|~+\-&]/g,'\\$&').replace(/^(\s*\d+)\./gm,'$1\\.').replace(/\n/g,'\\\n');}
