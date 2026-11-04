import { setTimeout as delay } from 'node:timers/promises';
import type { JSONValue } from '@superagent/plugin-sdk';

export interface DiscordDispatch {type:string;data:Record<string,JSONValue>;sequence:number;sessionId:string;receivedAt:string}
export type DiscordMethod='GET'|'POST'|'PUT'|'PATCH'|'DELETE';
export interface DiscordAPI {request(method:DiscordMethod,route:string,body?:unknown,signal?:AbortSignal):Promise<unknown>}
/** One serialized REST budget can be shared by Source and the optional business modules. */
export class DiscordREST implements DiscordAPI {
  private tail:Promise<unknown>=Promise.resolve();
  private retryAt=0;
  constructor(private readonly token:()=>Promise<string>,private readonly options:{fetch?:typeof fetch;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;onFailure?:(code:string)=>Promise<void>}={}){}
  request(method:DiscordMethod,route:string,body?:unknown,signal:AbortSignal=new AbortController().signal):Promise<unknown>{
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(method)||!route.startsWith('/')||route.startsWith('//')||/[\\#\r\n]/.test(route)||route.includes('..'))return Promise.reject(new Error('INVALID_REQUEST'));
    const result=this.tail.then(()=>this.execute(method,route,body,signal));this.tail=result.catch(()=>{});return result;
  }
  private async execute(method:DiscordMethod,route:string,body:unknown,signal:AbortSignal):Promise<unknown>{
    const pause=this.options.sleep??(async(ms:number,s:AbortSignal)=>{await delay(ms,undefined,{signal:s});});
    for(let attempt=0;;attempt++){
      signal.throwIfAborted();let remaining=Math.max(0,this.retryAt-Date.now());while(remaining>0){const chunk=Math.min(60000,remaining);await pause(chunk,signal);remaining-=chunk;}this.retryAt=0;
      let response:Response;
      try{response=await (this.options.fetch??fetch)('https://discord.com/api/v10'+route,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{Authorization:'Bot '+await this.token(),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
      catch{if(method!=='GET')throw new Error('OUTCOME_UNKNOWN');signal.throwIfAborted();await this.options.onFailure?.('TRANSIENT_NETWORK');if(attempt>=3)throw new Error('TRANSIENT_NETWORK');await pause(1000*2**attempt,signal);continue;}
      if(response.status===429){
        const data:unknown=await response.json().catch(()=>null);
        const retry=typeof data==='object'&&data!==null&&'retry_after' in data?Number(data.retry_after):Number(response.headers.get('retry-after'));
        const waitMs=Math.max(1000,Number.isFinite(retry)&&retry>=0?Math.min(retry*1000,86400000):1000*2**attempt);
        this.retryAt=Date.now()+waitMs;
        await this.options.onFailure?.('RATE_LIMITED');if(attempt>=3)throw new Error('RATE_LIMITED');
        let remaining=waitMs;while(remaining>0){const chunk=Math.min(60000,remaining);await pause(chunk,signal);remaining-=chunk;}this.retryAt=0;continue;
      }
      if(response.status>=500){await response.body?.cancel();if(method!=='GET')throw new Error('OUTCOME_UNKNOWN');await this.options.onFailure?.('PLATFORM_UNAVAILABLE');if(attempt>=3)throw new Error('PLATFORM_UNAVAILABLE');await pause(1000*2**attempt,signal);continue;}
      if(!response.ok){await response.body?.cancel();throw new Error(response.status===401?'UNAUTHORIZED':response.status===403?'PERMISSION_DENIED':response.status===404?'NOT_FOUND':'PLATFORM_REJECTED');}
      if(response.status===204)return null;
      // Bound decompressed JSON, including discovery responses and untrusted message bodies.
      const reader=response.body?.getReader();if(!reader)throw new Error(method==='GET'?'INVALID_EVENT':'OUTCOME_UNKNOWN');
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4000000)throw new Error('RESPONSE_LIMIT');chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
      catch{await reader.cancel().catch(()=>{});throw new Error(method==='GET'?'INVALID_EVENT':'OUTCOME_UNKNOWN');}finally{reader.releaseLock();}
    }
  }
}
