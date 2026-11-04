import { setTimeout as delay } from 'node:timers/promises';
import { object, QQAPI, QQError, text } from './protocol.js';
import type { QQObject } from './protocol.js';

export interface QQSession { sessionId: string; seq: number }
export interface QQGatewayOptions {
  intents: number;
  loadSession: () => Promise<QQSession | null>;
  dispatch: (payload: QQObject, session: QQSession) => Promise<void>;
  invalidateSession: () => Promise<void>;
  health?: (reason: string) => Promise<void>;
  maxFailures?: number;
  backoffMs?: number;
  maxPendingDispatches?: number;
  createSocket?: (url: string) => WebSocket;
}
/** Read-only Gateway: no outbound group/C2C message capability. */
export class QQGateway {
  constructor(private readonly api: QQAPI, private readonly options: QQGatewayOptions) {
    if (!Number.isSafeInteger(options.intents) || options.intents < 1) throw new QQError('QQ_INVALID_INTENTS', 'blocked');
    if (!Number.isSafeInteger(options.maxPendingDispatches??256) || (options.maxPendingDispatches??256)<1) throw new QQError('QQ_INVALID_DISPATCH_LIMIT', 'blocked');
  }
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const startedAt = Date.now();
      let reason = 'QQ_GATEWAY_DISCONNECTED_COVERAGE_GAP';
      try { await this.connection(signal); }
      catch (error) {
        if (signal.aborted) return;
        if (error instanceof QQError && error.outcome === 'blocked') throw error;
        reason += ':' + (error instanceof QQError ? error.code : 'QQ_GATEWAY_FAILED');
      }
      if (signal.aborted) return;
      if (Date.now() - startedAt > 60_000) failures = 0;
      failures++;
      if (failures >= (this.options.maxFailures ?? 12)) throw new QQError('QQ_GATEWAY_RECONNECT_BUDGET', 'blocked');
      await this.options.health?.(reason);
      try { await delay(Math.min(30_000, (this.options.backoffMs ?? 1000) * 2 ** Math.min(failures - 1, 5)), undefined, { signal }); }
      catch { if (signal.aborted) return; }
    }
  }
  private async connection(signal: AbortSignal): Promise<void> {
    const url = await this.api.gateway(signal); signal.throwIfAborted();
    const accessToken = await this.api.accessToken(signal); signal.throwIfAborted();
    let session = await this.options.loadSession();
    await new Promise<void>((resolve, reject) => {
      const socket = (this.options.createSocket ?? (value => new WebSocket(value)))(url);
      let ended = false; let hello = false; let awaitingAck = false; let authenticated = false; let healthPending = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let queue: Promise<void> = Promise.resolve();
      let pendingDispatches=0;
      const send = (payload: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };
      const finish = (error?: Error, invalidate = false) => {
        if (ended) return; ended = true; clearTimeout(deadline); if (heartbeat) clearInterval(heartbeat);
        signal.removeEventListener('abort', abort);
        try { socket.close(1000); } catch { /* Already closed. */ }
        const settle = async () => {
          try { if (invalidate) await this.options.invalidateSession(); }
          catch { reject(new QQError('QQ_GATEWAY_CHECKPOINT_FAILED')); return; }
          if (error) reject(error); else resolve();
        };
        // Finish any started durable callback before allowing a replacement or DB close.
        void queue.then(settle, settle);
      };
      const abort = () => finish();
      const deadline = setTimeout(() => finish(new QQError('QQ_GATEWAY_HANDSHAKE_TIMEOUT')), 20_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { finish(); return; }
      socket.addEventListener('error', () => finish(new QQError('QQ_GATEWAY_TRANSPORT_ERROR')));
      socket.addEventListener('close', event => {
        const blocked = [4001, 4002, 4004, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(event.code);
        finish(new QQError(`QQ_GATEWAY_CLOSE_${event.code}`, blocked ? 'blocked' : 'unknown'), [4006, 4007].includes(event.code) || event.code >= 4900 && event.code <= 4913);
      });
      socket.addEventListener('message', event => {
        if (ended) return;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1_000_000) throw new QQError('QQ_GATEWAY_PAYLOAD_LIMIT', 'blocked');
          const payload = object(JSON.parse(event.data));
          if (payload.op === 11) {
            const confirmed = awaitingAck && authenticated; awaitingAck = false;
            // At most one pending health update; share dispatch draining on shutdown.
            if (confirmed && !healthPending) {
              healthPending = true;
              queue = queue.then(async () => { if (!ended && !signal.aborted) await this.options.health?.('QQ_GATEWAY_HEARTBEAT_ACK'); })
                .catch(error => { finish(error instanceof QQError ? error : new QQError('QQ_GATEWAY_COMMIT_FAILED')); })
                .finally(() => { healthPending = false; });
            }
            return;
          }
          if (payload.op === 10) {
            if (hello) throw new QQError('QQ_GATEWAY_DUPLICATE_HELLO'); hello = true;
            const interval = Number(object(payload.d).heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 10 || interval > 120_000) throw new QQError('QQ_INVALID_HEARTBEAT', 'blocked');
            send(session ? { op: 6, d: { token: `QQBot ${accessToken}`, session_id: session.sessionId, seq: session.seq } } : { op: 2, d: { token: `QQBot ${accessToken}`, intents: this.options.intents, shard: [0, 1] } });
            if (ended) return;
            heartbeat = setInterval(() => { if (awaitingAck) { finish(new QQError('QQ_GATEWAY_HEARTBEAT_LOST')); return; } awaitingAck = true; send({ op: 1, d: session?.seq ?? null }); }, interval);
            return;
          }
          if (payload.op === 1) { send({ op: 1, d: session?.seq ?? null }); return; }
          if (payload.op === 7) { finish(new QQError('QQ_GATEWAY_RECONNECT')); return; }
          if (payload.op === 9) { finish(new QQError('QQ_GATEWAY_INVALID_SESSION'), true); return; }
          if (payload.op !== 0 || !hello || !Number.isSafeInteger(payload.s) || Number(payload.s) < 0 || typeof payload.t !== 'string') throw new QQError('QQ_GATEWAY_INVALID_DISPATCH');
          // Reconnect from the last committed sequence instead of retaining an
          // unbounded chain of player payloads while the durable Host is slow.
          if (pendingDispatches >= (this.options.maxPendingDispatches??256)) throw new QQError('QQ_GATEWAY_DISPATCH_BACKPRESSURE');
          pendingDispatches++;
          queue = queue.then(async () => {
            if (ended || signal.aborted) return;
            const next = payload.t === 'READY' ? { sessionId: text(object(payload.d).session_id, 512), seq: Number(payload.s) } : session ? { ...session, seq: Number(payload.s) } : null;
            if (!next) throw new QQError('QQ_GATEWAY_NOT_AUTHENTICATED');
            if (payload.t !== 'READY' && session && next.seq <= session.seq) return;
            await this.options.dispatch(payload, next); // Ack/Resume sequence advances only after durable Host commit.
            session = next;
            if ((payload.t === 'READY' || payload.t === 'RESUMED') && !ended && !signal.aborted) {
              authenticated = true;
              clearTimeout(deadline); await this.options.health?.('QQ_GATEWAY_CONNECTED_EVENT_PERMISSION_UNVERIFIED');
            }
          }).catch(error => { finish(error instanceof QQError ? error : new QQError('QQ_GATEWAY_COMMIT_FAILED')); }).finally(()=>{pendingDispatches--;});
        } catch (error) { finish(error instanceof QQError ? error : new QQError('QQ_GATEWAY_INVALID_JSON')); }
      });
    });
  }
}
