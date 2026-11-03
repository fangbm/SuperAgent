import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCommunityState } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';

test('community state persists canonical JSON across a real M1 SQLite reopen', async t => {
  const f = fixture(t);
  const state = new DurableCommunityState(f.runtime.store, 'guild:alpha', { clock: f.clock });
  await state.set('room:one', { z: 3, a: { y: true, b: null } });
  assert.equal(f.runtime.store.get("SELECT value_json FROM community_state WHERE namespace='guild:alpha' AND state_key='room:one'").value_json, '{"a":{"b":null,"y":true},"z":3}');

  f.runtime.close();
  const reopened = f.open();
  const afterRestart = new DurableCommunityState(reopened.store, 'guild:alpha', { clock: f.clock });
  assert.deepEqual(await afterRestart.get('room:one'), { a: { b: null, y: true }, z: 3 });
  assert.equal(await afterRestart.get('missing'), null);
});

test('get/set/update return independent JSON snapshots and synchronous reducers commit atomically', async t => {
  const { runtime } = fixture(t);
  const state = new DurableCommunityState(runtime.store, 'guild:reducers');
  await state.set('counter', { count: 1 });
  const got = await state.get('counter');
  got.count = 99;
  assert.deepEqual(await state.get('counter'), { count: 1 });

  const updated = await state.update('counter', old => ({ count: old.count + 1 }));
  updated.count = 88;
  assert.deepEqual(await state.get('counter'), { count: 2 });
  assert.deepEqual(await state.update('initial', old => old === null ? { ready: true } : old), { ready: true });

  await assert.rejects(state.update('counter', async () => ({ count: 3 })), /ASYNC_COMMUNITY_STATE_REDUCER/);
  await assert.rejects(state.update('counter', () => ({ then() {} })), /ASYNC_COMMUNITY_STATE_REDUCER/);
  await assert.rejects(state.update('counter', () => { throw new Error('reducer failure'); }), /reducer failure/);
  await assert.rejects(state.update('counter', () => undefined), /INVALID_JSON/);
  await assert.rejects(state.update('counter', () => Number.POSITIVE_INFINITY), /INVALID_JSON/);
  assert.deepEqual(await state.get('counter'), { count: 2 });
  await assert.rejects(state.set('counter', { bad: undefined }), /INVALID_JSON/);
  assert.deepEqual(await state.get('counter'), { count: 2 });
  await assert.rejects(state.get(''), /INVALID_COMMUNITY_STATE_KEY/);
});

test('list uses exact literal prefixes and isolates namespaces', async t => {
  const { runtime } = fixture(t);
  const one = new DurableCommunityState(runtime.store, 'guild:one');
  const two = new DurableCommunityState(runtime.store, 'guild:two');
  await one.set('ticket:a', 1);
  await one.set('ticket:😀', 2);
  await one.set('ticketXb', 3);
  await one.set('ticket:%_literal', 4);
  await two.set('ticket:foreign', 5);
  assert.deepEqual(await one.list('ticket:'), [
    { key: 'ticket:%_literal', value: 4 },
    { key: 'ticket:a', value: 1 },
    { key: 'ticket:😀', value: 2 },
  ]);
  assert.deepEqual(await one.list('ticket:%_'), [{ key: 'ticket:%_literal', value: 4 }]);
  assert.deepEqual(await two.list('ticket:'), [{ key: 'ticket:foreign', value: 5 }]);
  assert.deepEqual(await one.list(''), [
    { key: 'ticket:%_literal', value: 4 },
    { key: 'ticket:a', value: 1 },
    { key: 'ticket:😀', value: 2 },
    { key: 'ticketXb', value: 3 },
  ]);
});

test('lease acquisition is durable, expires, and fences stale owners from takeover', t => {
  const f = fixture(t);
  let now = '2026-11-02T00:00:00.000Z';
  const state = new DurableCommunityState(f.runtime.store, 'guild:lease', { clock: () => now });
  const otherNamespace = new DurableCommunityState(f.runtime.store, 'guild:other', { clock: () => now });

  assert.equal(state.acquireLease('controller-a', 1_000), true);
  assert.equal(state.acquireLease('controller-b', 1_000), false);
  assert.equal(otherNamespace.acquireLease('controller-b', 1_000), true);
  assert.equal(state.renewLease('controller-a', 2_000), true);
  assert.equal(state.store.get("SELECT generation FROM community_leases WHERE namespace='guild:lease'").generation, 1);

  f.runtime.close();
  const reopened = f.open();
  const afterRestart = new DurableCommunityState(reopened.store, 'guild:lease', { clock: () => now });
  assert.equal(afterRestart.acquireLease('controller-b', 1_000), false);

  now = '2026-11-02T00:00:02.001Z';
  assert.equal(afterRestart.renewLease('controller-a', 1_000), false);
  assert.equal(afterRestart.acquireLease('controller-b', 1_000), true);
  assert.equal(reopened.store.get("SELECT generation FROM community_leases WHERE namespace='guild:lease'").generation, 2);
  assert.equal(afterRestart.acquireLease('controller-a', 1_000), false);
  afterRestart.releaseLease('controller-a');
  assert.equal(afterRestart.renewLease('controller-b', 1_000), true);
  afterRestart.releaseLease('controller-b');
  assert.equal(afterRestart.acquireLease('controller-a', 1_000), true);
});

test('invalid lease arguments are rejected without changing the current owner', t => {
  const { runtime, clock } = fixture(t);
  const state = new DurableCommunityState(runtime.store, 'guild:invalid-lease', { clock });
  assert.equal(state.acquireLease('owner', 10), true);
  assert.throws(() => state.acquireLease('', 10), /INVALID_COMMUNITY_LEASE/);
  assert.throws(() => state.acquireLease('other', 0), /INVALID_COMMUNITY_LEASE/);
  assert.throws(() => state.renewLease('other', Number.NaN), /INVALID_COMMUNITY_LEASE/);
  assert.equal(state.renewLease('owner', 10), true);
  assert.equal(state.store.get("SELECT generation FROM community_leases WHERE namespace='guild:invalid-lease'").generation, 1);
});

test('lease-bound state reads and mutations reject stale owners before running reducers', async t => {
  const { runtime } = fixture(t);
  let now = '2026-11-02T00:00:00.000Z';
  const oldOwner = new DurableCommunityState(runtime.store, 'guild:fenced-state', { clock: () => now, leaseOwner: 'controller-old' });
  const currentOwner = new DurableCommunityState(runtime.store, 'guild:fenced-state', { clock: () => now, leaseOwner: 'controller-current' });

  assert.equal(oldOwner.acquireLease('controller-old', 1_000), true);
  await oldOwner.set('ticket:one', { status: 'open' });
  now = '2026-11-02T00:00:01.001Z';
  assert.equal(currentOwner.acquireLease('controller-current', 5_000), true);

  let reducerCalled = false;
  await assert.rejects(oldOwner.set('ticket:one', { status: 'stale-write' }), /COMMUNITY_LEASE_LOST/);
  await assert.rejects(oldOwner.update('ticket:one', () => { reducerCalled = true; return { status: 'stale-update' }; }), /COMMUNITY_LEASE_LOST/);
  await assert.rejects(oldOwner.get('ticket:one'), /COMMUNITY_LEASE_LOST/);
  await assert.rejects(oldOwner.list('ticket:'), /COMMUNITY_LEASE_LOST/);
  assert.equal(reducerCalled, false);

  oldOwner.releaseLease('controller-old');
  assert.deepEqual(await currentOwner.get('ticket:one'), { status: 'open' });
  assert.deepEqual(await currentOwner.update('ticket:one', value => ({ ...value, checked: true })), { checked: true, status: 'open' });
});
