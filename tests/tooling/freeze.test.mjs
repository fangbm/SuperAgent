import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkContractFreeze } from '../../scripts/check-contract-freeze.mjs';

test('editable application config is excluded explicitly while all 45 M0 hashes and config inventory stay protected',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'sa-freeze-')),source=fileURLToPath(new URL('../..',import.meta.url));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(path.join(source,'contracts.freeze.json'),'utf8'));
  const write=(name,data)=>{const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,data);};
  write('contracts.freeze.json',JSON.stringify(manifest));for(const name of Object.keys(manifest.files))write(name,readFileSync(path.join(source,name)));
  write('config/superagent.json','{"database":"operator-change.sqlite"}');write('config/plugins/qq.json','{"kind":"group"}');
  assert.equal(checkContractFreeze(root).count,45);
  const batching=readFileSync(path.join(root,'config/batching.default.json'));
  write('config/batching.default.json','{}');assert.throws(()=>checkContractFreeze(root),/Frozen contract changed/);write('config/batching.default.json',batching);
  write('config/another.default.json','{}');assert.throws(()=>checkContractFreeze(root),/inventory changed/);rmSync(path.join(root,'config/another.default.json'));
  manifest.applicationConfigPaths=['config/'];write('contracts.freeze.json',JSON.stringify(manifest));assert.throws(()=>checkContractFreeze(root),/Unexpected application config exclusions/);
});
