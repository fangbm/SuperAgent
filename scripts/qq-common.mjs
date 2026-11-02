import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { M1Runtime } from '@superagent/agent-core';
import { QQSource } from '@superagent/qq-official';

export const secrets = async key => {
  const name = key === 'QQ_RECIPIENT_OPENID' ? 'SA_QQ_DEVELOPER_OPENID' : `SA_${key}`;
  const value = process.env[name]; if (!value) throw new Error(`MISSING_${name}`); return value;
};
export function configuredSecrets(values) {
  if (!values['protected-config']) return secrets;
  if (process.platform !== 'win32') throw new Error('QQ_PROTECTED_CONFIG_REQUIRES_WINDOWS');
  const script = "Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:SA_QQ_PROTECTED_CONFIG_PATH); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($p)";
  let config;
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 32768, env: { ...process.env, SA_QQ_PROTECTED_CONFIG_PATH: path.resolve(values['protected-config']) }, stdio: ['ignore', 'pipe', 'pipe'] });
    config = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
  } catch { throw new Error('QQ_PROTECTED_CONFIG_UNAVAILABLE'); }
  return async key => {
    if (!['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_SCOPE_ID', 'QQ_PSEUDONYM_KEY', 'QQ_RECIPIENT_OPENID'].includes(key) || typeof config[key] !== 'string' || !config[key]) throw new Error('QQ_PROTECTED_CONFIG_KEY_REQUIRED');
    return config[key];
  };
}
export function openQQ(values, signal) {
  if (!values.database || !values.project || !values.source || !['group', 'channel', 'c2c'].includes(values.kind ?? 'group') || !['webhook', 'websocket'].includes(values.transport ?? 'webhook')) throw new Error('QQ_DATABASE_PROJECT_SOURCE_KIND_TRANSPORT_REQUIRED');
  const filename = path.resolve(values.database); mkdirSync(path.dirname(filename), { recursive: true });
  const policy = JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
  const runtime = new M1Runtime(filename, { policy });
  try {
    const sourceUri = `urn:superagent:source:${encodeURIComponent(values.source)}`;
    runtime.ingress.registerSource({ projectId: values.project, sourceId: values.source, sourceUri, platform: 'qq-official' });
    const source = new QQSource({ kind: values.kind ?? 'group', sourceUri, transport: values.transport ?? 'webhook' });
    const getSecret = configuredSecrets(values);
    const host = runtime.ingress.sourceHost({ projectId: values.project, sourceId: values.source }, { secretKeys: source.manifest.permissions.secretKeys, getSecret });
    return { runtime, source, start: () => source.start(host, signal), filename, getSecret };
  } catch (error) { runtime.close(); throw error; }
}
export const sourceArgs = { database: { type: 'string' }, project: { type: 'string' }, source: { type: 'string' }, kind: { type: 'string', default: 'group' }, transport: { type: 'string', default: 'webhook' }, 'protected-config': { type: 'string' } };
