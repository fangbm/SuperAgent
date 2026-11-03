import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { M1Runtime } from '@superagent/agent-core';
import { CommunitySubmissions, DurableCommunityState } from '@superagent/plugin-host';
import { defaultPolicy, initial } from './helpers.mjs';

const guildId = '100';
const binding = { projectId: 'ticket-crash-private', sourceId: 'discord-100-tickets', sourceUri: 'urn:superagent:source:discord:100:tickets', platform: 'discord' };
const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
const childPath = fileURLToPath(new URL('./core-ticket-crash-child.mjs', import.meta.url));

function database(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'superagent-ticket-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'ticket-crash.sqlite');
}

async function killAtReady(t, filename, scenario) {
  const child = spawn(process.execPath, [childPath, filename, scenario], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; let output = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
  child.stdout.setEncoding('utf8');
  const exited = once(child, 'exit');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Ticket crash child did not reach READY: ${stderr}`)), 10_000);
    child.stdout.on('data', data => { output += data; if (output.includes('READY\n')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); if (!output.includes('READY\n')) reject(new Error(`Ticket crash child exited early: ${stderr}`)); });
  });
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
}

function open(filename, now, owner) {
  const runtime = new M1Runtime(filename, { policy: { ...defaultPolicy, auditSampleRate: 0 }, clock: () => new Date(now).toISOString() });
  const state = new DurableCommunityState(runtime.store, `discord-community:${guildId}`, { clock: () => new Date(now).toISOString(), leaseOwner: owner });
  assert.equal(state.acquireLease(owner, 45_000), true);
  const submissions = new CommunitySubmissions(runtime.ingress, state, { scope, guildId, clock: () => new Date(now).toISOString() });
  return { runtime, state, submissions };
}

function count(runtime, table, ...params) {
  const where = table === 'source_events' ? ' WHERE project_id=? AND source_id=?' : ' WHERE event_id IN (SELECT event_id FROM source_events WHERE project_id=? AND source_id=?)';
  return runtime.store.get(`SELECT count(*) n FROM ${table}${where}`, ...params).n;
}

test('process death after ticket transaction commit recovers pending intent without Interaction replay', { timeout: 15_000 }, async t => {
  const filename = database(t);
  await killAtReady(t, filename, 'committed');
  const reopened = open(filename, Date.parse(initial) + 45_001, 'replacement-controller');
  try {
    const row = reopened.runtime.store.get('SELECT event_id FROM source_events WHERE project_id=? AND source_id=?', scope.projectId, scope.sourceId);
    assert.ok(row?.event_id, 'archived event has its durable internal ID');
    assert.equal(count(reopened.runtime, 'source_events', scope.projectId, scope.sourceId), 1);
    assert.equal(count(reopened.runtime, 'event_outbox', scope.projectId, scope.sourceId), 1);
    const recovered = reopened.submissions.recover();
    assert.equal(recovered.recovered, 0, 'atomic receipt was already committed; recovery is idempotent');
    const ticket = reopened.state.getSync('ticket:9901');
    assert.equal(ticket.status, 'pending_create');
    assert.equal(ticket.evidenceEventId, row.event_id);
    assert.equal(reopened.state.getSync('ticket:open:700'), '9901');
    assert.equal(reopened.state.getSync('interaction:9901').eventId, row.event_id);
    assert.equal(reopened.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=? AND source_id=?', scope.projectId, scope.sourceId).n, 1);
  } finally { reopened.runtime.close(); }
});

test('process death inside ticket transaction leaves no event, outbox, cursor, or partial lifecycle state', { timeout: 15_000 }, async t => {
  const filename = database(t);
  await killAtReady(t, filename, 'mid-transaction');
  const reopened = open(filename, Date.parse(initial) + 45_001, 'replacement-controller');
  try {
    assert.equal(count(reopened.runtime, 'source_events', scope.projectId, scope.sourceId), 0);
    assert.equal(count(reopened.runtime, 'event_outbox', scope.projectId, scope.sourceId), 0);
    assert.equal(reopened.runtime.store.get('SELECT cursor_json FROM sync_cursors WHERE source_id=?', scope.sourceId), undefined);
    assert.equal(reopened.state.getSync('ticket:9901'), null);
    assert.equal(reopened.state.getSync('ticket:open:700'), null);
    assert.equal(reopened.state.getSync('interaction:9901'), null);
    assert.deepEqual(reopened.submissions.recover(), { recovered: 0, staleLocksCleared: 0 });
  } finally { reopened.runtime.close(); }
});
