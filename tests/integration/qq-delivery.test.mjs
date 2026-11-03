import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { QQAPI, QQC2CDelivery } from '@superagent/qq-official';
import { deliveryHost } from '@superagent/plugin-host';
import { fixture, binding, count } from './helpers.mjs';
import { deliveryFixture, deliveryRequest, qqSecrets, readSecret } from './qq-helpers.mjs';

const apiFetch = (send, log = []) => async (url, init) => {
  log.push({ url: String(url), ...init });
  if (String(url).endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'fixture-access-token', expires_in: '7200' });
  if (String(url).endsWith('/users/@me')) return Response.json({ id: 'fixture-bot' });
  return send(url, init);
};
test('QQ token cache refreshes early, coalesces concurrent requests, and handles HTTP-200 auth errors', async () => {
  let now = 0; let count = 0; const api = new QQAPI(readSecret, { now: () => now, fetch: async () => { count++; return Response.json({ access_token: `fixture-token-${count}`, expires_in: '120' }); } });
  assert.deepEqual(await Promise.all([api.accessToken(), api.accessToken(), api.accessToken()]), ['fixture-token-1', 'fixture-token-1', 'fixture-token-1']);
  now = 59_000; await api.identity().catch(() => {}); assert.equal(count, 2); // identity GET is the second request, token stays cached.
  now = 61_000; assert.equal(await api.accessToken(), 'fixture-token-3');
  for (const code of [100007, 100016, 100001]) {
    const invalid = new QQAPI(readSecret, { fetch: async () => Response.json({ code, message: 'fixture-sensitive-provider-error' }) });
    await assert.rejects(invalid.accessToken(), error => error.code === `QQ_API_${code}` && !error.message.includes('sensitive'));
  }
});
test('QQ Gateway rejects non-platform WebSocket destinations and plaintext remote URLs', async () => {
  for (const url of ['wss://attacker.invalid/socket', 'ws://api.sgroup.qq.com/socket', 'wss://user:password@api.bot.qq.com/socket']) {
    const api = new QQAPI(readSecret, { fetch: async endpoint => Response.json(String(endpoint).endsWith('/app/getAppAccessToken') ? { access_token: 'fixture-token', expires_in: 7200 } : { url }) });
    await assert.rejects(api.gateway(), /QQ_INVALID_GATEWAY/);
  }
});

test('interaction ACK uses callback AppID and accepts empty HTTP 200; HTTP errors expose only numeric codes',async t=>{
  const seen=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({path:req.url,headers:req.headers,body});if(req.url==='/app/getAppAccessToken'){res.end(JSON.stringify({access_token:'fixture-token',expires_in:7200}));return;}if(req.url.startsWith('/interactions/')){if(req.headers['x-callback-appid']!==qqSecrets.QQ_APP_ID){res.writeHead(400);res.end(JSON.stringify({code:40034025}));return;}res.writeHead(200);res.end();return;}res.writeHead(400);res.end(JSON.stringify({code:40034025,message:'fixture-private-identifier'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const api=new QQAPI(readSecret,{baseURL:`http://127.0.0.1:${server.address().port}`,allowLoopbackHTTP:true});await api.acknowledgeInteraction('fixture-interaction');assert.deepEqual(JSON.parse(seen[1].body),{code:0});
  await assert.rejects(api.sendC2C(qqSecrets.QQ_RECIPIENT_OPENID,{}),error=>error.code==='QQ_API_40034025'&&error.outcome==='rejected'&&!error.message.includes('private'));
});
test('QQ sends only to the approved C2C recipient, with Markdown or explicit text and no group API', async () => {
  const requests = []; const plugin = new QQC2CDelivery({ projectId: binding.projectId, recipientRef: 'developer', api: { fetch: apiFetch(() => Response.json({ id: 'sent-1' }), requests) } });
  const host = deliveryHost(plugin, readSecret);
  assert.equal((await plugin.send({ ...deliveryRequest(), recipientRef: 'attacker' }, host)).status, 'blocked'); assert.equal(requests.length, 0);
  assert.equal((await plugin.send(deliveryRequest(), host)).status, 'accepted');
  const send = requests.find(r => r.url.includes('/v2/users/'));
  assert.equal(send.headers.Authorization, 'QQBot fixture-access-token'); assert.equal(send.redirect, 'error');
  assert.deepEqual(JSON.parse(send.body), { msg_type: 2, markdown: { content: '[QQ 验收] Test\n\nPrivate test message' } });
  assert.equal(requests.some(r => r.url.includes('/groups/')), false);
  const text = new QQC2CDelivery({ projectId: binding.projectId, recipientRef: 'developer', format: 'text', api: { fetch: apiFetch((_url, init) => { assert.equal(JSON.parse(init.body).msg_type, 0); return Response.json({ id: 'sent-2' }); }) } });
  assert.equal((await text.send(deliveryRequest(), deliveryHost(text, readSecret))).status, 'accepted');
  await assert.rejects(host.getSecret('QQ_PSEUDONYM_KEY'), /SECRET_NOT_AUTHORIZED/);
});
test('QQ response classification is conservative and never sends a second POST or automatic fallback', async () => {
  for (const [response, status] of [[() => Response.json({ code: 40034105, message: 'private raw denial' }), 'blocked'], [() => Response.json({ code: 40034127 }), 'blocked'], [() => new Response('{}', { status: 401 }), 'blocked'], [() => new Response('{}', { status: 429 }), 'unknown'], [() => new Response('{}', { status: 500 }), 'unknown'], [() => Response.json([]), 'unknown'], [() => Response.json({}), 'unknown'], [() => { throw new Error('fixture-sensitive-network-error'); }, 'unknown']]) {
    let posts = 0; const plugin = new QQC2CDelivery({ projectId: binding.projectId, recipientRef: 'developer', api: { fetch: apiFetch(() => { posts++; return response(); }) } });
    const result = await plugin.send(deliveryRequest(), deliveryHost(plugin, readSecret));
    assert.equal(result.status, status); assert.equal(posts, 1); assert.equal(JSON.stringify(result).includes('private raw'), false); assert.equal(JSON.stringify(result).includes('sensitive'), false);
  }
});

test('documented err_code failures override apparent success and never leak provider messages or retry',async()=>{
  for(const payload of [{err_code:40034025,id:'not-a-success',message:'private-value'},{err_code:40034025,code:0},{err_code:0,code:40034025}]){let sends=0;const plugin=new QQC2CDelivery({projectId:binding.projectId,recipientRef:'developer',api:{fetch:apiFetch(()=>{sends++;return Response.json(payload);})}});const result=await plugin.send(deliveryRequest(),deliveryHost(plugin,readSecret));assert.equal(result.status,'rejected');assert.equal(result.errorCode,'QQ_API_40034025');assert.equal(sends,1);assert.equal(JSON.stringify(result).includes('private-value'),false);}
});
test('report Keyboard uses three opaque Host tokens and fixed snapshot; missing handler produces no dead buttons', async () => {
  const request = { ...deliveryRequest(), reportRevision: 2, presentation: { schemaVersion: '1.0', kind: 'report_summary', format: 'markdown', reportId: 'qq-fixture-report', revision: 2, actions: [{ kind: 'report.open_section', section: 'bugs', label: '查看 Bug' }, { kind: 'report.open_section', section: 'suggestions', label: '查看建议' }, { kind: 'report.open_section', section: 'steam_negative_reviews', label: '查看 Steam 差评' }] } };
  const sent = []; const options = { projectId: binding.projectId, recipientRef: 'developer', api: { fetch: apiFetch((_url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ id: 'sent' }); }) } };
  const plugin = new QQC2CDelivery({ ...options, navigationTokens: async () => ['opaque_token_000001', 'opaque_token_000002', 'opaque_token_000003'] });
  assert.equal((await plugin.send(request, deliveryHost(plugin, readSecret))).status, 'accepted');
  const buttons = sent[0].keyboard.content.rows[0].buttons; assert.equal(buttons.length, 3); assert.deepEqual(buttons.map(b => b.action.permission), Array(3).fill({type:2}));
  assert.equal((await plugin.send({ ...request, reportRevision: 1 }, deliveryHost(plugin, readSecret))).status, 'rejected'); assert.equal(sent.length, 1);
  const plain = new QQC2CDelivery(options); await plain.send(request, deliveryHost(plain, readSecret));
  assert.equal(sent[1].keyboard, undefined); assert.match(sent[1].markdown.content, /未启用报告交互导航/);
});
test('durable delivery opt-in, stable identity and commit prevent duplicate sends after reopen', async t => {
  const f = fixture(t); let sends = 0; const api = { fetch: apiFetch(() => { sends++; return Response.json({ id: 'provider-message' }); }) };
  const { service } = deliveryFixture(f, api, { service: { allowWrites: false } }); const id = service.enqueue(deliveryRequest(), 'acceptance');
  assert.equal((await service.tick()).state, 'write_disabled'); assert.equal(sends, 0);
  const live = deliveryFixture(f, api).service; assert.equal((await live.tick()).state, 'succeeded'); assert.equal(sends, 1);
  const reopened = f.open(); const next = deliveryFixture({ ...f, runtime: reopened }, api).service;
  assert.equal(next.enqueue(deliveryRequest(), 'acceptance'), id); assert.equal((await next.tick()).processed, false); assert.equal(sends, 1);
  assert.throws(() => next.enqueue({ ...deliveryRequest(), text: 'different' }, 'acceptance'), /DELIVERY_IDENTITY_CONFLICT/);
  assert.throws(() => next.enqueue({ ...deliveryRequest('not-authorized'), recipientRef: 'other' }, 'acceptance'), /NOT_AUTHORIZED/);
  assert.throws(() => next.enqueue(deliveryRequest('missing-report')), /SEALED_REPORT_NOT_AUTHORIZED/);
  assert.throws(() => deliveryFixture(f, api, { service: { recipientBindingId: 'different-target' } }), /DELIVERY_RECIPIENT_BINDING_CHANGED/);
  assert.equal(count(f.runtime.store, 'external_operation_attempts'), 1);
});
test('actual local HTTP timeout after platform receipt stays unknown across restart without resending', async t => {
  const f = fixture(t); let posts = 0;
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} if (req.url === '/app/getAppAccessToken') res.end(JSON.stringify({ access_token: 'fixture-http-token', expires_in: 7200 })); else { posts++; /* Accepted remotely, but response deliberately lost. */ } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const api = { baseURL: `http://127.0.0.1:${server.address().port}`, allowLoopbackHTTP: true, timeoutMs: 100 };
  const { service } = deliveryFixture(f, api); const id = service.enqueue(deliveryRequest(), 'acceptance');
  assert.equal((await service.tick()).state, 'unknown'); assert.equal(posts, 1); f.advance(3600_000);
  const next = deliveryFixture({ ...f, runtime: f.open() }, api).service; assert.equal((await next.tick()).processed, false); assert.equal(next.get(id).state, 'unknown'); assert.equal(posts, 1);
});
test('only proven pre-dispatch auth failures receive bounded safe retries', async t => {
  const f = fixture(t); let attempts = 0;
  const { service } = deliveryFixture(f, { fetch: async () => { attempts++; return Response.json({ code: 100001 }); } });
  const id = service.enqueue(deliveryRequest(), 'acceptance');
  for (let i = 0; i < 3; i++) { assert.equal((await service.tick()).state, 'safe_retry'); f.advance(31_000); }
  assert.equal((await service.tick()).state, 'manual_review'); assert.equal(attempts, 3); assert.equal(service.get(id).state, 'manual_review');
});
test('real delivery process termination leaves unknown after lease expiry and never replays POST', async t => {
  const f = fixture(t); let resolvePost; const received = new Promise(resolve => { resolvePost = resolve; }); let posts = 0;
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} if (req.url === '/app/getAppAccessToken') res.end(JSON.stringify({ access_token: 'fixture-token', expires_in: 7200 })); else { posts++; resolvePost(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const api = { baseURL: `http://127.0.0.1:${server.address().port}`, allowLoopbackHTTP: true };
  const { service } = deliveryFixture(f, api); const id = service.enqueue(deliveryRequest(), 'acceptance');
  const child = spawn(process.execPath, ['tests/integration/qq-crash-child.mjs', f.filename, api.baseURL, f.clock()], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let error = ''; child.stderr.on('data', b => { error += b; }); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([received, new Promise((_r, reject) => setTimeout(() => reject(new Error(`QQ child did not send: ${error}`)), 5000).unref())]);
  child.kill('SIGKILL'); await once(child, 'exit'); f.advance(61_000);
  const next = deliveryFixture({ ...f, runtime: f.open() }, api).service;
  assert.equal((await next.tick()).processed, false); assert.equal(next.get(id).state, 'unknown'); assert.equal(posts, 1);
});
