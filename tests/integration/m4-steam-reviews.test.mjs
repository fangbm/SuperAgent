import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SteamReviewsConnector, normalizeSteamReview } from '@superagent/connector-steam-reviews';
import { validateContract } from '@superagent/contract-validation';
import { connectorFixture, nativeFixture, signal } from './m4-helpers.mjs';
const review = (patch = {}) => ({ ...nativeFixture('steam-review'), ...patch });
const page = (reviews = [], cursor = 'end') => Response.json({ response: { reviews, cursor } });
const config = f => ({ sourceUri: f.binding.sourceUri, appId: 570 });

test('Steam live polling probe exposes a recovered network interruption without counting probe success as a scan', async t => {
  const f=connectorFixture(t,'steam-reviews'),health=[],controller=new AbortController();let polling=false,failNext=false;
  const connector=new SteamReviewsConnector({...config(f),pollIntervalMs:60000},{fetch:async()=>{if(failNext){failNext=false;throw new TypeError('network');}return page();},sleep:async(ms,signal)=>{
    if(ms===60000){polling=true;await delay(ms,undefined,{signal});}
  }});
  const run=connector.start({...f.host,reportHealth:async info=>{await f.host.reportHealth(info);health.push(info);}},controller.signal);
  try {
    for(let n=0;!polling&&n<200;n++)await delay(5);
    assert.ok(polling);const old=await f.host.getCheckpoint();health.length=0;failNext=true;
    assert.equal((await connector.probe()).coverage,'partial');
    assert.deepEqual(health.map(h=>h.reason),['STEAM_REVIEWS_POLL_INTERRUPTED:TRANSIENT_NETWORK']);
    assert.deepEqual(await f.host.getCheckpoint(),old);
  } finally {controller.abort();await run;await connector.stop();}
});

test('Steam native fixtures retain IDs, text, author, language and metadata; equal text by different players survives', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const first = normalizeSteamReview(review(), config(f), f.scope);
  assert.equal(validateContract('normalized-event-v1', first).valid, true);
  assert.equal(first.data.object.externalId, '18446744073709550001');
  assert.equal(first.data.content.text, review().review);
  assert.equal(first.data.content.language, 'schinese');
  assert.equal(first.data.attributes.native.votes_up, 3);
  const other = normalizeSteamReview(review({ recommendationid: '18446744073709550002', author: { steamid: '76561198000000002' } }), config(f), f.scope);
  const receipt = await f.host.commitBatch([first, other]);
  const duplicate = await f.host.commitBatch([first, other]);
  assert.equal(duplicate.duplicates, 2);
  assert.deepEqual(duplicate.refs.map(ref => ref.eventId), receipt.refs.map(ref => ref.eventId));
  assert.equal(f.events(f.runtime).length, 2);
  assert.notEqual(receipt.refs[0].eventId, first.id);
  assert.throws(() => normalizeSteamReview(review({ recommendationid: 18446744073709550001 }), config(f), f.scope), /INVALID_EVENT/);
});

test('Steam pagination resumes from file-backed Host checkpoint after restart', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const requests = [];
  const first = new SteamReviewsConnector({ ...config(f), maxPagesPerSync: 1 }, { fetch: async url => {
    const q = JSON.parse(url.searchParams.get('input_json')); requests.push(q);
    return page([review()], 'second/page+encoded=');
  } });
  await first.sync(f.host, signal());
  assert.equal((await f.host.getCheckpoint()).cursor, 'second/page+encoded=');
  assert.equal(requests[0].review_type, 0);
  assert.equal(requests[0].purchase_type, 1);
  assert.deepEqual(requests[0].languages, ['all']);
  assert.equal(requests[0].filter_offtopic_activity, false);
  f.runtime.close(); const reopened = f.open(); const host = f.getHost(reopened);
  let calls = 0;
  const next = new SteamReviewsConnector(config(f), { fetch: async url => {
    const cursor = JSON.parse(url.searchParams.get('input_json')).cursor;
    if (calls++ === 0) { assert.equal(cursor, 'second/page+encoded='); return page([review({ recommendationid: '42' })], 'third'); }
    return page();
  } });
  await next.sync(host, signal());
  assert.equal(f.events(reopened).length, 2);
  assert.equal((await host.getCheckpoint()).cursor, '*');
  assert.equal((await host.getCheckpoint()).watermark, review().timestamp_updated);
});

test('Steam negative-to-positive and text edits preserve independent history and stable object IDs', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  let current = review(); let request = 0;
  const connector = new SteamReviewsConnector(config(f), { fetch: async () => (++request % 2 ? page([current], 'next') : page()) });
  await connector.sync(f.host, signal());
  current = review({ voted_up: true, review: '更新后已经修复。', timestamp_updated: review().timestamp_updated + 60 });
  await connector.sync(f.host, signal());
  await connector.sync(f.host, signal());
  const events = f.events(f.runtime);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'com.superagent.feedback.review.updated.v1');
  assert.equal(events[1].data.attributes.voted_up, true);
  assert.equal(events[0].data.object.externalId, events[1].data.object.externalId);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[0].data.content.text, review().review);
});

test('Steam failed batch does not advance checkpoint; restart retries the same page', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const requests = [];
  const options = { fetch: async url => { const cursor = JSON.parse(url.searchParams.get('input_json')).cursor; requests.push(cursor); return cursor === '*' ? page([review()], 'next') : page(); } };
  const failedHost = { ...f.host, commitBatch: async () => { throw new Error('disk full'); } };
  await assert.rejects(new SteamReviewsConnector(config(f), options).sync(failedHost, signal()), /disk full/);
  assert.equal(await f.host.getCheckpoint(), null);
  assert.equal(f.events(f.runtime).length, 0);
  await new SteamReviewsConnector(config(f), options).sync(f.host, signal());
  assert.deepEqual(requests, ['*', '*', 'next']);
  assert.equal(f.events(f.runtime).length, 1);
});

test('Steam invalid response and source identity conflicts roll back all events and the cursor', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const invalidPage = new SteamReviewsConnector(config(f), { fetch: async () => page([review(), review({ recommendationid: 7 })]) });
  await assert.rejects(invalidPage.sync(f.host, signal()), /INVALID_EVENT/);
  assert.equal(f.events(f.runtime).length, 0);
  const first = normalizeSteamReview(review(), config(f), f.scope);
  await f.host.commitBatch([first], { sourceId: f.scope.sourceId, cursor: 'retained' });
  const fresh = normalizeSteamReview(review({ recommendationid: '55' }), config(f), f.scope);
  const conflicting = structuredClone(first); conflicting.data.content.text = 'tampered';
  await assert.rejects(f.host.commitBatch([fresh, conflicting], { sourceId: f.scope.sourceId, cursor: 'bad' }), /EVENT_IDENTITY_CONFLICT/);
  const wrong = structuredClone(fresh); wrong.data.sourceId = 'other';
  await assert.rejects(f.host.commitBatch([fresh, wrong], { sourceId: f.scope.sourceId, cursor: 'bad' }), /EVENT_SOURCE_MISMATCH/);
  assert.equal(f.events(f.runtime).length, 1);
  assert.equal(await f.host.getCheckpoint(), 'retained');
});

test('Steam 429 honors Retry-After, retries network outages, and permission errors retain cursor', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  const waits = []; let calls = 0;
  const connector = new SteamReviewsConnector(config(f), { sleep: async ms => { waits.push(ms); }, fetch: async () => {
    calls++; if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '7' } });
    if (calls === 2) throw new TypeError('network'); return page();
  } });
  const health=[];
  await connector.sync({...f.host,reportHealth:async info=>{await f.host.reportHealth(info);health.push(info);}}, signal());
  assert.deepEqual(waits, [7000, 2000]);
  assert.deepEqual(health.slice(0,2).map(h=>h.reason),['STEAM_REVIEWS_POLL_INTERRUPTED:RATE_LIMITED','STEAM_REVIEWS_POLL_INTERRUPTED:TRANSIENT_NETWORK']);
  assert.ok(health.at(-1).reason.startsWith('Review scan completed'));
  const old = await f.host.getCheckpoint();
  for (const status of [403, 429, 503]) {
    const broken = new SteamReviewsConnector(config(f), { sleep: async () => {}, fetch: async () => new Response('', { status }) });
    await assert.rejects(broken.sync(f.host, signal()));
    assert.deepEqual(await f.host.getCheckpoint(), old);
    assert.equal((await broken.probe()).coverage, 'unavailable');
  }
  assert.equal(f.runtime.store.get('SELECT coverage FROM sources WHERE source_id=?', f.scope.sourceId).coverage, 'unavailable');
});

test('Steam overlap does not skip other reviews with identical updated timestamps', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  let calls = 0;
  const connector = new SteamReviewsConnector(config(f), { fetch: async () => {
    calls++; return calls === 1 ? page([review()], 'next') : calls === 2 ? page() : calls === 3 ? page([review(), review({ recommendationid: '77' })], 'next') : page();
  } });
  await connector.sync(f.host, signal()); await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 2);
  assert.equal((await connector.probe()).coverage, 'partial');
});

test('Steam preserves metadata at content revisions without emitting player feedback for vote-count changes', async t => {
  const f = connectorFixture(t, 'steam-reviews');
  let current = review(); let calls = 0;
  const connector = new SteamReviewsConnector(config(f), { fetch: async () => ++calls % 2 ? page([current], 'next') : page() });
  await connector.sync(f.host, signal());
  current = review({ votes_up: 100, author: { ...review().author, playtime_forever: 500 } });
  await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 1);
  current.review = '文本编辑'; current.timestamp_updated++;
  await connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, 2);
  assert.equal(f.events(f.runtime)[1].data.attributes.native.votes_up, 100);
});
