import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createConsoleServer } from '@superagent/web-console';
import { m5Fixture, accessKey, readerKey } from './m5-helpers.mjs';
import { binding } from './helpers.mjs';
async function serverFixture(t){const f=await m5Fixture(t);f.add('one');await f.worker.tick();const report=f.generate();const server=createConsoleServer(f.control,{now:f.clock});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
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
