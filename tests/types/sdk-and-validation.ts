import type { SourcePluginHostV1, DeliveryPluginHostV1, SourcePluginV1, P0AlertDeliveryPluginV1 } from '@superagent/plugin-sdk';
import type { NormalizedEventV1, DeliveryResultV1 } from '@superagent/contracts';
import { validateContract, parseContract } from '@superagent/contract-validation';

declare const sourceHost: SourcePluginHostV1;
declare const deliveryHost: DeliveryPluginHostV1;
declare const plugin: SourcePluginV1;
declare const p0: P0AlertDeliveryPluginV1;
void plugin.start;
void p0.sendP0Alert;
// @ts-expect-error Source Host cannot perform delivery
sourceHost.send;
// @ts-expect-error Source Host cannot modify Issue state
sourceHost.issues;
// @ts-expect-error Delivery Host cannot advance the source cursor
deliveryHost.commitBatch;

const unknownInput: unknown = {};
const result = validateContract('normalized-event-v1', unknownInput);
if (result.valid) {
  const event: NormalizedEventV1 = result.value;
  if (event.type === 'com.superagent.source.coverage.changed.v1') {
    const coverage: string = event.data.coverage;
    void coverage;
  }
}
const delivery: DeliveryResultV1 = parseContract('delivery-result-v1', unknownInput);
void delivery;
// @ts-expect-error Schema name is a closed public registry
validateContract('unregistered-contract', unknownInput);
