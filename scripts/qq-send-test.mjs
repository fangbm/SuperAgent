import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SqliteStore, stableId } from '@superagent/persistence';
import { QQC2CDelivery } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost } from '@superagent/plugin-host';
import { configuredSecrets } from './qq-common.mjs';

const { values } = parseArgs({ options: { database: { type: 'string' }, project: { type: 'string' }, send: { type: 'boolean', default: false }, format: { type: 'string', default: 'markdown' }, 'protected-config': { type: 'string' } } });
if (!values.database || !values.project || !['markdown', 'text'].includes(values.format)) throw new Error('QQ_DATABASE_PROJECT_FORMAT_REQUIRED');
const filename = path.resolve(values.database); mkdirSync(path.dirname(filename), { recursive: true });
const store = new SqliteStore(filename);
try {
  const secrets = configuredSecrets(values);
  const plugin = new QQC2CDelivery({ projectId: values.project, recipientRef: 'qq-developer', format: values.format });
  const recipientBindingId = stableId('qq-recipient', await secrets('QQ_APP_ID'), await secrets('QQ_RECIPIENT_OPENID'));
  const service = new DurableDeliveryService(store, plugin, deliveryHost(plugin, secrets), { projectId: values.project, recipientRef: 'qq-developer', recipientBindingId, allowWrites: values.send });
  const key = `qq-acceptance-v1:${values.project}:${values.format}`;
  const id = stableId('delivery', key);
  // UUID required by the frozen contract; use a deterministic UUID-shaped digest.
  const hex = id.slice(-32); const deliveryId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
  const previous = store.get('SELECT r.request_json FROM plugin_delivery_requests r JOIN external_operations o USING(operation_id) WHERE o.idempotency_key=?', key);
  const requestedAt = previous ? JSON.parse(previous.request_json).requestedAt : new Date().toISOString();
  const request = { deliveryId, idempotencyKey: key, projectId: values.project, reportId: 'qq-live-acceptance', recipientRef: 'qq-developer', title: '[QQ 验收] SuperAgent 私聊链路', text: '这是一条测试消息，用于验证官方机器人开发者私聊发送权限。接口受理不代表已读，请在 QQ 客户端确认是否实际收到。', requestedAt };
  const operationId = service.enqueue(request, 'acceptance');
  const existing = service.get(operationId);
  // Only this prepared operation is eligible; never drain unrelated queued sends.
  let result = existing;
  if (values.send && ['prepared', 'safe_retry'].includes(existing.state)) {
    const other = store.get("SELECT 1 FROM plugin_delivery_requests r JOIN external_operations o USING(operation_id) WHERE plugin_id=? AND project_id=? AND recipient_ref=? AND operation_id<>? AND state IN ('prepared','safe_retry')", plugin.manifest.id, values.project, 'qq-developer', operationId);
    if (other) throw new Error('QQ_UNRELATED_DELIVERY_PENDING');
    await service.tick(); result = service.get(operationId);
  }
  console.log(JSON.stringify({ operationId, preview: !values.send, title: request.title, text: request.text, ...result, actualReceipt: 'requires_recipient_confirmation' }));
  if (values.send && result.state !== 'succeeded') process.exitCode = 1;
} finally { store.close(); }
