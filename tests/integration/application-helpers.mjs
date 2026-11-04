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
export function material(entry,projectId,id='fixture') {
  const e=event(id);e.source=entry.config.sourceUri;e.data.sourceId=entry.id;e.data.projectId=projectId;e.data.platform=entry.plugin;return e;
}
export function sourceDouble(entry,hooks={}) {
  const manifest=builtinSources.get(entry.plugin).factory(entry.config).manifest;
  return {manifest,probe:async()=>({connection:'push',coverage:'partial',readMessages:true,readHistory:false,readEdits:false,readAttachments:false}),
    start:async(host,signal)=>{await hooks.start?.(host,signal);if(builtinSources.get(entry.plugin).mode==='blocking')await untilAbort(signal);},
    sync:async(host,signal)=>hooks.sync?.(host,signal),stop:async()=>hooks.stop?.(),...hooks.overrides};
}
