import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SqliteStore, addMilliseconds, canonicalJSON, systemClock, timestamp } from '@superagent/persistence';
import type { Clock } from '@superagent/persistence';
import type { JSONValue } from '@superagent/contracts';
export const hash = (value:string):string => createHash('sha256').update(value).digest('hex');
export interface Principal { actorRef:string; role:'reader'|'developer'; projects:readonly string[] }
export class ControlError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}
export class OperatorAuth {
  constructor(readonly store:SqliteStore,private readonly clock:Clock=systemClock){}
  private now():string{return timestamp(this.clock());}
  register(principal:Principal,accessKey:string):void{
    if(accessKey.length<32||!principal.actorRef||!['reader','developer'].includes(principal.role)||!principal.projects.length||principal.projects.some(p=>!this.store.get('SELECT 1 FROM projects WHERE project_id=?',p)))throw new ControlError('INVALID_OPERATOR_CONFIG');
    this.store.transaction(()=>{
      const old=this.store.get<{access_hash:string}>('SELECT access_hash FROM operator_accounts WHERE actor_ref=?',principal.actorRef),accessHash=hash(accessKey);
      this.store.run('INSERT INTO operator_accounts VALUES(?,?,?,?,1) ON CONFLICT(actor_ref) DO UPDATE SET access_hash=excluded.access_hash,role=excluded.role,projects_json=excluded.projects_json,enabled=1',principal.actorRef,accessHash,principal.role,JSON.stringify(principal.projects));
      if(old&&old.access_hash!==accessHash)this.store.run('DELETE FROM operator_sessions WHERE actor_ref=?',principal.actorRef);
    });
  }
  principal(actorRef:string):Principal{
    const row=this.store.get<{actor_ref:string;role:Principal['role'];projects_json:string}>('SELECT * FROM operator_accounts WHERE actor_ref=? AND enabled=1',actorRef);if(!row)throw new ControlError('UNAUTHORIZED',401);
    return{actorRef:row.actor_ref,role:row.role,projects:JSON.parse(row.projects_json) as string[]};
  }
  authorize(principal:Principal,projectId:string,write=false):Principal{
    const current=this.principal(principal.actorRef);if(!current.projects.includes(projectId)||write&&current.role!=='developer')throw new ControlError('FORBIDDEN',403);return current;
  }
  login(key:string):{session:string;csrf:string;principal:Principal}{
    if(typeof key!=='string'||key.length>512)throw new ControlError('UNAUTHORIZED',401);
    const row=this.store.get<{actor_ref:string}>('SELECT actor_ref FROM operator_accounts WHERE access_hash=? AND enabled=1',hash(key));if(!row)throw new ControlError('UNAUTHORIZED',401);
    const session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    this.store.run('DELETE FROM operator_sessions WHERE expires_at<=?',this.now());
    this.store.run('INSERT INTO operator_sessions VALUES(?,?,?,?)',hash(session),row.actor_ref,hash(csrf),addMilliseconds(this.now(),8*3_600_000));return{session,csrf,principal:this.principal(row.actor_ref)};
  }
  session(token:string,csrf?:string):Principal{
    const row=this.store.get<{actor_ref:string;csrf_hash:string}>('SELECT actor_ref,csrf_hash FROM operator_sessions WHERE session_hash=? AND expires_at>?',hash(token),this.now());if(!row)throw new ControlError('UNAUTHORIZED',401);
    if(csrf!==undefined&&hash(csrf)!==row.csrf_hash)throw new ControlError('CSRF_INVALID',403);return this.principal(row.actor_ref);
  }
  logout(token:string):void{this.store.run('DELETE FROM operator_sessions WHERE session_hash=?',hash(token));}
}
export class TokenService {
  constructor(readonly store:SqliteStore,private readonly signingKey:string,private readonly clock:Clock=systemClock){if(signingKey.length<32)throw new ControlError('CURSOR_KEY_REQUIRED');}
  private now():string{return timestamp(this.clock());}
  issue(principal:Principal,projectId:string,purpose:string,payload:JSONValue,options:{ttlMs?:number;stableKey?:string}={}):string{
    const token=options.stableKey?createHmac('sha256',this.signingKey).update(JSON.stringify([principal.actorRef,projectId,purpose,options.stableKey,payload])).digest('base64url'):randomBytes(32).toString('base64url');
    const body=canonicalJSON(payload);const old=this.store.get<{payload_json:string;expires_at:string}>('SELECT payload_json,expires_at FROM operator_tokens WHERE token_hash=?',hash(token));
    if(old){if(old.payload_json!==body)throw new ControlError('TOKEN_IDENTITY_CONFLICT');return token;}
    this.store.run('INSERT INTO operator_tokens VALUES(?,?,?,?,?,?,NULL)',hash(token),principal.actorRef,projectId,purpose,body,addMilliseconds(this.now(),options.ttlMs??15*60_000));return token;
  }
  read(principal:Principal,projectId:string,purpose:string,token:string,consume=false):JSONValue{
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ControlError('TOKEN_INVALID',403);
    const row=this.store.get<{payload_json:string;consumed_at:string|null;expires_at:string}>('SELECT * FROM operator_tokens WHERE token_hash=? AND actor_ref=? AND project_id=? AND purpose=?',hash(token),principal.actorRef,projectId,purpose);
    if(!row||row.expires_at<=this.now()||row.consumed_at)throw new ControlError('TOKEN_EXPIRED_OR_USED',403);
    if(consume){const changed=this.store.run('UPDATE operator_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL',this.now(),hash(token));if(!changed.changes)throw new ControlError('TOKEN_EXPIRED_OR_USED',403);}
    return JSON.parse(row.payload_json) as JSONValue;
  }
  cursor(principal:Principal,scope:JSONValue,offset:number):string{
    const body=Buffer.from(JSON.stringify({actor:principal.actorRef,scope,offset,expires:Date.parse(this.now())+7*24*3_600_000})).toString('base64url');return body+'.'+createHmac('sha256',this.signingKey).update(body).digest('base64url');
  }
  offset(principal:Principal,scope:JSONValue,cursor?:string):number{
    if(!cursor)return 0;if(cursor.length>2048)throw new ControlError('CURSOR_INVALID',403);const [body,sig,...extra]=cursor.split('.');if(!body||!sig||extra.length)throw new ControlError('CURSOR_INVALID',403);
    const expected=createHmac('sha256',this.signingKey).update(body).digest();const actual=Buffer.from(sig,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new ControlError('CURSOR_INVALID',403);
    let data:{actor:string;scope:JSONValue;offset:number;expires:number};try{data=JSON.parse(Buffer.from(body,'base64url').toString()) as typeof data;}catch{throw new ControlError('CURSOR_INVALID',403);}
    if(data.actor!==principal.actorRef||canonicalJSON(data.scope)!==canonicalJSON(scope)||!Number.isSafeInteger(data.offset)||data.offset<0||data.expires<Date.parse(this.now()))throw new ControlError('CURSOR_SCOPE_INVALID',403);return data.offset;
  }
}
