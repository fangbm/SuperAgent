import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import type { JSONValue } from '@superagent/contracts';
export {ensureQQFeatures} from './qq-features.js';

export type Clock = () => string;
export const systemClock: Clock = () => new Date().toISOString();
export function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('INVALID_TIMESTAMP');
  return new Date(value).toISOString();
}
export const addMilliseconds = (value: string, milliseconds: number): string => new Date(Date.parse(value) + milliseconds).toISOString();
export function stableId(namespace: string, ...parts: string[]): string {
  return `${namespace}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
/** Canonical key order for local identities and immutable-payload comparison. */
export function canonicalJSON(value: JSONValue): string {
  const seen = new WeakSet<object>();
  const normalize = (item: JSONValue): JSONValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || seen.has(item)) throw new Error('INVALID_JSON');
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_JSON');
    seen.add(item);
    const result: JSONValue = Array.isArray(item) ? Array.from(item, normalize)
      : Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key]!)]));
    seen.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value));
}

export interface Migration { name: string; sql: string }
/** Trusted project quarantine; absence preserves existing public behavior. */
export function isRestrictedProject(store:SqliteStore,projectId:string):boolean{
  return Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restricted_projects'")&&store.get('SELECT 1 FROM restricted_projects WHERE project_id=?',projectId));
}
export function bundledMigrations(): Migration[] {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  return readdirSync(directory).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()
    .map(name => ({ name, sql: readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8') }));
}

/** Host-internal single-process SQLite owner. Never expose this to platform plugins. */
export class SqliteStore {
  private readonly database: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private savepoint = 0;
  constructor(readonly filename: string, options: { migrations?: readonly Migration[]; busyTimeoutMs?: number } = {}) {
    this.database = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
    try {
      const timeout = options.busyTimeoutMs ?? 5_000;
      if (!Number.isInteger(timeout) || timeout < 0) throw new Error('INVALID_BUSY_TIMEOUT');
      this.database.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
      this.migrate(options.migrations ?? bundledMigrations());
    } catch (error) { this.database.close(); throw error; }
  }
  private statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.database.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  run(sql: string, ...parameters: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } { return this.statement(sql).run(...parameters); }
  get<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined { return this.statement(sql).get(...parameters) as T | undefined; }
  all<T>(sql: string, ...parameters: SQLInputValue[]): T[] { return this.statement(sql).all(...parameters) as T[]; }
  exec(sql: string): void { this.database.exec(sql); this.statements.clear(); }
  transaction<T>(work: () => T): T {
    if (types.isAsyncFunction(work)) throw new Error('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
    const nested = this.database.isTransaction;
    const name = `m1_${++this.savepoint}`;
    this.database.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result && typeof result === 'object' && 'then' in result) throw new Error('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
      this.database.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
      throw error;
    }
  }
  private migrate(migrations: readonly Migration[]): void {
    const table = this.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
    if (!table && this.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")) throw new Error('UNMANAGED_DATABASE_REQUIRES_EXPLICIT_MIGRATION');
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = this.all<{ name: string; sha256: string }>('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    for (const [index, row] of applied.entries()) {
      const migration = migrations[index];
      if (!migration || migration.name !== row.name || createHash('sha256').update(migration.sql).digest('hex') !== row.sha256) throw new Error('MIGRATION_HISTORY_MISMATCH');
    }
    if (new Set(migrations.map(m => m.name)).size !== migrations.length) throw new Error('DUPLICATE_MIGRATION');
    for (const migration of migrations.slice(applied.length)) {
      // Bundled scripts wrap their own transactions; the runner owns the atomic
      // SQL + ledger commit, stripping only standalone control statements.
      const sql = migration.sql.replace(/^\s*(?:PRAGMA foreign_keys\s*=\s*ON;|BEGIN(?: IMMEDIATE)?;|COMMIT;)\s*$/gim, '');
      this.transaction(() => {
        this.exec(sql);
        this.run('INSERT INTO schema_migrations VALUES(?,?,?)', migration.name, createHash('sha256').update(migration.sql).digest('hex'), systemClock());
      });
    }
    if (this.all('PRAGMA foreign_key_check').length) throw new Error('DATABASE_FOREIGN_KEY_VIOLATION');
  }
  close(): void { this.statements.clear(); if (this.database.isOpen) this.database.close(); }
}
