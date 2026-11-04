import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SteamReviewCommentsConnector, seedSteamReviewCommentsCheckpoint } from '@superagent/connector-steam-reviews';
import { validateContract } from '@superagent/contract-validation';
import { connectorFixture, signal } from './m4-helpers.mjs';

const html = readFileSync(new URL('../fixtures/m4/steam-review-comments.html', import.meta.url), 'utf8');
const reply = JSON.parse(readFileSync(new URL('../fixtures/m4/steam-review-comments.json', import.meta.url), 'utf8'));
const config = f => ({ sourceUri: f.binding.sourceUri, appId: 570, parentReviewSourceId: 'steam-reviews-all' });
const review = (recommendationid = '7001', steamid = '76561198000000001', comment_count = 1) => ({ recommendationid, author: { steamid }, comment_count });
const reviewsPage = (reviews = [], cursor = 'end') => Response.json({ response: { reviews, cursor } });
const threadPage = (items = [], start = 0, total = items.length) => Response.json({ success: true, start, pagesize: 100, total_count: total, comments_html: items.map(x => x.html).join('') });
const endpoint = 'https://steamcommunity.com/comment/Recommendation/render/';
const sourceReply = (id = '900001', text = 'First line<br>second <a href="https://steamcommunity.com/profiles/76561198000000002">linked word</a>', reviewId = '7001', owner = '76561198000000001') => ({ html: `<div class="commentthread_comment" id="comment_${id}"><div class="commentthread_comment_text">${text}</div><a class="commentthread_author_link" href="https://steamcommunity.com/profiles/76561198000000002">Synthetic author</a><span data-timestamp="1700000000"></span></div>`, reviewId, owner });

test('Steam review comments preserve parsed text, native fragment, parent links and distinct IDs', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const configValue = { ...config(f), maxRequestsPerSync: 4 };
  const fetch = async url => {
    if (url.hostname === 'api.steampowered.com') return reviewsPage([review(), review('7002', '76561198000000003')], 'metadata-next');
    const owner = url.pathname.split('/').filter(Boolean).at(-2);
    return owner === '76561198000000003' ? threadPage([sourceReply('900002', undefined, '7002', owner)], 0, 1)
      : Response.json({ ...reply, start: Number(url.searchParams.get('start')) });
  };
  const connector = new SteamReviewCommentsConnector(configValue, { fetch, sleep: async () => {}, now: () => 1800000000000 });
  await connector.sync(f.host, signal());
  const events = f.events(f.runtime);
  assert.equal(events.length, 2);
  assert.equal(validateContract('normalized-event-v1', events[0]).valid, true);
  assert.equal(events[0].data.platform, 'steam-reviews');
  assert.equal(events[0].data.sourceId, f.scope.sourceId);
  assert.equal(events[0].data.object.externalId, 'comment:7001:900001');
  assert.equal(events[0].data.object.parentExternalId, '7001');
  assert.equal(events[0].data.object.threadExternalId, 'review:7001');
  assert.equal(events[0].data.attributes.parentReviewSourceId, 'steam-reviews-all');
  assert.equal(events[0].data.content.text, 'First line\nsecond linked word');
  assert.match(events[0].data.attributes.native.nativeHtml, /commentthread_comment/);
  assert.equal(events[0].data.attributes.native.reviewOwner, '76561198000000001');
  assert.equal(events[0].data.actor.opaqueId, '76561198000000002');
  assert.notEqual(events[0].data.object.externalId, events[1].data.object.externalId);
});

test('probe verifies the comment-render endpoint and reports unknown when no candidate exists', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const denied = new SteamReviewCommentsConnector(config(f), { sleep: async () => {}, fetch: async url => url.hostname === 'api.steampowered.com'
    ? reviewsPage([review()], 'next') : new Response('', { status: 403 }) });
  const unavailable = await denied.probe();
  assert.equal(unavailable.coverage, 'unavailable'); assert.equal(unavailable.readMessages, false);
  const empty = new SteamReviewCommentsConnector(config(f), { sleep: async () => {}, fetch: async () => reviewsPage([], 'end') });
  const unknown = await empty.probe();
  assert.equal(unknown.coverage, 'unknown'); assert.equal(unknown.readMessages, false);
});

test('one-request comment sync budgets still permit the separate two-request diagnostic probe without concurrency', async t => {
  const f = connectorFixture(t, 'steam-reviews'); let active = 0; let peak = 0;
  const connector = new SteamReviewCommentsConnector({ ...config(f), maxRequestsPerSync: 1 }, { sleep: async () => {}, fetch: async url => {
    active++; peak = Math.max(peak, active); await new Promise(setImmediate); active--;
    return url.hostname === 'api.steampowered.com' ? reviewsPage([review()], 'next') : threadPage([sourceReply()], 0, 1);
  } });
  const [capability] = await Promise.all([connector.probe(), connector.sync(f.host, signal())]);
  assert.equal(capability.coverage, 'partial'); assert.equal(peak, 1);
});

test('Steam review comments paginate full metadata and empty tails, then rescan unchanged pages without duplicate events', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  let now = 1800000000000; let metadataCalls = 0; let commentCalls = 0;
  const connector = new SteamReviewCommentsConnector({ ...config(f), rescanIntervalMs: 1000 }, { now: () => now, sleep: async () => {}, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') {
      metadataCalls++;
      const cursor = JSON.parse(url.searchParams.get('input_json')).cursor;
      return cursor === '*' ? reviewsPage([review()], 'page/2') : reviewsPage([], 'page/2');
    }
    commentCalls++; return threadPage([sourceReply()], Number(url.searchParams.get('start')), 1);
  } });
  await connector.sync(f.host, signal()); assert.equal(f.events(f.runtime).length, 1);
  await connector.sync(f.host, signal()); assert.equal((await f.host.getCheckpoint()).reviewCursor, '*');
  now += 2000; await connector.sync(f.host, signal());
  assert.equal(metadataCalls, 4); assert.equal(commentCalls, 2); assert.equal(f.events(f.runtime).length, 1);
  assert.equal((await f.host.getCheckpoint()).threads['7001'].lastScannedAt, now);
});

test('comment pages resume by offset across syncs without losing earlier page events', async t => {
  const f = connectorFixture(t, 'steam-reviews'); const offsets = [];
  const connector = new SteamReviewCommentsConnector({ ...config(f), pageSize: 1 }, { sleep: async () => {}, now: () => 1800000000000, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') return JSON.parse(url.searchParams.get('input_json')).cursor === '*' ? reviewsPage([review('7001', '76561198000000001', 2)], 'metadata-next') : reviewsPage([], 'metadata-next');
    const start = Number(url.searchParams.get('start')); offsets.push(start);
    return threadPage([sourceReply(start === 0 ? '900001' : '900002', `message ${start}`)], start, 2);
  } });
  await connector.sync(f.host, signal());
  assert.deepEqual(offsets, [0]); assert.equal((await f.host.getCheckpoint()).threads['7001'].offset, 1);
  assert.equal(f.events(f.runtime).length, 1);
  await connector.sync(f.host, signal());
  assert.deepEqual(offsets, [0, 1]); assert.equal((await f.host.getCheckpoint()).threads['7001'].pending, false);
  assert.deepEqual(f.events(f.runtime).map(event => event.data.object.externalId), ['comment:7001:900001', 'comment:7001:900002']);
});

test('comment-count changes retain an unfinished page offset and schedule a follow-up head pass', async t => {
  const f = connectorFixture(t, 'steam-reviews'); let count = 2; const offsets = [];
  const connector = new SteamReviewCommentsConnector({ ...config(f), pageSize: 1, maxRequestsPerSync: 2 }, { sleep: async () => {}, now: () => 1800000000000, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') return JSON.parse(url.searchParams.get('input_json')).cursor === '*' ? reviewsPage([review('7001', '76561198000000001', count)], 'next') : reviewsPage([], 'next');
    const offset = Number(url.searchParams.get('start')); offsets.push(offset);
    return threadPage([sourceReply(String(900001 + offset))], offset, count);
  } });
  await connector.sync(f.host, signal()); assert.deepEqual(offsets, [0]);
  count = 3;
  for (let i = 0; i < 6; i++) await connector.sync(f.host, signal());
  assert.deepEqual(offsets.slice(0, 4), [0, 1, 2, 0]);
  assert.equal(new Set(f.events(f.runtime).map(event => event.data.object.externalId)).size, 3);
});

test('a valid empty tail completes a stale reported thread without deleting archived comments', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const seeded = { version: 2, appId: 570, sourceUri: f.binding.sourceUri, parentReviewSourceId: 'steam-reviews-all', mode: 'bounded-anonymous-web-observation',
    reviewCursor: '*', metadataSweepAt: 0, nextEligibleAt: 0, serviceTurn: 'head', knownReviews: { '7001': true },
    threads: { '7001': { owner: '76561198000000001', reportedCount: 100, offset: 100, lastScannedAt: 0, pending: true, known: true, retryAt: 0 } }, observations: {} };
  await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: seeded });
  let requestedOffset;
  const connector = new SteamReviewCommentsConnector(config(f), { sleep: async () => {}, now: () => 1800000000000, fetch: async url => url.hostname === 'api.steampowered.com'
    ? reviewsPage([review('7001', '76561198000000001', 100)], 'next')
    : (requestedOffset = Number(url.searchParams.get('start')), threadPage([], requestedOffset, 100)) });
  await connector.sync(f.host, signal());
  assert.equal(requestedOffset, 100); assert.equal((await f.host.getCheckpoint()).threads['7001'].pending, false);
  assert.equal(f.events(f.runtime).length, 0);
});

test('small request budgets alternate metadata and comment work instead of starving either queue', async t => {
  const f = connectorFixture(t, 'steam-reviews'); let comments = 0; let metadata = 0;
  const connector = new SteamReviewCommentsConnector({ ...config(f), maxRequestsPerSync: 1 }, { sleep: async () => {}, now: () => 1800000000000, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') { metadata++; return reviewsPage([review()], 'page/2'); }
    comments++; return threadPage([sourceReply()], 0, 1);
  } });
  await connector.sync(f.host, signal());
  assert.equal(metadata, 1); assert.equal(comments, 0); assert.equal((await f.host.getCheckpoint()).serviceTurn, 'comments');
  await connector.sync(f.host, signal());
  assert.equal(metadata, 1); assert.equal(comments, 1); assert.equal(f.events(f.runtime).length, 1);
  assert.equal((await f.host.getCheckpoint()).serviceTurn, 'background');
});

test('head refresh discovers a new candidate while the independent tail cursor continues', async t => {
  const f = connectorFixture(t, 'steam-reviews'); const metadataCursors = [];
  const connector = new SteamReviewCommentsConnector({ ...config(f), maxRequestsPerSync: 3 }, { sleep: async () => {}, now: () => 1800000000000, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') {
      const cursor = JSON.parse(url.searchParams.get('input_json')).cursor; metadataCursors.push(cursor);
      if (metadataCursors.length === 1) return reviewsPage([review('7001', '76561198000000001', 0)], 'tail:1');
      if (cursor === '*') return reviewsPage([review('7002', '76561198000000002', 1)], 'head:next');
      return reviewsPage([review('7003', '76561198000000003', 1)], 'tail:2');
    }
    const owner = url.pathname.split('/').filter(Boolean).at(-2);
    return threadPage([sourceReply('900002', 'new head comment', '7002', owner)], 0, 1);
  } });
  await connector.sync(f.host, signal());
  assert.equal((await f.host.getCheckpoint()).reviewCursor, 'tail:1');
  await connector.sync(f.host, signal());
  assert.deepEqual(metadataCursors, ['*', '*', 'tail:1']);
  assert.equal((await f.host.getCheckpoint()).reviewCursor, 'tail:2');
  assert.equal(f.events(f.runtime).length, 1);
  assert.equal(f.events(f.runtime)[0].data.object.externalId, 'comment:7002:900002');
});

test('Steam comment revisions keep stable object identity and distinct A/B/A observations', async t => {
  const f = connectorFixture(t, 'steam-reviews'); let now = 1800000000000; let text = 'original';
  const connector = new SteamReviewCommentsConnector({ ...config(f), rescanIntervalMs: 1000 }, { now: () => now, sleep: async () => {}, fetch: async url => url.hostname === 'api.steampowered.com'
    ? JSON.parse(url.searchParams.get('input_json')).cursor === '*' ? reviewsPage([review()], 'page/2') : reviewsPage([], 'page/2')
    : threadPage([sourceReply('900001', text)], Number(url.searchParams.get('start')), 1) });
  for (const value of ['original', 'original', 'edited', 'original']) { text = value; await connector.sync(f.host, signal()); now += 2000; }
  const events = f.events(f.runtime);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.data.content.text), ['original', 'edited', 'original']);
  assert.equal(new Set(events.map(event => event.data.object.externalId)).size, 1);
  assert.equal(new Set(events.map(event => event.id)).size, 3);
  assert.ok(events[1].data.attributes.observedAt);
  assert.equal(events[1].time, events[1].data.attributes.observedAt);
  assert.equal(events[0].time, new Date(1700000000 * 1000).toISOString());
});

test('body HTML link changes are material even when visible comment text is unchanged', async t => {
  const f = connectorFixture(t, 'steam-reviews'); let now = 1800000000000; let href = 'https://example.test/a';
  const connector = new SteamReviewCommentsConnector({ ...config(f), rescanIntervalMs: 1000 }, { now: () => now, sleep: async () => {}, fetch: async url => url.hostname === 'api.steampowered.com'
    ? JSON.parse(url.searchParams.get('input_json')).cursor === '*' ? reviewsPage([review()], 'next') : reviewsPage([], 'next')
    : threadPage([sourceReply('900001', `same <a href="${href}">link</a>`)], 0, 1) });
  await connector.sync(f.host, signal()); href = 'https://example.test/b'; now += 2000; await connector.sync(f.host, signal());
  const events = f.events(f.runtime);
  assert.equal(events.length, 2); assert.equal(events[0].data.content.text, events[1].data.content.text);
  assert.notEqual(events[0].data.object.revision, events[1].data.object.revision);
});

test('Steam comment thread page only advances with atomic commit; restart retries an uncommitted page', async t => {
  const f = connectorFixture(t, 'steam-reviews'); const requests = [];
  const fetch = async url => { requests.push(url); if (url.hostname !== 'api.steampowered.com') return threadPage([sourceReply()], 0, 1); return JSON.parse(url.searchParams.get('input_json')).cursor === '*' ? reviewsPage([review()], 'page/2') : reviewsPage([], 'page/2'); };
  let failEvents = true;
  const host = { ...f.host, commitBatch: async (events, checkpoint) => {
    if (failEvents && events.length) throw new Error('disk full');
    return f.host.commitBatch(events, checkpoint);
  } };
  const connector = new SteamReviewCommentsConnector({ ...config(f) }, { fetch, sleep: async () => {}, now: () => 1800000000000 });
  await assert.rejects(connector.sync(host, signal()), /disk full/);
  assert.equal(f.events(f.runtime).length, 0);
  assert.equal((await f.host.getCheckpoint()).threads['7001'].lastScannedAt, 0);
  failEvents = false; await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 1);
  assert.equal(requests.filter(url => url.hostname === 'steamcommunity.com').length, 2);
});

test('Steam comment errors retain checkpoints; 429 honors Retry-After and malformed cursors are rejected', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const configValue = { ...config(f) };
  const seed = await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: { version: 2, appId: 570, sourceUri: f.binding.sourceUri, parentReviewSourceId: 'steam-reviews-all', mode: 'bounded-anonymous-web-observation', reviewCursor: '*', metadataSweepAt: 0, nextEligibleAt: 0, serviceTurn: 'head', knownReviews: {}, threads: {}, observations: {} } });
  void seed;
  const waits = []; let calls = 0;
  const retry = new SteamReviewCommentsConnector(configValue, { sleep: async ms => waits.push(ms), now: () => 1800000000000, fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '7' } }); } });
  await retry.sync(f.host, signal()); assert.deepEqual(waits, []); assert.equal(calls, 1, '429 must not be retried before its deadline');
  assert.ok((await f.host.getCheckpoint()).nextEligibleAt > 1800000000000);
  const before = await f.host.getCheckpoint(); await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: { ...before, nextEligibleAt: 0 } });
  const immediate = await f.host.getCheckpoint();
  for (const broken of [
    async () => new Response('', { status: 403 }),
    async () => { throw new TypeError('network'); },
    async () => Response.json({ response: { reviews: [review()], cursor: '*' } }),
    async () => Response.json({ response: { reviews: [], cursor: '' } }),
    async () => new Response('{bad', { headers: { 'content-type': 'application/json' } }),
  ]) {
    const connector = new SteamReviewCommentsConnector(configValue, { sleep: async () => {}, fetch: broken });
    await assert.rejects(connector.sync(f.host, signal()));
    assert.deepEqual(await f.host.getCheckpoint(), immediate);
  }
});

test('private and false-success comment pages preserve the committed thread cursor', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  for (const failComment of [
    async () => new Response('', { status: 403 }),
    async () => Response.json({ success: false, start: 0, pagesize: 100, total_count: 0, comments_html: '' }),
    async () => Response.json({ success: true, start: 0, pagesize: 100, total_count: 1, comments_html: '' }),
  ]) {
    const committed = [];
    const host = { ...f.host, commitBatch: async (events, cp) => { if (cp && !events.length) committed.push(cp.cursor); return f.host.commitBatch(events, cp); } };
    const connector = new SteamReviewCommentsConnector(config(f), { sleep: async () => {}, now: () => 1800000000000, fetch: async url => url.hostname === 'api.steampowered.com'
      ? reviewsPage([review()], 'page/2') : failComment() });
    // A known thread survives a new metadata sweep and remains queued on each endpoint failure.
    const seeded = { version: 2, appId: 570, sourceUri: f.binding.sourceUri, parentReviewSourceId: 'steam-reviews-all', mode: 'bounded-anonymous-web-observation', reviewCursor: '*', metadataSweepAt: 0, nextEligibleAt: 0, serviceTurn: 'head', knownReviews: { '7001': true },
      threads: { '7001': { owner: '76561198000000001', reportedCount: 1, offset: 0, lastScannedAt: 0, pending: true, known: true, retryAt: 0 } }, observations: {} };
    await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: seeded });
    const before = await f.host.getCheckpoint();
    await connector.sync(host, signal());
    assert.ok(committed.length);
    assert.equal((await f.host.getCheckpoint()).threads['7001'].offset, before.threads['7001'].offset);
    assert.equal((await f.host.getCheckpoint()).threads['7001'].pending, before.threads['7001'].pending);
    assert.ok((await f.host.getCheckpoint()).threads['7001'].retryAt > 1800000000000);
    await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: { ...seeded, threads: {} } });
  }
});

test('a private early thread does not starve a later public thread', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const connector = new SteamReviewCommentsConnector({ ...config(f), maxRequestsPerSync: 4 }, { sleep: async () => {}, now: () => 1800000000000, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') return reviewsPage([review('7001', '76561198000000001'), review('7002', '76561198000000003')], 'metadata-next');
    const owner = url.pathname.split('/').filter(Boolean).at(-2);
    if (owner === '76561198000000001') return new Response('', { status: 403 });
    return threadPage([sourceReply('900002', undefined, '7002', owner)], 0, 1);
  } });
  await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 1);
  assert.equal(f.events(f.runtime)[0].data.object.externalId, 'comment:7002:900002');
  const cp = await f.host.getCheckpoint();
  assert.equal(cp.threads['7001'].offset, 0); assert.ok(cp.threads['7001'].retryAt > 1800000000000);
  assert.equal(cp.threads['7002'].pending, false);
  assert.match(f.runtime.store.get('SELECT health_reason FROM sources WHERE source_id=?', f.scope.sourceId).health_reason, /inaccessible/);
});

test('legacy 19-event checkpoint seeding is metadata-only, exact-source scoped and replay-safe', async t => {
  const f = connectorFixture(t, 'steam-reviews'); const oldConfig = config(f); const legacy = { version: 1, appId: 570,
    mode: 'bounded-anonymous-web-observation', cursor: null, capturedAt: '2025-01-01T00:00:00.000Z', revisions: {}, threads: [{ reviewId: '7002', reportedCount: 0, observedCount: 0 }] };
  const oldEvents = Array.from({ length: 19 }, (_, index) => {
    const item = { id: String(900001 + index), reviewId: '7001', reviewOwner: '76561198000000001', authorId: '76561198000000002', authorUrl: 'https://steamcommunity.com/profiles/76561198000000002', created: 1700000000, text: `synthetic ${index}`, nativeHtml: `<div class="commentthread_comment" id="comment_${900001 + index}"><div class="commentthread_comment_text">synthetic ${index}</div><a class="commentthread_author_link" href="https://steamcommunity.com/profiles/76561198000000002">Synthetic author</a><span data-timestamp="1700000000"></span></div>`, renderUrl: 'https://steamcommunity.com/comment/Recommendation/render/76561198000000001/570/?start=0&count=100' };
    const externalId = `comment:${item.reviewId}:${item.id}`;
    const revision = createHash('sha256').update(JSON.stringify(item)).digest('hex');
    return { specversion: '1.0', id: `${externalId}:created:${revision}`, source: f.binding.sourceUri, type: 'com.superagent.feedback.comment.created.v1', time: new Date(item.created * 1000).toISOString(), datacontenttype: 'application/json',
      data: { schemaVersion: '1.0', projectId: f.scope.projectId, sourceId: f.scope.sourceId, platform: 'steam-reviews', object: { kind: 'comment', externalId, revision, parentExternalId: item.reviewId, threadExternalId: `review:${item.reviewId}` }, content: { text: item.text }, attributes: { appId: 570, surface: 'review-comments', ingestionMode: 'bounded-anonymous-web-observation', parentReviewSourceId: oldConfig.parentReviewSourceId, parentRecommendationId: item.reviewId, nativeCreatedAt: item.created, sourceEndpoint: item.renderUrl, native: item } } };
  });
  await f.host.commitBatch(oldEvents);
  const seed = seedSteamReviewCommentsCheckpoint(oldConfig, legacy, oldEvents);
  for (const mutate of [
    event => { event.data.object.externalId = 'comment:7001:999'; },
    event => { event.data.object.parentExternalId = 'other-review'; },
    event => { event.data.object.threadExternalId = 'review:wrong'; },
    event => { event.data.sourceId = 'other-source'; },
    event => { event.data.projectId = 'other-project'; },
    event => { event.id += ':wrong'; },
  ]) {
    const malformed = structuredClone(oldEvents[0]); mutate(malformed);
    assert.throws(() => seedSteamReviewCommentsCheckpoint(oldConfig, legacy, [malformed], f.scope), /INVALID_EVENT/);
  }
  assert.equal(seed.version, 2); assert.equal(Object.keys(seed.observations).length, 19);
  assert.equal(JSON.stringify(seed).includes('synthetic 0'), false);
  assert.deepEqual(seedSteamReviewCommentsCheckpoint(oldConfig, seed, []), seed);
  await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: seed });
  assert.throws(() => seedSteamReviewCommentsCheckpoint({ ...oldConfig, parentReviewSourceId: 'other' }, seed, []), /INVALID_CHECKPOINT/);
  await assert.rejects(new SteamReviewCommentsConnector({ ...oldConfig, parentReviewSourceId: 'other' }, { fetch: async () => reviewsPage() }).sync(f.host, signal()), /INVALID_CHECKPOINT/);
  const checkedThreads = [];
  const connector = new SteamReviewCommentsConnector({ ...oldConfig }, { now: () => 1800000000000, sleep: async () => {}, fetch: async url => {
    if (url.hostname === 'api.steampowered.com') return reviewsPage([review(), review('7002', '76561198000000003', 0)], 'page/2');
    const owner = url.pathname.split('/').filter(Boolean).at(-2); checkedThreads.push(owner);
    return owner === '76561198000000003' ? threadPage([], 0, 0) : threadPage([sourceReply('900001', 'synthetic 0')], 0, 1);
  } });
  await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 19);
  assert.ok(checkedThreads.includes('76561198000000003'));
  assert.equal((await f.host.getCheckpoint()).observations['comment:7001:900001'].revision, 1);
  assert.equal(JSON.stringify(await f.host.getCheckpoint()).includes('eventIds'), false);
  assert.ok(f.runtime.store.get('SELECT event_id FROM source_events WHERE external_event_id=?', oldEvents[0].id));
});


test('legacy v2 checkpoint eventIds are compacted while revision counters stay stable', async t => {
  const f = connectorFixture(t, 'steam-reviews'), cfg = config(f);
  const commentId = 'comment:7001:900001';
  const state = seedSteamReviewCommentsCheckpoint(cfg, null, []);
  state.observations[commentId] = { materialHash: 'a'.repeat(64), revision: 5,
    eventIds: Array.from({ length: 25 }, (_, n) => 'old-event-' + n), observedAt: new Date(1800000000000).toISOString() };
  await f.host.commitBatch([], { sourceId: f.scope.sourceId, cursor: state });
  const collector = new SteamReviewCommentsConnector(cfg, { now: () => 1800000000000, sleep: async () => {},
    fetch: async () => reviewsPage([], 'end') });
  await collector.sync(f.host, signal());
  const current = await f.host.getCheckpoint();
  assert.equal(current.observations[commentId].revision, 5);
  assert.equal(current.observations[commentId].materialHash, 'a'.repeat(64));
  assert.equal(Object.hasOwn(current.observations[commentId], 'eventIds'), false);
  assert.equal(f.events(f.runtime).length, 0);
});
