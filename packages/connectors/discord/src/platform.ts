import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorCapabilityV1, SourcePluginHostV1, SourcePluginV1 } from '@superagent/plugin-sdk';
import { DiscordConnector,discordConfigSchema } from './source.js';
import type { DiscordConfig,DiscordOptions } from './source.js';
import { DiscordTickets } from './tickets.js';
import type { DiscordTicketConfig } from './tickets.js';
import { DiscordVoice } from './voice.js';
import type { DiscordVoiceConfig } from './voice.js';
import type { DiscordDispatch } from './transport.js';
import { safeCode,object,snowflake } from './module-types.js';
import type { DiscordBusinessModule,DiscordModulePort } from './module-types.js';
export interface DiscordPlatformConfig extends DiscordConfig {tickets?:DiscordTicketConfig;voice?:DiscordVoiceConfig}
export interface DiscordModuleRuntime {port:DiscordModulePort;receive(p:DiscordDispatch):void;next():{key:string;packet:DiscordDispatch}|null;fail(key:string,code:string,permanent?:boolean):void;revoke():void}
export const discordPlatformSchema={...discordConfigSchema,properties:{...discordConfigSchema.properties,tickets:{type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'},allowWrites:{type:'boolean'},projectId:{type:'string',minLength:1},categoryId:{type:'string',pattern:'^[0-9]+$'},staffRoleIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',pattern:'^[0-9]+$'}}}},voice:{type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'},allowWrites:{type:'boolean'},categoryId:{type:'string',pattern:'^[0-9]+$'},creatorChannelIds:{type:'array',minItems:1,maxItems:16,uniqueItems:true,items:{type:'string',pattern:'^[0-9]+$'}},emptyRoomMs:{type:'integer',minimum:1000,maximum:86400000},defaultLimit:{type:'integer',minimum:1,maximum:99},cleanupEmptyRooms:{type:'boolean'}}}}};
/** One supervised platform instance and Gateway; independently cancellable business modules. */
export class DiscordPlatform implements SourcePluginV1 {
  readonly manifest;readonly source:DiscordConnector;
  private runtimes:Record<string,DiscordModuleRuntime>={};private modules:Record<string,DiscordBusinessModule>={};
  private states:Record<string,{state:string;lastError:string|null;retryAt:number}>={};
  private controller=new AbortController();private workers:Promise<void>[]=[];
  private connected=false;
  constructor(readonly config:DiscordPlatformConfig,options:DiscordOptions={}){
    const {tickets,voice,...source}=config;
    if(tickets&&(typeof tickets.enabled!=='boolean'||Object.keys(tickets).some(k=>!['enabled','allowWrites','projectId','categoryId','staffRoleIds'].includes(k))))throw new Error('INVALID_CONFIG');
    if(tickets?.enabled&&(!tickets.projectId||!snowflake(tickets.categoryId)||!Array.isArray(tickets.staffRoleIds)||!tickets.staffRoleIds.length||tickets.staffRoleIds.some(id=>!snowflake(id)||id===config.guildId)))throw new Error('INVALID_CONFIG');
    if(voice&&(typeof voice.enabled!=='boolean'||Object.keys(voice).some(k=>!['enabled','allowWrites','categoryId','creatorChannelIds','emptyRoomMs','defaultLimit','cleanupEmptyRooms'].includes(k))))throw new Error('INVALID_CONFIG');
    if(voice?.enabled&&(!snowflake(voice.categoryId)||!Array.isArray(voice.creatorChannelIds)||!voice.creatorChannelIds.length||voice.creatorChannelIds.some(id=>!snowflake(id))))throw new Error('INVALID_CONFIG');
    if(tickets?.enabled&&voice?.enabled&&tickets.categoryId===voice.categoryId)throw new Error('INVALID_CONFIG');
    this.source=new DiscordConnector(source,{...options,additionalIntents:(options.additionalIntents??0)|(tickets?.enabled?512|32768:0)|(voice?.enabled?128:0),
      excludeChannel:async(id,parent)=>parent===tickets?.categoryId||!!(await options.excludeChannel?.(id,parent))||!!(this.runtimes.tickets&&(await this.runtimes.tickets.port.list('ticket:')).some(r=>object(r.value)&&r.value.channelId===id)),
      onDispatch:async(p,signal)=>{for(const [name,module] of Object.entries(this.modules))if(await module.owns(p))this.runtimes[name]!.receive(module.sanitize?await module.sanitize(p):p);await options.onDispatch?.(p,signal);},
      onImmediate:async p=>{for(const module of Object.values(this.modules))if(await module.owns(p))await module.acknowledge(p);await options.onImmediate?.(p);},
      onConnection:connected=>{this.connected=connected;for(const module of Object.values(this.modules))if(connected)module.heartbeat?.();else module.disconnect?.();options.onConnection?.(connected);},
    });
    this.manifest={...this.source.manifest,configSchema:discordPlatformSchema};
  }
  bindModules(runtimes:Record<string,DiscordModuleRuntime>){
    this.runtimes=runtimes;
    if(this.config.tickets?.enabled){if(!runtimes.tickets)throw new Error('DISCORD_MODULE_HOST_REQUIRED');this.modules.tickets=new DiscordTickets(this.config.guildId,this.config.tickets,runtimes.tickets.port,this.source.api);this.states.tickets={state:'configured',lastError:null,retryAt:0};}
    if(this.config.voice?.enabled){if(!runtimes.voice)throw new Error('DISCORD_MODULE_HOST_REQUIRED');this.modules.voice=new DiscordVoice(this.config.guildId,this.config.voice,runtimes.voice.port,this.source.api,()=>this.connected);this.states.voice={state:'configured',lastError:null,retryAt:0};}
  }
  moduleStatus(){return Object.fromEntries(Object.entries(this.states).map(([name,state])=>[name,{...structuredClone(state),...this.modules[name]?.diagnostics?.()}]));}
  probe():Promise<ConnectorCapabilityV1>{return this.source.probe();}
  sync(host:SourcePluginHostV1,signal:AbortSignal){return this.source.sync(host,signal);}
  async start(host:SourcePluginHostV1,signal:AbortSignal):Promise<void>{
    if(this.config.tickets?.enabled&&!this.modules.tickets)throw new Error('DISCORD_MODULE_HOST_REQUIRED');
    if(this.config.voice?.enabled&&!this.modules.voice)throw new Error('DISCORD_MODULE_HOST_REQUIRED');
    const combined=AbortSignal.any([signal,this.controller.signal]);
    await this.source.prepare(host);
    this.workers=Object.entries(this.modules).map(async([name,module])=>{
      const state=this.states[name]!,runtime=this.runtimes[name]!;
      try{while(!combined.aborted){
        for(let n=0;n<20;n++){const next=runtime.next();if(!next)break;
          const confirmed=module.diagnostics?.().occupancy==='confirmed';
          try{await module.handle(next.packet,combined);if(!confirmed&&module.diagnostics?.().occupancy==='confirmed'&&state.state!=='blocked'&&state.state!=='retry_wait')state.retryAt=0;}catch(error){if(combined.aborted)break;const code=safeCode(error);runtime.fail(next.key,code,/^(DISCORD_(?:TICKET|VOICE)_(?:FORBIDDEN|NOT_FOUND|INPUT_INVALID|STATE_CONFLICT)|PERMISSION_DENIED|UNAUTHORIZED|INVALID_EVENT)$/.test(code));if(next.packet.type!=='INTERACTION_CREATE')module.disconnect?.();state.lastError=code;try{await module.reject?.(next.packet,code);}catch{/* An uncertain ephemeral reply is never replayed. */}}
        }
        if(Date.now()>=state.retryAt&&state.state!=='blocked')try{await module.tick(combined);state.state='running';state.lastError=null;state.retryAt=Date.now()+5000;}catch(error){if(combined.aborted)break;const code=safeCode(error);state.state=/^(PERMISSION_DENIED|UNAUTHORIZED|DISCORD_TICKET_CATEGORY_NOT_PRIVATE|INVALID_CONFIG)$/.test(code)?'blocked':'retry_wait';state.lastError=code;state.retryAt=Date.now()+30000;}
        await delay(250,undefined,{signal:combined});
      }}catch(error){if(!combined.aborted){state.state='failed';state.lastError=safeCode(error);}}
    });
    try{await this.source.start(host,combined);}finally{this.controller.abort();await Promise.allSettled(this.workers);}
  }
  async stop(){this.controller.abort();for(const m of Object.values(this.modules))m.stop();for(const r of Object.values(this.runtimes))r.revoke();await this.source.stop();await Promise.allSettled(this.workers);}
}
