import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { createApplication } from '../../scripts/application.mjs';
import { appFixture } from './application-helpers.mjs';

test('application fixture awaits resource shutdown before removing its SQLite directory', async t=>{
  let cleanup;const order=[];
  const f=appFixture({after:fn=>{cleanup=fn;}});
  t.after(()=>cleanup());
  const app=await createApplication(f.config,{access:f.access});
  f.after(async()=>{await app.close();order.push('closed');});
  f.after(async()=>{await new Promise(setImmediate);assert.ok(existsSync(f.config.database));order.push('worker');});
  await app.start();await cleanup();
  assert.deepEqual(order,['worker','closed']);assert.equal(existsSync(f.directory),false);
});

test('a failed fixture cleanup still closes SQLite and removes files, then reports the original failure', async t=>{
  let cleanup;const problem=new Error('EXPECTED_CLEANUP_FAILURE');
  const f=appFixture({after:fn=>{cleanup=fn;}});
  t.after(()=>cleanup());
  const app=await createApplication(f.config,{access:f.access});
  f.after(()=>app.close());f.after(()=>{throw problem;});
  await assert.rejects(cleanup(),error=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0]===problem);
  assert.equal(existsSync(f.directory),false);
});
