import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fixture, binding, count } from './helpers.mjs';
import { qqSecrets, qqEvent } from './qq-helpers.mjs';
import { qqSignature } from '@superagent/qq-official';

const env = () => ({ ...process.env, SA_QQ_APP_ID: qqSecrets.QQ_APP_ID, SA_QQ_APP_SECRET: qqSecrets.QQ_APP_SECRET, SA_QQ_SCOPE_ID: qqSecrets.QQ_SCOPE_ID, SA_QQ_PSEUDONYM_KEY: qqSecrets.QQ_PSEUDONYM_KEY, SA_QQ_DEVELOPER_OPENID: qqSecrets.QQ_RECIPIENT_OPENID });
test('production QQ Source CLI accepts signed HTTP events, rejects invalid signatures, and persists before reply', async t => {
  const f = fixture(t, { auditSampleRate: 0.02 }); const filename = path.join(f.directory, 'cli.sqlite');
  const child = spawn(process.execPath, ['scripts/qq-source.mjs', '--database', filename, '--project', binding.projectId, '--source', binding.sourceId, '--port', '0'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = ''; child.stderr.on('data', b => { errors += b; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', b => { output += b; if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } } });
    child.on('error', reject); child.on('exit', () => reject(new Error(`QQ CLI exited before ready: ${errors}`)));
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const info = await Promise.race([ready, new Promise((_r, reject) => setTimeout(() => reject(new Error(`QQ CLI timeout: ${errors}`)), 8000).unref())]);
  const body = JSON.stringify(qqEvent()); const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { 'Content-Type': 'application/json', 'x-bot-appid': qqSecrets.QQ_APP_ID, 'x-signature-timestamp': timestamp, 'x-signature-ed25519': qqSignature(qqSecrets.QQ_APP_SECRET, timestamp, body) };
  assert.equal((await fetch(info.url, { method: 'POST', headers: { ...headers, 'x-signature-ed25519': '00'.repeat(64) }, body })).status, 401);
  assert.deepEqual(await (await fetch(info.url, { method: 'POST', headers, body })).json(), { op: 12, d: 0 });
  assert.deepEqual(await (await fetch(info.url, { method: 'POST', headers, body })).json(), { op: 12, d: 0 });
  const { SqliteStore } = await import('@superagent/persistence'); const store = new SqliteStore(filename);
  try { assert.equal(count(store, 'source_events'), 1); assert.equal(count(store, 'event_outbox'), 1); } finally { store.close(); }
  const health = await (await fetch(info.url.replace('/qq/events', '/health'))).json(); assert.equal(health.coverage.coverage, 'partial');
  child.kill('SIGTERM'); await once(child, 'exit');
});
test('production QQ acceptance CLI previews one durable draft and never calls the network by default', async t => {
  const f = fixture(t); const child = await promisify(execFile)(process.execPath, ['scripts/qq-send-test.mjs', '--database', f.filename, '--project', binding.projectId], { env: env(), windowsHide: true, timeout: 8000 });
  const result = JSON.parse(child.stdout.trim()); assert.equal(result.preview, true); assert.equal(result.state, 'prepared');
  assert.equal(count(f.runtime.store, 'external_operation_attempts'), 0); assert.equal(child.stdout.includes(qqSecrets.QQ_RECIPIENT_OPENID), false);
  const again = await promisify(execFile)(process.execPath, ['scripts/qq-send-test.mjs', '--database', f.filename, '--project', binding.projectId], { env: env(), windowsHide: true, timeout: 8000 });
  assert.equal(JSON.parse(again.stdout.trim()).operationId, result.operationId);
  assert.equal(count(f.runtime.store, 'plugin_delivery_requests'), 1);
});
test('Windows DPAPI configuration can be used without plaintext files and refuses overwrite', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const protectedFile = path.join(f.directory, '测试 configuration.dpapi');
  const protect = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/qq-protect-config.ps1', '-OutputPath', protectedFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const config = { ...qqSecrets }; let log = ''; protect.stdout.on('data', b => { log += b; }); protect.stdin.end(JSON.stringify(config) + '\n');
  const [code] = await once(protect, 'exit'); assert.equal(code, 0); assert.match(log, /protected/);
  const { readFileSync } = await import('node:fs'); assert.equal(readFileSync(protectedFile).includes(Buffer.from(qqSecrets.QQ_APP_SECRET)), false);
  const output = await promisify(execFile)(process.execPath, ['scripts/qq-send-test.mjs', '--database', f.filename, '--project', binding.projectId, '--protected-config', protectedFile], { env: { ...process.env, SA_QQ_APP_ID: '', SA_QQ_APP_SECRET: '', SA_QQ_SCOPE_ID: '', SA_QQ_PSEUDONYM_KEY: '', SA_QQ_DEVELOPER_OPENID: '' }, windowsHide: true, timeout: 10_000 });
  assert.equal(JSON.parse(output.stdout.trim()).state, 'prepared'); assert.equal(count(f.runtime.store, 'external_operation_attempts'), 0);
  const second = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/qq-protect-config.ps1', '-OutputPath', protectedFile], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  second.stdin.end(JSON.stringify(config) + '\n'); const [secondCode] = await once(second, 'exit'); assert.equal(secondCode, 1);
});
