import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createCore } from '../../scripts/core-runtime.mjs';
import { modelServer } from './m3-helpers.mjs';
import { fixture, event, binding, defaultPolicy } from './helpers.mjs';

test('a loaded source submits material and the existing Core M3 worker analyzes the committed archive', async t => {
  const f = fixture(t);
  const server = await modelServer(t);
  const publicBinding = { ...binding, sourceId: 'core-discord', sourceUri: 'urn:source:core-discord', platform: 'discord',
    policy: { visibility: 'public', processingMode: 'standard' } };
  const input = event('core-first'); input.source = publicBinding.sourceUri;
  Object.assign(input.data, { sourceId: publicBinding.sourceId, platform: publicBinding.platform });
  let committedId;
  const plugin = {
    manifest: { permissions: { secretKeys: [] } },
    async sync(host) {
      const receipt = await host.commitBatch([input]); committedId = receipt.refs[0].eventId;
      assert.equal('setSourcePolicy' in host, false); assert.equal('store' in host, false);
    }, async start() {}, async stop() {},
  };
  const config = { schemaVersion: 1, projectId: binding.projectId, database: path.join(f.directory, 'core-model.sqlite'),
    sources: [publicBinding], plugins: [{ kind: 'discord', sourceId: publicBinding.sourceId, config: { sourceUri: publicBinding.sourceUri } }], analysis: { enabled: true } };
  const app = await createCore(config, { clock: f.clock, policy: { ...defaultPolicy, auditSampleRate: 0 }, sourceFactories: { discord: () => plugin },
    env: { SA_LLM_BASE_URL: server.baseURL, SA_LLM_MODEL: 'fixture-model', SA_LLM_API_KEY: 'fixture-only', SA_ALLOW_LOOPBACK_HTTP: '1' } });
  try {
    await app.run({ once: true });
    assert.ok(committedId);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n, 1);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM admission_decisions').n, 1);
    for (const segment of app.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'")) app.runtime.buffer.flushSync(segment.segment_id, 'replay');
    const result = await app.tick();
    assert.equal(result.analysis.status, 'succeeded');
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM issues').n, 1);
    assert.ok(server.requests.length > 0);
    assert.ok(server.requests[0].task.messages.some(message => message.eventId === committedId && message.text === input.data.content.text));
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n, 1);
  } finally { await app.close(); }
});
