import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { defaultPolicy, fixture } from './helpers.mjs';

test('M4 archive-only runner commits real Host events/checkpoint and leaves admission/analysis untouched on replay', t => {
  const f = fixture(t, { auditSampleRate: defaultPolicy.auditSampleRate });
  const configPath = path.join(f.directory, 'source.json');
  const sourceUri = 'urn:superagent:source:archive-only-test';
  writeFileSync(configPath, JSON.stringify({ sourceUri, appId: 570, mode: 'snapshot', snapshotPath: path.resolve('tests/fixtures/m4/discussions.json') }));
  const run = () => {
    const result = spawnSync(process.execPath, ['scripts/m4-source.mjs', '--connector', 'steam-discussions', '--config', configPath,
      '--database', f.filename, '--project', 'archive-only', '--source', 'snapshot-only', '--once', '--archive-only'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const first = run();
  assert.ok(first.metrics.sourceEventsIngested > 0);
  assert.equal(first.metrics.pendingOutbox, first.metrics.sourceEventsIngested);
  assert.equal(first.metrics.admissionDecisions, 0);
  assert.equal(first.metrics.fullAgentJobs, 0);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM sync_cursors WHERE source_id=?', 'snapshot-only').n, 1);
  const ids = () => f.runtime.store.all('SELECT event_id FROM source_events ORDER BY rowid').map(row => row.event_id);
  const before = ids();
  const again = run();
  assert.deepEqual(ids(), before);
  assert.equal(again.metrics.sourceEventsIngested, first.metrics.sourceEventsIngested);
  assert.equal(again.metrics.admissionDecisions, 0);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM jobs').n, 0);
});

test('continuous archive-only runner commits later polls without admission and survives cancellation', async t => {
  const f = fixture(t, { auditSampleRate: defaultPolicy.auditSampleRate });
  const snapshotPath = path.join(f.directory, 'snapshot.json');
  const configPath = path.join(f.directory, 'source.json');
  const snapshot = JSON.parse(readFileSync('tests/fixtures/m4/discussions.json', 'utf8'));
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  writeFileSync(configPath, JSON.stringify({ sourceUri: 'urn:superagent:source:continuous-archive-test', appId: 570,
    mode: 'snapshot', snapshotPath, pollIntervalMs: 1000 }));
  const child = spawn(process.execPath, ['scripts/m4-source.mjs', '--connector', 'steam-discussions', '--config', configPath,
    '--database', f.filename, '--project', 'archive-only', '--source', 'continuous-only', '--archive-only'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    const waitForCount = async expected => {
      for (let i = 0; i < 100; i++) {
        if (f.runtime.store.get('SELECT count(*) n FROM source_events').n === expected) return;
        assert.equal(child.exitCode, null, stderr);
        await delay(50);
      }
      assert.fail('Archive poll did not commit within five seconds: ' + stderr);
    };
    await waitForCount(snapshot.records.length);
    const before = f.runtime.store.all('SELECT event_id FROM source_events ORDER BY rowid');
    snapshot.records.push({ ...snapshot.records[0], id: '1003', threadId: '1003' });
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    await waitForCount(snapshot.records.length);
    assert.deepEqual(f.runtime.store.all('SELECT event_id FROM source_events ORDER BY rowid').slice(0, before.length), before);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
  const metrics = f.runtime.metrics();
  assert.equal(metrics.pendingOutbox, snapshot.records.length);
  assert.equal(metrics.admissionDecisions, 0);
  assert.equal(metrics.fullAgentJobs, 0);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM jobs').n, 0);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM sync_cursors WHERE source_id=?', 'continuous-only').n, 1);
});
