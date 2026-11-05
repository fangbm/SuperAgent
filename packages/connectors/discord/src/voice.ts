import { createHash } from 'node:crypto';
import type { DiscordAPI,DiscordDispatch } from './transport.js';
import { discordPermissions } from './source.js';
import { asJSON,object,packetKey,snowflake } from './module-types.js';
import type { DiscordBusinessModule,DiscordModulePort,StateRow,StateChange } from './module-types.js';
export interface DiscordVoiceConfig {enabled:boolean;allowWrites?:boolean;categoryId?:string;creatorChannelIds?:string[];emptyRoomMs?:number;defaultLimit?:number;cleanupEmptyRooms?:boolean}
interface Room {id:string;ownerId:string;creatorId:string;status:'pending_create'|'creating'|'unknown_create'|'active'|'deleting'|'unknown_delete'|'retired'|'blocked';channelId?:string;limit:number;locked:boolean;createdAt:string;emptySince?:string;closingAt?:string;applied?:string;lastError?:string;nextCheckAt?:string;move?:'pending'|'moving'|'done'|'unknown'}
interface Snapshot {sessionId:string;valid:boolean;presence:Record<string,string>;sequence:number}
const room=(r:StateRow)=>r.value as unknown as Room;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,20);
export class DiscordVoice implements DiscordBusinessModule {
  private live=false;private healthAt=0;private checked=false;private botId='';private appId='';
  private connectionController=new AbortController();
  private commandSetup='unverified';
  private readonly stopController=new AbortController();private readonly replies=new Map<string,{app:string;token:string;ack:Promise<unknown>;expires:number}>();
  constructor(readonly guildId:string,readonly config:DiscordVoiceConfig,private readonly host:DiscordModulePort,private readonly api:DiscordAPI,private readonly connected:()=>boolean=()=>true){
    if(!config.enabled||!snowflake(config.categoryId)||!Array.isArray(config.creatorChannelIds)||!config.creatorChannelIds.length||config.creatorChannelIds.length>16||config.creatorChannelIds.some(id=>!snowflake(id))||new Set(config.creatorChannelIds).size!==config.creatorChannelIds.length||!Number.isInteger(config.emptyRoomMs??60000)||(config.emptyRoomMs??60000)<1000||!Number.isInteger(config.defaultLimit??4)||(config.defaultLimit??4)<1||(config.defaultLimit??4)>99)throw new Error('INVALID_CONFIG');
  }
  stop(){this.disconnect();this.stopController.abort();this.replies.clear();}
  disconnect(){this.live=false;this.connectionController.abort();}
  heartbeat(){this.healthAt=Date.now();}
  diagnostics(){return{occupancy:this.fresh()?'confirmed':'unknown',gatewayConnected:this.connected(),commandSetup:this.commandSetup};}
  private fresh(){return this.live&&this.connected()&&Date.now()-this.healthAt<300000&&!this.stopController.signal.aborted;}
  private async snapshot():Promise<{row:StateRow|null;data:Snapshot}>{const row=await this.host.get('snapshot');return{row,data:row?row.value as unknown as Snapshot:{sessionId:'',valid:false,presence:{},sequence:0}};}
  async owns(p:DiscordDispatch):Promise<boolean>{
    if(p.type==='READY'||p.type==='RESUMED')return true;
    if(p.type==='GUILD_CREATE')return p.data.id===this.guildId;
    if(p.data.guild_id!==this.guildId)return false;
    if(p.type==='INTERACTION_CREATE')return object(p.data.data)&&p.data.data.name==='sa-voice';
    if(p.type==='VOICE_STATE_UPDATE')return true; // Minimal guild occupancy closes channel-create/first-join races.
    return false;
  }
  /** Minimal guild occupancy also covers rooms created before a lost response;
   * filtering by locally known IDs would falsely declare such rooms empty. */
  async sanitize(p:DiscordDispatch):Promise<DiscordDispatch>{
    if(p.type==='GUILD_CREATE'){
      return {...p,data:{id:this.guildId,...(p.data.unavailable===true?{unavailable:true}:{}),voice_states:Array.isArray(p.data.voice_states)?p.data.voice_states.map(v=>{const s=object(v)?v:{};return{user_id:String(s.user_id),channel_id:s.channel_id as string};}):null}};
    }
    if(p.type==='VOICE_STATE_UPDATE')return{...p,data:{guild_id:this.guildId,user_id:p.data.user_id!,channel_id:p.data.channel_id??null}};
    if(p.type==='READY'||p.type==='RESUMED')return{...p,data:{}};
    return p;
  }
  async acknowledge(p:DiscordDispatch){
    for(const [id,r]of this.replies)if(r.expires<Date.now())this.replies.delete(id);
    if(!this.config.allowWrites||this.replies.size>=256||p.type!=='INTERACTION_CREATE'||!(await this.owns(p))||!snowflake(p.data.id)||!snowflake(p.data.application_id)||typeof p.data.token!=='string'||this.replies.has(p.data.id))return;
    const ack=this.api.request('POST',`/interactions/${p.data.id}/${encodeURIComponent(p.data.token)}/callback`,{type:5,data:{flags:64}},this.stopController.signal);
    this.replies.set(p.data.id,{app:p.data.application_id,token:p.data.token,ack,expires:Date.now()+14*60000});await ack;
  }
  private async respond(p:DiscordDispatch,text:string){const id=String(p.data.id),r=this.replies.get(id);if(!r||r.expires<Date.now())return;try{await r.ack;await this.api.request('PATCH',`/webhooks/${r.app}/${encodeURIComponent(r.token)}/messages/@original`,{content:text,allowed_mentions:{parse:[]}},this.stopController.signal);}finally{this.replies.delete(id);}}
  async reject(p:DiscordDispatch,code:string){await this.respond(p,`请求暂未确认（${code}）。请核对房间状态后再操作。`);}
  private async save(row:StateRow,value:Room){await this.host.commit([{key:row.key,expectedVersion:row.version,value:asJSON(value)}]);}
  private marker(r:Room){return `sa-room-${r.id}`;}
  private identity(channel:unknown,r:Room):channel is Record<string,unknown>{return object(channel)&&channel.id===r.channelId&&channel.guild_id===this.guildId&&channel.type===2&&channel.parent_id===this.config.categoryId&&channel.name===this.marker(r);}
  private overwrites(r:Room,closing=false){return[{id:this.guildId,type:0,allow:'1024',deny:r.locked||closing?String(1n<<20n):'0'},
    {id:r.ownerId,type:1,allow:closing?'1024':String(1024n|(1n<<20n)),deny:closing?String(1n<<20n):'0'},
    {id:this.botId,type:1,allow:String(1024n|16n|(1n<<24n)|(1n<<20n)|(1n<<28n)),deny:'0'}];}
  private async permissions(user:string,channel:Record<string,unknown>,signal:AbortSignal,unlockForTransfer=false):Promise<boolean>{
    let member:unknown;try{member=await this.api.request('GET',`/guilds/${this.guildId}/members/${user}`,undefined,signal);}catch(e){if(e instanceof Error&&e.message==='NOT_FOUND')return false;throw e;}
    const roles=await this.api.request('GET',`/guilds/${this.guildId}/roles`,undefined,signal);
    if(!object(member)||!object(member.user)||member.user.id!==user||!Array.isArray(member.roles)||!Array.isArray(roles)||!Array.isArray(channel.permission_overwrites))throw new Error('INVALID_EVENT');
    const overwrites=channel.permission_overwrites as Parameters<typeof discordPermissions>[4];
    const bits=discordPermissions(this.guildId,user,member.roles as string[],roles as Parameters<typeof discordPermissions>[3],unlockForTransfer?overwrites.map(o=>o.id===this.guildId&&o.type===0?{...o,deny:String(BigInt(o.deny)&~(1n<<20n))}:o):overwrites);return (bits&(1024n|(1n<<20n)))===(1024n|(1n<<20n));
  }
  async handle(p:DiscordDispatch,signal:AbortSignal){
    const key=packetKey(p);if(await this.host.get('receipt:'+key)){await this.host.commit([],key);return;}
    const {row,data}=await this.snapshot();const next:Snapshot=structuredClone(data),changes:StateChange[]=[];
    if(p.type==='READY'){this.disconnect();next.sessionId=p.sessionId;next.valid=false;next.presence={};}
    else if(p.type==='RESUMED'){this.connectionController=new AbortController();this.live=next.valid&&next.sessionId===p.sessionId;this.healthAt=Date.now();}
    else if(p.type==='GUILD_CREATE'&&p.data.id===this.guildId){
      next.sessionId=p.sessionId;next.valid=Array.isArray(p.data.voice_states)&&p.data.unavailable!==true;next.presence={};
      if(next.valid)for(const v of p.data.voice_states as unknown[]){if(!object(v)||!snowflake(v.user_id)||!snowflake(v.channel_id))throw new Error('INVALID_EVENT');next.presence[v.user_id]=v.channel_id;}
      this.connectionController=new AbortController();this.live=next.valid;this.healthAt=Date.now();
    }else if(p.type==='VOICE_STATE_UPDATE'&&p.data.guild_id===this.guildId){
      if(!snowflake(p.data.user_id)||p.data.channel_id!==null&&!snowflake(p.data.channel_id))throw new Error('INVALID_EVENT');
      if(p.data.channel_id===null)delete next.presence[p.data.user_id];else next.presence[p.data.user_id]=p.data.channel_id;
      if(next.sessionId!==p.sessionId){next.valid=false;this.live=false;}
    }else if(p.type==='INTERACTION_CREATE'){
      if(!this.fresh()||!object(p.data.member)||!object(p.data.member.user)||!snowflake(p.data.member.user.id)||!object(p.data.data))throw new Error('DISCORD_VOICE_FORBIDDEN');
      const user=p.data.member.user.id,options=Array.isArray(p.data.data.options)?p.data.data.options.filter(object) as Record<string,unknown>[]:[],option=(name:string)=>options.find(v=>v.name===name)?.value;
      const current=option('room')?await this.host.get('room:'+String(option('room'))):(await this.host.list('room:')).find(r=>room(r).channelId===next.presence[user]&&room(r).ownerId===user);if(!current)throw new Error('DISCORD_VOICE_NOT_FOUND');const r=room(current);
      if(r.ownerId!==user||r.status!=='active'||!r.channelId||next.presence[user]!==r.channelId)throw new Error('DISCORD_VOICE_FORBIDDEN');
      const channel=await this.api.request('GET','/channels/'+r.channelId,undefined,signal);if(!this.identity(channel,r)||!(await this.permissions(user,channel,signal)))throw new Error('DISCORD_VOICE_FORBIDDEN');
      const action=option('action');let updated:Room={...r};
      if(action==='limit'){const limit=Number(option('limit'));if(!Number.isInteger(limit)||limit<1||limit>99)throw new Error('DISCORD_VOICE_INPUT_INVALID');updated.limit=limit;}
      else if(action==='lock'||action==='unlock')updated.locked=action==='lock';
      else if(action==='transfer'){
        const target=option('target');if(!snowflake(target)||next.presence[target]!==r.channelId||!(await this.permissions(target,channel,signal)))throw new Error('DISCORD_VOICE_FORBIDDEN');updated.ownerId=target;
        const old=await this.host.get('owner:'+r.creatorId+':'+user),index=await this.host.get('owner:'+r.creatorId+':'+target);
        if(old&&object(old.value)&&old.value.id===r.id)changes.push({key:old.key,expectedVersion:old.version,value:{id:''}});if(!index||!object(index.value)||!index.value.id||index.value.id===r.id)changes.push({key:'owner:'+r.creatorId+':'+target,expectedVersion:index?.version??null,value:{id:r.id}});
      }else throw new Error('DISCORD_VOICE_INPUT_INVALID');
      delete updated.closingAt;delete updated.emptySince;changes.push({key:current.key,expectedVersion:current.version,value:asJSON(updated)});
      await this.host.commit([...changes,{key:'receipt:'+key,expectedVersion:null,value:{at:this.host.now(),action:String(action),roomId:r.id}}],key);await this.respond(p,'语音房设置已保存，将在权限复核后应用。');return;
    }else{await this.host.commit([],key);return;}
    next.sequence=p.sequence;
    if(this.fresh()&&next.valid){
      for(const [user,channel]of Object.entries(next.presence))if(this.config.creatorChannelIds!.includes(channel)&&user!==this.botId){
        const indexKey='owner:'+channel+':'+user,index=await this.host.get(indexKey),prior=index&&object(index.value)&&typeof index.value.id==='string'?await this.host.get('room:'+index.value.id):null;
        if(prior&&room(prior).status!=='retired')continue;
        const id=hash(this.guildId+':'+channel+':'+user+':'+key);
        changes.push({key:'room:'+id,expectedVersion:null,value:asJSON({id,ownerId:user,creatorId:channel,status:'pending_create',limit:this.config.defaultLimit??4,locked:false,createdAt:this.host.now(),move:'pending'})},{key:indexKey,expectedVersion:index?.version??null,value:{id}});
      }
    }
    changes.push({key:'snapshot',expectedVersion:row?.version??null,value:asJSON(next)},{key:'receipt:'+key,expectedVersion:null,value:{at:this.host.now()}});await this.host.commit(changes,key);
  }
  private async inspect(signal:AbortSignal){
    const user=await this.api.request('GET','/users/@me',undefined,signal),app=await this.api.request('GET','/oauth2/applications/@me',undefined,signal),category=await this.api.request('GET','/channels/'+this.config.categoryId,undefined,signal);
    if(!object(user)||!snowflake(user.id)||!object(app)||!snowflake(app.id)||!object(category)||category.guild_id!==this.guildId||category.type!==4)throw new Error('PERMISSION_DENIED');
    this.botId=user.id;this.appId=app.id;
    for(const id of this.config.creatorChannelIds!){const c=await this.api.request('GET','/channels/'+id,undefined,signal);if(!object(c)||c.guild_id!==this.guildId||c.type!==2)throw new Error('PERMISSION_DENIED');}
    const member=await this.api.request('GET',`/guilds/${this.guildId}/members/${this.botId}`,undefined,signal),roles=await this.api.request('GET',`/guilds/${this.guildId}/roles`,undefined,signal);
    if(!object(member)||!Array.isArray(member.roles)||!Array.isArray(roles)||!Array.isArray(category.permission_overwrites))throw new Error('PERMISSION_DENIED');
    const bits=discordPermissions(this.guildId,this.botId,member.roles as string[],roles as Parameters<typeof discordPermissions>[3],category.permission_overwrites as Parameters<typeof discordPermissions>[4]);
    const required=16n|(1n<<24n)|(1n<<28n)|1024n|(1n<<20n);
    if((bits&required)!==required)throw new Error('PERMISSION_DENIED');this.checked=true;
  }
  private async retire(row:StateRow){const r=room(row),index=await this.host.get('owner:'+r.creatorId+':'+r.ownerId);await this.host.commit([{key:row.key,expectedVersion:row.version,value:asJSON({...r,status:'retired'})},...(index&&object(index.value)&&index.value.id===r.id?[{key:index.key,expectedVersion:index.version,value:{id:''}}]:[])]);}
  async tick(signal:AbortSignal){
    if(!this.config.allowWrites||!this.fresh()||!(await this.snapshot()).data.valid)return;
    signal=AbortSignal.any([signal,this.connectionController.signal]);
    if(await this.host.pending())return;
    if(!this.checked)await this.inspect(signal);
    const setup=await this.host.get('setup:command');
    if(setup&&object(setup.value))this.commandSetup=String(setup.value.status);
    if(!setup||object(setup.value)&&setup.value.status!=='ready'&&!(typeof setup.value.nextCheckAt==='string'&&setup.value.nextCheckAt>this.host.now())){
      const commands=await this.api.request('GET',`/applications/${this.appId}/guilds/${this.guildId}/commands`,undefined,signal);if(!Array.isArray(commands))throw new Error('INVALID_EVENT');
      if(commands.some(c=>object(c)&&c.name==='sa-voice')){await this.host.commit([{key:'setup:command',expectedVersion:setup?.version??null,value:{status:'ready'}}]);this.commandSetup='ready';}
      else if(setup){this.commandSetup='manual_review';await this.host.commit([{key:setup.key,expectedVersion:setup.version,value:{status:'manual_review',nextCheckAt:new Date(Date.parse(this.host.now())+60000).toISOString()}}]);}
      else{
        await this.host.commit([{key:'setup:command',expectedVersion:null,value:{status:'sending'}}]);this.commandSetup='sending';
        await this.api.request('POST',`/applications/${this.appId}/guilds/${this.guildId}/commands`,{name:'sa-voice',description:'托管临时语音房',options:[{type:3,name:'action',description:'操作',required:true,choices:['transfer','limit','lock','unlock'].map(name=>({name,value:name}))},{type:3,name:'room',description:'房间编号（默认当前房间）'},{type:6,name:'target',description:'新房主'},{type:4,name:'limit',description:'人数上限',min_value:1,max_value:99}]},signal);
        const current=await this.host.get('setup:command');if(current)await this.host.commit([{key:current.key,expectedVersion:current.version,value:{status:'ready'}}]);this.commandSetup='ready';
      }
    }
    for(const row of await this.host.list('room:')){
      if(!this.fresh())return;const r=room(row);if(r.status==='retired'||r.status==='blocked'||r.nextCheckAt&&r.nextCheckAt>this.host.now())continue;
      const {data:snapshot}=await this.snapshot();
      if(['pending_create','creating','unknown_create'].includes(r.status)){
        if(!this.config.creatorChannelIds!.includes(r.creatorId)){await this.save(row,{...r,status:'blocked',lastError:'DISCORD_VOICE_CREATOR_REMOVED'});continue;}
        const channels=await this.api.request('GET',`/guilds/${this.guildId}/channels`,undefined,signal);if(!Array.isArray(channels))throw new Error('INVALID_EVENT');
        const matches=channels.filter(c=>object(c)&&c.guild_id===this.guildId&&c.parent_id===this.config.categoryId&&c.type===2&&c.name===this.marker(r));
        if(matches.length>1){await this.save(row,{...r,status:'blocked',lastError:'DISCORD_DUPLICATE_MARKER'});continue;}
        let channel=matches[0];
        if(!channel){
          if(r.status!=='pending_create'){await this.save(row,{...r,status:'unknown_create',lastError:'DISCORD_CREATE_REQUIRES_RECONCILIATION',nextCheckAt:new Date(Date.parse(this.host.now())+60000).toISOString()});continue;}
          if(snapshot.presence[r.ownerId]!==r.creatorId||r.ownerId===this.botId){await this.retire(row);continue;}
          const creator=await this.api.request('GET','/channels/'+r.creatorId,undefined,signal);if(!object(creator)||!(await this.permissions(r.ownerId,creator,signal))){await this.save(row,{...r,status:'blocked',lastError:'DISCORD_VOICE_OWNER_PERMISSION'});continue;}
          if(await this.host.pending()||!this.fresh())return;
          await this.save(row,{...r,status:'creating'});
          try{channel=await this.api.request('POST',`/guilds/${this.guildId}/channels`,{name:this.marker(r),type:2,parent_id:this.config.categoryId,user_limit:r.limit,permission_overwrites:this.overwrites(r)},signal);}
          catch(error){const fresh=await this.host.get(row.key);if(fresh)await this.save(fresh,{...room(fresh),status:error instanceof Error&&error.message==='OUTCOME_UNKNOWN'?'unknown_create':'blocked',lastError:error instanceof Error?error.message:'DISCORD_CREATE_FAILED'});continue;}
        }
        if(!object(channel)||!snowflake(channel.id)||channel.guild_id!==this.guildId||channel.parent_id!==this.config.categoryId||channel.type!==2||channel.name!==this.marker(r))throw new Error('OUTCOME_UNKNOWN');
        const latest=await this.host.get(row.key);if(latest)await this.save(latest,{...room(latest),status:'active',channelId:channel.id});continue;
      }
      if(!r.channelId)continue;
      let channel:unknown;try{channel=await this.api.request('GET','/channels/'+r.channelId,undefined,signal);}catch(error){if(error instanceof Error&&error.message==='NOT_FOUND'){await this.retire(row);continue;}throw error;}
      if(!this.identity(channel,r)){await this.save(row,{...r,status:'blocked',lastError:'DISCORD_VOICE_CHANNEL_IDENTITY'});continue;}
      if(r.status==='deleting'||r.status==='unknown_delete'){await this.save(row,{...r,status:'blocked',lastError:'DISCORD_DELETE_REQUIRES_RECONCILIATION'});continue;}
      const occupants=Object.entries(snapshot.presence).filter(([,id])=>id===r.channelId).map(([id])=>id).sort();
      if(r.move==='pending'&&snapshot.presence[r.ownerId]===r.creatorId){
        if(await this.host.pending()||!this.fresh())return;
        await this.save(row,{...r,move:'moving'});try{await this.api.request('PATCH',`/guilds/${this.guildId}/members/${r.ownerId}`,{channel_id:r.channelId},signal);const fresh=await this.host.get(row.key);if(fresh)await this.save(fresh,{...room(fresh),move:'done'});}catch{const fresh=await this.host.get(row.key);if(fresh)await this.save(fresh,{...room(fresh),move:'unknown'});}continue;
      }
      if(occupants.length&&r.closingAt){const updated={...r};delete updated.closingAt;delete updated.emptySince;await this.api.request('PATCH','/channels/'+r.channelId,{user_limit:r.limit,permission_overwrites:this.overwrites(updated)},signal);await this.save(row,updated);continue;}
      if(occupants.length&&(!occupants.includes(r.ownerId)||!(await this.permissions(r.ownerId,channel,signal)))){
        let owner:string|undefined;for(const candidate of occupants)if(await this.permissions(candidate,channel,signal,r.locked)){owner=candidate;break;}
        if(owner){const old=await this.host.get('owner:'+r.creatorId+':'+r.ownerId),index=await this.host.get('owner:'+r.creatorId+':'+owner);
          await this.host.commit([{key:row.key,expectedVersion:row.version,value:asJSON({...r,ownerId:owner})},...(old&&object(old.value)&&old.value.id===r.id?[{key:old.key,expectedVersion:old.version,value:{id:''}}]:[]),...(!index||!object(index.value)||!index.value.id||index.value.id===r.id?[{key:'owner:'+r.creatorId+':'+owner,expectedVersion:index?.version??null,value:{id:r.id}}]:[])]);continue;}
      }
      const desired=hash(JSON.stringify({owner:r.ownerId,limit:r.limit,locked:r.locked,closing:!!r.closingAt}));
      const normalize=(items:unknown)=>Array.isArray(items)?items.filter(object).map(o=>({id:o.id,type:o.type,allow:String(o.allow),deny:String(o.deny)})).sort((a,b)=>String(a.id).localeCompare(String(b.id))):null;
      const actual=channel.user_limit===r.limit&&JSON.stringify(normalize(channel.permission_overwrites))===JSON.stringify(normalize(this.overwrites(r,!!r.closingAt)));
      if(!actual){await this.api.request('PATCH','/channels/'+r.channelId,{user_limit:r.limit,permission_overwrites:this.overwrites(r,!!r.closingAt)},signal);await this.save(row,{...r,applied:desired});continue;}
      if(occupants.length||this.config.cleanupEmptyRooms===false)continue;
      if(!r.emptySince){await this.save(row,{...r,emptySince:this.host.now()});continue;}
      if(Date.parse(this.host.now())-Date.parse(r.emptySince)<(this.config.emptyRoomMs??60000)||await this.host.pending())continue;
      if(!r.closingAt){await this.save(row,{...r,closingAt:this.host.now()});continue;}
      if(Date.parse(this.host.now())-Date.parse(r.closingAt)<1000||!this.fresh())continue;
      if(await this.host.pending())return;
      await this.save(row,{...r,status:'deleting'});
      try{await this.api.request('DELETE','/channels/'+r.channelId,undefined,signal);const latest=await this.host.get(row.key);if(latest)await this.retire(latest);}
      catch(error){const latest=await this.host.get(row.key);if(latest)await this.save(latest,{...room(latest),status:error instanceof Error&&error.message==='OUTCOME_UNKNOWN'?'unknown_delete':'blocked',lastError:error instanceof Error?error.message:'DISCORD_DELETE_FAILED'});}
    }
  }
}
