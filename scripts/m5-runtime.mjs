import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { ReportService } from '@superagent/reporting';
import { OperatorAuth, TokenService, ControlPlane, QQOperatorService } from '@superagent/control-plane';
import { QQC2CDelivery, QQSource } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost, ReportDeliveryCoordinator, QQCardRetirementService } from '@superagent/plugin-host';
import { GitHubREST, GitHubActionWorker } from '@superagent/issue-tracker';
import { canonicalJSON, stableId } from '@superagent/persistence';
import { configuredSecrets } from './qq-common.mjs';
import { loadM5Access } from './m5-local-access.mjs';

export async function createM5(values,signal,options={}){
  if(!values.database||!values.project)throw new Error('M5_DATABASE_PROJECT_REQUIRED');
  const filename=path.resolve(values.database);mkdirSync(path.dirname(filename),{recursive:true});let backupFile=null;
  if(!options.runtime&&existsSync(filename)){
    const original=new DatabaseSync(filename,{readOnly:true});
    try{const applied=original.prepare("SELECT 1 FROM schema_migrations WHERE name='011_qq_all_interaction_retirement.sql'").get();if(!applied){mkdirSync('.artifacts/backups',{recursive:true});backupFile=path.resolve(`.artifacts/backups/m5-before-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);await backup(original,backupFile);}}finally{original.close();}
  }
  const access=options.access??loadM5Access(values['access-config']);const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
  const runtime=options.runtime??new M1Runtime(filename,{policy});let source;try{
    runtime.store.run('INSERT INTO projects(project_id) VALUES(?) ON CONFLICT DO NOTHING',values.project);
    const memory=options.memory??new HybridMemory(runtime.store);const repository=options.repository??process.env.SA_GITHUB_REPOSITORY;
    const domain=options.domain??new DomainService(runtime.store,memory,{authorizedActors:['web-developer','qq-developer'],...(repository?{repositories:{[values.project]:repository}}:{})});
    const reports=new ReportService(runtime.store,domain,runtime.queue,{recipients:values['qq-configured']?['qq-developer']:[],...(options.clock?{clock:options.clock}:{})});
    if(options.scheduleReports!==false)reports.registerSchedule(values.project);
    const auth=new OperatorAuth(runtime.store);auth.register({actorRef:'web-developer',role:'developer',projects:[values.project]},access.accessKey);
    auth.register({actorRef:'qq-developer',role:values['qq-readonly']?'reader':'developer',projects:[values.project]},randomBytes(32).toString('base64url'));
    if(process.env.SA_WEB_READER_KEY)auth.register({actorRef:'web-reader',role:'reader',projects:[values.project]},process.env.SA_WEB_READER_KEY);
    const tokens=new TokenService(runtime.store,access.signingKey);const control=new ControlPlane(runtime.store,domain,reports,auth,tokens);
    let delivery,coordinator,qq,retirement;
    if(values['qq-configured']){
      const read=options.readSecret??configuredSecrets(values);qq=new QQOperatorService(control,{projectId:values.project,actorRef:'qq-developer',recipientRef:'qq-developer'});
      const plugin=(options.deliveryFactory??(config=>new QQC2CDelivery(config)))({projectId:values.project,recipientRef:'qq-developer',navigationTokens:async request=>qq.navigationTokens(request),messageOptions:async request=>coordinator.messageOptions(request.deliveryId)});
      const recipientBindingId=stableId('qq-recipient',await read('QQ_APP_ID'),await read('QQ_RECIPIENT_OPENID'));
      const host=options.deliveryHostFactory?options.deliveryHostFactory(plugin,read):deliveryHost(plugin,read);
      delivery=new DurableDeliveryService(runtime.store,plugin,host,{projectId:values.project,recipientRef:'qq-developer',recipientBindingId,allowWrites:Boolean(values['qq-write']),authorizeDelivery:()=>auth.authorize(auth.principal('qq-developer'),values.project),authorizeInteraction:request=>coordinator.authorizeReply(request)});
      coordinator=new ReportDeliveryCoordinator(runtime.store,delivery,{getReport:(p,id,rev)=>reports.getExact(p,id,rev)});
      retirement=new QQCardRetirementService(runtime.store,{recallMessage:id=>plugin.recallMessage(id,host)},{pluginId:plugin.manifest.id,projectId:values.project,recipientRef:'qq-developer',bindingId:recipientBindingId,allowWrites:Boolean(values['qq-write']),authorize:()=>auth.authorize(auth.principal('qq-developer'),values.project)});
      if(values['qq-source']){
        if(!values.source)throw new Error('QQ_SOURCE_ID_REQUIRED');const sourceUri=`urn:superagent:source:${encodeURIComponent(values.source)}`;runtime.ingress.registerSource({projectId:values.project,sourceId:values.source,sourceUri,platform:'qq-official'});
        source=new QQSource({kind:'group',sourceUri,transport:'websocket',operator:{receive:async request=>qq.receive(request)}});
        const sourceRead=key=>read(key==='QQ_OPERATOR_OPENID'?'QQ_RECIPIENT_OPENID':key);await source.start(runtime.ingress.sourceHost({projectId:values.project,sourceId:values.source},{secretKeys:source.manifest.permissions.secretKeys,getSecret:sourceRead}),signal);
      }
    }
    const remote=Object.hasOwn(options,'github')?options.github:(repository&&process.env.SA_GITHUB_TOKEN?new GitHubREST({repository,token:process.env.SA_GITHUB_TOKEN}):null);
    const github=remote?new GitHubActionWorker(runtime.store,domain,remote,{allowWrites:Boolean(values['github-write']),authorize:(actor,p)=>auth.authorize(auth.principal(actor),p,true)}):null;
    let sends=0;
    const tick=async()=>{
      if(options.tickIngress!==false)runtime.tick();if(options.scheduleReports!==false)reports.scheduleDue();const report=options.scheduleReports!==false?reports.tick():{processed:false};qq?.tick();
      // A confirmed remote action should produce a final receipt on its first QQ reply.
      const remote=github?await github.tick():{processed:false};
      qq?.refreshActionReplies();
      if(coordinator){coordinator.enqueueReplies(values.project,'qq-developer');coordinator.prepare(values.project,'qq-developer');}
      let delivered={processed:false};
      if(delivery&&sends<Number(values['max-sends']??Number.MAX_SAFE_INTEGER)){
        delivered=await delivery.tick({purpose:'interaction'});if(!delivered.processed)delivered=await delivery.tick({purpose:'report'});if(delivered.processed)sends++;
        coordinator.prepare(values.project,'qq-developer');
      }
      const recalled=retirement?await retirement.tick():{processed:false};
      return{report,delivery:delivered,github:remote,recall:recalled,sends};
    };
    return{runtime,domain,reports,auth,control,qq,coordinator,delivery,retirement,backupFile,tick,close:async()=>{await source?.stop();if(!options.runtime)runtime.close();}};
  }catch(error){await source?.stop();if(!options.runtime)runtime.close();throw error;}
}
