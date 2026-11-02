import { M1Runtime } from '@superagent/agent-core';
import { binding, scope, event, initial, defaultPolicy } from './helpers.mjs';

const [filename, scenario] = process.argv.slice(2);
const runtime = new M1Runtime(filename, { policy: { ...defaultPolicy, auditSampleRate: 0 }, clock: () => initial });
runtime.ingress.registerSource(binding);
if (scenario === 'uncommitted') runtime.store.exec('BEGIN IMMEDIATE');
runtime.ingress.commitBatch(scope, [event('crash-event')], { sourceId: scope.sourceId, cursor: 'durable-cursor' });
if (scenario === 'segment') runtime.tick();
if (scenario === 'lease') {
  runtime.ingress.dispatchOutbox();
  const job = runtime.queue.claim('crashed-worker', 'admission', 100);
  runtime.queue.start(job.jobId, job.leaseToken);
}
process.stdout.write('READY\n');
// Parent terminates this process without closing SQLite or running cleanup.
setInterval(() => {}, 1_000);
