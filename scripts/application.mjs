import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { GitHubREST } from '@superagent/issue-tracker';
import { deliveryHost } from '@superagent/plugin-host';
import { createConsoleServer } from '@superagent/web-console';
import { parseApplicationConfig } from './application-config.mjs';
import { ApplicationPlugins } from './application-plugins.mjs';
import { builtinSources } from './source-registry.mjs';
import { createDelivery,validateDelivery } from './qq-delivery.mjs';
import {qqMenuDenial} from './qq-menu-denial.mjs';
import { secretReader } from './application-plugin-host.mjs';
import { bounded } from './plugin-validation.mjs';
import { acquireApplicationOwner } from './application-owner.mjs';
import { createM3Services } from './m3-services.mjs';
import { createM5 } from './m5-runtime.mjs';
import { loadM5Access } from './m5-local-access.mjs';
import { readFileSync } from 'node:fs';

const listen=async(server,port)=>{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});};
const closeServer=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
function webhook(plugin) {
  let active=0;
  return createServer({requestTimeout:10000,headersTimeout:5000},async(req,res)=>{
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method!=='POST'||req.url!=='/qq/events'){reply(404,{error:'NOT_FOUND'});return;}
    if(active>=32){req.resume();reply(503,{error:'QQ_CALLBACK_BUSY'});return;}active++;
    try{
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.byteLength;if(length>1000000){reply(413,{error:'QQ_BODY_LIMIT'});return;}chunks.push(chunk);}
      const headers=Object.fromEntries(['x-bot-appid','x-signature-timestamp','x-signature-ed25519'].map(key=>[key,typeof req.headers[key]==='string'?req.headers[key]:undefined]));
      const result=await plugin().handleWebhook(headers,Buffer.concat(chunks));reply(result.statusCode,result.body);
    }catch{if(!res.headersSent)reply(503,{error:'QQ_CALLBACK_FAILED'});}finally{active--;}
  });
}
const safeError=error=>error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'APPLICATION_FAILED';

export async function createApplication(input,options={}) {
  const registry=options.sourceRegistry??builtinSources;
  const config=parseApplicationConfig(input,options.directory,registry),env=options.env??process.env,clock=options.clock,log=options.log??(()=>{});
  const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  const policy=options.policy??JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
  let runtime,owner,m5,manager,m3,webServer,processor,closePromise,started=false,ticking=false;
  const servers=[];let menuDenial=async()=>{};
  const close=()=>closePromise??=(async()=>{
    controller.abort();
    // First stop accepting callbacks, then drain plugins/workers before closing their shared store.
    const stopping=servers.map(closeServer);
    await manager?.close();await processor?.catch(()=>{});await Promise.allSettled(stopping);
    try{await m5?.close();}finally{try{owner?.release();}finally{runtime?.close();}}
  })();
  try {
    // Service authorization is explicit configuration; merely setting an env var enables nothing.
    const required=name=>{if(!name||!env[name])throw new Error('APPLICATION_SECRET_MISSING');return env[name];};
    const github=config.github.enabled?(options.github??new GitHubREST({repository:config.github.repository,token:required(config.github.tokenEnv),
      ...(config.github.baseURL?{baseURL:config.github.baseURL}:{}),allowLoopbackHTTP:config.github.allowLoopbackHTTP===true})):null;
    // Resolve model settings at startup; no LLM provider or local runtime is mandatory.
    const analysisConfig={...config.analysis,
      ...(config.analysis.enabled&&config.analysis.baseURLEnv?{baseURL:required(config.analysis.baseURLEnv)}:{}),
      ...(config.analysis.enabled&&config.analysis.modelEnv?{model:required(config.analysis.modelEnv)}:{}),
      ...(config.analysis.enabled&&config.analysis.apiKeyEnv?{apiKey:required(config.analysis.apiKeyEnv)}:{})};
    const delivery=config.deliveries.find(e=>e.enabled);
    if(delivery)validateDelivery((options.deliveryFactory??createDelivery)(delivery.config),delivery);
    manager=new ApplicationPlugins(null,config,null,{env,factories:options.sourceFactories,log,registry,timing:options.supervisorTiming,
      ...(delivery?{operator:{receive:request=>m5.qq.receive(request),reject:request=>menuDenial(request)}}:{})});
    mkdirSync(path.dirname(config.database),{recursive:true});
    runtime=new M1Runtime(config.database,{policy,...(clock?{clock}:{})});owner=acquireApplicationOwner(runtime.store);
    if(runtime.store.get('SELECT 1 FROM projects WHERE project_id<>? LIMIT 1',config.projectId))throw new Error('APPLICATION_PROJECT_SCOPE_MISMATCH');
    const memory=new HybridMemory(runtime.store);
    const domain=new DomainService(runtime.store,memory,{authorizedActors:['web-developer','qq-developer'],...(clock?{clock}:{}),
      ...(config.github.enabled?{repositories:{[config.projectId]:config.github.repository}}:{})});
    m3=createM3Services(runtime,{projectId:config.projectId,analysis:analysisConfig,model:options.model,memory,domain,github,githubWrite:config.github.allowWrites,clock});
    let access=options.access;
    if(!access){
      if(config.web.accessKeyEnv){const accessKey=required(config.web.accessKeyEnv);if(accessKey.length<32)throw new Error('WEB_ACCESS_KEY_TOO_SHORT');access={accessKey,signingKey:config.web.signingKeyEnv?required(config.web.signingKeyEnv):accessKey};}
      else if(config.web.enabled||delivery)access=loadM5Access(config.web.accessConfig);
      else access={accessKey:randomBytes(32).toString('hex'),signingKey:randomBytes(32).toString('hex')};
    }
    let deliveryState={state:'disabled'};
    m5=await createM5({database:config.database,project:config.projectId,'qq-configured':!!delivery,'qq-write':delivery?.allowWrites===true,
      'qq-readonly':!config.github.allowWrites,'github-write':config.github.allowWrites},signal,
      {runtime,memory,domain,clock,access,repository:config.github.repository??'',github,tickIngress:false,scheduleReports:config.reports.enabled,operatorMenu:delivery?.config.operatorMenu,
        ...(delivery?{readSecret:secretReader(delivery,env),deliveryFactory:callbacks=>validateDelivery((options.deliveryFactory??createDelivery)({...delivery.config,...callbacks}),delivery),
          deliveryHostFactory:(plugin,read)=>deliveryHost(plugin,read)}:{})});
    if(delivery&&m5.delivery)menuDenial=qqMenuDenial({runtime,plugin:m5.delivery.plugin,host:m5.qqHost,enabled:delivery.config.operatorMenu?.enabled===true,allowWrites:delivery.allowWrites,clock});
    manager.runtime=runtime;manager.owner=owner;
    const tick=async()=>{
      if(processor)throw new Error('APPLICATION_MANAGED_WORKERS_RUNNING');
      if(ticking)throw new Error('APPLICATION_TICK_ALREADY_RUNNING');signal.throwIfAborted();owner.assert();ticking=true;
      try{
        const ingress=runtime.tick(),analysis=await m3.tick(signal),reports=await m5.tick();
        return {ingress,...analysis,m5:reports};
      }finally{ticking=false;}
    };
    const start=async()=>{
      if(started)throw new Error('APPLICATION_ALREADY_STARTED');signal.throwIfAborted();started=true;
      if(config.web.enabled){webServer=createConsoleServer(m5.control);servers.push(webServer);await listen(webServer,config.web.port??8787);}
      if(m5.delivery){const capability=await bounded(m5.delivery.plugin.probe(),config.runtime.stopTimeoutMs);deliveryState={state:'loaded',capability,allowWrites:delivery.allowWrites};log({kind:'delivery',id:delivery.id,...deliveryState});}
      manager.start();
      for(const entry of config.sources.filter(e=>e.enabled&&e.plugin==='qq-official'&&(e.config.transport??'webhook')==='webhook')){
        const server=webhook(()=>{const instance=manager.instances.get(entry.id);if(!instance)throw new Error('SOURCE_NOT_RUNNING');return instance.plugin;});server.sourceId=entry.id;servers.push(server);await listen(server,entry.port);
      }
      log({kind:'application',state:'started',analysis:config.analysis.enabled?'enabled':'disabled',reports:config.reports.enabled,p0:'not_implemented',
        webPort:webServer?.address()?.port,sourcePorts:Object.fromEntries(servers.filter(s=>s.sourceId).map(s=>[s.sourceId,s.address().port])),plugins:manager.status()});
    };
    const run=async()=>{
      if(!started)await start();
      if(processor)throw new Error('APPLICATION_MANAGED_WORKERS_RUNNING');
      let failure;
      const loop=async(name,work)=>{
        try{while(!signal.aborted){owner.assert();const result=await work();
          if(result.admitted||result.analysis?.processed||result.github?.processed||result.report?.processed||result.delivery?.processed)
            log({kind:'worker',worker:name,admitted:result.admitted,analysis:result.analysis?.status,github:result.github?.state,report:result.report?.status,delivery:result.delivery?.state});
          await delay(config.runtime.pollMs,undefined,{signal});
        }}catch(error){if(!signal.aborted)failure??=error;controller.abort();}
      };
      // Independent managed loops share the existing durable lanes. Slow LLM/GitHub IO
      // must not delay archive admission or fixed-window report scheduling.
      processor=Promise.all([loop('m1',()=>runtime.tick()),loop('m3',()=>m3.tick(signal)),loop('m5',()=>m5.tick())]).then(()=>{if(failure)throw failure;});
      try{await processor;}catch(error){log({kind:'application',state:'failed',error:safeError(error)});throw error;}
      finally{await close();}
    };
    return {config,runtime,memory,domain,m3,m5,plugins:manager,signal,tick,start,run,close,
      status:()=>({plugins:manager.status(),delivery:deliveryState,webPort:webServer?.address()?.port,
        sourcePorts:Object.fromEntries(servers.filter(s=>s.sourceId&&s.listening).map(s=>[s.sourceId,s.address().port])),metrics:runtime.metrics(),p0:'not_implemented'})};
  }catch(error){await close();throw error;}
}
