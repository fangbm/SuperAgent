import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJSON, systemClock, timestamp, stableId, addMilliseconds } from '@superagent/persistence';
import type { Clock, SqliteStore } from '@superagent/persistence';
import type { CommitResultV1, JSONValue, NormalizedEventV1 } from '@superagent/contracts';

export interface DiscordStateRow {key:string;version:number;value:JSONValue}
export interface DiscordStateChange {key:string;expectedVersion:number|null;value:JSONValue}
export interface DiscordModuleBinding {namespace:string;kind:'tickets'|'voice';guildId:string;projectId:string;publicProjectId:string;sourceId:string;sourceUri:string}
interface Packet {type:string;data:Record<string,JSONValue>;sequence:number;sessionId:string;receivedAt:string}
const json=(v:unknown)=>canonicalJSON(v as JSONValue);
export const discordPacketKey=(p:Packet)=>p.type==='INTERACTION_CREATE'&&typeof p.data.id==='string'?`interaction:${p.data.id}`:`gateway:${p.sessionId}:${p.sequence}`;
export function installDiscordState(store:SqliteStore):void{
  const sql=readFileSync(new URL('../migrations/discord-state-v1.sql',import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
  store.transaction(()=>{
    store.exec('CREATE TABLE IF NOT EXISTS discord_feature_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');
    const old=store.get<{sha256:string}>('SELECT sha256 FROM discord_feature_migrations WHERE name=?','discord-state-v1');
    if(old){if(old.sha256!==hash)throw new Error('DISCORD_MIGRATION_HISTORY_MISMATCH');return;}
    store.exec(sql);store.run('INSERT INTO discord_feature_migrations VALUES(?,?)','discord-state-v1',hash);
  });
}
/** Host-private capability. The plugin only receives port(), never SQLite or Ingress. */
export class DiscordModuleHost {
  private open=true;
  constructor(readonly store:SqliteStore,readonly binding:DiscordModuleBinding,private readonly options:{clock?:Clock;assertOwner:()=>void;commit?:(events:readonly NormalizedEventV1[])=>CommitResultV1;getEvent?:(id:string)=>NormalizedEventV1|undefined}){
    installDiscordState(store);
    if(!binding.namespace||!/^\d+$/.test(binding.guildId)||binding.kind==='tickets'&&binding.projectId===binding.publicProjectId)throw new Error('INVALID_DISCORD_MODULE_BINDING');
    const hash=stableId('discord-binding',json(binding));
    store.transaction(()=>{
      const prior=store.get<{binding_hash:string}>('SELECT binding_hash FROM discord_modules WHERE namespace=?',binding.namespace);
      if(prior&&prior.binding_hash!==hash)throw new Error('DISCORD_MODULE_BINDING_CHANGED');
      if(!prior)store.run('INSERT INTO discord_modules VALUES(?,?,?,?,?,?,?,?)',binding.namespace,binding.kind,binding.guildId,binding.projectId,binding.sourceId,binding.sourceUri,binding.publicProjectId,hash);
      if(binding.kind==='tickets'){
        if(store.get('SELECT 1 FROM source_events WHERE project_id=?',binding.projectId)&&!store.get('SELECT 1 FROM restricted_projects WHERE project_id=?',binding.projectId))throw new Error('DISCORD_PRIVATE_PROJECT_NOT_EMPTY');
        const restricted=store.get<{owner_project_id:string}>('SELECT owner_project_id FROM restricted_projects WHERE project_id=?',binding.projectId);
        if(restricted&&restricted.owner_project_id!==binding.publicProjectId)throw new Error('DISCORD_PRIVATE_PROJECT_CONFLICT');
        store.run("INSERT INTO restricted_projects VALUES(?,?,'discord_staff_tickets') ON CONFLICT DO NOTHING",binding.projectId,binding.publicProjectId);
      }
    });
  }
  private assert(){if(!this.open)throw new Error('DISCORD_MODULE_HOST_CLOSED');this.options.assertOwner();}
  private now(){return timestamp((this.options.clock??systemClock)());}
  revoke(){this.open=false;}
  get(key:string):DiscordStateRow|null{
    this.assert();const row=this.store.get<{version:number;value_json:string}>('SELECT version,value_json FROM discord_module_state WHERE namespace=? AND state_key=?',this.binding.namespace,key);
    return row?{key,version:row.version,value:JSON.parse(row.value_json) as JSONValue}:null;
  }
  list(prefix:string):DiscordStateRow[]{this.assert();return this.store.all<{state_key:string;version:number;value_json:string}>('SELECT * FROM discord_module_state WHERE namespace=? AND substr(state_key,1,length(?))=? ORDER BY state_key',this.binding.namespace,prefix,prefix).map(r=>({key:r.state_key,version:r.version,value:JSON.parse(r.value_json) as JSONValue}));}
  commit(changes:readonly DiscordStateChange[],packetKey?:string):void{
    this.assert();this.store.transaction(()=>{
      for(const c of changes){if(!c.key||c.key.length>300)throw new Error('DISCORD_STATE_KEY_INVALID');const prior=this.get(c.key);if((prior?.version??null)!==c.expectedVersion)throw new Error('DISCORD_STATE_CONFLICT');
        this.store.run('INSERT INTO discord_module_state VALUES(?,?,?,?,?) ON CONFLICT(namespace,state_key) DO UPDATE SET version=excluded.version,value_json=excluded.value_json,updated_at=excluded.updated_at',this.binding.namespace,c.key,(prior?.version??0)+1,json(c.value),this.now());}
      if(packetKey)this.store.run("UPDATE discord_module_inbox SET status='completed',error_code=NULL WHERE namespace=? AND event_id=?",this.binding.namespace,packetKey);
    });
  }
  receive(packet:Packet):void{
    this.assert();
    const p=structuredClone(packet);delete p.data.token;
    const key=discordPacketKey(p);
    this.store.transaction(()=>{
      const prior=this.store.get<{payload_json:string}>('SELECT payload_json FROM discord_module_inbox WHERE namespace=? AND event_id=?',this.binding.namespace,key);
      // Interaction IDs are the identity across Gateway replay/session replacement.
      if(prior){if(p.type==='INTERACTION_CREATE'&&json((JSON.parse(prior.payload_json) as Packet).data)!==json(p.data))throw new Error('DISCORD_INTERACTION_ID_CONFLICT');return;}
      this.store.run("INSERT INTO discord_module_inbox(namespace,event_id,sequence,payload_json,retry_at,created_at) VALUES(?,?,?,?,?,?)",this.binding.namespace,key,p.sequence,json(p),this.now(),this.now());
    });
  }
  next():{key:string;packet:Packet}|null{this.assert();const r=this.store.get<{event_id:string;payload_json:string}>("SELECT * FROM discord_module_inbox WHERE namespace=? AND status='pending' AND retry_at<=? ORDER BY rowid LIMIT 1",this.binding.namespace,this.now());return r?{key:r.event_id,packet:JSON.parse(r.payload_json) as Packet}:null;}
  fail(key:string,code:string,permanent=false):void{this.assert();this.store.transaction(()=>{
    const row=this.store.get<{payload_json:string}>("SELECT payload_json FROM discord_module_inbox WHERE namespace=? AND event_id=? AND status='pending'",this.binding.namespace,key);
    this.store.run("UPDATE discord_module_inbox SET attempt=attempt+1,status=CASE WHEN ? OR attempt>=4 THEN 'failed' ELSE 'pending' END,retry_at=?,error_code=? WHERE namespace=? AND event_id=? AND status='pending'",permanent?1:0,addMilliseconds(this.now(),30000),/^[A-Z0-9_]{1,100}$/.test(code)?code:'DISCORD_MODULE_FAILED',this.binding.namespace,key);
    if(row&&this.binding.kind==='voice'&&['VOICE_STATE_UPDATE','GUILD_CREATE','READY','RESUMED'].includes((JSON.parse(row.payload_json) as Packet).type))this.store.run("UPDATE discord_module_state SET value_json=json_set(value_json,'$.valid',json('false')),version=version+1,updated_at=? WHERE namespace=? AND state_key='snapshot'",this.now(),this.binding.namespace);
  });}
  ownsChannel(id:string):boolean{return this.list('ticket:').some(r=>typeof r.value==='object'&&r.value!==null&&!Array.isArray(r.value)&&r.value.channelId===id);}
  submit(packetKey:string,event:NormalizedEventV1,initial:JSONValue):DiscordStateRow{
    this.assert();if(this.binding.kind!=='tickets'||!this.options.commit||!this.options.getEvent||event.data.projectId!==this.binding.projectId||event.data.sourceId!==this.binding.sourceId||event.source!==this.binding.sourceUri||event.type!=='com.superagent.feedback.message.created.v1')throw new Error('DISCORD_TICKET_ARCHIVE_SCOPE');
    if(!initial||typeof initial!=='object'||Array.isArray(initial)||typeof initial.id!=='string'||typeof initial.userId!=='string'||!['bug','suggestion','help'].includes(String(initial.kind))||initial.status!=='pending_create'||event.data.actor?.opaqueId!==initial.userId)throw new Error('DISCORD_TICKET_INITIAL_STATE_INVALID');
    return this.store.transaction(()=>{
      const receipt=this.get('receipt:'+packetKey);
      if(receipt){this.options.commit!([event]);const id=(receipt.value as {ticketId:string}).ticketId;return this.get('ticket:'+id)!;}
      const indexKey='open:'+initial.userId+':'+initial.kind,index=this.get(indexKey),existing=index?this.get('ticket:'+String((index.value as {id:string}).id)):null;
      const prior=existing&&(existing.value as {status:string}).status!=='deleted'&&(existing.value as {status:string}).status!=='closed'?existing:null;
      const archived=this.options.commit!([event]),eventId=archived.refs[0]!.eventId;
      const id=prior?String((prior.value as {id:string}).id):String(initial.id),key='ticket:'+id;
      const old=this.get(key);const value=prior?prior.value:{...initial,evidenceEventId:eventId};
      this.commit([{key,expectedVersion:old?.version??null,value},{key:indexKey,expectedVersion:index?.version??null,value:{id}},
        {key:'receipt:'+packetKey,expectedVersion:null,value:{ticketId:id,eventId}},
        {key:'history:'+id+':'+packetKey,expectedVersion:null,value:{action:'submitted',actor:String(initial.userId),eventId,at:this.now()}}],packetKey);
      return this.get(key)!;
    });
  }
  archive(packetKey:string,event:NormalizedEventV1,channelId:string):void{
    this.assert();if(!this.options.commit||!this.ownsChannel(channelId)||event.data.projectId!==this.binding.projectId||event.data.sourceId!==this.binding.sourceId||event.source!==this.binding.sourceUri)throw new Error('DISCORD_TICKET_ARCHIVE_SCOPE');
    this.store.transaction(()=>{const prior=this.get('archived:'+packetKey);if(!prior){const receipt=this.options.commit!([event]);this.commit([{key:'archived:'+packetKey,expectedVersion:null,value:{eventId:receipt.refs[0]!.eventId}}],packetKey);}else this.commit([],packetKey);});
  }
  port(){return Object.freeze({scope:{projectId:this.binding.projectId,sourceId:this.binding.sourceId,sourceUri:this.binding.sourceUri},get:async(key:string)=>this.get(key),list:async(prefix:string)=>this.list(prefix),commit:async(changes:readonly DiscordStateChange[],key?:string)=>this.commit(changes,key),
    submit:async(key:string,event:NormalizedEventV1,initial:JSONValue)=>this.submit(key,event,initial),archive:async(key:string,event:NormalizedEventV1,channel:string)=>this.archive(key,event,channel),
    event:async(id:string)=>{this.assert();const event=this.options.getEvent?.(id);return event?.data.projectId===this.binding.projectId&&event.data.sourceId===this.binding.sourceId?event:null;},
    current:async(externalId:string)=>{this.assert();const r=this.store.get<{payload_json:string}>('SELECT e.payload_json FROM source_objects o JOIN source_events e USING(event_id) WHERE o.source_id=? AND o.external_id=? AND e.project_id=?',this.binding.sourceId,externalId,this.binding.projectId);return r?JSON.parse(r.payload_json) as NormalizedEventV1:null;},
    pending:async()=>{this.assert();return Boolean(this.store.get("SELECT 1 FROM discord_module_inbox WHERE namespace=? AND status='pending' LIMIT 1",this.binding.namespace));},now:()=>this.now()});}
}
