import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { openQQ, sourceArgs } from './qq-common.mjs';

const { values } = parseArgs({ options: { ...sourceArgs, port: { type: 'string', default: '8080' } } });
const port = Number(values.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_QQ_PORT');
const controller = new AbortController(); const app = openQQ(values, controller.signal);
let active = 0;
const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') {
    reply(200, { transport: 'qq-webhook', coverage: app.runtime.store.get('SELECT coverage,health_reason FROM sources WHERE source_id=?', values.source) }); return;
  }
  if (req.method !== 'POST' || req.url !== '/qq/events') { reply(404, { error: 'NOT_FOUND' }); return; }
  if (active >= 32) { reply(503, { error: 'QQ_CALLBACK_BUSY' }); req.resume(); return; }
  active++;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.byteLength; if (size > 1_000_000) { reply(413, { error: 'QQ_BODY_LIMIT' }); return; } chunks.push(chunk); }
    const headers = Object.fromEntries(['x-bot-appid', 'x-signature-timestamp', 'x-signature-ed25519'].map(name => [name, typeof req.headers[name] === 'string' ? req.headers[name] : undefined]));
    const result = await app.source.handleWebhook(headers, Buffer.concat(chunks)); reply(result.statusCode, result.body);
  } catch { if (!res.headersSent) reply(503, { error: 'QQ_CALLBACK_FAILED' }); }
  finally { active--; }
});
let timer;
const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
const control = message => { if (message?.type === 'stop') stop(); }; process.on('message', control);
try {
  await app.start();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(JSON.stringify({ status: 'listening', transport: values.transport, url: `http://127.0.0.1:${server.address().port}/qq/events`, sourceId: values.source, livePlatformAcceptance: 'pending_authenticated_event' }));
  timer = setInterval(() => { try { app.runtime.tick(); } catch { console.error('QQ_ADMISSION_TICK_FAILED'); } }, 1000);
  await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', resolve, { once: true }); });
} finally {
  controller.abort(); if (timer) clearInterval(timer);
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  await app.source.stop(); app.runtime.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  process.removeListener('message', control); if (process.connected) process.disconnect();
}
