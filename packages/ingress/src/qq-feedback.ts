import type {NormalizedEventV1} from '@superagent/contracts';
import type {JSONValue} from '@superagent/contracts';
import {canonicalJSON} from '@superagent/persistence';
export interface QQFeedbackConfig {enabled:boolean;allowReplyContext:boolean;maxDescriptionLength:number;rateWindowMs:number;perUserRateLimit:number;perGroupRateLimit:number;perProjectRateLimit:number;maxModelCallsPerWindow:number}
export function qqFeedbackConfig(input:Partial<QQFeedbackConfig>&{enabled:boolean}):QQFeedbackConfig {
  const config={allowReplyContext:true,maxDescriptionLength:4000,rateWindowMs:60000,perUserRateLimit:5,perGroupRateLimit:30,perProjectRateLimit:60,maxModelCallsPerWindow:120,...input};
  if(Object.keys(config).some(k=>!['enabled','allowReplyContext','maxDescriptionLength','rateWindowMs','perUserRateLimit','perGroupRateLimit','perProjectRateLimit','maxModelCallsPerWindow'].includes(k))||typeof config.enabled!=='boolean'||typeof config.allowReplyContext!=='boolean'||!Number.isInteger(config.maxDescriptionLength)||config.maxDescriptionLength<1||config.maxDescriptionLength>16000||!Number.isInteger(config.rateWindowMs)||config.rateWindowMs<1000||config.rateWindowMs>86400000||[config.perUserRateLimit,config.perGroupRateLimit,config.perProjectRateLimit,config.maxModelCallsPerWindow].some(n=>!Number.isInteger(n)||n<1||n>10000))throw new Error('QQ_FEEDBACK_CONFIG_INVALID');
  return config;
}
/** The trusted QQ registration is checked separately; arbitrary event attributes grant nothing. */
export function validatedQQIntent(event:NormalizedEventV1):{version:number;kind:string;command:string;start:number;end:number}|undefined {
  if(event.type!=='com.superagent.feedback.message.created.v1'||event.data.platform!=='qq-official'||event.data.attributes?.qqScope!=='group')return;
  const a=event.data.attributes.qqFeedbackCommand,text=event.data.content?.text??'';
  if(!a||typeof a!=='object'||Array.isArray(a)||a.version!==1||!['bug','suggestion'].includes(String(a.kind))||!Number.isInteger(a.start)||a.end!==text.length||Number(a.start)<0||Number(a.start)>text.length)return;
  const prefix=text.slice(0,Number(a.start)),m=/^\s*(?:<@qq-actor-[a-f0-9]{64}>\s*)?\/(bug|suggest)\s*$/iu.exec(prefix);
  if(!m||a.command!==`/${m[1]!.toLowerCase()}`||a.kind!==(m[1]!.toLowerCase()==='bug'?'bug':'suggestion'))return;
  return{version:1,kind:String(a.kind),command:String(a.command),start:Number(a.start),end:text.length};
}
/** Transport variants may differ only in authenticated command-prefix rendering
 * and optional hints. Actor/time/object/attachments/reply binding must remain exact. */
export function equivalentQQCommand(old:NormalizedEventV1,next:NormalizedEventV1):boolean {
  if(old.type!=='com.superagent.feedback.message.created.v1'||next.type!==old.type||old.data.platform!=='qq-official'||next.data.platform!=='qq-official')return false;
  const verified=validatedQQIntent(old)??validatedQQIntent(next);
  const projection=(event:typeof old)=>{
    const copy=structuredClone(event),body=copy.data.content?.text??'';
    if(verified){const match=/^\s*(?:<@qq-actor-[a-f0-9]{64}>\s*)?\/(bug|suggest)(?=\s|$)\s*/iu.exec(body);if(match&&`/${match[1]!.toLowerCase()}`===verified.command&&copy.data.content)copy.data.content.text=verified.command+' '+body.slice(match[0].length).trim();}
    if(copy.data.attributes)delete copy.data.attributes.qqFeedbackCommand;
    // Asset references are opaque connector-derived metadata. Signed CDN URL
    // rotations/identity algorithm upgrades must not turn one immutable native
    // create into another feedback. Keep the first archived reference unchanged.
    if(copy.data.content?.attachments)copy.data.content.attachments=copy.data.content.attachments.map(a=>{const item={...a};delete item.assetRef;return item;});
    return canonicalJSON(copy as unknown as JSONValue);
  };
  return projection(old)===projection(next);
}
/** An authenticated alternate observation can prove the command while keeping
 * the first immutable archive and translating offsets back into that archive. */
export function archivedQQIntent(old:NormalizedEventV1,next:NormalizedEventV1):ReturnType<typeof validatedQQIntent>{
  const verified=validatedQQIntent(next);if(!verified||!equivalentQQCommand(old,next)||old.type!=='com.superagent.feedback.message.created.v1')return;
  const text=old.data.content?.text??'',match=/^\s*(?:<@qq-actor-[a-f0-9]{64}>\s*)?\/(bug|suggest)(?=\s|$)\s*/iu.exec(text);
  return match?{...verified,start:match[0].length,end:text.length}:undefined;
}
