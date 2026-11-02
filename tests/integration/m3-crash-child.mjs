import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';
import { defaultPolicy, initial } from './helpers.mjs';
const runtime=new M1Runtime(process.argv[2],{policy:{...defaultPolicy,auditSampleRate:0},clock:()=>initial});
const memory=new HybridMemory(runtime.store);const domain=new DomainService(runtime.store,memory,{clock:()=>initial});
const model={modelId:'interrupted-fixture',generate:async()=>{process.stdout.write('MODEL_WAIT\n');setInterval(()=>{},1000);return await new Promise(()=>{});}};
await new AnalysisWorker(runtime.store,runtime.queue,domain,memory,model,{clock:()=>initial}).tick();
