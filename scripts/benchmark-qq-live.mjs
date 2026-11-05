import {parseArgs} from 'node:util';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir,cpus,totalmem,release} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const {values}=parseArgs({options:{scales:{type:'string',default:'1000:10000,5000:50000,10000:100000'},samples:{type:'string',default:'3'},'query-timeout-ms':{type:'string',default:'30000'},'case-timeout-ms':{type:'string',default:'180000'},output:{type:'string'}}});
const queryTimeoutMs=Number(values['query-timeout-ms']),caseTimeoutMs=Number(values['case-timeout-ms']);
const samples=Number(values.samples),scales=values.scales.split(',').map(value=>{
  const match=/^(\d+):(\d+)$/.exec(value);if(!match)throw new Error('INVALID_BENCHMARK_SCALE');
  const works=Number(match[1]),feedback=Number(match[2]);
  if(works<2||works>20000||works%2||feedback<works||feedback>200000||feedback%works||feedback/works>30)throw new Error('INVALID_BENCHMARK_SCALE');
  return{works,feedback};
});
if(!Number.isInteger(samples)||samples<1||samples>5||!scales.length||scales.length>5||!Number.isInteger(queryTimeoutMs)||queryTimeoutMs<1||queryTimeoutMs>120000||!Number.isInteger(caseTimeoutMs)||caseTimeoutMs<1000||caseTimeoutMs>600000||caseTimeoutMs<queryTimeoutMs)throw new Error('INVALID_BENCHMARK_BUDGET');
const base=realpathSync(tmpdir()),cases=[];
for(const scale of scales){
  const directory=mkdtempSync(path.join(base,'superagent-qq-live-perf-'));
  try{
    process.stderr.write(`BENCHMARK start ${scale.works} works / ${scale.feedback} analyzed feedback\n`);
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./bench/qq-live-worker.mjs',import.meta.url)),directory,String(scale.works),String(scale.feedback),String(samples)],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
      let stdout='',stderr='',queryTimer,timeoutReason=null,lastPhase=null;
      const stop=reason=>{if(timeoutReason)return;timeoutReason=reason;child.kill('SIGKILL');};
      const totalTimer=setTimeout(()=>stop('case_timeout'),caseTimeoutMs),cancel=()=>stop('cancelled');
      process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
      child.stdout.on('data',data=>{stdout+=data;});
      child.stderr.on('data',data=>{process.stderr.write(data);stderr+=data;let end;while((end=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,end);stderr=stderr.slice(end+1);if(line.startsWith('BENCHMARK_PHASE ')){
        lastPhase=JSON.parse(line.slice('BENCHMARK_PHASE '.length));clearTimeout(queryTimer);if(lastPhase.name==='query')queryTimer=setTimeout(()=>stop('query_timeout'),queryTimeoutMs);
      }}});
      child.once('error',reject);child.once('close',code=>{
        clearTimeout(queryTimer);clearTimeout(totalTimer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
        if(timeoutReason){const file=path.join(directory,'partial.json'),partial=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
          resolve({...partial,status:timeoutReason,interruptedPhase:lastPhase,phaseElapsedMs:lastPhase?Date.now()-Date.parse(lastPhase.startedAt):null,configuredQueryTimeoutMs:queryTimeoutMs,configuredCaseTimeoutMs:caseTimeoutMs});
        }else if(code!==0)reject(new Error('BENCHMARK_WORKER_FAILED'));else resolve({...JSON.parse(stdout),status:'complete'});
      });
    });
    cases.push(result);if(result.status==='cancelled')throw new Error('BENCHMARK_CANCELLED');
  }finally{
    const resolved=realpathSync(directory);
    if(path.dirname(resolved)!==base||!path.basename(resolved).startsWith('superagent-qq-live-perf-'))throw new Error('BENCHMARK_CLEANUP_SCOPE_MISMATCH');
    rmSync(resolved,{recursive:true,force:true});
  }
}
const artifacts=Object.fromEntries(['packages/control-plane/src/qq-live.ts','packages/control-plane/dist/qq-live.js','scripts/bench/qq-live-worker.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')]));
const report={schemaVersion:1,measuredAt:new Date().toISOString(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),artifacts,environment:{platform:process.platform,release:release(),arch:process.arch,node:process.version,cpu:cpus()[0]?.model,logicalCPUs:cpus().length,totalMemoryGiB:Math.round(totalmem()/1024**3)},samples,queryTimeoutMs,caseTimeoutMs,
  scope:'Synthetic file-SQLite query benchmark. Direct fixture seeding bypasses Ingress/LLM. No real QQ, model or outbound calls. No latency pass/fail SLA. Store-call instrumentation included; not cold-cache or concurrent load.',cases};
if(values.output){const target=path.resolve(values.output);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
process.stdout.write(JSON.stringify(report,null,2)+'\n');
