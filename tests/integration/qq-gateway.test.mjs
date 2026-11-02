import assert from 'node:assert/strict';
import test from 'node:test';
import { QQGateway, QQSource } from '@superagent/qq-official';
import { fixture, binding, scope, count } from './helpers.mjs';
import { qqEvent, readSecret } from './qq-helpers.mjs';

class FakeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent = [];
  constructor(onSend) { super(); this.onSend = onSend; queueMicrotask(() => this.message({ op: 10, d: { heartbeat_interval: 20 } })); }
  message(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
  send(raw) { const payload = JSON.parse(raw); this.sent.push(payload); this.onSend(payload, this); }
  close() { this.readyState = WebSocket.CLOSED; }
  closed(code) { this.readyState = WebSocket.CLOSED; const event = new Event('close'); Object.defineProperty(event, 'code', { value: code }); this.dispatchEvent(event); }
}
const api = { gateway: async () => 'ws://fixture.invalid', accessToken: async () => 'fixture-token' };
const until = async predicate => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('QQ_GATEWAY_FIXTURE_TIMEOUT'); await new Promise(r => setTimeout(r, 5)); } };
test('Gateway identifies and advances heartbeat sequence only after durable dispatch resolves', async () => {
  const controller = new AbortController(); let saved = null, socket, release, entered = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const gateway = new QQGateway(api, { intents: 1 << 25, loadSession: async () => saved, invalidateSession: async () => { saved = null; }, dispatch: async (payload, session) => { if (payload.s === 2) { entered = true; await blocked; } saved = session; }, createSocket: () => socket = new FakeSocket((p, ws) => { if (p.op === 2) { assert.equal(p.d.token, 'QQBot fixture-token'); ws.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'fixture-session' } }); } if (p.op === 1) ws.message({ op: 11 }); }) });
  const run = gateway.run(controller.signal); await until(() => saved?.seq === 1);
  socket.message({ op: 0, s: 2, ...qqEvent(), t: 'GROUP_AT_MESSAGE_CREATE' }); await until(() => entered);
  await until(() => socket.sent.some(p => p.op === 1)); assert.equal(socket.sent.filter(p => p.op === 1).at(-1).d, 1);
  release(); await until(() => saved.seq === 2); controller.abort(); await run;
});
test('Gateway resumes from committed cursor after reconnect and invalid session causes fresh Identify', async () => {
  const controller = new AbortController(); let saved = null, connections = 0, invalidations = 0; const auth = [];
  const gateway = new QQGateway(api, { intents: 1 << 25, backoffMs: 1, loadSession: async () => saved, invalidateSession: async () => { saved = null; invalidations++; }, dispatch: async (p, s) => { saved = s; if (p.t === 'READY' && connections === 1) setTimeout(() => sockets[0].message({ op: 7 }), 1); if (p.t === 'RESUMED') setTimeout(() => sockets[1].message({ op: 9, d: false }), 1); if (p.t === 'READY' && connections === 3) controller.abort(); }, createSocket: () => { const n = ++connections; const ws = new FakeSocket((p, socket) => { if (p.op === 1) socket.message({ op: 11 }); if (p.op === 2 || p.op === 6) { auth.push(p); socket.message({ op: 0, s: n, t: p.op === 2 ? 'READY' : 'RESUMED', d: p.op === 2 ? { session_id: 'fixture-session' } : {} }); } }); sockets.push(ws); return ws; } });
  const sockets = []; await gateway.run(controller.signal);
  assert.deepEqual(auth.map(a => a.op), [2, 6, 2]); assert.equal(auth[1].d.seq, 1); assert.equal(invalidations, 1);
});
test('Gateway closes on lost heartbeat and stops on permanent intent rejection', async () => {
  const controller = new AbortController(); let connections = 0;
  const gateway = new QQGateway(api, { intents: 1 << 25, backoffMs: 1, loadSession: async () => null, invalidateSession: async () => {}, dispatch: async () => {}, createSocket: () => { const n = ++connections; return new FakeSocket((p, socket) => { if (p.op === 2) { if (n === 2) { socket.closed(4014); return; } socket.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'fixture-session' } }); } }); } });
  await assert.rejects(gateway.run(controller.signal), /QQ_GATEWAY_CLOSE_4014/); assert.equal(connections, 2);
});
test('Gateway failed Host commit never advances Resume cursor or silently consumes the message', async () => {
  let saved = { sessionId: 'fixture-session', seq: 1 }; const resumes = [];
  const gateway = new QQGateway(api, { intents: 1 << 25, backoffMs: 1, maxFailures: 2, loadSession: async () => saved, invalidateSession: async () => { saved = null; }, dispatch: async () => { throw new Error('fixture-db-failure'); }, createSocket: () => new FakeSocket((p, socket) => { if (p.op === 6) { resumes.push(p.d.seq); socket.message({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', d: qqEvent().d }); } if (p.op === 1) socket.message({ op: 11 }); }) });
  await assert.rejects(gateway.run(new AbortController().signal), /QQ_GATEWAY_RECONNECT_BUDGET/); assert.deepEqual(resumes, [1, 1]); assert.equal(saved.seq, 1);
});
test('QQ Source Gateway stores message and sequence atomically, resumes on reopen, and has no send route', async t => {
  const f = fixture(t); const sockets = [];
  const options = { kind: 'group', sourceUri: binding.sourceUri, transport: 'websocket', now: () => Date.parse(f.clock()), api: { allowLoopbackHTTP: true, fetch: async url => Response.json(String(url).endsWith('/app/getAppAccessToken') ? { access_token: 'fixture-token', expires_in: 7200 } : { url: 'ws://localhost/gateway' }) }, gateway: { createSocket: () => { const ws = new FakeSocket((p, socket) => { if (p.op === 1) socket.message({ op: 11 }); if (p.op === 2) { socket.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'fixture-session' } }); socket.message({ ...qqEvent(), s: 2 }); } if (p.op === 6) socket.message({ op: 0, s: 3, t: 'RESUMED', d: {} }); }); sockets.push(ws); return ws; } } };
  const host = f.runtime.ingress.sourceHost(scope, { secretKeys: ['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_SCOPE_ID', 'QQ_PSEUDONYM_KEY'], getSecret: readSecret });
  const source = new QQSource(options); await source.start(host, new AbortController().signal);
  await until(() => count(f.runtime.store, 'source_events') === 1); const cp = f.runtime.ingress.getCheckpoint(scope);
  assert.equal(cp.gateway.seq, 2); assert.equal(JSON.stringify(cp).includes('fixture-token'), false); assert.equal((await source.handleWebhook({}, Buffer.from('{}'))).statusCode, 403);
  await source.stop(); const next = new QQSource(options); await next.start(host, new AbortController().signal);
  try { await until(() => f.runtime.ingress.getCheckpoint(scope).gateway.seq === 3); assert.equal(sockets[1].sent.find(p => p.op === 6).d.seq, 2); assert.equal(count(f.runtime.store, 'source_events'), 1); } finally { await next.stop(); }
});
