import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fixture, binding } from './helpers.mjs';
import { accessKey } from './m5-helpers.mjs';
test('production M5 CLI generates and archives a due report, never logs access key, and exits without external writes',async t=>{
  const f=fixture(t);const filename=path.join(f.directory,'m5-cli.sqlite');const result=await promisify(execFile)(process.execPath,['scripts/m5-run.mjs','--database',filename,'--project',binding.projectId,'--port','0','--once'],{cwd:process.cwd(),windowsHide:true,timeout:15_000,env:{...process.env,SA_WEB_ACCESS_KEY:accessKey,SA_WEB_READER_KEY:'',SA_GITHUB_TOKEN:'',SA_GITHUB_REPOSITORY:''}});
  const lines=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(lines[0].qqWrites,false);assert.equal(lines[0].githubWrites,false);assert.equal(lines[1].report.status,'succeeded');assert.equal(result.stdout.includes(accessKey),false);
});
