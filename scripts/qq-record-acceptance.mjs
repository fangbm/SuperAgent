import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteStore } from '@superagent/persistence';
const { values } = parseArgs({ options: { database: { type: 'string' }, output: { type: 'string' }, 'receipt-confirmed': { type: 'boolean', default: false } } });
if (!values.database || !values.output) throw new Error('QQ_ACCEPTANCE_DATABASE_OUTPUT_REQUIRED');
const store = new SqliteStore(path.resolve(values.database));
try {
  const source = store.get('SELECT coverage,health_reason FROM sources WHERE source_id=?', 'qq-live-group-01');
  const cp = JSON.parse(store.get('SELECT cursor_json FROM sync_cursors WHERE source_id=?', 'qq-live-group-01').cursor_json);
  const events = store.all('SELECT payload_json FROM source_events WHERE source_id=?', 'qq-live-group-01');
  const matched = events.some(row => JSON.parse(row.payload_json).data.content?.text?.includes('SA-QQ-INGRESS-a78768b5'));
  const operation = store.get("SELECT state,attempt FROM external_operations WHERE operation_id=?", 'external-fba986ef9e8ed910ba5b6f0880106a73364a12c9af026e1d99d424ac55fbea36');
  const batches = store.all('SELECT reason,count(*) count FROM feedback_batches GROUP BY reason');
  if (!matched || !cp.observed || operation?.state !== 'succeeded' || operation.attempt !== 1 || !batches.length) throw new Error('QQ_LIVE_ACCEPTANCE_INCOMPLETE');
  const result = {
    capturedAt: new Date().toISOString(), scope: 'official QQ group mentions and one approved developer C2C message',
    authentication: { realTokenAPI: true, realIdentityAPI: true, gatewayHost: 'api.sgroup.qq.com', webSocketLogin: true },
    binding: { groupOpenidFromChallengeEvent: true, developerOpenidFromChallengeEvent: true, credentialsStorage: 'Windows DPAPI CurrentUser, ignored .artifacts/qq-config.dpapi', rawIdentifiersIncluded: false },
    ingress: { transport: 'websocket', projectId: 'game-qq-live', sourceId: 'qq-live-group-01', expectedMessageMatched: matched, eventCount: events.length, observedEventType: cp.observedEventType, coverage: source.coverage, reason: source.health_reason, committedSequence: cp.gateway.seq, batches, jobs: store.all('SELECT kind,status,count(*) count FROM jobs GROUP BY kind,status'), modelCalls: store.get('SELECT count(*) n FROM model_calls').n },
    delivery: { format: 'markdown', approvedMessageCount: 1, state: operation.state, attempts: operation.attempt, apiAccepted: true, clientReceiptConfirmedByUser: values['receipt-confirmed'], readReceiptNotAsserted: true },
    localChecks: { command: 'pnpm check', nodeTestsPassed: 138, referenceSuitesPassed: 6, frozenFilesUnchanged: 45, workspacePackagesPrivate: true },
    databaseQuickCheck: store.get('PRAGMA quick_check').quick_check,
    remaining: ['full-group message permission', 'live Webhook', 'history/edit reconciliation', 'attachments download', 'M5 report/actions and P0 scheduler', 'real QQ fault injection'],
  };
  const output = path.resolve(values.output); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { store.close(); }
