import { SqliteStore } from '@superagent/persistence';
import { QQC2CDelivery } from '@superagent/qq-official';
import { DurableDeliveryService, deliveryHost } from '@superagent/plugin-host';
import { readSecret } from './qq-helpers.mjs';
const [filename, baseURL, clock] = process.argv.slice(2);
const store = new SqliteStore(filename);
const plugin = new QQC2CDelivery({ projectId: 'game-test', recipientRef: 'developer', api: { baseURL, allowLoopbackHTTP: true } });
const service = new DurableDeliveryService(store, plugin, deliveryHost(plugin, readSecret), { projectId: 'game-test', recipientRef: 'developer', recipientBindingId: 'fixture-recipient-binding', allowWrites: true, clock: () => clock });
await service.tick(); store.close();
