import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { QQC2CDelivery } from '@superagent/qq-official';
import { deliveryHost } from '@superagent/plugin-host';
import { openQQ, sourceArgs } from './qq-common.mjs';

const { values } = parseArgs({ options: { ...sourceArgs, output: { type: 'string', default: '.artifacts/qq-capabilities.json' } } });
const controller = new AbortController(); const app = openQQ(values, controller.signal);
try {
  await app.start(); const source = await app.source.probe();
  const plugin = new QQC2CDelivery({ projectId: values.project, recipientRef: 'qq-developer' });
  const delivery = await plugin.probeAuthentication(deliveryHost(plugin, app.getSecret));
  const report = { checkedAt: new Date().toISOString(), sourceId: values.source, source, delivery, actualDelivery: 'not_attempted', callbackDeployment: 'not_performed', note: 'Authentication is not proof of message entitlement, active C2C, Markdown, Keyboard, or receipt.' };
  const output = path.resolve(values.output); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (source.coverage === 'unavailable' || !delivery.authenticated) process.exitCode = 1;
} finally { await app.close(); }
