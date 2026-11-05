import type { JSONValue, NormalizedEventV1 } from '@superagent/plugin-sdk';
import type { DiscordDispatch } from './transport.js';
export interface StateRow {key:string;version:number;value:JSONValue}
export interface StateChange {key:string;expectedVersion:number|null;value:JSONValue}
export interface DiscordModulePort {
  scope:{projectId:string;sourceId:string;sourceUri:string};
  get(key:string):Promise<StateRow|null>;list(prefix:string):Promise<StateRow[]>;
  commit(changes:readonly StateChange[],packetKey?:string):Promise<void>;
  submit(key:string,event:NormalizedEventV1,initial:JSONValue):Promise<StateRow>;
  archive(key:string,event:NormalizedEventV1,channel:string):Promise<void>;
  event(id:string):Promise<NormalizedEventV1|null>;now():string;
  current(externalId:string):Promise<NormalizedEventV1|null>;pending():Promise<boolean>;
}
export const packetKey=(p:DiscordDispatch)=>p.type==='INTERACTION_CREATE'&&typeof p.data.id==='string'?`interaction:${p.data.id}`:`gateway:${p.sessionId}:${p.sequence}`;
export const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const snowflake=(v:unknown):v is string=>typeof v==='string'&&/^\d{1,22}$/.test(v);
export const asJSON=(v:unknown)=>v as JSONValue;
export const safeCode=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'DISCORD_MODULE_FAILED';
export interface DiscordBusinessModule { owns(packet:DiscordDispatch):Promise<boolean>;acknowledge(packet:DiscordDispatch):Promise<void>;handle(packet:DiscordDispatch,signal:AbortSignal):Promise<void>;tick(signal:AbortSignal):Promise<void>;stop():void;sanitize?(packet:DiscordDispatch):Promise<DiscordDispatch>;disconnect?():void;heartbeat?():void;diagnostics?():Record<string,unknown>;reject?(packet:DiscordDispatch,code:string):Promise<void> }
