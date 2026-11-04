import { createHash } from 'node:crypto';
import type { JSONValue, NormalizedEventV1 } from '@superagent/plugin-sdk';
import type { DiscordAPI,DiscordDispatch } from './transport.js';
import { asJSON,object,packetKey,snowflake } from './module-types.js';
import type { DiscordModulePort,DiscordBusinessModule,StateRow } from './module-types.js';
import { discordPermissions,normalizeDiscordMessage } from './source.js';
export interface DiscordTicketConfig {enabled:boolean;allowWrites?:boolean;projectId?:string;categoryId?:string;staffRoleIds?:string[]}
interface Ticket {id:string;userId:string;kind:'bug'|'suggestion'|'help';title:string;status:'pending_create'|'creating'|'unknown_create'|'open'|'closed'|'delete_pending'|'deleting'|'deleted'|'blocked';evidenceEventId:string;createdAt:string;channelId?:string;lastError?:string;appliedStatus?:string;claimedBy?:string;intro?:'sending'|'sent'|'unknown';reconcileAt?:string}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,20);
const val=(r:StateRow)=>r.value as unknown as Ticket;
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&v.length<=max?v:undefined;
/** Ticket-only business module. All persistence and archival are scoped Host calls. */
export class DiscordTickets implements DiscordBusinessModule {
  private readonly replies=new Map<string,{app:string;token:string;expires:number;ack:Promise<void>}>();
  private botId='';private appId='';private checked=false;private readonly controller=new AbortController();
  constructor(readonly guildId:string,readonly config:DiscordTicketConfig,private readonly host:DiscordModulePort,private readonly api:DiscordAPI){
    if(!config.enabled||!config.projectId||!snowflake(guildId)||!snowflake(config.categoryId)||!Array.isArray(config.staffRoleIds)||!config.staffRoleIds.length||config.staffRoleIds.some(id=>!snowflake(id)||id===guildId)||new Set(config.staffRoleIds).size!==config.staffRoleIds.length)throw new Error('INVALID_CONFIG');
  }
  stop(){this.controller.abort();this.replies.clear();}
  async owns(p:DiscordDispatch):Promise<boolean>{
    if(p.data.guild_id!==this.guildId)return false;
    if(p.type==='INTERACTION_CREATE')return object(p.data.data)&&(p.data.data.name==='sa-ticket'||typeof p.data.data.custom_id==='string'&&p.data.data.custom_id.startsWith('sa-ticket:'));
    if(['MESSAGE_CREATE','MESSAGE_UPDATE','MESSAGE_DELETE','MESSAGE_DELETE_BULK'].includes(p.type))return (await this.host.list('ticket:')).some(r=>val(r).channelId===p.data.channel_id);
    return false;
  }
  async acknowledge(p:DiscordDispatch):Promise<void>{
    for(const [id,r] of this.replies)if(r.expires<Date.now())this.replies.delete(id);
    if(this.replies.size>=256)return;
    if(!this.config.allowWrites||p.type!=='INTERACTION_CREATE'||!(await this.owns(p))||!snowflake(p.data.id)||typeof p.data.token!=='string'||!snowflake(p.data.application_id)||this.replies.has(p.data.id))return;
    const promise=this.api.request('POST',`/interactions/${p.data.id}/${encodeURIComponent(p.data.token)}/callback`,{type:5,data:{flags:64}},this.controller.signal).then(()=>{});
    this.replies.set(p.data.id,{app:p.data.application_id,token:p.data.token,expires:Date.now()+14*60000,ack:promise});await promise;
  }
  private async reply(p:DiscordDispatch,content:string){
    const id=String(p.data.id),r=this.replies.get(id);if(!r||r.expires<Date.now())return;
    try{await r.ack;await this.api.request('PATCH',`/webhooks/${r.app}/${encodeURIComponent(r.token)}/messages/@original`,{content:content.slice(0,1900),allowed_mentions:{parse:[]}},this.controller.signal);}finally{this.replies.delete(id);}
  }
  private async staff(user:string,signal:AbortSignal):Promise<boolean>{
    const member=await this.api.request('GET',`/guilds/${this.guildId}/members/${user}`,undefined,signal);
    if(!object(member)||!object(member.user)||member.user.id!==user||!Array.isArray(member.roles))throw new Error('PERMISSION_DENIED');
    return member.roles.some(id=>this.config.staffRoleIds!.includes(String(id)));
  }
  private async authorized(row:StateRow,user:string,signal:AbortSignal,staffOnly=false){if((!staffOnly&&val(row).userId===user)||await this.staff(user,signal))return;throw new Error('DISCORD_TICKET_FORBIDDEN');}
  private async receipt(p:DiscordDispatch,changes:Parameters<DiscordModulePort['commit']>[0]=[]){
    const key=packetKey(p),old=await this.host.get('receipt:'+key);if(old){await this.host.commit([],key);return;}
    await this.host.commit([...changes,{key:'receipt:'+key,expectedVersion:null,value:{at:this.host.now()}}],key);
  }
  async handle(p:DiscordDispatch,signal:AbortSignal):Promise<void>{
    if(!(await this.owns(p))){await this.host.commit([],packetKey(p));return;}
    if(p.type!=='INTERACTION_CREATE'){
      const ids=p.type==='MESSAGE_DELETE_BULK'&&Array.isArray(p.data.ids)?p.data.ids:[p.data.id];
      for(const id of ids){if(!snowflake(id)||!snowflake(p.data.channel_id))throw new Error('INVALID_EVENT');
        const action=p.type==='MESSAGE_CREATE'?'created':p.type==='MESSAGE_UPDATE'?'updated':'deleted';
        const event=normalizeDiscordMessage({...p.data,id},action,{sourceUri:this.host.scope.sourceUri,guildId:this.guildId,channelIds:[]},this.host.scope,{eventKey:`private:${p.sessionId}:${p.sequence}`,receivedAt:p.receivedAt,threadId:p.data.channel_id});
        await this.host.archive(packetKey(p)+':'+id,event,p.data.channel_id);
      }await this.host.commit([],packetKey(p));return;
    }
    const key=packetKey(p);if(await this.host.get('receipt:'+key)){await this.host.commit([],key);return;}
    const member=p.data.member,user=object(member)&&object(member.user)?member.user.id:undefined;
    if(!snowflake(user)||!object(p.data.data))throw new Error('DISCORD_TICKET_FORBIDDEN');
    const raw=p.data.data,options:Record<string,unknown>[]=Array.isArray(raw.options)?raw.options.filter(object) as Record<string,unknown>[]:[];
    const option=(name:string)=>options.find(o=>o.name===name)?.value;
    const custom=typeof raw.custom_id==='string'?raw.custom_id.split(':'):[];
    const action=String(option('action')??custom[1]??'view');
    if(action==='new'){
      const kind=option('kind'),title=text(option('title'),120),body=text(option('body'),3500);
      if(!['bug','suggestion','help'].includes(String(kind))||!title||!body||!snowflake(p.data.id))throw new Error('DISCORD_TICKET_INPUT_INVALID');
      const id=sha(this.guildId+':'+p.data.id);
      const event:NormalizedEventV1={specversion:'1.0',id:'discord-ticket:'+p.data.id,source:this.host.scope.sourceUri,type:'com.superagent.feedback.message.created.v1',time:p.receivedAt,datacontenttype:'application/json',data:{schemaVersion:'1.0',projectId:this.host.scope.projectId,sourceId:this.host.scope.sourceId,platform:'discord',object:{kind:'message',externalId:String(p.data.id),revision:'submitted'},actor:{opaqueId:user},content:{text:title+'\n\n'+body},attributes:{guildId:this.guildId,ticketKind:String(kind),title,interactionId:p.data.id}}};
      const ticket=await this.host.submit(key,event,asJSON({id,userId:user,kind,title,status:'pending_create',createdAt:this.host.now()}));await this.reply(p,'已可靠归档工单 '+val(ticket).id+'；频道创建状态将在私人频道中显示。');return;
    }
    const id=String(option('ticket')??custom[2]??''),row=await this.host.get('ticket:'+id);if(!row)throw new Error('DISCORD_TICKET_NOT_FOUND');await this.authorized(row,user,signal);
    const ticket=val(row);
    if(action==='view'||action==='history'){
      const evidence=await this.host.event(ticket.evidenceEventId);
      const history=await this.host.list('history:'+id+':');await this.receipt(p);
      const body=action==='view'?evidence&&evidence.type!=='com.superagent.source.coverage.changed.v1'?evidence.data.content?.text??'[原文不可见]':'[原文不可见]':history.map(h=>JSON.stringify(h.value)).join('\n');
      const page=Number(option('page')??1),chars=Array.from(body),pages=Math.max(1,Math.ceil(chars.length/1600));
      if(!Number.isSafeInteger(page)||page<1||page>pages)throw new Error('DISCORD_TICKET_INPUT_INVALID');
      await this.reply(p,`工单 ${id}\n${ticket.title}\n状态：${ticket.status}\n第 ${page}/${pages} 页（使用 page 参数翻页）\n${chars.slice((page-1)*1600,page*1600).join('')}`);return;
    }
    if(!['close','reopen','claim','delete'].includes(action))throw new Error('DISCORD_TICKET_INPUT_INVALID');
    if(action==='claim'||action==='delete')await this.authorized(row,user,signal,true);
    const status=action==='close'?'closed':action==='reopen'?'open':action==='delete'?'delete_pending':ticket.status;
    if(action==='close'&&ticket.status!=='open'||action==='reopen'&&ticket.status!=='closed'||action==='delete'&&ticket.status!=='closed'||action==='claim'&&ticket.status!=='open')throw new Error('DISCORD_TICKET_STATE_CONFLICT');
    const index=await this.host.get('open:'+ticket.userId+':'+ticket.kind);
    if(action==='reopen'&&index&&object(index.value)&&index.value.id!==id&&typeof index.value.id==='string'){
      const other=await this.host.get('ticket:'+index.value.id);if(other&&!['closed','deleted'].includes(val(other).status))throw new Error('DISCORD_TICKET_STATE_CONFLICT');
    }
    await this.receipt(p,[{key:row.key,expectedVersion:row.version,value:asJSON({...ticket,status,...(action==='claim'?{claimedBy:user}:{})})},{key:'history:'+id+':'+key,expectedVersion:null,value:{action,actor:user,at:this.host.now()}},...(action==='reopen'?[{key:'open:'+ticket.userId+':'+ticket.kind,expectedVersion:index?.version??null,value:{id}}]:[])]);await this.reply(p,'工单状态已归档：'+status);
  }
  private async inspect(signal:AbortSignal){
    const user=await this.api.request('GET','/users/@me',undefined,signal),category=await this.api.request('GET','/channels/'+this.config.categoryId,undefined,signal);
    if(!object(user)||!snowflake(user.id)||!object(category)||category.guild_id!==this.guildId||category.type!==4||!Array.isArray(category.permission_overwrites))throw new Error('PERMISSION_DENIED');
    const everyone=category.permission_overwrites.find(x=>object(x)&&x.id===this.guildId);
    if(!object(everyone)||(BigInt(String(everyone.deny??'0'))&1024n)===0n)throw new Error('DISCORD_TICKET_CATEGORY_NOT_PRIVATE');
    const member=await this.api.request('GET',`/guilds/${this.guildId}/members/${user.id}`,undefined,signal),roles=await this.api.request('GET',`/guilds/${this.guildId}/roles`,undefined,signal),app=await this.api.request('GET','/oauth2/applications/@me',undefined,signal);
    if(!object(member)||!Array.isArray(member.roles)||!Array.isArray(roles)||!object(app)||!snowflake(app.id)||typeof app.flags!=='number'||(app.flags&((1<<18)|(1<<19)))===0)throw new Error('PERMISSION_DENIED');
    const bits=discordPermissions(this.guildId,user.id,member.roles as string[],roles as Parameters<typeof discordPermissions>[3],category.permission_overwrites as Parameters<typeof discordPermissions>[4]);
    const required=1024n|16n|(1n<<28n);if((bits&required)!==required)throw new Error('PERMISSION_DENIED');
    this.botId=user.id;this.appId=app.id;this.checked=true;
  }
  private overwrites(user:string){return [{id:this.guildId,type:0,deny:String(1024n|(1n<<35n)|(1n<<36n)),allow:'0'},{id:user,type:1,allow:String(1024n|2048n|65536n),deny:String((1n<<35n)|(1n<<36n))},{id:this.botId,type:1,allow:String(1024n|2048n|65536n|16n|(1n<<28n)),deny:'0'},...this.config.staffRoleIds!.map(id=>({id,type:0,allow:String(1024n|2048n|65536n),deny:'0'}))];}
  private privateChannel(channel:Record<string,unknown>,requester:string):boolean{
    if(!Array.isArray(channel.permission_overwrites))return false;
    const p=channel.permission_overwrites.filter(object),everyone=p.find(p=>p.id===this.guildId);
    if(!everyone||(BigInt(String(everyone.deny??'0'))&1024n)===0n||(BigInt(String(everyone.allow??'0'))&1024n)!==0n)return false;
    return p.every(p=>(BigInt(String(p.allow??'0'))&1024n)===0n||[this.botId,requester,...this.config.staffRoleIds!].includes(String(p.id)));
  }
  private async change(row:StateRow,patch:Partial<Ticket>){const latest=await this.host.get(row.key);if(!latest||latest.version!==row.version)throw new Error('DISCORD_STATE_CONFLICT');await this.host.commit([{key:row.key,expectedVersion:row.version,value:asJSON({...val(row),...patch})}]);}
  private async flush(channelId:string,signal:AbortSignal):Promise<boolean>{
    const key='history-channel:'+channelId;let row=await this.host.get(key);
    let scan=(row?.value??{after:'0',before:null,high:'0'}) as {after:string;before:string|null;high:string};
    for(let n=0;n<5;n++){
      const messages=await this.api.request('GET',`/channels/${channelId}/messages?limit=100${scan.before?'&before='+scan.before:''}`,undefined,signal);
      if(!Array.isArray(messages)||messages.some(m=>!object(m)||!snowflake(m.id)||m.channel_id!==channelId||m.guild_id!==undefined&&m.guild_id!==this.guildId||scan.before&&BigInt(m.id)>=BigInt(scan.before)))throw new Error('DISCORD_TICKET_HISTORY_INVALID');
      let high=scan.high,oldest:string|null=null;
      for(const m of messages){
        if(!object(m)||!snowflake(m.id))throw new Error('DISCORD_TICKET_HISTORY_INVALID');
        if(BigInt(m.id)>BigInt(high))high=m.id;if(!oldest||BigInt(m.id)<BigInt(oldest))oldest=m.id;
        const current=await this.host.current(m.id),raw={...m,guild_id:this.guildId};
        const id='private-snapshot:'+sha(JSON.stringify(raw)+':'+(current?.id??'initial'));
        const event=normalizeDiscordMessage(raw,m.edited_timestamp?'updated':'created',{sourceUri:this.host.scope.sourceUri,guildId:this.guildId,channelIds:[]},this.host.scope,{eventKey:id,receivedAt:this.host.now(),threadId:channelId});
        if(current&&current.type!=='com.superagent.source.coverage.changed.v1'&&JSON.stringify(current.data.content)===JSON.stringify(event.data.content))continue;
        await this.host.archive(id,event,channelId);
      }
      const complete=messages.length<100||messages.some(m=>object(m)&&snowflake(m.id)&&BigInt(m.id)<=BigInt(scan.after));
      scan=complete?{after:high,before:null,high}:{after:scan.after,before:oldest,high};
      await this.host.commit([{key,expectedVersion:row?.version??null,value:asJSON(scan)}]);row=await this.host.get(key);
      if(complete)return true;
    }return false;
  }
  async tick(signal:AbortSignal):Promise<void>{
    if(!this.config.allowWrites)return;if(!this.checked)await this.inspect(signal);
    const setup=await this.host.get('setup:command');
    if(!setup||object(setup.value)&&setup.value.status!=='ready'){
      const commands=await this.api.request('GET',`/applications/${this.appId}/guilds/${this.guildId}/commands`,undefined,signal);
      if(!Array.isArray(commands))throw new Error('INVALID_EVENT');
      if(!commands.some(c=>object(c)&&c.name==='sa-ticket')){
        if(setup){await this.host.commit([{key:setup.key,expectedVersion:setup.version,value:{status:'manual_review'}}]);return;}
        await this.host.commit([{key:'setup:command',expectedVersion:null,value:{status:'sending'}}]);
        await this.api.request('POST',`/applications/${this.appId}/guilds/${this.guildId}/commands`,{name:'sa-ticket',description:'私人社区工单',options:[{type:3,name:'action',description:'操作',required:true,choices:['new','view','history','close','reopen','claim','delete'].map(name=>({name,value:name}))},{type:3,name:'kind',description:'工单类型',choices:['bug','suggestion','help'].map(name=>({name,value:name}))},{type:3,name:'title',description:'标题',max_length:120},{type:3,name:'body',description:'原始详情',max_length:3500},{type:3,name:'ticket',description:'工单编号'},{type:4,name:'page',description:'原文或历史页码',min_value:1,max_value:1000}]},signal);
      }
      const current=await this.host.get('setup:command');await this.host.commit([{key:'setup:command',expectedVersion:current?.version??null,value:{status:'ready'}}]);
    }
    for(const row of await this.host.list('ticket:')){
      signal.throwIfAborted();const t=val(row),marker='superagent-ticket:'+t.id;
      if(['pending_create','creating','unknown_create'].includes(t.status)){
        if(t.reconcileAt&&t.reconcileAt>this.host.now())continue;
        const channels=await this.api.request('GET',`/guilds/${this.guildId}/channels`,undefined,signal);if(!Array.isArray(channels))throw new Error('INVALID_EVENT');
        const matches=channels.filter(c=>object(c)&&c.guild_id===this.guildId&&c.parent_id===this.config.categoryId&&c.type===0&&c.topic===marker);
        if(matches.length>1){await this.change(row,{status:'blocked',lastError:'DISCORD_DUPLICATE_MARKER'});continue;}
        let channel=matches[0];
        if(!channel){
          if(t.status!=='pending_create'){await this.change(row,{status:'unknown_create',lastError:'DISCORD_CREATE_REQUIRES_RECONCILIATION',reconcileAt:new Date(Date.parse(this.host.now())+60000).toISOString()});continue;}
          await this.change(row,{status:'creating'});
          try{channel=await this.api.request('POST',`/guilds/${this.guildId}/channels`,{name:`ticket-${t.kind}-${t.id.slice(0,8)}`,type:0,parent_id:this.config.categoryId,topic:marker,permission_overwrites:this.overwrites(t.userId)},signal);}
          catch(error){const fresh=await this.host.get(row.key);if(fresh)await this.change(fresh,{status:error instanceof Error&&error.message==='OUTCOME_UNKNOWN'?'unknown_create':'blocked',lastError:error instanceof Error?error.message.split(':')[0]??'DISCORD_CREATE_FAILED':'DISCORD_CREATE_FAILED'});continue;}
        }
        if(!object(channel)||!snowflake(channel.id)||channel.guild_id!==this.guildId||channel.parent_id!==this.config.categoryId||channel.type!==0||channel.topic!==marker||!this.privateChannel(channel,t.userId))throw new Error('OUTCOME_UNKNOWN');
        const current=await this.host.get(row.key);if(current)await this.change(current,{status:'open',channelId:channel.id});continue;
      }
      if(!t.channelId||t.status==='blocked'||t.status==='deleted')continue;
      let channel:unknown;try{channel=await this.api.request('GET','/channels/'+t.channelId,undefined,signal);}catch(error){if(error instanceof Error&&error.message==='NOT_FOUND'){await this.change(row,{status:t.status==='deleting'?'deleted':'blocked',lastError:'DISCORD_TICKET_CHANNEL_MISSING'});continue;}throw error;}
      if(!object(channel)||channel.guild_id!==this.guildId||channel.parent_id!==this.config.categoryId||channel.topic!==marker||channel.type!==0||!this.privateChannel(channel,t.userId))throw new Error('DISCORD_TICKET_CHANNEL_IDENTITY');
      if(t.status==='delete_pending'||t.status==='deleting'){
        if(t.status==='deleting'){await this.change(row,{status:'blocked',lastError:'DISCORD_DELETE_REQUIRES_RECONCILIATION'});continue;}
        const requester=Array.isArray(channel.permission_overwrites)?channel.permission_overwrites.find(p=>object(p)&&p.id===t.userId&&p.type===1):undefined;
        if(!object(requester)||(BigInt(String(requester.deny??'0'))&2048n)===0n||(BigInt(String(requester.allow??'0'))&2048n)!==0n){
          await this.api.request('PUT',`/channels/${t.channelId}/permissions/${t.userId}`,{type:1,allow:String(1024n|65536n),deny:String(2048n|(1n<<35n)|(1n<<36n))},signal);await this.change(row,{appliedStatus:'closed'});continue;
        }
        if(await this.host.pending()||!(await this.flush(t.channelId,signal)))continue;
        await this.change(row,{status:'deleting'});await this.api.request('DELETE','/channels/'+t.channelId,undefined,signal);const fresh=await this.host.get(row.key);if(fresh)await this.change(fresh,{status:'deleted'});continue;
      }
      await this.flush(t.channelId,signal);
      if(t.appliedStatus!==t.status){await this.api.request('PUT',`/channels/${t.channelId}/permissions/${t.userId}`,{type:1,allow:String(1024n|65536n|(t.status==='closed'?0n:2048n)),deny:String((1n<<35n)|(1n<<36n)|(t.status==='closed'?2048n:0n))},signal);await this.change(row,{appliedStatus:t.status});continue;}
      if(!t.intro){const original=await this.host.event(t.evidenceEventId);await this.change(row,{intro:'sending'});try{await this.api.request('POST',`/channels/${t.channelId}/messages`,{content:`工单 ${t.id}\n${original&&original.type!=='com.superagent.source.coverage.changed.v1'?original.data.content?.text??t.title:t.title}`.slice(0,1900),allowed_mentions:{parse:[]}},signal);const fresh=await this.host.get(row.key);if(fresh)await this.change(fresh,{intro:'sent'});}catch{const fresh=await this.host.get(row.key);if(fresh)await this.change(fresh,{intro:'unknown'});}}
    }
    for(const [id,r] of this.replies)if(r.expires<Date.now())this.replies.delete(id);
  }
}
