// Read-only enrollment helper. Secrets enter through one stdin JSON line, never argv/files.
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { QQAPI, QQGateway, QQError } from '@superagent/qq-official';

const input = createInterface({ input: process.stdin, terminal: false });
const [line] = await once(input, 'line'); input.close();
if (line.length > 8192) throw new Error('QQ_BIND_CONFIG_LIMIT');
const config = JSON.parse(line);
if (![config.appId, config.appSecret, config.groupChallenge, config.developerChallenge].every(v => typeof v === 'string' && v.length > 0 && v.length < 512)) throw new Error('QQ_BIND_CONFIG_REQUIRED');
const controller = new AbortController(); const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
process.on('message', message => { if (message?.type === 'stop') stop(); });
const timer = setTimeout(stop, 10 * 60_000);
let session = null, group = false, developer = false;
const api = new QQAPI(async key => key === 'QQ_APP_ID' ? config.appId : key === 'QQ_APP_SECRET' ? config.appSecret : '');
const gateway = new QQGateway(api, {
  intents: 1 << 25,
  loadSession: async () => session,
  invalidateSession: async () => { session = null; },
  dispatch: async (payload, next) => {
    session = next;
    if (payload.t === 'READY' || payload.t === 'RESUMED') console.log(JSON.stringify({ status: 'connected', receivedAt: new Date().toISOString() }));
    const d = payload.d;
    if (!d || typeof d !== 'object' || typeof d.content !== 'string') return;
    if (!group && ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(payload.t) && d.content.includes(config.groupChallenge) && typeof d.group_openid === 'string') {
      group = true; process.send?.({ type: 'group_binding', openid: d.group_openid });
      console.log(JSON.stringify({ status: 'group_bound', idDigest: createHash('sha256').update(d.group_openid).digest('hex').slice(0, 12), eventType: payload.t }));
    }
    if (!developer && payload.t === 'C2C_MESSAGE_CREATE' && d.content.includes(config.developerChallenge) && typeof d.author?.user_openid === 'string') {
      developer = true; process.send?.({ type: 'developer_binding', openid: d.author.user_openid });
      console.log(JSON.stringify({ status: 'developer_bound', idDigest: createHash('sha256').update(d.author.user_openid).digest('hex').slice(0, 12) }));
    }
    if (group && developer) controller.abort();
  },
  health: async reason => console.log(JSON.stringify({ status: 'connection_status', reason })),
});
try { await gateway.run(controller.signal); }
catch (error) { console.log(JSON.stringify({ status: 'failed', errorCode: error instanceof QQError ? error.code : 'QQ_BIND_FAILED' })); process.exitCode = 1; }
finally {
  clearTimeout(timer); config.appSecret = ''; session = null;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  console.log(JSON.stringify({ status: 'stopped', groupBound: group, developerBound: developer }));
  if (process.connected) process.disconnect();
}
