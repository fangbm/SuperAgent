import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contractNames, validateContract, parseContract, ContractValidationError } from '@superagent/contract-validation';
import * as sdk from '@superagent/plugin-sdk';

const require = createRequire(import.meta.url);
const fixture = name => structuredClone(require(`@superagent/contracts/fixtures/${name}.json`));
const cases = {
  'qq-message-created': ['normalized-event-v1', true],
  'invalid-type-data': ['normalized-event-v1', false],
  'plugin-manifest-qq-source': ['plugin-manifest-v1', true],
  'feedback-batch': ['feedback-batch-v1', true],
  'host-ingest-receipt': ['commit-result-v1', true],
  'triage-mixed-intent-v2': ['triage-result-v2', true],
  'triage-question-only-v2': ['triage-result-v2', true],
  'triage-two-suggestions-v2': ['triage-result-v2', true],
  'invalid-defect-category-v2': ['triage-result-v2', false],
  'invalid-suggestion-category-v2': ['triage-result-v2', false],
  'invalid-empty-triage-v2': ['triage-result-v2', false],
  'decision-p0-realtime': ['notification-routing-decision-v1', true],
  'decision-steam-digest': ['notification-routing-decision-v1', true],
  'p0-alert': ['p0-alert-v1', true],
  'report-presentation-markdown-qq': ['report-presentation-v1', true],
  'report-v2.1-revision2': ['report-v2', true],
  'report-v2.1-with-steam': ['report-v2', true],
  'delivery-request': ['delivery-request-v1', true],
  'delivery-result-accepted': ['delivery-result-v1', true],
  'delivery-result-unknown': ['delivery-result-v1', true],
  'p0-alert-delivery-request': ['p0-alert-delivery-request-v1', true],
  'agent-task': ['agent-task-v1', true],
};

test('every fixture and runtime schema has an explicit expected result', () => {
  const directory = fileURLToPath(new URL('../../packages/contracts/fixtures/', import.meta.url));
  assert.deepEqual(readdirSync(directory).sort(), Object.keys(cases).map(name => `${name}.json`).sort());
  assert.deepEqual([...new Set(Object.values(cases).map(([name]) => name))].sort(), [...contractNames].sort());
});
for (const [name, [contract, expected]] of Object.entries(cases)) {
  test(`fixture ${name}: ${expected ? 'accept' : 'reject'}`, () => {
    const result = validateContract(contract, fixture(name));
    assert.equal(result.valid, expected, JSON.stringify(result.valid ? {} : result.errors));
  });
}

test('all 13 source event variants enforce matching object kinds', () => {
  for (const kind of ['message', 'review', 'thread', 'comment']) {
    for (const action of ['created', 'updated', 'deleted']) {
      const event = fixture('qq-message-created');
      event.type = `com.superagent.feedback.${kind}.${action}.v1`;
      event.data.object.kind = kind;
      assert.equal(validateContract('normalized-event-v1', event).valid, true, event.type);
      event.data.object.kind = kind === 'message' ? 'review' : 'message';
      assert.equal(validateContract('normalized-event-v1', event).valid, false, event.type);
    }
  }
  const event = fixture('qq-message-created');
  event.type = 'com.superagent.source.coverage.changed.v1';
  event.data = { schemaVersion: '1.0', projectId: 'game-01', sourceId: 'qq-01', platform: 'qq-official', coverage: 'partial' };
  assert.equal(validateContract('normalized-event-v1', event).valid, true);
  event.data.object = { kind: 'message', externalId: '1', revision: '1' };
  assert.equal(validateContract('normalized-event-v1', event).valid, false);
});

test('validation rejects unknown fields without deleting or coercing input', () => {
  const batch = fixture('feedback-batch');
  batch.revision = '1';
  batch.secretInstruction = 'untrusted payload';
  const before = structuredClone(batch);
  assert.equal(validateContract('feedback-batch-v1', batch).valid, false);
  assert.deepEqual(batch, before);
});

test('date-time formats are checked in production validators', () => {
  const event = fixture('qq-message-created');
  event.time = 'tomorrow';
  assert.equal(validateContract('normalized-event-v1', event).valid, false);
});

test('semver manifests reject invalid versions', () => {
  const manifest = fixture('plugin-manifest-qq-source');
  for (const version of ['latest', '1.2', 'v1.2.3']) {
    manifest.version = version;
    assert.equal(validateContract('plugin-manifest-v1', manifest).valid, false);
  }
});

test('report navigation keeps exactly the ordered three sections', () => {
  const presentation = fixture('report-presentation-markdown-qq');
  presentation.actions.reverse();
  assert.equal(validateContract('report-presentation-v1', presentation).valid, false);
});

test('new report writes require v2.1 snapshot metadata and predecessor presence', () => {
  for (const key of ['revision', 'snapshotCutoffAt', 'steamNegativeReviews']) {
    const report = fixture('report-v2.1-with-steam');
    delete report[key];
    assert.equal(validateContract('report-v2', report).valid, false, key);
  }
  const report = fixture('report-v2.1-with-steam');
  report.revision = 2;
  assert.equal(validateContract('report-v2', report).valid, false);
  report.schemaVersion = '2.0';
  assert.equal(validateContract('report-v2', report).valid, false);
});

test('only P0 can be represented as a realtime routing decision with evidence', () => {
  const decision = fixture('decision-p0-realtime');
  decision.severity = 'P1';
  assert.equal(validateContract('notification-routing-decision-v1', decision).valid, false);
  const alert = fixture('p0-alert');
  alert.evidence = [];
  assert.equal(validateContract('p0-alert-v1', alert).valid, false);
});

test('report delivery with a presentation requires an explicit frozen revision', () => {
  const request = fixture('delivery-request');
  delete request.reportRevision;
  assert.equal(validateContract('delivery-request-v1', request).valid, false);
  // Existing plain-text v1 callers remain compatible.
  delete request.presentation;
  assert.equal(validateContract('delivery-request-v1', request).valid, true);
});

test('unknown delivery outcomes survive validation as unknown', () => {
  const result = parseContract('delivery-result-v1', fixture('delivery-result-unknown'));
  assert.equal(result.status, 'unknown');
});

test('tasks reject unrecognized kinds', () => {
  const task = fixture('agent-task');
  task.kind = 'arbitrary.shell';
  assert.equal(validateContract('agent-task-v1', task).valid, false);
});

test('unconstrained JSON payloads still reject non-JSON values and cycles', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const payload of [() => {}, 1n, NaN, Infinity, new Date(), cyclic, { missing: undefined }]) {
    const task = fixture('agent-task');
    task.payload = payload;
    assert.equal(validateContract('agent-task-v1', task).valid, false);
  }
  const shared = { event: 'e' };
  const task = fixture('agent-task');
  task.payload = [shared, shared];
  assert.equal(validateContract('agent-task-v1', task).valid, true);
});

test('diagnostics are stable between calls and exclude source values', () => {
  const secret = 'sensitive-content-should-not-be-logged';
  const event = fixture('qq-message-created');
  event.time = secret;
  const rejected = validateContract('normalized-event-v1', event);
  assert.equal(rejected.valid, false);
  const snapshot = structuredClone(rejected.errors);
  parseContract('feedback-batch-v1', fixture('feedback-batch'));
  assert.deepEqual(rejected.errors, snapshot);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  assert.throws(() => parseContract('normalized-event-v1', event), error => {
    assert.ok(error instanceof ContractValidationError);
    assert.equal(error.contract, 'normalized-event-v1');
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test('plugin SDK emits no platform runtime or Host implementation', () => {
  assert.deepEqual(Object.keys(sdk), []);
});
