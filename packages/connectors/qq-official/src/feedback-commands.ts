export interface QQFeedbackCommands {enabled:boolean;allowReplyContext?:boolean;maxDescriptionLength?:number;rateWindowMs?:number;perUserRateLimit?:number;perGroupRateLimit?:number;perProjectRateLimit?:number;maxModelCallsPerWindow?:number}
export const qqFeedbackSchema={type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'},allowReplyContext:{type:'boolean'},maxDescriptionLength:{type:'integer',minimum:1,maximum:16000},rateWindowMs:{type:'integer',minimum:1000,maximum:86400000},perUserRateLimit:{type:'integer',minimum:1,maximum:10000},perGroupRateLimit:{type:'integer',minimum:1,maximum:10000},perProjectRateLimit:{type:'integer',minimum:1,maximum:10000},maxModelCallsPerWindow:{type:'integer',minimum:1,maximum:10000}}};
/** Only an authenticated bot ID can consume a leading native mention. */
export function parseQQFeedback(text:string,botId?:string):{version:1;kind:'bug'|'suggestion';command:string;start:number;end:number}|undefined {
  let start=/^\s*/u.exec(text)![0].length;
  const mention=/^<@!?([^>]+)>/u.exec(text.slice(start));
  if(mention){if(!botId||mention[1]!==botId)return;start+=mention[0].length;start+=/^\s*/u.exec(text.slice(start))![0].length;}
  const match=/^\/(bug|suggest)(?=\s|$)/iu.exec(text.slice(start));if(!match)return;
  start+=match[0].length;start+=/^\s*/u.exec(text.slice(start))![0].length;
  return{version:1,kind:match[1]!.toLowerCase()==='bug'?'bug':'suggestion',command:match[0].toLowerCase(),start,end:text.length};
}
