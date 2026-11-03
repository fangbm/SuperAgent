import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunitySubmissions, DurableCommunityState } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';

const guild = '100';
const binding = { projectId: 'tickets-private', sourceId: 'discord-tickets', sourceUri: `urn:superagent:source:discord:${guild}:tickets`, platform: 'discord' };
const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
function setup(runtime, clock, owner = 'tickets-controller') {
  runtime.ingress.registerSource(binding);
  runtime.ingress.setSourcePolicy(scope, { visibility: 'staff', processingMode: 'archive_only' });
  const state = new DurableCommunityState(runtime.store, `discord-community:${guild}`, { clock, leaseOwner: owner });
  assert.equal(state.acquireLease(owner, 45_000), true);
  const submissions = new CommunitySubmissions(runtime.ingress, state, { scope, guildId: guild, clock });
  return { state, submissions };
}
function event(id, user = '700', title = 'Crash', body = 'Description') {
  const kind = 'bug';
  return {
    specversion: '1.0', id: `discord-community:${id}`, source: binding.sourceUri,
    type: 'com.superagent.feedback.message.created.v1', time: '2026-11-02T00:00:00.000Z', datacontenttype: 'application/json',
    data: { schemaVersion: '1.0', projectId: scope.projectId, sourceId: scope.sourceId, platform: 'discord',
      object: { kind: 'message', externalId: id, revision: `${title}:${body}` }, actor: { opaqueId: user },
      content: { text: `[${kind}] ${title}\n\n${body}` }, origin: { permalink: `https://discord.com/channels/${guild}/200` },
      attributes: { guildId: guild, ticketKind: kind, interactionId: id,
        native: { title, body, kind, interactionId: id, channelId: '200' } } },
  };
}

test('ticket event and lifecycle writes roll back together on a late state failure', t => {
  const f = fixture(t); const { state, submissions } = setup(f.runtime, f.clock);
  f.runtime.store.run(`CREATE TRIGGER fail_ticket_receipt BEFORE INSERT ON community_state
    WHEN NEW.state_key='interaction:9301' BEGIN SELECT RAISE(ABORT,'INJECTED_TICKET_RECEIPT_FAILURE'); END`);
  assert.throws(() => submissions.submitTicket(event('9301')), /INJECTED_TICKET_RECEIPT_FAILURE/);
  assert.equal(f.runtime.store.get('SELECT 1 FROM source_events WHERE source_id=?', scope.sourceId), undefined);
  assert.equal(state.getSync('ticket:9301'), null);
  assert.equal(state.getSync('ticket:open:700'), null);
  f.runtime.store.run('DROP TRIGGER fail_ticket_receipt');
  assert.equal(submissions.submitTicket(event('9301')).status, 'created');
});

test('committed event recovers ticket intents after restart without Interaction replay', t => {
  const f = fixture(t); const before = setup(f.runtime, f.clock, 'before-restart');
  const result = before.submissions.submitTicket(event('9302', '701', 'Private title', 'PRIVATE-BODY-SENTINEL'));
  assert.equal(result.status, 'created');
  const hostId = result.eventId;
  f.runtime.close(); f.advance(45_001);
  const reopened = f.open(); const after = setup(reopened, f.clock, 'after-restart');
  // Simulate a legacy archived orphan by removing its lifecycle records after commit.
  reopened.store.run("DELETE FROM community_state WHERE namespace=? AND state_key IN ('ticket:9302','ticket:open:701','interaction:9302')", `discord-community:${guild}`);
  assert.deepEqual(after.submissions.recover(), { recovered: 1, staleLocksCleared: 0 });
  assert.equal(after.state.getSync('ticket:9302').status, 'pending_create');
  assert.equal(after.state.getSync('ticket:9302').evidenceEventId, hostId);
  assert.equal(after.state.getSync('interaction:9302').eventId, hostId);
  assert.doesNotMatch(JSON.stringify(after.state.listSync('')), /PRIVATE-BODY-SENTINEL/);
  assert.equal(reopened.store.get('SELECT count(*) n FROM source_events WHERE source_id=?', scope.sourceId).n, 1);
});

test('same-player concurrent submissions archive distinct forms but create one open ticket', t => {
  const f = fixture(t); const { submissions, state } = setup(f.runtime, f.clock);
  const a = submissions.submitTicket(event('9310', '710', 'First', 'Form one'));
  const b = submissions.submitTicket(event('9311', '710', 'Second', 'Form two'));
  assert.equal(a.status, 'created'); assert.equal(b.status, 'existing');
  assert.equal(a.ticketId, b.ticketId);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?', scope.sourceId).n, 2);
  assert.equal(state.getSync('ticket:open:710'), '9310');
});

test('same interaction replay requires exact payload and lease ownership', t => {
  const f = fixture(t); const { submissions } = setup(f.runtime, f.clock, 'owner-one');
  const original = event('9320');
  assert.equal(submissions.submitTicket(original).status, 'created');
  assert.equal(submissions.submitTicket(original).status, 'replayed');
  assert.throws(() => submissions.submitTicket(event('9320', '700', 'Changed title')), /COMMUNITY_INTERACTION_IDENTITY_CONFLICT/);
  f.advance(45_001);
  const replacement = new DurableCommunityState(f.runtime.store, `discord-community:${guild}`, { clock: f.clock, leaseOwner: 'owner-two' });
  assert.equal(replacement.acquireLease('owner-two', 45_000), true);
  assert.throws(() => submissions.submitTicket(event('9321')), /COMMUNITY_LEASE_LOST/);
});

test('recovery clears a pending reservation only after exact private-event lookup finds no match', t => {
  const f = fixture(t); const { submissions, state } = setup(f.runtime, f.clock);
  state.setSync('ticket:open:799', 'pending:9399');
  assert.deepEqual(submissions.recover(), { recovered: 0, staleLocksCleared: 1 });
  assert.equal(state.getSync('ticket:open:799'), '');
});

test('legacy archived pending lock recovers to its exact ticket ID', t => {
  const f = fixture(t); const { submissions, state } = setup(f.runtime, f.clock);
  const orphan = event('9398', '798', 'Legacy orphan', 'Archived before lifecycle initialization');
  const archived = f.runtime.ingress.commitBatch(scope, [orphan]);
  state.setSync('ticket:open:798', 'pending:9398');
  assert.deepEqual(submissions.recover(), { recovered: 1, staleLocksCleared: 0 });
  assert.equal(state.getSync('ticket:open:798'), '9398');
  assert.equal(state.getSync('ticket:9398').evidenceEventId, archived.refs[0].eventId);
});

test('legacy orphan recovery replaces a stale closed index immediately', t => {
  const f = fixture(t); const { submissions, state } = setup(f.runtime, f.clock);
  const orphan = event('9396', '796', 'Recovered request', 'Archived before lifecycle state');
  f.runtime.ingress.commitBatch(scope, [orphan]);
  state.setSync('ticket:9395', { version: 1, id: '9395', userId: '796', kind: 'bug', status: 'closed', evidenceEventId: 'legacy-host-id', createdAt: '2026-11-01T00:00:00.000Z', createMarker: 'superagent-ticket:9395' });
  state.setSync('ticket:open:796', '9395');
  submissions.recover();
  assert.equal(state.getSync('ticket:9395').status, 'closed');
  assert.equal(state.getSync('ticket:9396').status, 'pending_create');
  assert.equal(state.getSync('ticket:open:796'), '9396');
});

test('recovery preserves closed history and repairs only the current active ticket index', t => {
  const f = fixture(t); const { submissions, state } = setup(f.runtime, f.clock);
  submissions.submitTicket(event('9401', '720', 'Closed request', 'Old body'));
  state.setSync('ticket:9401', { ...state.getSync('ticket:9401'), status: 'closed' });
  state.setSync('ticket:open:720', '');
  const extra = event('9402', '720', 'Additional archived form', 'Belonged to the old ticket');
  const archived = f.runtime.ingress.commitBatch(scope, [extra]);
  state.setSync('interaction:9402', { status: 'archived', ticketId: '9401', eventId: archived.refs[0].eventId });
  submissions.submitTicket(event('9403', '720', 'New request', 'New open ticket'));
  state.setSync('ticket:open:720', '');
  submissions.recover();
  assert.equal(state.getSync('ticket:9401').status, 'closed');
  assert.equal(state.getSync('ticket:9402'), null);
  assert.equal(state.getSync('ticket:open:720'), '9403');
});
