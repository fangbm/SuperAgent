import { openCoreStore } from './core-store.mjs';
import { configuredSecrets } from './qq-secrets.mjs';
import { createQQWebhookServer } from './qq-webhook.mjs';
import { QQSource } from '@superagent/qq-official';

const sourceArgs = { database: { type: 'string' }, project: { type: 'string' }, source: { type: 'string' }, kind: { type: 'string', default: 'group' }, transport: { type: 'string', default: 'webhook' }, 'protected-config': { type: 'string' } };

export function openQQ(values, signal = new AbortController().signal) {
  if (!values.database || !values.project || !values.source || !['group', 'channel', 'c2c'].includes(values.kind ?? 'group') || !['webhook', 'websocket'].includes(values.transport ?? 'webhook')) throw new Error('QQ_DATABASE_PROJECT_SOURCE_KIND_TRANSPORT_REQUIRED');
  const binding = { projectId: values.project, sourceId: values.source, sourceUri: `urn:superagent:source:${encodeURIComponent(values.source)}`, platform: 'qq-official' };
  const core = openCoreStore({ database: values.database, sources: [{ ...binding, policy: { processingMode: 'standard', visibility: 'public' } }] });
  try {
    const source = new QQSource({ kind: values.kind ?? 'group', sourceUri: binding.sourceUri, transport: values.transport ?? 'webhook' });
    const getSecret = configuredSecrets(values);
    const host = core.registry.sourceHost({ projectId: binding.projectId, sourceId: binding.sourceId }, { secretKeys: source.manifest.permissions.secretKeys, getSecret });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await source.stop(); } finally { core.close(); }
    };
    return {
      runtime: core.runtime, source, start: () => source.start(host, signal), filename: core.filename, getSecret,
      health: () => core.runtime.store.get('SELECT coverage,health_reason FROM sources WHERE source_id=? AND project_id=?', binding.sourceId, binding.projectId),
      tick: () => core.runtime.tick(), close,
    };
  } catch (error) { core.close(); throw error; }
}

export async function runQQSource(values) {
  const port = Number(values.port ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_QQ_PORT');
  const controller = new AbortController();
  const app = openQQ(values, controller.signal);
  const server = createQQWebhookServer(app.source, app.health);
  let timer;
  const stop = () => controller.abort();
  const control = message => { if (message?.type === 'stop') stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('message', control);
  try {
    await app.start();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.log(JSON.stringify({ status: 'listening', transport: values.transport, url: `http://127.0.0.1:${server.address().port}/qq/events`, sourceId: values.source, livePlatformAcceptance: 'pending_authenticated_event' }));
    timer = setInterval(() => { try { app.tick(); } catch { console.error('QQ_ADMISSION_TICK_FAILED'); } }, 1000);
    await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', resolve, { once: true }); });
  } finally {
    stop(); if (timer) clearInterval(timer);
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await app.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.removeListener('message', control); if (process.connected) process.disconnect();
  }
}

export { sourceArgs };
