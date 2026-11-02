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
import { DurableDeliveryService, deliveryHost, ReportDeliveryCoordinator } from '@superagent/plugin-host';
import { GitHubREST, GitHubActionWorker } from '@superagent/issue-tracker';
import { canonicalJSON, stableId } from '@superagent/persistence';
import { configuredSecrets } from './qq-common.mjs';
import { loadM5Access } from './m5-local-access.mjs';

export async function createM5(values,signal){
  if(!values.database||!values.project)throw new Error('M5_DATABASE_PROJECT_REQUIRED');
  const filename=path.resolve(values.database);mkdirSync(path.dirname(filename),{recursive:true});let backupFile=null;
  if(existsSync(filename)){
    const original=new DatabaseSync(filename,{readOnly:true});
    try{const applied=original.prepare("SELECT 1 FROM schema_migrations WHERE name='009_m5_reports_actions_web.sql'").get();if(!applied){mkdirSync('.artifacts/backups',{recursive:true});backupFile=path.resolve(`.artifacts/backups/m5-before-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);await backup(original,backupFile);}}finally{original.close();}
  }
  const access=loadM5Access(values['access-config']);const policy=JSON.parse(readFileSync(new URL('../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
  const runtime=new M1Runtime(filename,{policy});let source;try{
    runtime.store.run('INSERT INTO projects(project_id) VALUES(?) ON CONFLICT DO NOTHING',values.project);
    const memory=new HybridMemory(runtime.store);const repository=process.env.SA_GITHUB_REPOSITORY;
    const domain=new DomainService(runtime.store,memory,{authorizedActors:['web-developer','qq-developer'],...(repository?{repositories:{[values.project]:repository}}:{})});
    const reports=new ReportService(runtime.store,domain,runtime.queue,{recipients:values['qq-configured']?['qq-developer']:[]});
    reports.registerSchedule(values.project);
    const auth=new OperatorAuth(runtime.store);auth.register({actorRef:'web-developer',role:'developer',projects:[values.project]},access.accessKey);
    auth.register({actorRef:'qq-developer',role:values['qq-readonly']?'reader':'developer',projects:[values.project]},randomBytes(32).toString('base64url'));
    if(process.env.SA_WEB_READER_KEY)auth.register({actorRef:'web-reader',role:'reader',projects:[values.project]},process.env.SA_WEB_READER_KEY);
    const tokens=new TokenService(runtime.store,access.signingKey);const control=new ControlPlane(runtime.store,domain,reports,auth,tokens);
    let delivery,coordinator,qq;
    if(values['qq-configured']){
      const read=configuredSecrets(values);qq=new QQOperatorService(control,{projectId:values.project,actorRef:'qq-developer',recipientRef:'qq-developer'});
      const plugin=new QQC2CDelivery({projectId:values.project,recipientRef:'qq-developer',navigationTokens:async request=>qq.navigationTokens(request),messageOptions:async request=>coordinator.messageOptions(request.deliveryId)});
      const recipientBindingId=stableId('qq-recipient',await read('QQ_APP_ID'),await read('QQ_RECIPIENT_OPENID'));
      delivery=new DurableDeliveryService(runtime.store,plugin,deliveryHost(plugin,read),{projectId:values.project,recipientRef:'qq-developer',recipientBindingId,allowWrites:Boolean(values['qq-write']),authorizeDelivery:()=>auth.authorize(auth.principal('qq-developer'),values.project),authorizeInteraction:request=>coordinator.authorizeReply(request)});
      coordinator=new ReportDeliveryCoordinator(runtime.store,delivery,{getReport:(p,id,rev)=>reports.getExact(p,id,rev)});
      if(values['qq-source']){
        if(!values.source)throw new Error('QQ_SOURCE_ID_REQUIRED');const sourceUri=`urn:superagent:source:${encodeURIComponent(values.source)}`;runtime.ingress.registerSource({projectId:values.project,sourceId:values.source,sourceUri,platform:'qq-official'});
        source=new QQSource({kind:'group',sourceUri,transport:'websocket',operator:{receive:async request=>qq.receive(request)}});
        const sourceRead=key=>read(key==='QQ_OPERATOR_OPENID'?'QQ_RECIPIENT_OPENID':key);await source.start(runtime.ingress.sourceHost({projectId:values.project,sourceId:values.source},{secretKeys:source.manifest.permissions.secretKeys,getSecret:sourceRead}),signal);
      }
    }
    const github=repository&&process.env.SA_GITHUB_TOKEN?new GitHubActionWorker(runtime.store,domain,new GitHubREST({repository,token:process.env.SA_GITHUB_TOKEN}),{allowWrites:Boolean(values['github-write']),authorize:(actor,p)=>auth.authorize(auth.principal(actor),p,true)}):null;
    let sends=0;
    const tick=async()=>{
      runtime.tick();reports.scheduleDue();const report=reports.tick();qq?.tick();
      if(coordinator){coordinator.enqueueReplies(values.project,'qq-developer');coordinator.prepare(values.project,'qq-developer');}
      let delivered={processed:false};
      if(delivery&&sends<Number(values['max-sends']??Number.MAX_SAFE_INTEGER)){
        delivered=await delivery.tick({purpose:'interaction'});if(!delivered.processed)delivered=await delivery.tick({purpose:'report'});if(delivered.processed)sends++;
        coordinator.prepare(values.project,'qq-developer');
      }
      const remote=github?await github.tick():{processed:false};return{report,delivery:delivered,github:remote,sends};
    };
    return{runtime,domain,reports,auth,control,qq,coordinator,delivery,backupFile,tick,close:async()=>{await source?.stop();runtime.close();}};
  }catch(error){await source?.stop();runtime.close();throw error;}
}
