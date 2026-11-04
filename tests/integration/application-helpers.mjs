import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadApplicationConfig } from '../../scripts/application-config.mjs';
import { builtinSources } from '../../scripts/source-registry.mjs';
import { event,defaultPolicy } from './helpers.mjs';

export const access={accessKey:'unified-local-fixture-access-key-longer-than-32',signingKey:'unified-fixture-cursor-signing-key-longer-than-32'};
export function appFixture(t) {
  const directory=mkdtempSync(path.join(tmpdir(),'superagent-application-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config=loadApplicationConfig(fileURLToPath(new URL('../../config/superagent.json',import.meta.url)));
  config.database=path.join(directory,'state.sqlite');config.reports.enabled=false;
  config.runtime={pollMs:10,probeIntervalMs:10,healthGraceMs:10,maxRestarts:1,backoffMs:5,maxBackoffMs:20,stopTimeoutMs:100};
  return {directory,config,policy:{...defaultPolicy,auditSampleRate:0,maxCandidateMessages:1},access};
}
export const untilAbort=signal=>signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
export async function eventually(check,ms=5000) {const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(5);}assert.fail('Application condition timed out');}
/** Test-only physical clock; configuration cannot bypass production timing limits. */
export class SupervisorClock {
  current=Date.parse('2026-11-04T00:00:00Z');pending=new Set();
  now=()=>this.current;random=()=>0.5;
  wait=(ms,signal)=>new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('ABORTED'));return;}
    const entry={due:this.current+ms,finish:()=>{this.pending.delete(entry);signal.removeEventListener('abort',abort);resolve();}};
    const abort=()=>{this.pending.delete(entry);reject(new Error('ABORTED'));};
    this.pending.add(entry);signal.addEventListener('abort',abort,{once:true});
  });
  async advance(ms){this.current+=ms;for(const entry of [...this.pending])if(entry.due<=this.current)entry.finish();await new Promise(setImmediate);}
  async until(check){for(let i=0;i<300;i++){if(check())return;const next=Math.min(...[...this.pending].map(e=>e.due));if(next<=this.current+1000)await this.advance(Math.max(0,next-this.current));else await delay(1);}assert.fail('Supervisor did not reach expected short-cycle state');}
}
export function material(entry,projectId,id='fixture') {
  const e=event(id);e.source=entry.config.sourceUri;e.data.sourceId=entry.id;e.data.projectId=projectId;e.data.platform=entry.plugin;return e;
}
export function sourceDouble(entry,hooks={}) {
  const manifest=builtinSources.get(entry.plugin).factory(entry.config).manifest;
  return {manifest,probe:async()=>({connection:'push',coverage:'partial',readMessages:true,readHistory:false,readEdits:false,readAttachments:false}),
    start:async(host,signal)=>{await hooks.start?.(host,signal);if(builtinSources.get(entry.plugin).mode==='blocking')await untilAbort(signal);},
    sync:async(host,signal)=>hooks.sync?.(host,signal),stop:async()=>hooks.stop?.(),...hooks.overrides};
}
