import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';

const { values } = parseArgs({ options: { database: { type: 'string' } } });
const artifactRoot = path.resolve('.artifacts');
mkdirSync(artifactRoot, { recursive: true });
const filename = values.database ? path.resolve(values.database) : path.join(mkdtempSync(path.join(artifactRoot, 'm1-demo-')), 'state.sqlite');
if (existsSync(filename)) throw new Error('DEMO_REQUIRES_NEW_DATABASE');
mkdirSync(path.dirname(filename), { recursive: true });
const policy = JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
let now = new Date().toISOString();
const options = { policy, clock: () => now };
const binding = { projectId: 'demo-game', sourceId: 'demo-qq', sourceUri: 'urn:superagent:source:demo-qq', platform: 'qq-official' };
const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
let runtime = new M1Runtime(filename, options);
try {
  runtime.ingress.registerSource(binding);
  const event = { specversion: '1.0', id: 'demo-message-1', source: binding.sourceUri, type: 'com.superagent.feedback.message.created.v1', time: now,
    datacontenttype: 'application/json', data: { schemaVersion: '1.0', projectId: binding.projectId, sourceId: binding.sourceId, platform: binding.platform,
      object: { kind: 'message', externalId: 'message-1', revision: 'original' }, content: { text: '联机加载时崩溃，希望增加自动重连' } } };
  const committed = runtime.ingress.commitBatch(scope, [event], { sourceId: scope.sourceId, cursor: { lastId: event.id } });
  const replay = runtime.ingress.commitBatch(scope, [event]);
  runtime.tick();
  runtime.close();
  now = new Date(Date.parse(now) + 121_000).toISOString();
  runtime = new M1Runtime(filename, options);
  const recovered = runtime.tick();
  const batches = runtime.store.all('SELECT batch_id FROM feedback_batches').map(row => runtime.buffer.getBatch(row.batch_id));
  console.log(JSON.stringify({ database: filename, evidence: 'synthetic input, file-backed SQLite, close/reopen, injected clock; no platform or LLM calls', committed, replay, recovered, checkpoint: runtime.ingress.getCheckpoint(scope), batches, metrics: runtime.metrics() }, null, 2));
} finally { runtime.close(); }
