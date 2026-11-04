import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {SqliteStore} from './index.js';
const ready=new WeakSet<SqliteStore>();
/** Application-owned additive feature ledger; leaves main migration numbering untouched. */
export function ensureQQFeatures(store:SqliteStore):void {
  if(ready.has(store))return;
  const sql=readFileSync(new URL('../features/qq-workbench-v1.sql',import.meta.url),'utf8'),digest=createHash('sha256').update(sql).digest('hex');
  store.transaction(()=>{store.exec('CREATE TABLE IF NOT EXISTS qq_feature_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');
    const old=store.get<{sha256:string}>("SELECT sha256 FROM qq_feature_migrations WHERE name='workbench-v1'");
    if(old){if(old.sha256!==digest)throw new Error('QQ_FEATURE_MIGRATION_MISMATCH');return;}
    store.exec(sql);store.run("INSERT INTO qq_feature_migrations VALUES('workbench-v1',?)",digest);
  });
  ready.add(store);
}
