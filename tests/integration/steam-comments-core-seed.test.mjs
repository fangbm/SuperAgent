import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createApplication } from '../../scripts/application.mjs';
import { M1Runtime } from '@superagent/agent-core';
import { SteamReviewCommentsConnector } from '@superagent/connector-steam-reviews';
import { appFixture, eventually, untilAbort } from './application-helpers.mjs';
import { initializeSteamReviewComments } from '../../scripts/steam-review-comments-state.mjs';

const binding = { projectId: 'game-test', sourceId: 'legacy-comments', sourceUri: 'urn:test:legacy-comments', platform: 'steam-reviews' };
const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
const platform = { sourceUri: binding.sourceUri, appId: 123, parentReviewSourceId: 'parent-reviews' };
const nativeHtml = '<div class="commentthread_comment" id="comment_900"><a class="commentthread_author_link" href="https://steamcommunity.com/profiles/4001/">Fixture author</a><span data-timestamp="1700000000"></span><div class="commentthread_comment_text">A reproducible failure.</div></div>';
const native = { id: '900', authorUrl: 'https://steamcommunity.com/profiles/4001/', authorId: '4001', created: 1700000000,
  text: 'A reproducible failure.', nativeHtml, reviewId: '2001', reviewOwner: '3001',
  renderUrl: 'https://steamcommunity.com/comment/Recommendation/render/3001/123/?start=0&count=100' };
function legacyEvent() {
  const revision = createHash('sha256').update(JSON.stringify(native)).digest('hex');
  return { specversion: '1.0', id: `comment:2001:900:created:${revision}`, source: binding.sourceUri,
    type: 'com.superagent.feedback.comment.created.v1', time: new Date(native.created * 1000).toISOString(), datacontenttype: 'application/json',
    data: { schemaVersion: '1.0', ...scope, platform: binding.platform,
      object: { kind: 'comment', externalId: 'comment:2001:900', revision, parentExternalId: '2001', threadExternalId: 'review:2001' },
      actor: { opaqueId: '4001', isBot: false }, content: { text: native.text }, origin: { permalink: 'https://steamcommunity.com/profiles/3001/recommended/123/#comment_900' },
      attributes: { appId: 123, surface: 'review-comments', ingestionMode: 'bounded-anonymous-web-observation', parentReviewSourceId: 'parent-reviews',
        parentRecommendationId: '2001', nativeCreatedAt: native.created, sourceEndpoint: native.renderUrl, native } } };
}

for (const legacyCheckpoint of [true, false]) test(`Core seeds only matching comment projections without rewriting existing events (legacy cursor: ${legacyCheckpoint})`, async t => {
  const f = appFixture(t), runtime = new M1Runtime(f.config.database, { policy: f.policy });
  runtime.ingress.registerSource(binding);
  const event = legacyEvent();
  const oldCursor = { version: 1, appId: 123, mode: 'bounded-anonymous-web-observation', capturedAt: '2026-11-04T00:00:00Z',
    revisions: { 'comment:2001:900': event.data.object.revision }, threads: [{ reviewId: '2001', owner: '3001', reportedCount: 1 }] };
  const receipt = runtime.ingress.commitBatch(scope, [event], legacyCheckpoint ? { sourceId: scope.sourceId, cursor: oldCursor } : undefined);
  const before = runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE event_id=?', receipt.refs[0].eventId);
  const unrelated = { ...binding, sourceId: 'unrelated-comments', sourceUri: 'urn:test:unrelated-comments' };
  runtime.ingress.registerSource(unrelated);
  runtime.ingress.commitBatch(unrelated, [{ ...event, source: unrelated.sourceUri, data: { ...event.data, sourceId: unrelated.sourceId } }], { sourceId: unrelated.sourceId, cursor: { leave: 'unchanged' } });
  runtime.close();
  const config = { ...f.config, projectId: binding.projectId, deliveries: [],
    sources: [{ id: binding.sourceId, plugin: 'steam-review-comments', enabled: true, config: platform,
      permissions: { networkHosts: ['api.steampowered.com', 'steamcommunity.com'], secretKeys: [] }, secrets: {} }] };
  const fetch = async url => {
    const u = new URL(url);
    if (u.hostname === 'api.steampowered.com') {
      const query = JSON.parse(u.searchParams.get('input_json'));
      return Response.json({ response: { cursor: 'end', query_summary: { num_reviews: query.cursor === '*' ? 1 : 0 },
        reviews: query.cursor === '*' ? [{ recommendationid: '2001', author: { steamid: '3001' }, comment_count: 1 }] : [] } });
    }
    assert.equal(u.pathname, '/comment/Recommendation/render/3001/123/');
    const start = Number(u.searchParams.get('start'));
    return Response.json({ success: true, start, pagesize: 100, total_count: 1, comments_html: start === 0 ? nativeHtml : '' });
  };
  let polled = false;
  const open = () => createApplication(config, { policy: f.policy, access: f.access, env: {},
    sourceFactories: { 'steam-review-comments': c => new SteamReviewCommentsConnector(c, { fetch, now: () => Date.parse('2026-11-04T00:00:00Z'),
      sleep: async (ms, signal) => { if (ms === 600000) { polled = true; await untilAbort(signal); } } }) } });
  let app = await open();
  f.after(() => app.close());
  try {
    await app.start(); await eventually(() => polled);
    let checkpoint = app.runtime.ingress.getCheckpoint(scope);
    assert.equal(checkpoint.version, 2);
    assert.deepEqual(Object.keys(checkpoint.observations), ['comment:2001:900']);
    assert.doesNotMatch(JSON.stringify(checkpoint), /A reproducible failure|commentthread_comment/);
    assert.equal(app.runtime.store.get('SELECT count(*) n FROM source_events WHERE source_id=?', scope.sourceId).n, 1);
    assert.deepEqual(app.runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE event_id=?', before.event_id), before);
    assert.deepEqual(app.runtime.ingress.getCheckpoint(unrelated), { leave: 'unchanged' });
    checkpoint = app.runtime.ingress.getCheckpoint(scope);
    await app.close(); app = await open();
    assert.deepEqual(app.runtime.ingress.getCheckpoint(scope), checkpoint, 'an already upgraded cursor is not reseeded at startup');
    const duplicate = app.runtime.ingress.commitBatch(scope, [event]);
    assert.equal(duplicate.refs[0].eventId, before.event_id);
    assert.equal(duplicate.duplicates, 1);
  } finally { await app.close(); }
});

test('a malformed archived comment projection rolls back trusted checkpoint initialization',t=>{
  const f=appFixture(t),runtime=new M1Runtime(f.config.database,{policy:f.policy});f.after(()=>runtime.close());
  runtime.ingress.registerSource(binding);
  const event=legacyEvent();event.data.object.parentExternalId='wrong-parent';
  const old={version:1,appId:123,mode:'bounded-anonymous-web-observation',revisions:{},threads:[]};
  const receipt=runtime.ingress.commitBatch(scope,[event],{sourceId:scope.sourceId,cursor:old});
  const before=runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE event_id=?',receipt.refs[0].eventId);
  assert.throws(()=>initializeSteamReviewComments({runtime,entry:{config:platform},binding}),/INVALID_CHECKPOINT/);
  assert.deepEqual(runtime.ingress.getCheckpoint(scope),old);
  assert.deepEqual(runtime.store.get('SELECT event_id,payload_json FROM source_events WHERE event_id=?',before.event_id),before);
});
