import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../../scripts/core-runtime.mjs';
import { readFileSync } from 'node:fs';
import { fixture, binding, event } from './helpers.mjs';

test('main owns community submission transactions and repairs legacy state before loading the platform adapter', async t => {
  const f = fixture(t);
  f.runtime.ingress.commitBatch(binding, [event('pre-existing-qq')]); f.runtime.tick();
  const botConfig = { ...JSON.parse(readFileSync('community/idle-abyss-princesses/bot-config.json', 'utf8')),
    guildId: '100', projectId: binding.projectId, privateProjectId: 'core-private' };
  const sources = [
    { projectId: binding.projectId, sourceId: 'core-public', sourceUri: 'urn:superagent:source:discord:100:public', platform: 'discord', policy: { visibility: 'public', processingMode: 'standard' } },
    { projectId: 'core-private', sourceId: 'core-private', sourceUri: 'urn:superagent:source:discord:100:tickets', platform: 'discord', policy: { visibility: 'staff', processingMode: 'archive_only' } },
  ];
  const config = { schemaVersion: 1, database: f.filename, projectId: binding.projectId, sources,
    plugins: [{ kind: 'discord-community', sourceId: 'core-public', privateSourceId: 'core-private', config: botConfig }] };
  let host;
  const open = () => createCore(config, { clock: f.clock, policy: f.policy, env: { DISCORD_BOT_TOKEN: 'fixture-token-only' }, communityFactory(_config, bound) {
    host = bound;
    assert.equal('runtime' in bound, false); assert.equal('store' in bound.state, false);
    assert.equal('setSourcePolicy' in bound, false); assert.equal('store' in bound.privateArchive, false);
    return { async start() {}, async stop() {} };
  } });
  const submission = (id, user = '700') => ({ specversion: '1.0', id: 'discord-community:' + id, source: sources[1].sourceUri,
    type: 'com.superagent.feedback.message.created.v1', time: f.clock(), datacontenttype: 'application/json',
    data: { schemaVersion: '1.0', projectId: 'core-private', sourceId: 'core-private', platform: 'discord',
      object: { kind: 'message', externalId: id, revision: 'form-v1' }, actor: { opaqueId: user }, content: { text: '[bug] Crash\n\nOriginal details' },
      attributes: { guildId: '100', ticketKind: 'bug', interactionId: id, native: { interactionId: id, title: 'Crash', body: 'Original details', kind: 'bug' } } } });
  let app = await open();
  try {
    const result = await host.submitTicket(submission('9101'));
    assert.equal(result.status, 'created');
    assert.equal((await host.state.get('ticket:9101')).evidenceEventId, result.eventId);
    app.runtime.store.exec("CREATE TRIGGER reject_ticket BEFORE INSERT ON community_state WHEN NEW.state_key='ticket:9102' BEGIN SELECT RAISE(ABORT,'INJECTED_STATE_FAILURE'); END;");
    await assert.rejects(host.submitTicket(submission('9102', '701')), /INJECTED_STATE_FAILURE/);
    assert.equal(app.runtime.store.get("SELECT 1 FROM source_events WHERE external_event_id='discord-community:9102'"), undefined);
    assert.equal(await host.state.get('ticket:open:701'), null);
    app.runtime.store.exec('DROP TRIGGER reject_ticket;');
    // Simulate old code's archived form + pending lock, with no Interaction replay on replacement.
    const orphan = submission('9103', '702');
    const receipt = app.runtime.ingress.commitBatch({ projectId: 'core-private', sourceId: 'core-private' }, [orphan]);
    await host.state.set('ticket:open:702', 'pending:9103');
    await app.close(); app = await open();
    assert.equal((await host.state.get('ticket:9103')).evidenceEventId, receipt.refs[0].eventId);
    assert.equal(await host.state.get('ticket:open:702'), '9103');
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?', 'core-private').n, 2);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM admission_decisions a JOIN source_events e USING(event_id) WHERE e.source_id=?', 'core-private').n, 0);
    assert.equal(app.runtime.store.get('SELECT 1 FROM source_policies WHERE source_id=?', binding.sourceId), undefined);
  } finally { await app.close(); }
});
