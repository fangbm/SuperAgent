import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeDiscordMessage } from '@superagent/connector-discord';
import { normalizeSteamReview } from '@superagent/connector-steam-reviews';
import { normalizeDiscussion } from '@superagent/connector-steam-discussions';
import { fixture, event } from './helpers.mjs';
import { createCore } from '../../scripts/core-runtime.mjs';

const publicProject = 'game-test';
const normalizedAt = '2026-11-02T00:00:00.000Z';
const bindings = [
  { projectId: publicProject, sourceId: 'discord-main', sourceUri: 'urn:superagent:source:discord-main', platform: 'discord', policy: { processingMode: 'standard', visibility: 'public' } },
  { projectId: publicProject, sourceId: 'steam-review-main', sourceUri: 'urn:superagent:source:steam-review-main', platform: 'steam-reviews', policy: { processingMode: 'standard', visibility: 'public' } },
  { projectId: publicProject, sourceId: 'steam-discussion-main', sourceUri: 'urn:superagent:source:steam-discussion-main', platform: 'steam-discussions', policy: { processingMode: 'standard', visibility: 'public' } },
  { projectId: 'staff-project', sourceId: 'steam-discussion-private', sourceUri: 'urn:superagent:source:steam-discussion-private', platform: 'steam-discussions', policy: { processingMode: 'archive_only', visibility: 'staff' } },
];
const pluginConfig = {
  'discord-main': { sourceUri: bindings[0].sourceUri, guildId: '100', channelIds: ['200'] },
  'steam-review-main': { sourceUri: bindings[1].sourceUri, appId: 123 },
  'steam-discussion-main': { sourceUri: bindings[2].sourceUri, appId: 123 },
  'steam-discussion-private': { sourceUri: bindings[3].sourceUri, appId: 456 },
};
function eventFor(binding) {
  const config = pluginConfig[binding.sourceId];
  const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
  if (binding.platform === 'discord') return normalizeDiscordMessage({ id: '123456789012345678', guild_id: '100', channel_id: '200',
    author: { id: '222222222222222222' }, content: '联机加载到90%时崩溃', timestamp: normalizedAt }, 'created', config, scope,
  { eventKey: 'fixture:discord:1', receivedAt: normalizedAt });
  if (binding.platform === 'steam-reviews') return normalizeSteamReview({ recommendationid: '18446744073709550001',
    author: { steamid: '76561198000000001' }, language: 'schinese', review: '联机加载到90%时崩溃', voted_up: false,
    timestamp_created: 1793577600, timestamp_updated: 1793577600 }, config, scope);
  return normalizeDiscussion({ kind: 'thread', id: binding.sourceId === 'steam-discussion-private' ? '3002' : '3001',
    threadId: binding.sourceId === 'steam-discussion-private' ? '3002' : '3001', title: '联机问题',
    body: '联机加载到90%时崩溃', createdAt: normalizedAt }, config, scope);
}
function fakeSourceFactory(config) {
  const ownBinding = bindings.find(item => item.sourceUri === config.sourceUri);
  assert.ok(ownBinding);
  const manifest = Object.freeze({ apiVersion: 'superagent.io/plugin/v1', id: 'fixture.' + ownBinding.platform,
    version: '0.0.0', displayName: 'Fixture source', kind: 'source', engine: Object.freeze({ sdk: '^0.1.0' }),
    permissions: Object.freeze({ secretKeys: Object.freeze([]) }) });
  let host;
  return Object.freeze({ manifest,
    async start(boundHost) { host = boundHost; },
    async sync(boundHost) {
      host = boundHost;
      assert.equal(Object.isFrozen(boundHost), true);
      assert.equal('setSourcePolicy' in boundHost, false);
      await boundHost.commitBatch([eventFor(ownBinding)]);
    },
    async stop() {},
    async probe() { return { coverage: 'full' }; },
    get lastHost() { return host; },
  });
}
function config(database) {
  return { schemaVersion: 1, database, projectId: publicProject, sources: bindings,
    plugins: bindings.map(binding => ({ kind: binding.platform, sourceId: binding.sourceId, config: pluginConfig[binding.sourceId] })),
    analysis: { enabled: true }, web: { enabled: false }, githubWrite: false };
}
const sourceFactories = Object.fromEntries(['discord', 'steam-reviews', 'steam-discussions'].map(kind => [kind, fakeSourceFactory]));

test('createCore runs configured plugins on one runtime and preserves existing/unlisted and private source policies through restart', async t => {
  const f = fixture(t);
  const qqScope = { projectId: f.runtime.store.get("SELECT project_id FROM sources WHERE source_id='qq-main'").project_id, sourceId: 'qq-main' };
  f.runtime.ingress.setSourcePolicy(qqScope, { processingMode: 'standard', visibility: 'public' });
  f.runtime.ingress.commitBatch(qqScope, [event('qq-before-core')]);
  const qqBefore = f.runtime.store.get('SELECT project_id,source_uri,platform FROM sources WHERE source_id=?', 'qq-main');
  const qqPolicyBefore = f.runtime.store.get('SELECT processing_mode,visibility FROM source_policies WHERE source_id=?', 'qq-main');
  const policy = JSON.parse(JSON.stringify(f.policy));
  const analysisSnapshots = [];
  const analysisFactory = runtime => ({
    async tick() {
      const visible = runtime.store.all(`SELECT e.source_id FROM source_events e JOIN source_policies p USING(source_id)
        JOIN admission_decisions a USING(event_id) WHERE p.processing_mode='standard' AND a.decision<>'archive_only' ORDER BY e.source_id`);
      analysisSnapshots.push({ runtime, visible: visible.map(row => row.source_id), events: runtime.store.get('SELECT count(*) n FROM source_events').n });
      return { analysis: { status: 'fixture-succeeded' } };
    },
  });
  const makeApp = () => createCore(config(f.filename), { clock: f.clock, policy, sourceFactories, analysisFactory, env: {} });
  let app = await makeApp();
  try {
    assert.equal(app.runtime.store.filename, f.filename);
    assert.equal(app.components.length, 4);
    await app.run({ once: true });
    assert.equal(analysisSnapshots.length, 1);
    assert.equal(analysisSnapshots[0].runtime, app.runtime);
    assert.equal(analysisSnapshots[0].events, 5);
    assert.deepEqual(analysisSnapshots[0].visible, ['discord-main', 'qq-main', 'steam-discussion-main', 'steam-review-main']);
    assert.equal(app.runtime.store.get("SELECT o.status FROM event_outbox o JOIN source_events e USING(event_id) WHERE e.source_id='steam-discussion-private'").status, 'pending');
    assert.equal(app.runtime.store.get("SELECT count(*) n FROM admission_decisions a JOIN source_events e USING(event_id) WHERE e.source_id='steam-discussion-private'").n, 0);
    assert.deepEqual(app.runtime.store.get('SELECT project_id,source_uri,platform FROM sources WHERE source_id=?', 'qq-main'), qqBefore);
    assert.deepEqual(app.runtime.store.get('SELECT processing_mode,visibility FROM source_policies WHERE source_id=?', 'qq-main'), qqPolicyBefore);
    for (const binding of bindings) {
      assert.deepEqual({ ...app.runtime.store.get('SELECT processing_mode AS processingMode,visibility FROM source_policies WHERE source_id=?', binding.sourceId) }, binding.policy);
    }
  } finally { await app.close(); }

  app = await makeApp();
  try {
    await app.run({ once: true });
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events').n, 5);
    assert.deepEqual(app.runtime.store.get('SELECT project_id,source_uri,platform FROM sources WHERE source_id=?', 'qq-main'), qqBefore);
    assert.deepEqual(app.runtime.store.get('SELECT processing_mode,visibility FROM source_policies WHERE source_id=?', 'qq-main'), qqPolicyBefore);
  } finally { await app.close(); }
});

test('createCore rejects platform source URI mismatch before creating the archive', async t => {
  const f = fixture(t);
  const database = path.join(f.directory, 'invalid-core.sqlite');
  const invalid = config(database);
  invalid.plugins[0].config.sourceUri = 'urn:superagent:source:wrong';
  await assert.rejects(() => createCore(invalid, { sourceFactories, analysisFactory: () => ({}), env: {} }), /CORE_PLUGIN_SOURCE_MISMATCH/);
  assert.equal(existsSync(database), false);
});
