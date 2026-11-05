import {createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,realpathSync,lstatSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {SqliteStore,stableId,canonicalJSON} from '@superagent/persistence';
import type {NormalizedEventV1} from '@superagent/contracts';

export interface ArtifactCaptureRequest {projectId:string;sourceId:string;sourceUri:string;externalEventId:string;assetRef:string;url:string;mimeType:string;filename:string;ordinal:number}
export interface StoredArtifact {artifactId:string;projectId:string;sourceEventId:string|null;assetRef:string;state:string;sha256:string|null;mimeType:string;size:number|null;errorCode:string|null}
interface Row {artifact_id:string;project_id:string;source_id:string;source_uri:string;external_event_id:string;source_event_id:string|null;asset_ref:string;mime_type:string;state:string;sha256:string|null;size:number|null;storage_key:string|null;ticket_cipher:string|null;ticket_expires_at:string;attempt:number;lease_token:string|null;lease_until:string|null}
export class ArtifactError extends Error {constructor(readonly code:string,readonly retryable=false){super(code);}}
const digest=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const hosts=new Set(['multimedia.nt.qq.com.cn','gchat.qpic.cn','c2cpicdw.qpic.cn']);
export function validateArtifactURL(input:string):URL{
  if(input.length>8192)throw new ArtifactError('ARTIFACT_URL_INVALID');
  let url:URL;try{url=new URL(input);}catch{throw new ArtifactError('ARTIFACT_URL_INVALID');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||!hosts.has(url.hostname)||isIP(url.hostname))throw new ArtifactError('ARTIFACT_URL_NOT_ALLOWED');return url;
}
export function publicArtifactAddress(address:string):boolean{
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0||b===2)||a===100&&b!>=64&&b!<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a!>=224);}
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0):/i.test(address);
}
/** Resolve once, reject private/reserved addresses, then pin that address to TLS. No redirects or credentials. */
export async function downloadArtifact(url:URL,maxBytes:number,signal:AbortSignal,transport:{resolve?:(host:string)=>Promise<{address:string;family:number}[]>;request?:typeof httpsRequest}={}):Promise<Buffer>{
  validateArtifactURL(url.href);
  const addresses=await Promise.race([(transport.resolve??(host=>lookup(host,{all:true})))(url.hostname),new Promise<never>((_,reject)=>{if(signal.aborted)reject(new ArtifactError('ARTIFACT_ABORTED',true));else signal.addEventListener('abort',()=>reject(new ArtifactError('ARTIFACT_ABORTED',true)),{once:true});})]);
  signal.throwIfAborted();if(!addresses.length||addresses.some(a=>!publicArtifactAddress(a.address)))throw new ArtifactError('ARTIFACT_ADDRESS_NOT_PUBLIC');
  const address=addresses[0]!;
  return new Promise((resolve,reject)=>{
    const req=(transport.request??httpsRequest)(url,{signal,family:address.family,headers:{Accept:'application/octet-stream'},lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)},res=>{
      if(res.statusCode!==200){res.destroy();reject(new ArtifactError(`ARTIFACT_HTTP_${res.statusCode}`,res.statusCode===429||Number(res.statusCode)>=500));return;}
      if(Number(res.headers['content-length'])>maxBytes){res.destroy();reject(new ArtifactError('ARTIFACT_TOO_LARGE'));return;}
      const chunks:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(new ArtifactError('ARTIFACT_TOO_LARGE'));}else chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(new ArtifactError('ARTIFACT_NETWORK',true)));
    });req.on('error',()=>reject(new ArtifactError('ARTIFACT_NETWORK',true)));req.end();
  });
}
export function artifactType(bytes:Buffer,declared:string,filename:string):string{
  let type:string|undefined;
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.subarray(12,16).toString()==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0)type='image/png';
  else if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)type='image/jpeg';
  else if(bytes.length>=20&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.subarray(12,16).toString())&&bytes.readUInt32LE(4)===bytes.length-8)type='image/webp';
  else if(/\.(?:txt|log|json)$/i.test(filename)){
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ArtifactError('ARTIFACT_TYPE_REJECTED');}
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||/^\s*<(?:!doctype|html|script|svg)/i.test(text))throw new ArtifactError('ARTIFACT_TYPE_REJECTED');type='text/plain';
  }
  if(!type||!bytes.length||declared.startsWith('image/')&&type!==declared)throw new ArtifactError('ARTIFACT_TYPE_REJECTED');return type;
}
const view=(r:Row):StoredArtifact=>({artifactId:r.artifact_id,projectId:r.project_id,sourceEventId:r.source_event_id,assetRef:r.asset_ref,state:r.state,sha256:r.sha256,mimeType:r.mime_type,size:r.size,errorCode:(r as Row&{error_code:string|null}).error_code});

/** Private Host capability, outside frozen Source/Delivery APIs. Raw signed URLs are encrypted tickets only. */
export class ArtifactStore {
  private readonly root:string;private readonly key:Buffer;
  constructor(readonly store:SqliteStore,private readonly options:{root:string;key:Buffer;clock?:()=>string;assertOwner?:()=>void;maxBytes?:number;maxFilesPerMessage?:number;maxTotalBytes?:number;ticketTtlMs?:number;timeoutMs?:number;download?:(url:URL,maxBytes:number,signal:AbortSignal)=>Promise<Buffer>;onChanged?:(eventId:string)=>void}){
    if(options.key.length!==32)throw new Error('ARTIFACT_KEY_REQUIRED');this.key=Buffer.from(options.key);mkdirSync(options.root,{recursive:true,mode:0o700});this.root=realpathSync(options.root);
    const sql=readFileSync(new URL('../migrations/artifacts-v1.sql',import.meta.url),'utf8'),hash=digest(sql);
    store.transaction(()=>{
      store.exec('CREATE TABLE IF NOT EXISTS artifact_feature_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');const old=store.get<{sha256:string}>('SELECT sha256 FROM artifact_feature_migrations WHERE name=?','artifacts-v1');
      if(old&&old.sha256!==hash)throw new Error('ARTIFACT_MIGRATION_HISTORY_MISMATCH');if(!old){store.exec(sql);store.run('INSERT INTO artifact_feature_migrations VALUES(?,?)','artifacts-v1',hash);}
      const binding=store.get<{root_hash:string;key_hash:string}>('SELECT * FROM artifact_store_binding WHERE id=1');if(binding&&(binding.root_hash!==digest(this.root)||binding.key_hash!==digest(this.key)))throw new Error('ARTIFACT_STORE_BINDING_CHANGED');
      if(!binding)store.run('INSERT INTO artifact_store_binding VALUES(1,?,?)',digest(this.root),digest(this.key));
    });
  }
  private now(){return (this.options.clock??(()=>new Date().toISOString()))();}
  private seal(bytes:Buffer,aad:string):Buffer{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);}
  private open(bytes:Buffer,aad:string):Buffer{if(bytes.length<28)throw new Error('ARTIFACT_INTEGRITY');const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);}
  private file(key:string):string{if(!/^artifact-[a-f0-9]{64}\.bin$/.test(key)||realpathSync(this.root)!==this.root)throw new Error('ARTIFACT_PATH_REJECTED');const target=path.join(this.root,key);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error('ARTIFACT_PATH_REJECTED');return target;}
  /** Stage before the immutable Host commit; downloading cannot occur until that exact event is archived. */
  stage(request:ArtifactCaptureRequest):void{
    this.options.assertOwner?.();const binding=this.store.get('SELECT 1 FROM sources WHERE source_id=? AND project_id=? AND source_uri=? AND platform=?',request.sourceId,request.projectId,request.sourceUri,'qq-official');
    if(!binding||!request.externalEventId||request.externalEventId.length>512||!request.assetRef||request.assetRef.length>512)throw new Error('ARTIFACT_SOURCE_NOT_AUTHORIZED');
    const id=stableId('artifact',request.projectId,request.sourceUri,request.externalEventId,request.assetRef);if(this.store.get('SELECT 1 FROM artifacts WHERE artifact_id=?',id))return;
    if(this.store.get<{n:number}>('SELECT count(*) n FROM artifacts WHERE project_id=?',request.projectId)!.n>=10000)return;
    let code:string|null=null;try{validateArtifactURL(request.url);if(request.ordinal>=(this.options.maxFilesPerMessage??5))throw new ArtifactError('ARTIFACT_FILE_COUNT_LIMIT');if(!Number.isInteger(request.ordinal)||request.ordinal<0)throw new ArtifactError('ARTIFACT_ORDINAL_INVALID');if(this.store.get<{n:number}>("SELECT count(*) n FROM artifacts WHERE state IN ('pending','capturing')")!.n>=100)throw new ArtifactError('ARTIFACT_QUEUE_FULL');}catch(e){code=e instanceof ArtifactError?e.code:'ARTIFACT_URL_INVALID';}
    const ticket=code?null:this.seal(Buffer.from(JSON.stringify({url:request.url,filename:request.filename.slice(0,255)})),`ticket:${id}`).toString('base64');
    this.store.run('INSERT INTO artifacts(artifact_id,project_id,source_id,source_uri,external_event_id,asset_ref,mime_type,state,ticket_cipher,ticket_expires_at,created_at,next_attempt_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,request.projectId,request.sourceId,request.sourceUri,request.externalEventId,request.assetRef,request.mimeType.slice(0,100),code?'rejected':'pending',ticket,new Date(Date.parse(this.now())+(this.options.ticketTtlMs??120000)).toISOString(),this.now(),this.now(),code);
  }
  private bind(row:Row):boolean{
    const event=this.store.get<{event_id:string;payload_json:string}>('SELECT event_id,payload_json FROM source_events WHERE project_id=? AND source_id=? AND source_uri=? AND external_event_id=?',row.project_id,row.source_id,row.source_uri,row.external_event_id);if(!event)return false;
    const value=JSON.parse(event.payload_json) as NormalizedEventV1;
    if(value.type!=='com.superagent.feedback.message.created.v1'||!value.data.content?.attachments?.some(a=>a.assetRef===row.asset_ref))throw new ArtifactError('ARTIFACT_SOURCE_MISMATCH');
    const changed=row.source_event_id!==event.event_id;row.source_event_id=event.event_id;this.store.run('UPDATE artifacts SET source_event_id=? WHERE artifact_id=?',event.event_id,row.artifact_id);if(changed)this.options.onChanged?.(event.event_id);return true;
  }
  private visible(row:Row):boolean{return !!row.source_event_id&&!!this.store.get('SELECT 1 FROM source_objects WHERE event_id=? AND deleted=0',row.source_event_id);}
  private saved(row:Row):Buffer{if(!row.storage_key||!row.sha256)throw new Error('ARTIFACT_NOT_STORED');const bytes=this.open(readFileSync(this.file(row.storage_key)),`content:${row.artifact_id}`);if(digest(bytes)!==row.sha256||bytes.length!==row.size)throw new Error('ARTIFACT_INTEGRITY');return bytes;}
  private finish(id:string,state:string,code:string|null=null,token?:string){const result=this.store.run('UPDATE artifacts SET state=?,error_code=?,ticket_cipher=NULL,lease_token=NULL,lease_until=NULL,captured_at=CASE WHEN ?=\'stored\' THEN ? ELSE captured_at END WHERE artifact_id=?'+(token?' AND lease_token=?':''),state,code,state,this.now(),id,...(token?[token]:[]));if(result.changes){const row=this.store.get<{source_event_id:string|null}>('SELECT source_event_id FROM artifacts WHERE artifact_id=?',id);if(row?.source_event_id)this.options.onChanged?.(row.source_event_id);}}
  async tick(signal:AbortSignal):Promise<{processed:boolean;state?:string}>{
    this.options.assertOwner?.();signal.throwIfAborted();
    const bindings=this.store.all<Row>(`SELECT a.* FROM artifacts a JOIN source_events e ON e.project_id=a.project_id AND e.source_id=a.source_id AND e.source_uri=a.source_uri AND e.external_event_id=a.external_event_id WHERE a.source_event_id IS NULL AND coalesce(a.error_code,'')<>'ARTIFACT_SOURCE_MISMATCH' LIMIT 100`);
    for(const row of bindings)try{this.bind(row);}catch{this.finish(row.artifact_id,'rejected','ARTIFACT_SOURCE_MISMATCH');}
    const expired=this.store.all<Row>("SELECT * FROM artifacts WHERE state='capturing' AND lease_until<=?",this.now());
    for(const row of expired){try{if(row.storage_key){this.saved(row);this.finish(row.artifact_id,'stored');continue;}}catch{/* An incomplete file never becomes stored. */}this.store.run("UPDATE artifacts SET state='pending',lease_token=NULL,lease_until=NULL WHERE artifact_id=?",row.artifact_id);}
    for(const row of this.store.all<Row>("SELECT * FROM artifacts WHERE state='pending' AND ticket_expires_at<=? LIMIT 100",this.now()))this.finish(row.artifact_id,'unavailable','ARTIFACT_URL_EXPIRED');
    const row=this.store.get<Row>("SELECT * FROM artifacts WHERE state='pending' AND source_event_id IS NOT NULL AND next_attempt_at<=? ORDER BY created_at,artifact_id LIMIT 1",this.now());if(!row)return{processed:false};
    if(row.attempt>=3){this.finish(row.artifact_id,'unavailable','ARTIFACT_RETRY_BUDGET');return{processed:true,state:'unavailable'};}
    try{if(!this.bind(row))return{processed:false};if(!this.visible(row)){this.finish(row.artifact_id,'unavailable','ARTIFACT_SOURCE_NOT_VISIBLE');return{processed:true,state:'unavailable'};}}catch(e){this.finish(row.artifact_id,'rejected',e instanceof ArtifactError?e.code:'ARTIFACT_SOURCE_INVALID');return{processed:true,state:'rejected'};}
    const token=randomUUID(),timeout=this.options.timeoutMs??10000;
    const changed=this.store.transaction(()=>{if(this.store.get("SELECT 1 FROM artifacts WHERE state='capturing' AND lease_until>?",this.now()))return 0;return Number(this.store.run("UPDATE artifacts SET state='capturing',attempt=attempt+1,lease_token=?,lease_until=? WHERE artifact_id=? AND state='pending'",token,new Date(Date.parse(this.now())+timeout+30000).toISOString(),row.artifact_id).changes);});if(!changed)return{processed:false};
    try{
      const ticket=JSON.parse(this.open(Buffer.from(row.ticket_cipher!,'base64'),`ticket:${row.artifact_id}`).toString()) as {url:string;filename:string};
      const deadline=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);
      let remove=()=>{};const aborted=new Promise<never>((_,reject)=>{const abort=()=>reject(new ArtifactError('ARTIFACT_ABORTED',true));remove=()=>deadline.removeEventListener('abort',abort);if(deadline.aborted)abort();else deadline.addEventListener('abort',abort,{once:true});});
      let bytes:Buffer;try{bytes=await Promise.race([Promise.resolve().then(()=>(this.options.download??downloadArtifact)(validateArtifactURL(ticket.url),this.options.maxBytes??5*1024*1024,deadline)),aborted]);}finally{remove();}
      signal.throwIfAborted();this.options.assertOwner?.();if(bytes.length>(this.options.maxBytes??5*1024*1024))throw new ArtifactError('ARTIFACT_TOO_LARGE');const mime=artifactType(bytes,row.mime_type,ticket.filename);
      if(!this.store.get('SELECT 1 FROM artifacts WHERE artifact_id=? AND lease_token=? AND lease_until>?',row.artifact_id,token,this.now()))throw new ArtifactError('ARTIFACT_LEASE_LOST');if(!this.visible(row))throw new ArtifactError('ARTIFACT_SOURCE_NOT_VISIBLE');
      const used=this.store.get<{n:number}>('SELECT coalesce(sum(size),0) n FROM artifacts WHERE project_id=? AND state IN (\'stored\',\'capturing\')',row.project_id)!.n;if(used+bytes.length>(this.options.maxTotalBytes??100*1024*1024))throw new ArtifactError('ARTIFACT_STORAGE_LIMIT');
      const key=`${row.artifact_id}.bin`,target=this.file(key),temp=target+`.${randomUUID()}.tmp`;
      this.store.run('UPDATE artifacts SET sha256=?,size=?,storage_key=?,mime_type=? WHERE artifact_id=? AND lease_token=?',digest(bytes),bytes.length,key,mime,row.artifact_id,token);
      try{writeFileSync(temp,this.seal(bytes,`content:${row.artifact_id}`),{flag:'wx',mode:0o600});renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}
      this.finish(row.artifact_id,'stored',null,token);return{processed:true,state:'stored'};
    }catch(e){
      const retry=(signal.aborted||e instanceof ArtifactError&&e.retryable)&&row.attempt+1<3&&row.ticket_expires_at>this.now();
      if(retry)this.store.run("UPDATE artifacts SET state='pending',error_code=?,lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE artifact_id=? AND lease_token=?",e instanceof ArtifactError?e.code:'ARTIFACT_ABORTED',new Date(Date.parse(this.now())+5000*2**row.attempt).toISOString(),row.artifact_id,token);
      else this.finish(row.artifact_id,'unavailable',e instanceof ArtifactError?e.code:'ARTIFACT_CAPTURE_FAILED',token);return{processed:true,state:retry?'pending':'unavailable'};
    }
  }
  list(projectId:string,eventId:string,authorize:()=>void):StoredArtifact[]{authorize();return this.store.all<Row>('SELECT * FROM artifacts WHERE project_id=? AND source_event_id=? ORDER BY artifact_id',projectId,eventId).filter(r=>this.visible(r)).map(view);}
  read(projectId:string,artifactId:string,authorize:()=>void):{bytes:Buffer;mimeType:string;sha256:string}{authorize();const row=this.store.get<Row>("SELECT * FROM artifacts WHERE artifact_id=? AND project_id=? AND state='stored'",artifactId,projectId);if(!row||!this.visible(row))throw new Error('ARTIFACT_NOT_FOUND');const bytes=this.saved(row);authorize();return{bytes,mimeType:row.mime_type,sha256:row.sha256!};}
}
