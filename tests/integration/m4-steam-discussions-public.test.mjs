import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { validateContract } from '@superagent/contract-validation';
import { connectorFixture, signal } from './m4-helpers.mjs';

const fixture = name => readFileSync(fileURLToPath(new URL('../fixtures/m4/steam-discussions-public-' + name, import.meta.url)), 'utf8');
const config = sourceUri => ({ sourceUri, appId: 5335850, mode: 'public', maxRequestsPerSync: 25, requestIntervalMs: 2000 });
function service(t, { budget = 25, now = () => new Date('2026-11-04T00:00:00Z'), topicText = () => 'Synthetic original body', topicTitle = () => '', failEvents = false } = {}) {
  const f = connectorFixture(t, 'steam-discussions');
  const calls = [];
  let failureCheckpoint;
  const fetch = async input => {
    const url = new URL(input); calls.push(url);
    let body;
    if (url.pathname === '/app/5335850/discussions/0/') body = fixture('forum.html');
    else if (url.pathname.startsWith('/forum/')) body = fixture('list-start' + url.searchParams.get('start') + '.json');
    else if (url.pathname.startsWith('/comment/ForumTopic/render/')) {
      const gid = url.searchParams.get('feature2'); const start = Number(url.searchParams.get('start'));
      body = !['571553580273786059', '571553580273908405'].includes(gid) ? JSON.stringify({ success: true, start, total_count: 0, comments_html: '' }) : fixture('replies-start' + start + '.json');
    }
    else {
      const gid = url.pathname.split('/').filter(Boolean).at(-1);
      body = fixture('topic.html').replaceAll('571553580273786059', gid).replace('Synthetic topic', 'Synthetic topic' + topicTitle(gid) + ' ' + gid)
        .replace('Synthetic original body', topicText(gid));
      if (!['571553580273786059', '571553580273908405'].includes(gid)) body = body.replace('"total_count":16', '"total_count":0');
    }
    return new Response(body, { status: 200, headers: { 'content-type': url.pathname.includes('/render/') ? 'application/json' : 'text/html' } });
  };
  const opts = { fetch, sleep: async () => {}, clock: now };
  const connector = new SteamDiscussionsConnector({ ...config(f.binding.sourceUri), maxRequestsPerSync: budget, rescanIntervalMs: 2000 }, opts);
  const host = failEvents ? { ...f.host, commitBatch: async (events, checkpoint) => {
    if (events.length) { failureCheckpoint = await f.host.getCheckpoint(); throw new Error('injected commit failure'); }
    return f.host.commitBatch(events, checkpoint);
  } } : f.host;
  return { ...f, connector, host, calls, failureCheckpoint: () => failureCheckpoint,
    restart: () => new SteamDiscussionsConnector({ ...config(f.binding.sourceUri), maxRequestsPerSync: budget, rescanIntervalMs: 2000 }, opts) };
}
async function drain(connector, host, max = 100) {
  for (let i = 0; i < max; i++) {
    await connector.sync(host, signal());
    const checkpoint = await host.getCheckpoint();
    if (checkpoint?.phase === 'head' && Object.values(checkpoint.topics).every(topic => topic.lastChecked > 0)) return;
  }
  assert.fail('public scan did not complete within request-budget continuations');
}

test('public mode pages topic lists and replies through the real Source Host with stable relations', async t => {
  const f = service(t); await drain(f.connector, f.host);
  const events = f.events(f.runtime);
  assert.equal(events.length, 48);
  assert.ok(f.calls.filter(url => url.pathname.startsWith('/forum/')).some(url => url.searchParams.get('start') === '15'));
  assert.equal(f.calls.filter(url => url.pathname.startsWith('/comment/ForumTopic/render/')).length, 18);
  for (const event of events) assert.equal(validateContract('normalized-event-v1', event).valid, true);
  const thread = events.find(event => event.data.object.externalId === 'thread:571553580273786059');
  assert.equal(thread.type, 'com.superagent.feedback.thread.created.v1');
  assert.equal(thread.data.content.text, 'Synthetic original body\ncontinued\nagain');
  assert.match(thread.data.attributes.nativeHtml, /<p>continued<br>again<\/p>/);
  assert.equal(thread.data.attributes.title, 'Synthetic topic 571553580273786059');
  const reply = events.find(event => event.data.object.externalId === 'comment:571553580273786059:572600000000000001');
  assert.equal(reply.data.object.threadExternalId, thread.data.object.externalId);
  assert.equal(reply.data.object.parentExternalId, thread.data.object.externalId);
  assert.equal(reply.data.content.text, 'synthetic reply 1\ncontinued');
  assert.match(reply.data.attributes.nativeHtml, /<p>synthetic reply 1<\/p>/);
  assert.equal(reply.data.attributes.appId, 5335850);
  assert.equal(f.calls.every(url => url.hostname === 'steamcommunity.com'), true);
});

test('public scan resumes at request budget and only emits distinct A/B/A observations', async t => {
  let text = 'A'; let titleEdit = false; let now = Date.UTC(2026, 10, 4); const f = service(t, { budget: 2, now: () => new Date(now), topicText: () => text, topicTitle: () => titleEdit ? ' edited' : '' });
  await drain(f.connector, f.host);
  const checkpoint = await f.host.getCheckpoint();
  assert.equal(checkpoint.mode, 'public');
  const initial = f.events(f.runtime).filter(event => event.data.object.externalId === 'thread:571553580273786059');
  assert.equal(initial.length, 1);
  text = 'B'; now += 2001; await drain(f.connector, f.host);
  text = 'A'; now += 2001; await drain(f.connector, f.host);
  const revisions = f.events(f.runtime).filter(event => event.data.object.externalId === 'thread:571553580273786059');
  assert.deepEqual(revisions.map(event => event.data.content.text), ['A\ncontinued\nagain', 'B\ncontinued\nagain', 'A\ncontinued\nagain']);
  assert.equal(new Set(revisions.map(event => event.data.object.revision)).size, 3);
  titleEdit = true; now += 2001; await drain(f.connector, f.host);
  const edited = f.events(f.runtime).filter(event => event.data.object.externalId === 'thread:571553580273786059');
  assert.equal(edited.at(-1).data.attributes.title, 'Synthetic topic edited 571553580273786059');
  assert.equal(edited.at(-1).type, 'com.superagent.feedback.thread.updated.v1');
  const before = f.events(f.runtime).length;
  await f.connector.sync(f.host, signal());
  assert.equal(f.events(f.runtime).length, before);
});

test('public list pages reject a mismatched offset without advancing the last committed checkpoint', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let pageCheckpoint;
  const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { sleep: async () => {}, fetch: async input => {
    const url = new URL(input);
    if (url.pathname.startsWith('/forum/')) { pageCheckpoint = await f.host.getCheckpoint(); return new Response(fixture('list-start15.json'), { status: 200 }); }
    return new Response(fixture('forum.html'), { status: 200 });
  } });
  await connector.sync(f.host, signal());
  const after = await f.host.getCheckpoint();
  assert.equal(after.backgroundStart, pageCheckpoint.backgroundStart);
  assert.deepEqual(after.topics, pageCheckpoint.topics);
  assert.match(after.headError, /forum page shape/);
  assert.match(f.runtime.store.get('SELECT health_reason FROM sources WHERE source_id=?', f.scope.sourceId).health_reason, /forum page shape/);
  assert.equal(f.events(f.runtime).length, 0);
});

test('public checkpoints are bound to source URI as well as app and forum', async t => {
  const f = service(t); await f.connector.sync(f.host, signal());
  const before = await f.host.getCheckpoint();
  const other = new SteamDiscussionsConnector(config('urn:superagent:source:another-discussions-source'), { sleep: async () => {} });
  await assert.rejects(other.sync(f.host, signal()), /INVALID_CHECKPOINT/);
  assert.deepEqual(await f.host.getCheckpoint(), before);
});

test('actual retries consume the per-sync budget and honor Retry-After', async t => {
  const f = connectorFixture(t, 'steam-discussions'); const waits = []; let calls = 0;
  const connector = new SteamDiscussionsConnector({ ...config(f.binding.sourceUri), maxRequestsPerSync: 2 }, { sleep: async ms => { waits.push(ms); }, fetch: async () => {
    calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : new Response(fixture('forum.html'), { status: 200 });
  } });
  await connector.sync(f.host, signal());
  assert.equal(calls, 2);
  assert.equal(waits.some(ms => ms >= 3000), true);
  assert.deepEqual((await f.host.getCheckpoint()).forums['0'].feature, '0');
});

test('a network failure retains the current list offset for the next poll', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let failedPageCheckpoint; let listCalls = 0;
  const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { sleep: async () => {}, fetch: async input => {
    const url = new URL(input);
    if (url.pathname === '/app/5335850/discussions/0/') return new Response(fixture('forum.html'), { status: 200 });
    failedPageCheckpoint = await f.host.getCheckpoint(); listCalls++; throw new Error('offline');
  } });
  await connector.sync(f.host, signal());
  assert.equal(listCalls, 8);
  const after = await f.host.getCheckpoint();
  assert.equal(after.backgroundStart, failedPageCheckpoint.backgroundStart);
  assert.deepEqual(after.topics, failedPageCheckpoint.topics);
  assert.match(after.listError, /TRANSIENT_NETWORK/);
  assert.equal(Object.keys(failedPageCheckpoint.topics).length, 0);
});

test('a blocked forum reports unavailable coverage until public list access succeeds', async t => {
  const f = connectorFixture(t, 'steam-discussions'); const health = [];
  const host = { ...f.host, reportHealth: async info => { health.push(info); await f.host.reportHealth(info); } };
  const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { fetch: async () => new Response('', { status: 403 }), sleep: async () => {} });
  await connector.sync(host, signal());
  assert.equal(health.at(-1).coverage, 'unavailable');
  assert.match(health.at(-1).reason, /PERMISSION_DENIED/);
  assert.equal((await connector.probe()).coverage, 'unavailable');
});

test('public failed Host commits do not advance beyond committed checkpoints', async t => {
  const f = service(t, { budget: 25, failEvents: true });
  await assert.rejects(f.connector.sync(f.host, signal()), /injected commit failure/);
  assert.deepEqual(await f.host.getCheckpoint(), f.failureCheckpoint());
  assert.equal(f.events(f.runtime).length, 0);
});

test('a private topic is retained as a gap while later public topics continue', async t => {
  const denied = connectorFixture(t, 'steam-discussions');
  const health = [];
  const host = { ...denied.host, reportHealth: async info => { health.push(info); await denied.host.reportHealth(info); } };
  const connector = new SteamDiscussionsConnector(config(denied.binding.sourceUri), { sleep: async () => {}, clock: () => new Date('2026-11-04T00:00:00Z'), fetch: async input => {
    const url = new URL(input); let body;
    if (url.pathname === '/app/5335850/discussions/0/') body = fixture('forum.html');
    else if (url.pathname.startsWith('/forum/')) body = fixture('list-start' + url.searchParams.get('start') + '.json');
    else if (url.pathname.startsWith('/comment/')) {
      const gid = url.searchParams.get('feature2'); const start = Number(url.searchParams.get('start'));
      body = gid === '571553580273786059' ? fixture('private.json') : !['571553580273908405'].includes(gid)
        ? JSON.stringify({ success: true, start, total_count: 0, comments_html: '' }) : fixture('replies-start' + start + '.json');
    }
    else {
      const gid = url.pathname.split('/').filter(Boolean).at(-1);
      body = fixture('topic.html').replaceAll('571553580273786059', gid);
      if (!['571553580273786059', '571553580273908405'].includes(gid)) body = body.replace('"total_count":16', '"total_count":0');
    }
    return new Response(body, { status: 200 });
  } });
  await drain(connector, host);
  const events = denied.events(denied.runtime); const checkpoint = await host.getCheckpoint();
  assert.equal(events.filter(event => event.data.object.kind === 'thread').length, 16);
  assert.equal(events.some(event => event.data.object.externalId.startsWith('comment:571553580273786059:')), false);
  assert.equal(events.some(event => event.data.object.externalId.startsWith('comment:571553580273908405:')), true);
  assert.match(checkpoint.topics['571553580273786059'].gap, /UNAVAILABLE_OR_PRIVATE/);
  assert.equal(checkpoint.topics['571553580273786059'].start, 0);
  assert.equal(checkpoint.topics['571553580273786059'].retryAt - Date.parse('2026-11-04T00:00:00Z'), 600000);
  assert.match(health.at(-1).reason, /retryableGaps=1.*571553580273786059:UNAVAILABLE_OR_PRIVATE/);
});

test('a one-request budget fairly resumes head, background lists and reply pages after process restart', async t => {
  const f = service(t, { budget: 1 });
  await f.connector.sync(f.host, signal());
  const before = await f.host.getCheckpoint();
  f.runtime.close(); const reopened = f.open(); const host = f.getHost(reopened);
  assert.deepEqual(await host.getCheckpoint(), before);
  for (let round = 0; round < 160; round++) {
    const calls = f.calls.length;
    await f.restart().sync(host, signal());
    assert.ok(f.calls.length - calls <= 1);
    const cp = await host.getCheckpoint();
    if (!cp.backgroundActive && !cp.topicQueue.length && Object.keys(cp.topics).length === 16) break;
    assert.ok(round < 159, 'all three queues must advance with one request and fresh plugin instances');
  }
  assert.equal(f.events(reopened).length, 48);
  assert.ok(f.calls.some(url => url.searchParams.get('start') === '15' && url.pathname.startsWith('/forum/')));
});

test('head activity discovers a fresh topic and new reply while older backfill remains pending', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let changed = false;
  const ids = Array.from({ length: 45 }, (_, i) => String(8000 + i)); const requests = [];
  const connector = new SteamDiscussionsConnector({ ...config(f.binding.sourceUri), maxRequestsPerSync: 4 }, { sleep: async () => {},
    clock: () => new Date('2026-11-04T00:00:00Z'), fetch: async input => {
      const url = new URL(input); requests.push(url);
      if (url.pathname === '/app/5335850/discussions/0/') return new Response(fixture('forum.html'));
      if (url.pathname.startsWith('/forum/')) {
        const all = changed ? ['9999', '8014', ...ids.filter(id => id !== '8014')] : ids; const start = Number(url.searchParams.get('start'));
        return Response.json({ success: 1, start, total_count: all.length, topics_html: all.slice(start, start + 15).map(id =>
          `<div class="forum_topic"><span class="forum_topic_name">Topic ${id}</span><span class="forum_topic_reply_count">${changed && id === '8014' ? 1 : 0}</span><a class="forum_topic_overlay" data-gidforumtopic="${id}" href="/app/5335850/discussions/0/${id}/"></a></div>`).join('') });
      }
      const gid = url.searchParams.get('feature2') ?? url.pathname.split('/').filter(Boolean).at(-1);
      const total = changed && gid === '8014' ? 1 : 0;
      if (url.pathname.startsWith('/comment/')) return Response.json({ success: true, start: Number(url.searchParams.get('start')), total_count: total,
        comments_html: total ? '<div class="commentthread_comment" id="comment_9014"><div class="commentthread_comment_text">Fresh reply</div><span data-timestamp="1700000000"></span></div>' : '' });
      return new Response(fixture('topic.html').replaceAll('571553580273786059', gid).replace('"total_count":16', `"total_count":${total}`));
    } });
  await connector.sync(f.host, signal()); await connector.sync(f.host, signal());
  assert.ok((await f.host.getCheckpoint()).topics['8014'].lastChecked > 0);
  changed = true;
  for (let round = 0; round < 4; round++) { const before = requests.length; await connector.sync(f.host, signal()); assert.ok(requests.length - before <= 4); }
  const cp = await f.host.getCheckpoint(); const events = f.events(f.runtime);
  assert.ok(events.some(event => event.data.object.externalId === 'thread:9999'));
  assert.ok(events.some(event => event.data.object.externalId === 'comment:8014:9014'));
  assert.ok(cp.topicQueue.length > 0, 'old backfill is still pending while new material is archived');
  assert.ok(requests.some(url => url.pathname.startsWith('/forum/') && Number(url.searchParams.get('start')) >= 30));
});

test('chunked oversized public responses are cancelled before parsing or advancing object cursors', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let cancelled = 0;
  const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { sleep: async () => {}, fetch: async () => {
    let count = 0;
    return new Response(new ReadableStream({ pull(controller) { if (count++ < 3) controller.enqueue(new Uint8Array(3 * 1024 * 1024)); else controller.close(); }, cancel() { cancelled++; } }));
  } });
  await connector.sync(f.host, signal());
  assert.ok(cancelled > 0); assert.equal(f.events(f.runtime).length, 0);
  const cp = await f.host.getCheckpoint(); assert.deepEqual(cp.forums, {}); assert.deepEqual(cp.topics, {});
  assert.match(cp.headError, /RESPONSE_TOO_LARGE/);
});

test('public probe and sync never issue concurrent platform requests', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let active = 0; let peak = 0;
  const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { sleep: async () => {}, fetch: async input => {
    active++; peak = Math.max(peak, active); await new Promise(setImmediate); active--;
    return new URL(input).pathname.startsWith('/forum/') ? Response.json({ success: 1, start: 0, total_count: 0, topics_html: '' }) : new Response(fixture('forum.html'));
  } });
  await Promise.all([connector.sync(f.host, signal()), connector.probe()]); assert.equal(peak, 1);
});

test('a restarted public collector honors a committed Retry-After deadline', async t => {
  const f = connectorFixture(t, 'steam-discussions'); let now = Date.parse('2026-11-04T00:00:00Z'); let calls = 0;
  const options = { sleep: async () => {}, clock: () => new Date(now), fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); } };
  const make = () => new SteamDiscussionsConnector({ ...config(f.binding.sourceUri), maxRequestsPerSync: 1 }, options);
  await make().sync(f.host, signal());
  assert.equal(calls, 1); const before = await f.host.getCheckpoint(); assert.equal(before.retryAfter, now + 3600000);
  now += 600000; await make().sync(f.host, signal());
  assert.equal(calls, 1); assert.deepEqual(await f.host.getCheckpoint(), before);
});

test('negative list, topic and reply totals cannot create a poisoned checkpoint or advance a failed page', async t => {
  for (const surface of ['list','topic','reply']) await t.test(surface, async t => {
    const f = connectorFixture(t, 'steam-discussions');
    const connector = new SteamDiscussionsConnector(config(f.binding.sourceUri), { sleep: async () => {}, fetch: async input => {
      const url = new URL(input);
      if (url.pathname === '/app/5335850/discussions/0/') return new Response(fixture('forum.html'));
      if (url.pathname.startsWith('/forum/')) return surface === 'list' ? Response.json({ success:1,start:0,total_count:-1,topics_html:'' }) : new Response(fixture('list-start'+url.searchParams.get('start')+'.json'));
      if (url.pathname.startsWith('/comment/')) return Response.json({success:true,start:0,total_count:-1,comments_html:''});
      const gid=url.pathname.split('/').filter(Boolean).at(-1);
      const body=fixture('topic.html').replaceAll('571553580273786059',gid);
      return new Response(surface==='topic'?body.replace('"total_count":16','"total_count":-1'):body);
    } });
    await connector.sync(f.host,signal());const cp=await f.host.getCheckpoint();
    assert.ok(Object.values(cp.topics).every(topic=>topic.total>=0&&topic.start===0));
    assert.equal(f.events(f.runtime).some(event=>event.data.object.kind==='comment'),false);
    if(surface==='list'){assert.equal(cp.backgroundStart,0);assert.equal(cp.backgroundActive,true);}
    // Reading the committed cursor a second time must remain valid even while pages stay malformed.
    await connector.sync(f.host,signal());
  });
});

test('v1 public thread metadata is refreshed without resetting a committed reply-page offset', async t => {
  const f=service(t,{budget:4});await f.connector.sync(f.host,signal());
  const cp=await f.host.getCheckpoint();const gid=Object.keys(cp.topics)[0];
  cp.version=1;cp.phase='topics';cp.topicQueue=[gid];cp.topics[gid].start=15;cp.topics[gid].total=16;
  cp.topics[gid].extendedData='legacy cached metadata';delete cp.topics[gid].commentOwner;delete cp.topics[gid].commentFeature;
  await f.host.commitBatch([],{sourceId:f.scope.sourceId,cursor:cp});
  const before=f.calls.length;await f.restart().sync(f.host,signal());
  const after=await f.host.getCheckpoint();assert.equal(after.version,2);
  assert.ok(f.calls.slice(before).some(url=>url.pathname.startsWith('/comment/')&&url.searchParams.get('feature2')===gid&&url.searchParams.get('start')==='15'));
});
