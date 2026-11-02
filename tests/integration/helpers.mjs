import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';

export const initial = '2026-11-02T00:00:00.000Z';
export const binding = { projectId: 'game-test', sourceId: 'qq-main', sourceUri: 'urn:superagent:source:qq-main', platform: 'qq-official' };
export const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
export const defaultPolicy = JSON.parse(readFileSync(new URL('../../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
export function event(id, options = {}) {
  const e = {
    specversion: '1.0', id, source: binding.sourceUri,
    type: `com.superagent.feedback.message.${options.action ?? 'created'}.v1`,
    time: options.time ?? initial, datacontenttype: 'application/json',
    data: { schemaVersion: '1.0', projectId: binding.projectId, sourceId: binding.sourceId, platform: binding.platform,
      object: { kind: 'message', externalId: options.objectId ?? id, revision: options.revision ?? options.action ?? 'original' },
      content: { text: Object.hasOwn(options, 'text') ? options.text : '多人联机加载到90%时崩溃', attachments: [] } },
  };
  if (options.parent) e.data.object.parentExternalId = options.parent;
  if (options.thread) e.data.object.threadExternalId = options.thread;
  return e;
}
export function fixture(t, policyOverrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'superagent-m1-test-'));
  const filename = path.join(directory, 'state.sqlite');
  let now = initial;
  const runtimes = [];
  const policy = { ...defaultPolicy, auditSampleRate: 0, ...policyOverrides };
  const open = (overrides = {}) => {
    const runtime = new M1Runtime(filename, { policy, clock: () => now, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(() => { for (const runtime of runtimes) runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = open();
  runtime.ingress.registerSource(binding);
  return { runtime, filename, directory, policy, open, setTime: value => { now = new Date(value).toISOString(); }, advance: ms => { now = new Date(Date.parse(now) + ms).toISOString(); } };
}
export const count = (store, table) => store.get(`SELECT count(*) n FROM ${table}`).n;
