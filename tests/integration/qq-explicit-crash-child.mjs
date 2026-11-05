import {M1Runtime} from '@superagent/agent-core';
import {QQSource} from '@superagent/qq-official';
import {HybridMemory} from '@superagent/memory';
import {DomainService} from '@superagent/domain';
import {AnalysisWorker} from '@superagent/agent-workers';
import {binding,scope,defaultPolicy,initial} from './helpers.mjs';
import {qqEvent,signed,readSecret} from './qq-helpers.mjs';
const [filename,stage]=process.argv.slice(2),clock=()=>initial;
const runtime=new M1Runtime(filename,{policy:{...defaultPolicy,auditSampleRate:0},clock});runtime.ingress.registerSource(binding);runtime.ingress.configureQQFeedback(scope,{enabled:true});
const source=new QQSource({kind:'group',sourceUri:binding.sourceUri,now:()=>Date.parse(clock()),feedbackCommands:{enabled:true},api:{fetch:async url=>String(url).endsWith('/app/getAppAccessToken')?Response.json({access_token:'fixture',expires_in:7200}):Response.json(String(url).endsWith('/bot_state')?{member_openid:'bot'}:{id:'bot'})}});
await source.start(runtime.ingress.sourceHost(scope,{secretKeys:source.manifest.permissions.secretKeys,getSecret:readSecret}),new AbortController().signal);
await source.handleWebhook(...signed(qqEvent('crash-command',{text:'/bug Windows 1.2.0 联机载入90%时崩溃',type:'GROUP_MESSAGE_CREATE'}),clock));
const wait=()=>{process.stdout.write('READY\n');setInterval(()=>{},1000);};
if(stage==='archive')wait();
else{
  const run=runtime.store.run.bind(runtime.store);runtime.store.run=(sql,...args)=>{const result=run(sql,...args);if(stage==='admission'&&sql.startsWith('INSERT INTO admission_decisions')||stage==='batch'&&sql.startsWith('INSERT INTO feedback_batches'))process.kill(process.pid,'SIGKILL');return result;};
  runtime.tick();
  if(stage==='queued')wait();
  else if(stage==='worker'){
    const memory=new HybridMemory(runtime.store),domain=new DomainService(runtime.store,memory,{clock});
    const model={modelId:'crash-fixture',generate:async()=>{wait();return await new Promise(()=>{});}};
    await new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{clock}).tick();
  }
}
