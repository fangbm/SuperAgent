import { M1Runtime } from '@superagent/agent-core';
import { CommunitySubmissions, DurableCommunityState } from '@superagent/plugin-host';
import { defaultPolicy, initial } from './helpers.mjs';

const [filename, scenario] = process.argv.slice(2);
const guildId = '100';
const binding = { projectId: 'ticket-crash-private', sourceId: 'discord-100-tickets', sourceUri: 'urn:superagent:source:discord:100:tickets', platform: 'discord' };
const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
const runtime = new M1Runtime(filename, { policy: { ...defaultPolicy, auditSampleRate: 0 }, clock: () => initial });
runtime.ingress.registerSource(binding);
runtime.ingress.setSourcePolicy(scope, { visibility: 'staff', processingMode: 'archive_only' });
const state = new DurableCommunityState(runtime.store, `discord-community:${guildId}`, { clock: () => initial, leaseOwner: 'crashed-ticket-controller' });
if (!state.acquireLease('crashed-ticket-controller', 45_000)) throw new Error('TEST_LEASE_NOT_ACQUIRED');
const submissions = new CommunitySubmissions(runtime.ingress, state, { scope, guildId, clock: () => initial });
const event = {
  specversion: '1.0', id: 'discord-community:9901', source: binding.sourceUri,
  type: 'com.superagent.feedback.message.created.v1', time: initial, datacontenttype: 'application/json',
  data: { schemaVersion: '1.0', projectId: scope.projectId, sourceId: scope.sourceId, platform: 'discord',
    object: { kind: 'message', externalId: '9901', revision: 'crash-fixture' }, actor: { opaqueId: '700' },
    content: { text: '[bug] Crash fixture\n\nSynthetic process crash test.' }, origin: { permalink: `https://discord.com/channels/${guildId}/200` },
    attributes: { guildId, ticketKind: 'bug', interactionId: '9901', native: { title: 'Crash fixture', body: 'Synthetic process crash test.', kind: 'bug', interactionId: '9901', channelId: '200' } } },
};

if (scenario === 'mid-transaction') {
  const set = state.setSync.bind(state);
  state.setSync = (key, value) => {
    if (key === 'ticket:9901') {
      process.stdout.write('READY\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return set(key, value);
  };
} else if (scenario !== 'committed') throw new Error('UNKNOWN_TEST_SCENARIO');

submissions.submitTicket(event);
process.stdout.write('READY\n');
setInterval(() => {}, 1_000);
