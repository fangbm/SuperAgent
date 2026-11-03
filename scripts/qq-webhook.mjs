import { createServer } from 'node:http';

/** Platform transport only. All persistence and source health come from Core callbacks. */
export function createQQWebhookServer(source, health) {
  let active = 0;
  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') { reply(200, { transport: 'qq-webhook', coverage: health() }); return; }
    if (req.method !== 'POST' || req.url !== '/qq/events') { reply(404, { error: 'NOT_FOUND' }); return; }
    if (active >= 32) { reply(503, { error: 'QQ_CALLBACK_BUSY' }); req.resume(); return; }
    active++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.byteLength; if (size > 1000000) { reply(413, { error: 'QQ_BODY_LIMIT' }); return; } chunks.push(chunk); }
      const headers = Object.fromEntries(['x-bot-appid', 'x-signature-timestamp', 'x-signature-ed25519'].map(name => [name, typeof req.headers[name] === 'string' ? req.headers[name] : undefined]));
      const result = await source.handleWebhook(headers, Buffer.concat(chunks)); reply(result.statusCode, result.body);
    } catch { if (!res.headersSent) reply(503, { error: 'QQ_CALLBACK_FAILED' }); }
    finally { active--; }
  });
}
