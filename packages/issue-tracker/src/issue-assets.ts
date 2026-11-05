import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {SqliteStore} from '@superagent/persistence';
import type {ArtifactStore} from '@superagent/plugin-host';
import type {AttachmentLinks} from '@superagent/domain';

export class IssueAssetError extends Error {constructor(readonly code:string,readonly outcome:'blocked'|'unknown'|'safe_retry'='unknown',readonly retryAfterMs=60000){super(code);}}
async function limitedJSON(response:Response):Promise<Record<string,unknown>>{
  if(!response.body)throw new IssueAssetError('GITHUB_ASSET_RESPONSE_UNKNOWN');const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw new IssueAssetError('GITHUB_ASSET_RESPONSE_LIMIT');parts.push(part.value);}const value:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export interface IssueAssetPort {readonly repository:string;canUpload?:(mimeType:string)=>boolean;inspect(signal?:AbortSignal):Promise<{private:boolean;repositoryId:string;canPush:boolean|null}>;upload(bytes:Buffer,mimeType:string,name:string,repositoryId:string,signal:AbortSignal):Promise<string>;verify(url:string,sha256:string,maxBytes:number,signal:AbortSignal):Promise<boolean>}
export function issueAssetURL(value:string):string{
  let url:URL;try{url=new URL(value);}catch{throw new IssueAssetError('GITHUB_ASSET_URL_INVALID','blocked');}
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/user-attachments\/(?:assets\/[a-f0-9-]{20,80}|files\/\d+\/[A-Za-z0-9._%-]+)$/i.test(url.pathname))throw new IssueAssetError('GITHUB_ASSET_URL_INVALID','blocked');return url.href;
}
/** Wire protocol used by official cli/cli internal/attachments. No browser cookies or repository-file commits. */
export class GitHubIssueAssets implements IssueAssetPort {
  readonly repository:string;private readonly fetcher:typeof fetch;
  constructor(private readonly options:{repository:string;token:string;session?:string;fetch?:typeof fetch;timeoutMs?:number}){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)||!options.token)throw new Error('GITHUB_ASSET_CONFIGURATION_REQUIRED');this.repository=options.repository;this.fetcher=options.fetch??fetch;
    if(options.session&&!/^[A-Za-z0-9_.%+/=-]{16,4096}$/.test(options.session))throw new Error('GITHUB_FILE_SESSION_INVALID');
  }
  canUpload(mimeType:string){return mimeType.startsWith('image/')||!!this.options.session;}
  async inspect(signal?:AbortSignal){
    const response=await this.fetcher(`https://api.github.com/repos/${this.repository}`,{headers:{Authorization:`Bearer ${this.options.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.options.timeoutMs??15000)])});
    if(!response.ok){await response.body?.cancel();throw new IssueAssetError('GITHUB_ASSET_REPOSITORY_UNAVAILABLE',[400,401,403,404,422].includes(response.status)?'blocked':'safe_retry');}
    const data=await limitedJSON(response) as {private?:boolean;id?:number;permissions?:{push?:boolean;admin?:boolean;maintain?:boolean}};if(!Number.isSafeInteger(data.id)||Number(data.id)<1)throw new IssueAssetError('GITHUB_ASSET_REPOSITORY_INVALID','blocked');
    return{private:data.private===true,repositoryId:String(data.id),canPush:data.permissions?data.permissions.push===true||data.permissions.admin===true||data.permissions.maintain===true:null};
  }
  async upload(bytes:Buffer,mimeType:string,name:string,repositoryId:string,signal:AbortSignal):Promise<string>{
    if(!/^\d+$/.test(repositoryId)||!/^artifact-[a-f0-9]{64}\.(?:png|jpg|webp|txt|pdf|zip|dmp)$/.test(name)||!['image/png','image/jpeg','image/webp','text/plain','application/pdf','application/zip','application/octet-stream'].includes(mimeType))throw new IssueAssetError('GITHUB_ASSET_INPUT_INVALID','blocked');
    if(!mimeType.startsWith('image/'))return this.uploadFile(bytes,mimeType,name,repositoryId,signal);
    const url=new URL('https://uploads.github.com/user-attachments/assets');url.searchParams.set('repository_id',repositoryId);url.searchParams.set('name',name);url.searchParams.set('content_type',mimeType);
    let response:Response;try{response=await this.fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs??15000)]),headers:{Authorization:`Bearer ${this.options.token}`,Accept:'application/vnd.github+json','Content-Type':'application/octet-stream','Content-Length':String(bytes.length)},body:new Uint8Array(bytes)});}catch{throw new IssueAssetError('GITHUB_ASSET_UPLOAD_UNKNOWN');}
    if(!response.ok){const wait=Number(response.headers.get('retry-after')??'60')*1000;await response.body?.cancel();if(response.status===429&&(!Number.isFinite(wait)||wait>86400000))throw new IssueAssetError('GITHUB_ASSET_RATE_LIMIT_REQUIRES_REVIEW','blocked');throw new IssueAssetError(`GITHUB_ASSET_HTTP_${response.status}`,response.status===429?'safe_retry':[400,401,403,404,422].includes(response.status)?'blocked':'unknown',Math.max(60000,wait));}
    try{const value=await limitedJSON(response);if(typeof value.url!=='string')throw new Error();return issueAssetURL(value.url);}catch{throw new IssueAssetError('GITHUB_ASSET_RESPONSE_UNKNOWN');}
  }
  private webCookie='';
  private async web(url:string,init:RequestInit,signal:AbortSignal){
    if(!this.options.session)throw new IssueAssetError('GITHUB_FILE_SESSION_REQUIRED','blocked');
    if(new URL(url).origin!=='https://github.com')throw new IssueAssetError('GITHUB_FILE_ORIGIN_INVALID','blocked');
    const response=await this.fetcher(url,{...init,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs??15000)]),headers:{Accept:'application/json',Origin:'https://github.com',Referer:`https://github.com/${this.repository}`,'X-Requested-With':'XMLHttpRequest',Cookie:`user_session=${this.options.session}; __Host-user_session_same_site=${this.options.session}${this.webCookie?`; _gh_sess=${this.webCookie}`:''}`,...init.headers}});
    for(const value of response.headers.getSetCookie())if(/^_gh_sess=([^;\r\n]+);/.test(value))this.webCookie=value.match(/^_gh_sess=([^;\r\n]+);/)![1]!;
    if(!response.ok){await response.body?.cancel();throw new IssueAssetError(`GITHUB_FILE_HTTP_${response.status}`,[301,302,303,307,308,400,401,403,404,422].includes(response.status)?'blocked':'unknown');}return response;
  }
  private async uploadFile(bytes:Buffer,mime:string,name:string,repositoryId:string,signal:AbortSignal):Promise<string>{
    if(!this.options.session)throw new IssueAssetError('GITHUB_FILE_SESSION_REQUIRED','blocked');
    const page=await this.web(`https://github.com/${this.repository}`,{headers:{Accept:'text/html'}},signal);let html='';
    if(!page.body)throw new IssueAssetError('GITHUB_FILE_SESSION_INVALID','blocked');const reader=page.body.getReader();
    try{for(;;){const part=await reader.read();if(part.done)break;html+=Buffer.from(part.value).toString('utf8');if(Buffer.byteLength(html)>2097152)throw new IssueAssetError('GITHUB_FILE_PAGE_LIMIT','blocked');}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const match=html.match(/"uploadToken"\s*:\s*"([^"\\]{1,16384})"/);if(!match)throw new IssueAssetError('GITHUB_FILE_SESSION_EXPIRED','blocked');
    const request=new FormData();for(const [key,value]of Object.entries({name,size:String(bytes.length),content_type:mime,repository_id:repositoryId,authenticity_token:match[1]!}))request.set(key,value);
    const policy=await limitedJSON(await this.web('https://github.com/upload/policies/assets',{method:'POST',body:request},signal));
    const asset=policy.asset as Record<string,unknown>|undefined,fields=policy.form as Record<string,unknown>|undefined,upload=typeof policy.upload_url==='string'?new URL(policy.upload_url):null;
    const allowedHosts=['github-production-user-asset-6210df.s3.amazonaws.com','github-production-repository-file-5c1aeb.s3.amazonaws.com'];
    const storageAllowed=upload&&(allowedHosts.includes(upload.hostname)&&upload.pathname==='/'||upload.hostname==='objects-origin.githubusercontent.com'&&['/github-production-repository-file-5c1aeb','/github-production-user-asset-6210df'].includes(upload.pathname));
    if(!asset||!fields||!upload||upload.protocol!=='https:'||upload.username||upload.password||upload.port||upload.search||upload.hash||!storageAllowed||fields.acl!=='private'||asset.size!==bytes.length||asset.content_type!==mime||fields['Content-Type']!==mime||typeof asset.href!=='string'||typeof asset.id!=='number'||!Number.isSafeInteger(asset.id)||asset.id<1||policy.asset_upload_url!==`/upload/repository-files/${asset.id}`||typeof policy.asset_upload_authenticity_token!=='string'||Object.keys(fields).length>32||Object.values(fields).some(v=>typeof v!=='string'||v.length>16384))throw new IssueAssetError('GITHUB_FILE_POLICY_INVALID','blocked');
    const finalURL=issueAssetURL(asset.href);if(!new URL(finalURL).pathname.startsWith(`/user-attachments/files/${asset.id}/`))throw new IssueAssetError('GITHUB_FILE_POLICY_INVALID','blocked');
    const form=new FormData();for(const [key,value]of Object.entries(fields))form.append(key,value as string);form.append('file',new Blob([new Uint8Array(bytes)],{type:mime}),name);
    let sent:Response;try{sent=await this.fetcher(upload,{method:'POST',body:form,redirect:'error',signal,headers:{Origin:'https://github.com'}});}catch{throw new IssueAssetError('GITHUB_FILE_UPLOAD_UNKNOWN');}await sent.body?.cancel();if(!sent.ok)throw new IssueAssetError(`GITHUB_FILE_STORAGE_HTTP_${sent.status}`);
    const finalize=new FormData();finalize.set('authenticity_token',policy.asset_upload_authenticity_token);const result=await limitedJSON(await this.web(`https://github.com${policy.asset_upload_url}`,{method:'PUT',body:finalize},signal));
    if(result.href!==finalURL)throw new IssueAssetError('GITHUB_FILE_FINALIZE_UNKNOWN');return finalURL;
  }
  private async read(url:string,authorized:boolean,maxBytes:number,signal:AbortSignal):Promise<Buffer|null>{
    let current=issueAssetURL(url);
    for(let redirects=0;redirects<4;redirects++){
      const parsed=new URL(current),response=await this.fetcher(current,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs??15000)]),headers:authorized&&parsed.hostname==='github.com'?{Authorization:`Bearer ${this.options.token}`,...(this.options.session&&parsed.pathname.startsWith('/user-attachments/files/')?{Cookie:`user_session=${this.options.session}; __Host-user_session_same_site=${this.options.session}`}:{})}:{}});
      if([401,403,404].includes(response.status)){await response.body?.cancel();return null;}
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new IssueAssetError('GITHUB_ASSET_REDIRECT_INVALID','blocked');
        const next=new URL(location,current);if(!authorized&&next.origin==='https://github.com'&&next.pathname==='/login')return null;if(next.protocol!=='https:'||next.username||next.password||next.port||next.hash||!(next.hostname==='github.com'&&next.pathname.startsWith('/user-attachments/')||next.hostname.endsWith('.githubusercontent.com')||['github-production-user-asset-6210df.s3.amazonaws.com','github-production-repository-file-5c1aeb.s3.amazonaws.com'].includes(next.hostname)))throw new IssueAssetError('GITHUB_ASSET_REDIRECT_INVALID','blocked');current=next.href;continue;
      }
      if(!response.ok||!response.body){await response.body?.cancel();throw new IssueAssetError('GITHUB_ASSET_READ_UNAVAILABLE');}
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes)throw new IssueAssetError('GITHUB_ASSET_READ_LIMIT','blocked');parts.push(part.value);}return Buffer.concat(parts);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }
    throw new IssueAssetError('GITHUB_ASSET_REDIRECT_LIMIT','blocked');
  }
  async verify(url:string,sha256:string,maxBytes:number,signal:AbortSignal):Promise<boolean>{
    const authenticated=await this.read(url,true,maxBytes,signal);if(!authenticated||createHash('sha256').update(authenticated).digest('hex')!==sha256)throw new IssueAssetError('GITHUB_ASSET_HASH_OR_AUTH_MISMATCH','blocked');
    if(await this.read(url,false,maxBytes,signal)!==null)throw new IssueAssetError('GITHUB_ASSET_NOT_PRIVATE','blocked');return true;
  }
}

export function installIssueAssets(store:SqliteStore):void{
  const sql=readFileSync(new URL('../migrations/issue-assets-v1.sql',import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
  store.transaction(()=>{store.exec('CREATE TABLE IF NOT EXISTS github_output_feature_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');const old=store.get<{sha256:string}>('SELECT sha256 FROM github_output_feature_migrations WHERE name=?','issue-assets-v1');if(old){if(old.sha256!==hash)throw new Error('GITHUB_OUTPUT_MIGRATION_HISTORY_MISMATCH');return;}store.exec(sql);store.run('INSERT INTO github_output_feature_migrations VALUES(?,?)','issue-assets-v1',hash);});
}
interface Publication {artifact_id:string;project_id:string;repository:string;repository_id:string|null;state:string;attempt:number;verify_attempt:number;asset_url:string|null;sha256:string;source_event_id:string;mime_type:string;size:number}
async function bound<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let off=()=>{};const aborted=new Promise<never>((_,reject)=>{const abort=()=>reject(new IssueAssetError('GITHUB_ASSET_ABORTED'));off=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});});try{return await Promise.race([Promise.resolve().then(work),aborted]);}finally{off();}
}
export class ArtifactPublisher {
  constructor(readonly store:SqliteStore,readonly artifacts:ArtifactStore,readonly port:IssueAssetPort,private readonly options:{links:AttachmentLinks;allowWrites?:boolean;authorize:(projectId:string)=>void;clock?:()=>string;onChanged?:(eventId:string)=>void;timeoutMs?:number}){installIssueAssets(store);}
  private now(){return(this.options.clock??(()=>new Date().toISOString()))();}
  private authorize(project:string){try{this.options.authorize(project);}catch{throw new IssueAssetError('GITHUB_ASSET_ACTOR_NOT_AUTHORIZED','blocked');}}
  private eligible(id:string):boolean{const row=this.store.get<{project_id:string;source_event_id:string;asset_ref:string}>(`SELECT a.* FROM artifacts a JOIN attachment_links e ON e.event_id=a.source_event_id AND e.asset_ref=a.asset_ref AND e.status='confirmed' JOIN feedback_items f ON f.feedback_item_id=e.feedback_item_id JOIN work_feedback_links l USING(feedback_item_id) JOIN work_metadata m ON m.work_kind=l.work_kind AND m.work_id=l.work_id AND m.project_id=a.project_id JOIN github_sync_outbox g ON g.work_kind=l.work_kind AND g.work_id=l.work_id AND g.repository=? WHERE a.artifact_id=? AND a.state='stored' AND f.active=1 AND m.review_required=0 AND g.state<>'held'`,this.port.repository,id);return !!row&&this.options.links.confirmed(row.project_id,row.source_event_id,row.asset_ref);}
  private changed(row:Publication){this.options.onChanged?.(row.source_event_id);}
  async tick(signal:AbortSignal):Promise<{processed:boolean;state?:string}>{
    signal.throwIfAborted();this.store.run("UPDATE artifact_publications SET state=CASE WHEN asset_url IS NULL THEN 'unknown' ELSE 'uploaded' END,error_code='GITHUB_ASSET_SEND_WINDOW_EXPIRED',lease_token=NULL,lease_until=NULL WHERE repository=? AND state='in_flight' AND lease_until<=?",this.port.repository,this.now());
    if(!this.options.allowWrites)return{processed:false,state:'write_disabled'};
    const project=this.store.get<{project_id:string}>('SELECT project_id FROM artifacts LIMIT 1')?.project_id;if(project)this.options.links.refresh(project);
    const candidates=this.store.all<{artifact_id:string;project_id:string;sha256:string}>(`SELECT DISTINCT a.artifact_id,a.project_id,a.sha256 FROM artifacts a JOIN attachment_links e ON e.event_id=a.source_event_id AND e.asset_ref=a.asset_ref AND e.status='confirmed' JOIN feedback_items f ON f.feedback_item_id=e.feedback_item_id JOIN work_feedback_links l USING(feedback_item_id) JOIN github_sync_outbox g ON g.work_kind=l.work_kind AND g.work_id=l.work_id AND g.repository=? WHERE a.state='stored' AND f.active=1 AND NOT EXISTS(SELECT 1 FROM artifact_publications p WHERE p.artifact_id=a.artifact_id AND p.repository=?) LIMIT 20`,this.port.repository,this.port.repository);
    for(const a of candidates)if(this.eligible(a.artifact_id))this.store.run("INSERT INTO artifact_publications(artifact_id,project_id,repository,state,sha256,next_attempt_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT DO NOTHING",a.artifact_id,a.project_id,this.port.repository,a.sha256,this.now());
    const row=this.store.get<Publication>(`SELECT p.*,a.source_event_id,a.mime_type,a.size FROM artifact_publications p JOIN artifacts a USING(artifact_id) WHERE p.repository=? AND p.state IN ('pending','safe_retry','uploaded','waiting_configuration') AND p.next_attempt_at<=? ORDER BY p.next_attempt_at,p.artifact_id LIMIT 1`,this.port.repository,this.now());if(!row)return{processed:false};
    const last=this.store.get<{attempt_at:string|null}>('SELECT max(attempt_at) attempt_at FROM artifact_publications WHERE repository=?',this.port.repository)?.attempt_at;
    if(!row.asset_url&&last&&Date.parse(this.now())-Date.parse(last)<15000)return{processed:false,state:'rate_limited'};
    if(!this.eligible(row.artifact_id)){this.store.run("UPDATE artifact_publications SET state='blocked',error_code='GITHUB_ASSET_SOURCE_NOT_AUTHORIZED' WHERE artifact_id=? AND repository=?",row.artifact_id,row.repository);this.changed(row);return{processed:true,state:'blocked'};}
    if(!row.asset_url&&this.port.canUpload?.(row.mime_type)===false){this.store.run("UPDATE artifact_publications SET state='waiting_configuration',error_code='GITHUB_FILE_SESSION_REQUIRED',next_attempt_at=? WHERE artifact_id=? AND repository=?",new Date(Date.parse(this.now())+60000).toISOString(),row.artifact_id,row.repository);if(row.state!=='waiting_configuration')this.changed(row);return{processed:false,state:'waiting_configuration'};}
    const token=randomUUID(),timeout=this.options.timeoutMs??20000;
    const claimed=this.store.transaction(()=>{if(this.store.get("SELECT 1 FROM artifact_publications WHERE repository=? AND state='in_flight' AND lease_until>?",row.repository,this.now()))return false;return !!this.store.run("UPDATE artifact_publications SET state='in_flight',lease_token=?,lease_until=? WHERE artifact_id=? AND repository=? AND state=?",token,new Date(Date.parse(this.now())+timeout+30000).toISOString(),row.artifact_id,row.repository,row.state).changes;});if(!claimed)return{processed:false};
    let dispatched=false;const deadline=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);
    try{
      this.authorize(row.project_id);const info=await bound(()=>this.port.inspect(deadline),deadline);deadline.throwIfAborted();if(!info.private||info.canPush===false)throw new IssueAssetError('GITHUB_ASSET_PRIVATE_WRITE_REQUIRED','blocked');if(row.repository_id&&row.repository_id!==info.repositoryId)throw new IssueAssetError('GITHUB_ASSET_REPOSITORY_CHANGED','blocked');
      this.store.run('UPDATE artifact_publications SET repository_id=? WHERE artifact_id=? AND repository=? AND lease_token=?',info.repositoryId,row.artifact_id,row.repository,token);
      if(!row.asset_url){
        if(row.attempt>=3)throw new IssueAssetError('GITHUB_ASSET_RETRY_BUDGET','blocked');let file;try{file=this.artifacts.read(row.project_id,row.artifact_id,()=>this.authorize(row.project_id));}catch{throw new IssueAssetError('GITHUB_ASSET_LOCAL_READ_DENIED','blocked');}if(file.sha256!==row.sha256)throw new IssueAssetError('GITHUB_ASSET_LOCAL_HASH_CHANGED','blocked');
        this.authorize(row.project_id);if(!this.eligible(row.artifact_id))throw new IssueAssetError('GITHUB_ASSET_SOURCE_NOT_AUTHORIZED','blocked');
        this.store.run('UPDATE artifact_publications SET attempt=attempt+1,attempt_at=? WHERE artifact_id=? AND repository=? AND lease_token=?',this.now(),row.artifact_id,row.repository,token);dispatched=true;
        const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','application/pdf':'pdf','application/zip':'zip','application/octet-stream':'dmp'} as Record<string,string>)[file.mimeType]??'txt';
        row.asset_url=issueAssetURL(await bound(()=>this.port.upload(file.bytes,file.mimeType,`${row.artifact_id}.${ext}`,info.repositoryId,deadline),deadline));
        this.store.run('UPDATE artifact_publications SET asset_url=? WHERE artifact_id=? AND repository=? AND lease_token=?',row.asset_url,row.artifact_id,row.repository,token);
      }
      if(row.verify_attempt>=3)throw new IssueAssetError('GITHUB_ASSET_VERIFY_BUDGET','blocked');
      this.store.run('UPDATE artifact_publications SET verify_attempt=verify_attempt+1 WHERE artifact_id=? AND repository=? AND lease_token=?',row.artifact_id,row.repository,token);
      if(!await bound(()=>this.port.verify(row.asset_url!,row.sha256,row.size,deadline),deadline))throw new IssueAssetError('GITHUB_ASSET_NOT_VERIFIED','blocked');this.authorize(row.project_id);if(!this.eligible(row.artifact_id))throw new IssueAssetError('GITHUB_ASSET_SOURCE_NOT_AUTHORIZED','blocked');
      this.store.transaction(()=>{const changed=this.store.run("UPDATE artifact_publications SET state='published',error_code=NULL,lease_token=NULL,lease_until=NULL WHERE artifact_id=? AND repository=? AND lease_token=? AND lease_until>?",row.artifact_id,row.repository,token,this.now());if(changed.changes)this.changed(row);});return{processed:true,state:'published'};
    }catch(error){
      const persisted=this.store.get<{asset_url:string|null}>('SELECT asset_url FROM artifact_publications WHERE artifact_id=? AND repository=?',row.artifact_id,row.repository)?.asset_url;
      const outcome=error instanceof IssueAssetError?error.outcome:'unknown',state=outcome==='blocked'?'blocked':persisted?'uploaded':!dispatched?'pending':outcome==='safe_retry'&&row.attempt<2?'safe_retry':'unknown';
      this.store.run('UPDATE artifact_publications SET state=?,error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE artifact_id=? AND repository=? AND lease_token=?',state,error instanceof IssueAssetError?error.code:'GITHUB_ASSET_UNKNOWN',new Date(Date.parse(this.now())+Math.max(60000,error instanceof IssueAssetError?error.retryAfterMs:60000)).toISOString(),row.artifact_id,row.repository,token);this.changed(row);return{processed:true,state};
    }
  }
  attachment(projectId:string,eventId:string,assetRef:string):{state:string;url?:string;sha256?:string;size?:number;mimeType?:string}|undefined{
    const a=this.store.get<{artifact_id:string;state:string;sha256:string|null;size:number|null;mime_type:string}>('SELECT * FROM artifacts WHERE project_id=? AND source_event_id=? AND asset_ref=?',projectId,eventId,assetRef);if(!a)return;
    const p=this.store.get<{state:string;asset_url:string|null}>('SELECT state,asset_url FROM artifact_publications WHERE artifact_id=? AND repository=?',a.artifact_id,this.port.repository);
    return{state:p?.state==='blocked'?'unavailable':p?.state??a.state,...(p?.state==='published'&&p.asset_url?{url:issueAssetURL(p.asset_url)}:{}),...(a.sha256?{sha256:a.sha256}:{}),...(a.size!==null?{size:a.size}:{}),mimeType:a.mime_type};
  }
}
