import { readFileSync } from 'node:fs';
import { createApplication } from '../../scripts/application.mjs';
import { sourceDouble,material,eventually,access } from './application-helpers.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),entry=config.sources[0];
const policy=JSON.parse(readFileSync(process.argv[3],'utf8'));
const app=await createApplication(config,{access,policy,sourceFactories:{'qq-official':()=>sourceDouble(entry,{start:async host=>{
  const old=await host.getCheckpoint();
  if(!old)await host.commitBatch([material(entry,config.projectId,'before-crash')],{sourceId:entry.id,cursor:{offset:1}});
}})}});
await app.start();await eventually(()=>app.runtime.store.get('SELECT count(*) n FROM source_events').n===1);
process.send({ready:true});
// Parent SIGKILLs the owner with archived input/outbox committed, before any tick.
await new Promise(()=>{});
