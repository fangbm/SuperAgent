import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubREST, GitHubSyncManager } from '@superagent/issue-tracker';
import { CompatibleChatModel } from '@superagent/llm';
import { binding, count } from './helpers.mjs';
import { m3Fixture } from './m3-helpers.mjs';

test('missing or invalid provider usage remains unknown rather than zero',async()=>{
  for(const usage of [undefined,{prompt_tokens:-1,completion_tokens:'2'}]){
    const model=new CompatibleChatModel({baseURL:'https://fixture.invalid',model:'fixture-model',fetch:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}],...(usage?{usage}:{})})});
    const result=await model.generate({schemaId:'fixture',schema:{type:'object'},prompt:'JSON',timeoutMs:1000,maxOutputTokens:10,signal:new AbortController().signal});
    assert.deepEqual(result.usage,{inputTokens:null,outputTokens:null});
  }
});

test('real local HTTP exercises GitHub authentication, private guard and Issue POST mapping',async t=>{
  const f=await m3Fixture(t);f.add('one','Windows 1.2.0 联机载入90%时崩溃');await f.worker.tick();const requests=[];let privateRepo=false;
  const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b.toString();requests.push({url:req.url,method:req.method,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');
    if(req.url==='/repos/owner/private-test'&&req.method==='GET')res.end(JSON.stringify({private:privateRepo}));
    else if(req.url==='/user')res.end(JSON.stringify({id:123}));
    else if(req.url==='/repos/owner/private-test/issues'&&req.method==='POST'){res.writeHead(201);res.end(JSON.stringify({number:1,body:JSON.parse(text).body,state:'open'}));}
    else{res.writeHead(404);res.end('{}');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const port=new GitHubREST({repository:'owner/private-test',token:'fixture-token',baseURL:`http://127.0.0.1:${server.address().port}`,allowLoopbackHTTP:true});
  const manager=new GitHubSyncManager(f.runtime.store,f.domain,port,{clock:f.clock,allowWrites:true});
  await assert.rejects(manager.tick(),/PUBLIC_REPOSITORY_NOT_AUTHORIZED/);assert.equal(requests.filter(r=>r.method==='POST').length,0);
  privateRepo=true;assert.equal((await manager.tick()).state,'succeeded');assert.equal(count(f.runtime.store,'external_work_links'),1);
  assert.ok(requests.every(r=>r.authorization==='Bearer fixture-token'));
});

test('production M3 CLI runs one HTTP-model batch and exits without a GitHub token',async t=>{
  // CLI uses the unchanged default policy; avoid test-only audit overrides.
  const f=await m3Fixture(t,{policyOverrides:{auditSampleRate:0.02}});f.add('one','Windows 1.2.0 联机载入90%时崩溃');
  const child=await promisify(execFile)(process.execPath,['scripts/m3-worker.mjs','--database',f.filename,'--once'],{cwd:process.cwd(),windowsHide:true,timeout:10_000,
    env:{...process.env,SA_LLM_BASE_URL:f.server.baseURL,SA_LLM_MODEL:'fixture-model',SA_LLM_API_KEY:'fixture-only',SA_ALLOW_LOOPBACK_HTTP:'1',SA_GITHUB_TOKEN:'',SA_GITHUB_REPOSITORY:''}});
  const result=JSON.parse(child.stdout.trim());assert.equal(result.analysis.status,'succeeded');assert.equal(result.github.state,'not_configured');assert.equal(count(f.runtime.store,'issues'),1);
});
