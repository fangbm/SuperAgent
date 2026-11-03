import type { JSONValue } from '@superagent/contracts';
import { addMilliseconds, canonicalJSON, systemClock, timestamp } from '@superagent/persistence';
import type { Clock, SqliteStore } from '@superagent/persistence';

interface StateRow {
  value_json: string;
}

interface StateListRow extends StateRow {
  state_key: string;
}

interface LeaseRow {
  owner: string;
  lease_until: string;
  generation: number;
}

export interface DurableCommunityStateOptions {
  clock?: Clock;
  leaseOwner?: string;
}

export type CommunityStateReducer = (current: JSONValue | null) => JSONValue;

/**
 * Durable, namespace-scoped JSON state for community lifecycle features.
 * State writes and synchronous reducers use the host's existing SQLite store;
 * leases are controller ownership records, not a second task queue.
 */
export class DurableCommunityState {
  private readonly clock: Clock;
  private readonly leaseOwner: string | undefined;

  constructor(readonly store: SqliteStore, readonly namespace: string, options: DurableCommunityStateOptions = {}) {
    if (!namespace.trim()) throw new Error('INVALID_COMMUNITY_STATE_NAMESPACE');
    this.clock = options.clock ?? systemClock;
    if (options.leaseOwner !== undefined && (typeof options.leaseOwner !== 'string' || !options.leaseOwner.trim())) throw new Error('INVALID_COMMUNITY_LEASE_OWNER');
    this.leaseOwner = options.leaseOwner;
  }

  private now(): string {
    return timestamp(this.clock());
  }

  private key(key: string): void {
    if (typeof key !== 'string' || key.length === 0) throw new Error('INVALID_COMMUNITY_STATE_KEY');
  }

  private assertLeaseOwner(now?: string): void {
    if (this.leaseOwner === undefined) return;
    const checkedAt = now ?? this.now();
    const lease = this.store.get<LeaseRow>('SELECT owner,lease_until,generation FROM community_leases WHERE namespace=?', this.namespace);
    if (!lease || lease.owner !== this.leaseOwner || lease.lease_until <= checkedAt) throw new Error('COMMUNITY_LEASE_LOST');
  }

  private decode(json: string): JSONValue {
    try {
      const value: unknown = JSON.parse(json);
      // Re-validate and normalize even if a database was modified outside this API.
      return JSON.parse(canonicalJSON(value as JSONValue)) as JSONValue;
    } catch {
      throw new Error('COMMUNITY_STATE_CORRUPT_JSON');
    }
  }

  private lease(owner: string, ttlMs: number): { now: string; until: string } {
    if (typeof owner !== 'string' || !owner.trim() || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('INVALID_COMMUNITY_LEASE');
    const now = this.now();
    let until: string;
    try { until = addMilliseconds(now, ttlMs); }
    catch { throw new Error('INVALID_COMMUNITY_LEASE'); }
    if (!Number.isFinite(Date.parse(until))) throw new Error('INVALID_COMMUNITY_LEASE');
    return { now, until };
  }

  async get(key: string): Promise<JSONValue | null> {
    this.key(key);
    this.assertLeaseOwner();
    const row = this.store.get<StateRow>('SELECT value_json FROM community_state WHERE namespace=? AND state_key=?', this.namespace, key);
    return row ? this.decode(row.value_json) : null;
  }

  async set(key: string, value: JSONValue): Promise<void> {
    this.key(key);
    const json = canonicalJSON(value);
    this.store.transaction(() => {
      const now = this.now();
      this.assertLeaseOwner(now);
      this.store.run(`INSERT INTO community_state(namespace,state_key,value_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(namespace,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      this.namespace, key, json, now);
    });
  }

  async update(key: string, reducer: CommunityStateReducer): Promise<JSONValue> {
    this.key(key);
    if (typeof reducer !== 'function') throw new Error('INVALID_COMMUNITY_STATE_REDUCER');
    return this.store.transaction(() => {
      const now = this.now();
      this.assertLeaseOwner(now);
      const row = this.store.get<StateRow>('SELECT value_json FROM community_state WHERE namespace=? AND state_key=?', this.namespace, key);
      const current = row ? this.decode(row.value_json) : null;
      // Avoid invoking async functions at all, so no post-await work can escape the transaction.
      if (reducer.constructor?.name === 'AsyncFunction') throw new Error('ASYNC_COMMUNITY_STATE_REDUCER');
      const next: unknown = reducer(current);
      if (next !== null && typeof next === 'object' && typeof (next as { then?: unknown }).then === 'function') {
        throw new Error('ASYNC_COMMUNITY_STATE_REDUCER');
      }
      const json = canonicalJSON(next as JSONValue);
      const snapshot = this.decode(json);
      this.assertLeaseOwner(this.now());
      this.store.run(`INSERT INTO community_state(namespace,state_key,value_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(namespace,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      this.namespace, key, json, now);
      return snapshot;
    });
  }

  async list(prefix: string): Promise<Array<{ key: string; value: JSONValue }>> {
    if (typeof prefix !== 'string') throw new Error('INVALID_COMMUNITY_STATE_PREFIX');
    this.assertLeaseOwner();
    const rows = this.store.all<StateListRow>(`SELECT state_key,value_json FROM community_state
      WHERE namespace=? AND substr(state_key,1,length(?))=? ORDER BY state_key`, this.namespace, prefix, prefix);
    return rows.map(row => ({ key: row.state_key, value: this.decode(row.value_json) }));
  }

  /** Acquire an unowned/expired lease, or extend this still-live owner's lease. */
  acquireLease(owner: string, ttlMs: number): boolean {
    const { now, until } = this.lease(owner, ttlMs);
    return this.store.transaction(() => {
      const row = this.store.get<LeaseRow>('SELECT owner,lease_until,generation FROM community_leases WHERE namespace=?', this.namespace);
      if (!row) {
        this.store.run('INSERT INTO community_leases(namespace,owner,lease_until,generation,updated_at) VALUES(?,?,?,1,?)', this.namespace, owner, until, now);
        return true;
      }
      if (row.owner === owner && row.lease_until > now) {
        this.store.run('UPDATE community_leases SET lease_until=?,updated_at=? WHERE namespace=? AND owner=? AND lease_until>?', until, now, this.namespace, owner, now);
        return true;
      }
      if (row.lease_until <= now) {
        const changed = Number(this.store.run(`UPDATE community_leases SET owner=?,lease_until=?,generation=generation+1,updated_at=?
          WHERE namespace=? AND lease_until<=?`, owner, until, now, this.namespace, now).changes);
        return changed === 1;
      }
      return false;
    });
  }

  /** Renew only a lease still held by this owner; an expired owner is fenced out. */
  renewLease(owner: string, ttlMs: number): boolean {
    const { now, until } = this.lease(owner, ttlMs);
    return this.store.transaction(() => Number(this.store.run(`UPDATE community_leases SET lease_until=?,updated_at=?
      WHERE namespace=? AND owner=? AND lease_until>?`, until, now, this.namespace, owner, now).changes) === 1);
  }

  /** Release only this owner's lease, never a replacement owner's lease. */
  releaseLease(owner: string): void {
    if (typeof owner !== 'string' || !owner.trim()) throw new Error('INVALID_COMMUNITY_LEASE_OWNER');
    this.store.transaction(() => {
      this.store.run('DELETE FROM community_leases WHERE namespace=? AND owner=?', this.namespace, owner);
    });
  }
}
