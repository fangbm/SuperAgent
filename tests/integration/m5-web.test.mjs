import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createConsoleServer } from '@superagent/web-console';
import { m5Fixture, accessKey, readerKey } from './m5-helpers.mjs';
import { binding,event,scope } from './helpers.mjs';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { webcrypto } from 'node:crypto';
async function serverFixture(t,original,threadTitle){
  const f=await m5Fixture(t);
  if(threadTitle){
    const thread=event('one',{text:original??'如题'});
    thread.type='com.superagent.feedback.thread.created.v1';
    thread.data.object.kind='thread';thread.data.attributes={title:threadTitle};
    f.runtime.ingress.commitBatch(scope,[thread]);f.runtime.tick();
    for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))
      f.runtime.buffer.flushSync(row.segment_id,'replay');
  }else f.add('one',original);
  await f.worker.tick();const report=f.generate();const server=createConsoleServer(f.control,{now:f.clock});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
  const login=async(key=accessKey)=>{const response=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({accessKey:key})});assert.equal(response.status,200);const cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const csrf=response.headers.getSetCookie().find(c=>c.startsWith('sa_csrf=')).split(';')[0].slice(8);return{cookies,csrf};};
  const call=(path,session,body,extra={})=>fetch(base+path+(path.includes('?')?'&':'?')+'project='+encodeURIComponent(binding.projectId),{method:body?'POST':'GET',headers:{Origin:base,...(session?{Cookie:session.cookies,'X-CSRF-Token':session.csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return{...f,report,base,login,call};}
test('HTTP console serves local assets but requires session, project authorization and CSRF for data and writes',async t=>{
  const f=await serverFixture(t);const page=await fetch(f.base);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal((await fetch(f.base+'/app.js')).status,200);assert.equal((await fetch(f.base+'/style.css')).status,200);
  assert.equal((await f.call('/api/reports')).status,401);const session=await f.login();const reports=await (await f.call('/api/reports',session)).json();assert.equal(reports[0].reportId,f.report.reportId);
  assert.equal((await fetch(f.base+'/api/reports?project=not-approved',{headers:{Cookie:session.cookies}})).status,403);
  assert.equal((await f.call('/api/reports/generate',session,{}, {'X-CSRF-Token':''})).status,403);
  assert.equal((await f.call('/api/reports/generate',session,{}, {Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.call('/api/reports/generate',session,{})).status,200);
  const body=await page.text();assert.equal(body.includes(accessKey),false);
});
test('HTTP actions change only authorized state, return optimistic conflicts and preserve report snapshot',async t=>{
  const f=await serverFixture(t);const session=await f.login();const work=f.control.listWorks(f.principal,binding.projectId,'suggestion')[0];const request={kind:'suggestion',id:work.id,action:'accept',expectedVersion:work.version};
  const token=await (await f.call('/api/actions/token',session,request)).json();const response=await f.call('/api/actions',session,{request,token:token.token,interactionId:'web-fixture'});assert.equal(response.status,200);assert.equal((await response.json()).status,'accepted');
  assert.equal((await f.call('/api/actions/token',session,request)).status,409);
  const frozen=await (await f.call(`/api/reports/${f.report.reportId}/1/section?section=suggestions`,session)).json();assert.equal(frozen.entries[0].status,'candidate');
  const evidence=await (await f.call(`/api/works/suggestion/${work.id}/evidence?reportId=${f.report.reportId}&revision=1`,session)).json();assert.match(evidence.items[0].originalText,/联机/);
  const history=await (await f.call(`/api/works/suggestion/${work.id}/history`,session)).json();assert.equal(history[0].details.to,'accepted');assert.equal(history[0].actorRef,'developer');
});
test('read-only and revoked operator sessions cannot issue commands or read another project',async t=>{
  const f=await serverFixture(t);const reader=await f.login(readerKey);assert.equal((await f.call('/api/reports/generate',reader,{})).status,403);
  const writer=await f.login();f.runtime.store.run('UPDATE operator_accounts SET enabled=0 WHERE actor_ref=?','developer');assert.equal((await f.call('/api/reports',writer)).status,401);
});

test('authenticated report content renders the frozen revision while original evidence stays literal in client DOM',async t=>{
  const original='联机崩溃\n# [原文](https://invalid.example) <script>opaque</script>';
  const f=await serverFixture(t,original),path=`/api/reports/${f.report.reportId}/1/content`;
  assert.equal((await f.call(path)).status,401);const session=await f.login(readerKey);
  assert.equal((await fetch(f.base+path+'?project=other',{headers:{Cookie:session.cookies}})).status,403);
  assert.equal((await f.call(`/api/reports/${f.report.reportId}/99/content`,session)).status,404);
  const rendered=await (await f.call(path,session)).json();assert.match(rendered.html,/<h1>社区反馈半日报<\/h1>/);assert.match(rendered.html,/<h2>Bug/);assert.match(rendered.html,/<ul>/);
  const before=await (await f.call(`/api/reports/${f.report.reportId}/1`,session)).json();
  const {window,document}=parseHTML(await (await fetch(f.base)).text());document.cookie=`sa_csrf=${session.csrf}`;
  // A simulated DOM executes the actual client and talks to the real local HTTP server.
  // This is a component/integration test, not a visible browser acceptance result.
  runInNewContext(await (await fetch(f.base+'/app.js')).text(),{document,Node:window.Node,Intl,crypto:webcrypto,setTimeout:()=>0,fetch:(url,options={})=>fetch(new URL(url,f.base),{...options,headers:{...options.headers,Origin:f.base,Cookie:session.cookies}})});
  const waitFor=async predicate=>{const end=Date.now()+3000;while(!predicate()&&Date.now()<end)await delay(10);assert.ok(predicate(),document.getElementById('toast').textContent);};
  const button=label=>{const found=[...document.querySelectorAll('button')].filter(b=>b.textContent===label);assert.equal(found.length,1);return found[0];};
  await waitFor(()=>document.querySelector('.report-cover'));button('打开报告 →').click();await waitFor(()=>document.querySelector('.report-content h1'));
  assert.equal(document.querySelector('.report-content').tagName,'DIV');assert.equal(document.querySelector('.report-content h1').textContent,'社区反馈半日报');assert.ok(document.querySelectorAll('.report-content li').length>0);assert.equal(document.querySelector('.report-content').innerHTML,rendered.html);
  button('查看原文与当前进展').click();await waitFor(()=>document.querySelector('pre.original'));assert.equal(document.querySelector('pre.original').textContent,original);assert.equal(document.querySelector('pre.original script'),null);
  f.setTime('2026-11-02T10:06:00.000Z');f.reports.generate(f.report.window,{revise:true,expectedRevision:1});
  assert.deepEqual(await (await f.call(path,session)).json(),rendered);assert.deepEqual(await (await f.call(`/api/reports/${f.report.reportId}/1`,session)).json(),before);
});


test('Web original API returns the exact thread title and body used by model evidence',async t=>{
  const title='Windows 联机加载90%时崩溃';
  const f=await serverFixture(t,'如题',title);
  const session=await f.login(readerKey);
  const work=f.control.listWorks(f.principal,binding.projectId,'defect')[0];
  assert.ok(work);
  const response=await f.call(`/api/works/defect/${work.id}/evidence?reportId=${f.report.reportId}&revision=1`,session);
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.equal(payload.items[0].originalText,'标题：'+title+'\n正文：如题');
  assert.equal(payload.items[0].visible,true);
});
