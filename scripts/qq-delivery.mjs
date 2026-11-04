import { QQC2CDelivery } from '@superagent/qq-official';
import { validatePlugin } from './plugin-validation.mjs';

// Existing single-product Delivery binding; deliberately outside the Source Registry.
export const createDelivery=config=>new QQC2CDelivery(config);
export const validateDelivery=(plugin,entry)=>validatePlugin(plugin,entry,{id:'qq-official-c2c-delivery',kind:'delivery'});
