import { QQSource, qqSignature, QQC2CDelivery } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost } from '@superagent/plugin-host';
import { binding, scope, fixture } from './helpers.mjs';

export const qqSecrets = { QQ_APP_ID: 'qq-fixture-app', QQ_APP_SECRET: 'qq-fixture-secret', QQ_SCOPE_ID: 'group-fixture-private', QQ_PSEUDONYM_KEY: 'fixture-pseudonym-key-at-least-32-bytes', QQ_RECIPIENT_OPENID: 'developer-fixture-private' };
export const readSecret = async key => { if (!(key in qqSecrets)) throw new Error('UNKNOWN_FIXTURE_SECRET'); return qqSecrets[key]; };
export function qqEvent(id = 'message-1', options = {}) {
  return { op: 0, id: `delivery-${id}`, t: options.type ?? 'GROUP_AT_MESSAGE_CREATE', d: {
    id, group_openid: options.scope ?? qqSecrets.QQ_SCOPE_ID, author: { member_openid: 'player-private', user_openid: qqSecrets.QQ_SCOPE_ID },
    content: options.text ?? 'Windows 1.2.0 联机载入90%时崩溃，希望自动重连', timestamp: '2026-11-02T00:00:00.000Z', message_type: 0, ...options.data,
  } };
}
export function signed(payload, clock, overrides = {}) {
  const raw = Buffer.from(JSON.stringify(payload)); const ts = String(Math.floor(Date.parse(clock()) / 1000));
  return [{ 'x-bot-appid': qqSecrets.QQ_APP_ID, 'x-signature-timestamp': ts, 'x-signature-ed25519': qqSignature(qqSecrets.QQ_APP_SECRET, ts, raw), ...overrides }, raw];
}
export async function qqFixture(t, options = {}) {
  const f = fixture(t); const source = new QQSource({ kind: options.kind ?? 'group', sourceUri: binding.sourceUri, now: () => Date.parse(f.clock()), ...options.source });
  const host = f.runtime.ingress.sourceHost(scope, { secretKeys: source.manifest.permissions.secretKeys, getSecret: readSecret });
  const controller = new AbortController(); await source.start(host, controller.signal);
  t.after(async () => { controller.abort(); await source.stop(); });
  return { ...f, source, host, controller, receive: (event, overrides) => source.handleWebhook(...signed(event, f.clock, overrides)) };
}
export const deliveryRequest = (key = 'qq-fixture-once') => ({ deliveryId: '00000000-0000-4000-a000-000000000001', idempotencyKey: key, projectId: binding.projectId, reportId: 'qq-fixture-report', recipientRef: 'developer', title: '[QQ 验收] Test', text: 'Private test message', requestedAt: '2026-11-02T00:00:00.000Z' });
export function deliveryFixture(f, api, overrides = {}) {
  const plugin = new QQC2CDelivery({ projectId: binding.projectId, recipientRef: 'developer', api, ...overrides.plugin });
  const host = deliveryHost(plugin, readSecret);
  const service = new DurableDeliveryService(f.runtime.store, plugin, host, { projectId: binding.projectId, recipientRef: 'developer', recipientBindingId: 'fixture-recipient-binding', clock: f.clock, allowWrites: true, ...overrides.service });
  return { plugin, host, service };
}
