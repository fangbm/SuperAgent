import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
export const nativeFixture = name => JSON.parse(readFileSync(new URL('../fixtures/m4/' + name + '.json', import.meta.url), 'utf8'));
export const signal = () => new AbortController().signal;
export function connectorFixture(t, platform, secretKeys = []) {
  const f = fixture(t);
  const binding = { projectId: 'm4-game', sourceId: platform + '-main', sourceUri: 'urn:superagent:source:' + platform, platform };
  f.runtime.ingress.registerSource(binding);
  const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
  const getHost = runtime => runtime.ingress.sourceHost(scope, { secretKeys, getSecret: async () => 'test-bot-secret' });
  const events = runtime => runtime.store.all('SELECT payload_json FROM source_events WHERE source_id=? ORDER BY rowid', binding.sourceId).map(row => JSON.parse(row.payload_json));
  return { ...f, binding, scope, host: getHost(f.runtime), getHost, events };
}
