import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export class QQError extends Error {
  constructor(readonly code: string, readonly outcome: 'blocked' | 'rejected' | 'retryable' | 'unknown' = 'unknown') {
    super(code); this.name = 'QQError';
  }
}
export type SecretReader = (key: string) => Promise<string>;
export type QQObject = Record<string, unknown>;
export function object(value: unknown): QQObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QQError('QQ_INVALID_EVENT', 'rejected');
  return value as QQObject;
}
export function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new QQError('QQ_INVALID_FIELD', 'rejected');
  return value;
}
function providerCode(data:QQObject):number|'INVALID'|undefined{
  const codes=[data.err_code,data.code].filter(v=>v!==undefined);
  if(codes.some(v=>typeof v!=='number'||!Number.isSafeInteger(v)||v<0))return'INVALID';
  const errors=[...new Set(codes.filter(v=>v!==0))];return errors.length>1?'INVALID':errors[0] as number|undefined;
}
function privateKey(secret: string) {
  let bytes = Buffer.from(text(secret), 'utf8');
  while (bytes.length < 32) bytes = Buffer.concat([bytes, bytes]);
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}
export function qqSignature(secret: string, timestamp: string, body: Uint8Array | string): string {
  return sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey(secret)).toString('hex');
}
export function verifyQQSignature(secret: string, timestamp: string, body: Uint8Array, signature: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), createPublicKey(privateKey(secret)), Buffer.from(signature, 'hex'));
}
export function endpoint(value: string, allowLoopbackHTTP = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(allowLoopbackHTTP && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new QQError('QQ_INVALID_ENDPOINT', 'blocked');
  return url;
}
async function responseJSON(response: Response, allowEmpty = false): Promise<QQObject> {
  if (!response.body) {if(allowEmpty)return {};throw new QQError('QQ_EMPTY_RESPONSE');}
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 1_000_000) throw new QQError('QQ_RESPONSE_LIMIT');
      chunks.push(next.value);
    }
    if(allowEmpty&&size===0)return {};
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export interface QQAPIOptions {
  baseURL?: string;
  tokenURL?: string;
  allowLoopbackHTTP?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}
/** Credentials and tokens remain inside this instance, never in a checkpoint. */
export class QQAPI {
  private token: { value: string; refreshAt: number } | undefined;
  private pending: Promise<string> | undefined;
  private readonly base: URL;
  private readonly tokenURL: URL;
  constructor(private readonly getSecret: SecretReader, private readonly options: QQAPIOptions = {}) {
    this.base = endpoint(options.baseURL ?? 'https://api.bot.qq.com', options.allowLoopbackHTTP);
    this.tokenURL = endpoint(options.tokenURL ?? new URL('/app/getAppAccessToken', this.base).href, options.allowLoopbackHTTP);
  }
  private async request(url: URL, init: RequestInit, beforeSend: boolean, allowEmpty = false): Promise<QQObject> {
    try {
      const response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 15_000)]) });
      if (!response.ok) {
        // Retain only a numeric provider code, never its free-form error text.
        let code:number|undefined;
        try{const value=providerCode(await responseJSON(response));if(typeof value==='number')code=value;}catch{/* Preserve the HTTP outcome for malformed/empty errors. */}
        throw new QQError(code!==undefined&&[400,401,403].includes(response.status)?`QQ_API_${code}`:`QQ_HTTP_${response.status}`, beforeSend ? ([400, 401, 403, 404].includes(response.status) ? 'blocked' : 'retryable') : ([401, 403].includes(response.status) ? 'blocked' : response.status === 400 ? 'rejected' : 'unknown'));
      }
      if (allowEmpty && response.status === 204) return {};
      let data: QQObject;
      try { data = await responseJSON(response,allowEmpty); }
      catch { throw new QQError('QQ_INVALID_RESPONSE', beforeSend ? 'retryable' : 'unknown'); }
      const code=providerCode(data);
      if (code !== undefined) {
        const outcome = beforeSend ? ([100007, 100016, 10004].includes(Number(code)) ? 'blocked' : 'retryable')
          : [11253,11254,11265,40034105,40054004,40054013,40034127,304064,304036,304037].includes(Number(code)) ? 'blocked'
          : [22006,50059,304061,304103,40034005,40034011,40034024,40034025,40034026,40034027,40034029,40034124,40034128,40054007,40054018].includes(Number(code)) ? 'rejected' : 'unknown';
        throw new QQError(`QQ_API_${code}`, outcome);
      }
      return data;
    } catch (error) {
      if (error instanceof QQError) throw error;
      throw new QQError(beforeSend ? 'QQ_AUTH_UNAVAILABLE' : 'QQ_SEND_UNKNOWN', beforeSend ? 'retryable' : 'unknown');
    }
  }
  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.refreshAt > (this.options.now ?? Date.now)()) return this.token.value;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const appId = await this.getSecret('QQ_APP_ID'), clientSecret = await this.getSecret('QQ_APP_SECRET');
      const data = await this.request(this.tokenURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: text(appId), clientSecret: text(clientSecret) }), ...(signal ? { signal } : {}) }, true);
      const value = text(data.access_token); const seconds = Number(data.expires_in);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new QQError('QQ_INVALID_TOKEN_RESPONSE', 'retryable');
      this.token = { value, refreshAt: (this.options.now ?? Date.now)() + Math.max(1, seconds - Math.min(60, seconds / 2)) * 1000 };
      return value;
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async identity(signal?: AbortSignal): Promise<void> {
    const token = await this.accessToken(signal);
    const data = await this.request(new URL('/users/@me', this.base), { headers: { Authorization: `QQBot ${token}` }, ...(signal ? { signal } : {}) }, true);
    text(data.id);
  }
  async gateway(signal?: AbortSignal): Promise<string> {
    const token = await this.accessToken(signal);
    const data = await this.request(new URL('/gateway', this.base), { headers: { Authorization: `QQBot ${token}` }, ...(signal ? { signal } : {}) }, true);
    const url = new URL(text(data.url));
    const secure = url.protocol === 'wss:' && ['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname);
    const local = this.options.allowLoopbackHTTP && url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || (!secure && !local)) throw new QQError('QQ_INVALID_GATEWAY', 'blocked');
    return url.href;
  }
  async sendC2C(openid: string, payload: object): Promise<string> {
    // No network retry, token refresh-and-resend, or format fallback after dispatch.
    const token = await this.accessToken();
    const data = await this.request(new URL(`/v2/users/${encodeURIComponent(text(openid, 256))}/messages`, this.base), { method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, false);
    return text(data.id);
  }
  async acknowledgeInteraction(id: string, code = 0): Promise<void> {
    const token = await this.accessToken();
    const appId=text(await this.getSecret('QQ_APP_ID'),256);
    await this.request(new URL(`/interactions/${encodeURIComponent(text(id,512))}`, this.base), { method:'PUT', headers:{ Authorization:`QQBot ${token}`,'Content-Type':'application/json','X-Callback-AppID':appId }, body:JSON.stringify({code}),signal:AbortSignal.timeout(1500) }, true, true);
  }
}
