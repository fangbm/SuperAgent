import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedSourceRegistry } from '../../packages/plugin-host/dist/source-registry.js';
import { fixture, event } from './helpers.mjs';

const source = (projectId, sourceId, sourceUri, platform, policy = { processingMode: 'standard', visibility: 'public' }) =>
  ({ projectId, sourceId, sourceUri, platform, policy });
const bindingOf = ({ projectId, sourceId, sourceUri, platform }) => ({ projectId, sourceId, sourceUri, platform });
const scope = ({ projectId, sourceId }) => ({ projectId, sourceId });

test('Core registers only configured sources and preserves processed public sources and dispatch', async t => {
  const f = fixture(t);
  const qq = source('game-test', 'qq-main', 'urn:superagent:source:qq-main', 'qq-official');
  const steam = source('game-test', 'steam-main', 'urn:superagent:source:steam-main', 'steam');
  const qqScope = scope(qq);
  f.runtime.ingress.registerSource(bindingOf(steam));
  f.runtime.ingress.setSourcePolicy(qqScope, { processingMode: 'standard', visibility: 'public' });
  f.runtime.ingress.setSourcePolicy(scope(steam), { processingMode: 'archive_only', visibility: 'public' });
  f.runtime.ingress.commitBatch(qqScope, [event('qq-existing')]);
  f.runtime.ingress.commitBatch(scope(steam), [{ ...event('steam-existing'), source: steam.sourceUri,
    data: { ...event('steam-existing').data, sourceId: steam.sourceId, platform: steam.platform } }]);
  const before = f.runtime.store.all('SELECT source_id,processing_mode,visibility FROM source_policies ORDER BY source_id');
  const discord = source('game-test', 'discord-main', 'urn:superagent:source:discord-main', 'discord');
  const registry = new TrustedSourceRegistry(f.runtime.ingress, [discord]);
  registry.apply();
  const host = registry.sourceHost(scope(discord));
  const accepted = await host.commitBatch([{ ...event('discord-new'), source: discord.sourceUri,
    data: { ...event('discord-new').data, sourceId: discord.sourceId, platform: discord.platform } }]);
  assert.equal(accepted.accepted, 1);
  assert.equal(f.runtime.ingress.dispatchOutbox(), 2);
  assert.deepEqual(f.runtime.store.all('SELECT source_id,processing_mode,visibility FROM source_policies WHERE source_id IN (?,?) ORDER BY source_id', 'qq-main', 'steam-main'), before);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM sources').n, 3);
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM event_outbox WHERE status='dispatched'").n, 2);
});

test('Core private staff source is archive-only and scoped frozen host exposes no policy controls', async t => {
  const f = fixture(t);
  const privateSource = source('private-project', 'ticket-source', 'urn:superagent:source:tickets', 'discord', { processingMode: 'archive_only', visibility: 'staff' });
  const registry = new TrustedSourceRegistry(f.runtime.ingress, [privateSource]);
  registry.apply();
  const host = registry.sourceHost(scope(privateSource));
  assert.equal(Object.isFrozen(host), true);
  assert.equal('setSourcePolicy' in host, false);
  assert.deepEqual(registry.binding(scope(privateSource)), { projectId: privateSource.projectId, sourceId: privateSource.sourceId, sourceUri: privateSource.sourceUri, platform: privateSource.platform });
  assert.throws(() => registry.binding({ projectId: 'private-project', sourceId: 'other' }), /SOURCE_NOT_AUTHORIZED/);
  assert.throws(() => registry.sourceHost({ projectId: 'private-project', sourceId: 'other' }), /SOURCE_NOT_AUTHORIZED/);
  const privateEvent = { ...event('private-event'), source: privateSource.sourceUri,
    data: { ...event('private-event').data, projectId: privateSource.projectId, sourceId: privateSource.sourceId, platform: privateSource.platform } };
  await host.commitBatch([privateEvent]);
  assert.equal(f.runtime.ingress.dispatchOutbox(), 0);
  assert.equal(f.runtime.store.get("SELECT visibility FROM source_policies WHERE source_id='ticket-source'").visibility, 'staff');
});

test('invalid config and identity conflict roll back all source and policy writes', t => {
  const f = fixture(t);
  const existing = source('other-project', 'taken', 'urn:superagent:source:taken', 'qq');
  f.runtime.ingress.registerSource(bindingOf(existing));
  f.runtime.ingress.setSourcePolicy(scope(existing), { processingMode: 'archive_only', visibility: 'public' });
  const newSource = source('new-project', 'new-source', 'urn:superagent:source:new', 'discord');
  const registry = new TrustedSourceRegistry(f.runtime.ingress, [newSource, source('elsewhere', 'taken', 'urn:superagent:source:conflict', 'discord')]);
  assert.throws(() => registry.apply(), /SOURCE_IDENTITY_CONFLICT/);
  assert.equal(f.runtime.store.get("SELECT 1 FROM projects WHERE project_id='new-project'"), undefined);
  assert.equal(f.runtime.store.get("SELECT 1 FROM sources WHERE source_id='new-source'"), undefined);
  assert.equal(f.runtime.store.get("SELECT processing_mode FROM source_policies WHERE source_id='taken'").processing_mode, 'archive_only');
  assert.throws(() => new TrustedSourceRegistry(f.runtime.ingress, [newSource, { ...newSource, sourceId: 'other-id' }]), /DUPLICATE_SOURCE_URI/);
  assert.throws(() => new TrustedSourceRegistry(f.runtime.ingress, [{ ...newSource, policy: { processingMode: 'standard', visibility: 'staff' } }]), /INVALID_SOURCE_POLICY/);
});

test('mixed project visibility rolls back every configured source and preserves private policy', t => {
  const f = fixture(t);
  const privateSource = source('staff-project', 'staff-only', 'urn:superagent:source:staff-only', 'discord', { processingMode: 'archive_only', visibility: 'staff' });
  f.runtime.ingress.registerSource(bindingOf(privateSource));
  f.runtime.ingress.setSourcePolicy(scope(privateSource), privateSource.policy);
  const conflicting = source('staff-project', 'public-new', 'urn:superagent:source:public-new', 'discord');
  assert.throws(() => new TrustedSourceRegistry(f.runtime.ingress, [conflicting]).apply(), /PROJECT_VISIBILITY_CONFLICT/);
  assert.equal(f.runtime.store.get("SELECT 1 FROM sources WHERE source_id='public-new'"), undefined);
  assert.equal(f.runtime.store.get("SELECT visibility FROM source_policies WHERE source_id='staff-only'").visibility, 'staff');
});

test('Core leaves unchanged processed archive policy alone and can explicitly restore standard for configured public source', t => {
  const f = fixture(t);
  const archive = source('game-test', 'qq-main', 'urn:superagent:source:qq-main', 'qq-official', { processingMode: 'archive_only', visibility: 'public' });
  const scopeObj = scope(archive);
  f.runtime.ingress.setSourcePolicy(scopeObj, archive.policy);
  f.runtime.ingress.commitBatch(scopeObj, [event('archived')]);
  assert.doesNotThrow(() => new TrustedSourceRegistry(f.runtime.ingress, [archive]).apply());
  const standard = { ...archive, policy: { processingMode: 'standard', visibility: 'public' } };
  new TrustedSourceRegistry(f.runtime.ingress, [standard]).apply();
  assert.equal(f.runtime.store.get("SELECT processing_mode FROM source_policies WHERE source_id='qq-main'").processing_mode, 'standard');
  assert.equal(f.runtime.ingress.dispatchOutbox(), 1);
});
