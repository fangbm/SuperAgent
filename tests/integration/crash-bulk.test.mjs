import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import test from 'node:test';
import { fixture, initial, scope, event, count } from './helpers.mjs';

async function terminateAtReady(t, filename, scenario) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), filename, scenario], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child did not reach READY: ${stderr}`)), 10_000);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; if (output.includes('READY\n')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); if (!output.includes('READY\n')) reject(new Error(`Child exited early: ${stderr}`)); });
  });
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
}

for (const scenario of ['uncommitted', 'committed', 'segment', 'lease']) {
  test(`real process termination recovers ${scenario} SQLite state`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    f.runtime.close();
    await terminateAtReady(t, f.filename, scenario);
    f.setTime(Date.parse(initial) + 121_000);
    const reopened = f.open();
    assert.equal(reopened.store.get('PRAGMA quick_check').quick_check, 'ok');
    if (scenario === 'uncommitted') {
      for (const table of ['source_events', 'event_outbox', 'sync_cursors', 'source_objects']) assert.equal(count(reopened.store, table), 0, table);
      return;
    }
    assert.equal(count(reopened.store, 'source_events'), 1);
    assert.equal(reopened.ingress.getCheckpoint(scope), 'durable-cursor');
    const tick = reopened.tick();
    if (scenario === 'lease') assert.equal(tick.recoveredJobs, 1);
    if (scenario !== 'segment') { f.advance(60_001); reopened.tick(); }
    assert.equal(count(reopened.store, 'feedback_batches'), 1);
    assert.equal(reopened.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage'").n, 1);
    reopened.tick();
    assert.equal(count(reopened.store, 'feedback_batches'), 1);
  });
}

test('10,000 persisted events produce only bounded compute batches with no full-Agent execution', { timeout: 60_000 }, t => {
  const f = fixture(t, { auditSampleRate: 0.02 });
  const { runtime } = f;
  const started = performance.now();
  for (let offset = 0; offset < 10_000; offset += 1_000) {
    const events = Array.from({ length: 1_000 }, (_, i) => event(`bulk-${offset + i}`, { text: (offset + i) % 100 === 0 ? '切换场景时出现崩溃' : '早上好' }));
    const receipt = runtime.ingress.commitBatch(scope, events, { sourceId: scope.sourceId, cursor: offset + 1_000 });
    assert.equal(receipt.accepted, 1_000);
  }
  const ingressMs = performance.now() - started;
  assert.equal(count(runtime.store, 'source_events'), 10_000);
  assert.equal(count(runtime.store, 'jobs'), 0); // ingress never starts inference/jobs directly
  assert.equal(count(runtime.store, 'feedback_batches'), 0);
  for (let i = 0; i < 10; i++) {
    const tick = runtime.tick();
    assert.equal(tick.failed, 0);
    assert.equal(tick.admitted, 1_000);
  }
  f.advance(121_000); runtime.tick();
  const metrics = runtime.metrics();
  assert.equal(metrics.sourceEventsIngested, 10_000);
  assert.equal(metrics.admissionDecisions, 10_000);
  assert.equal(metrics.pendingOutbox, 0);
  assert.equal(metrics.openSegments, 0);
  assert.ok(metrics.fullAgentJobs > 0 && metrics.fullAgentJobs < 1_000);
  const candidates = runtime.store.get("SELECT count(*) n FROM batch_events WHERE role='candidate'").n;
  assert.equal(runtime.store.get("SELECT count(DISTINCT event_id) n FROM batch_events WHERE role='candidate'").n, candidates);
  assert.equal(runtime.store.get("SELECT count(*) n FROM jobs WHERE kind='feedback.batch.triage' AND status<>'pending'").n, 0);
  for (const row of runtime.store.all('SELECT batch_json FROM feedback_batches')) {
    const batch = JSON.parse(row.batch_json);
    assert.ok(batch.candidateEventIds.length <= 30);
    assert.ok(batch.contextEventIds.length <= 50);
  }
  assert.equal(runtime.ingress.getCheckpoint(scope), 10_000);
  assert.equal(count(runtime.store, 'external_operations'), 0);
  const report = { scenario: 'synthetic-file-backed-10000-events', ingressMs: Math.round(ingressMs), totalMs: Math.round(performance.now() - started), ...metrics };
  mkdirSync(new URL('../../.artifacts/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../../.artifacts/m1-10000-events.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify(report));
});

test('persistent worker loop advances state and stops on AbortSignal', { timeout: 5_000 }, async t => {
  const { runtime } = fixture(t);
  runtime.ingress.commitBatch(scope, [event('loop')]);
  const controller = new AbortController();
  await runtime.run(controller.signal, { pollIntervalMs: 10, onTick: result => { assert.equal(result.admitted, 1); controller.abort(); } });
  assert.equal(count(runtime.store, 'admission_decisions'), 1);
});

test('a fully actionable burst still batches each source event exactly once', t => {
  const f = fixture(t);
  f.runtime.ingress.commitBatch(scope, Array.from({ length: 1_000 }, (_, i) => event(`all-feedback-${i}`)));
  assert.equal(f.runtime.tick().failed, 0);
  f.advance(121_000); f.runtime.tick();
  assert.equal(count(f.runtime.store, 'source_events'), 1_000);
  assert.equal(count(f.runtime.store, 'feedback_batches'), 34);
  assert.equal(f.runtime.store.get("SELECT count(*) n FROM batch_events WHERE role='candidate'").n, 1_000);
});
