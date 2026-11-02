import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore, bundledMigrations } from '@superagent/persistence';
import { fixture } from './helpers.mjs';
import path from 'node:path';

test('M5 migration preserves prior accepted and unknown delivery requests without changing their operations',t=>{
  const f=fixture(t);const filename=path.join(f.directory,'before-m5.sqlite');const migrations=bundledMigrations();let db=new SqliteStore(filename,{migrations:migrations.slice(0,8)});
  db.run("INSERT INTO projects VALUES('old-project')");
  for(const state of ['succeeded','unknown']){
    db.run("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES(?,'qq.c2c.send','developer',?,'original-hash',?,'2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z')",state,state,state);
    db.run("INSERT INTO plugin_delivery_requests VALUES(?,'qq-official-c2c-delivery','old-project','developer','acceptance',?,?,'2026-11-02T00:00:00.000Z')",state,JSON.stringify({old:state}),JSON.stringify({status:state==='succeeded'?'accepted':'unknown'}));
  }
  const before=db.all('SELECT * FROM plugin_delivery_requests ORDER BY operation_id');const operations=db.all('SELECT * FROM external_operations ORDER BY operation_id');db.close();
  db=new SqliteStore(filename);try{assert.deepEqual(db.all('SELECT * FROM plugin_delivery_requests ORDER BY operation_id'),before);assert.deepEqual(db.all('SELECT * FROM external_operations ORDER BY operation_id'),operations);assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);assert.ok(db.get("SELECT name FROM sqlite_master WHERE name='idx_plugin_delivery_pending'"));}finally{db.close();}
});
