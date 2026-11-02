import type { SourcePluginV1, DeliveryPluginV1 } from '@superagent/plugin-sdk';
import { QQSource, QQC2CDelivery } from '@superagent/qq-official';
const source: SourcePluginV1 = new QQSource({ kind: 'group', sourceUri: 'urn:superagent:source:qq-test' });
const delivery: DeliveryPluginV1 = new QQC2CDelivery({ projectId: 'test', recipientRef: 'approved-developer' });
void source; void delivery;
// @ts-expect-error Source has no send capability.
source.send;
// @ts-expect-error Delivery has no database/ingress capability.
delivery.commitBatch;
