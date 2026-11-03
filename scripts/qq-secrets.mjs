import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function environmentSecret(name, env = process.env) {
  const inline = env[name]?.trim(); const filename = env[name + '_FILE'];
  if (inline && filename) throw new Error('AMBIGUOUS_SECRET');
  const value = inline || (filename ? readFileSync(filename, 'utf8').trim() : '');
  if (!value || /\s/.test(value)) throw new Error('MISSING_SECRET: ' + name);
  return value;
}
export const secrets = async key => environmentSecret(key === 'QQ_RECIPIENT_OPENID' ? 'SA_QQ_DEVELOPER_OPENID' : `SA_${key}`);

export function configuredSecrets(values, env = process.env) {
  if (!values['protected-config']) return async key => environmentSecret(key === 'QQ_RECIPIENT_OPENID' ? 'SA_QQ_DEVELOPER_OPENID' : `SA_${key}`, env);
  if (process.platform !== 'win32') throw new Error('QQ_PROTECTED_CONFIG_REQUIRES_WINDOWS');
  const script = "Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:SA_QQ_PROTECTED_CONFIG_PATH); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($p)";
  let config;
  try {
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 32768, env: { ...env, SA_QQ_PROTECTED_CONFIG_PATH: path.resolve(values['protected-config']) }, stdio: ['ignore', 'pipe', 'pipe'] });
    config = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
  } catch { throw new Error('QQ_PROTECTED_CONFIG_UNAVAILABLE'); }
  return async key => {
    if (!['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_SCOPE_ID', 'QQ_PSEUDONYM_KEY', 'QQ_RECIPIENT_OPENID'].includes(key) || typeof config[key] !== 'string' || !config[key]) throw new Error('QQ_PROTECTED_CONFIG_KEY_REQUIRED');
    return config[key];
  };
}
