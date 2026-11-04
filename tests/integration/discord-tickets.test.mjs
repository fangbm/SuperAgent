import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketFixture,interaction } from './discord-module-helpers.mjs';
import { DomainService } from '@superagent/domain';
import { HybridMemory } from '@superagent/memory';
import { ReportService,latestClosedWindow } from '@superagent/reporting';
import { DiscordModuleHost } from '@superagent/plugin-host';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bounded } from '../../scripts/plugin-validation.mjs';
import { SqliteStore,bundledMigrations } from '@superagent/persistence';

test('Bug, suggestion and help submissions atomically archive lifecycle/index/receipt, with private project guards',async t=>{
  const f=ticketFixture(t);
  for(const [i,kind] of ['bug','suggestion','help'].entries())await f.handle(interaction(String(10001+i),'111','new',{kind}));
  assert.equal(f.tickets().length,3);assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.binding.projectId).n,3);
  assert.equal(f.host.list('open:').length,3);assert.equal(f.host.list('receipt:').length,3);
  f.runtime.tick();assert.equal(f.runtime.store.get("SELECT count(*) n FROM jobs WHERE project_id=? AND kind LIKE 'feedback.batch.%'",f.binding.projectId).n,0);
  const archived=f.runtime.store.get('SELECT event_id FROM source_events WHERE project_id=?',f.binding.projectId).event_id;
  assert.throws(()=>f.runtime.buffer.reprocessArchived(archived,'reprocess','developer','try processing'),/PRIVATE_PROJECT_PROCESSING_NOT_AUTHORIZED/);
  const memory=new HybridMemory(f.runtime.store),domain=new DomainService(f.runtime.store,memory);assert.equal(domain.evidence(f.binding.projectId,archived),undefined);assert.equal(domain.evidence('game-test',archived),undefined);
  const reports=new ReportService(f.runtime.store,domain,f.runtime.queue,{clock:f.clock});assert.throws(()=>reports.generate(latestClosedWindow(f.binding.projectId,'2026-11-02T10:04:00Z')),/PRIVATE_PROJECT_REPORT_NOT_AUTHORIZED/);
  assert.equal(JSON.stringify(f.runtime.store.all('SELECT * FROM discord_module_state')).includes('fixture-volatile-token'),false);assert.equal(JSON.stringify(f.runtime.store.all('SELECT * FROM discord_module_inbox')).includes('fixture-volatile-token'),false);
});
test('replayed interaction is idempotent and independent submissions append evidence to one active user/kind ticket',async t=>{
  const f=ticketFixture(t),p=interaction();await f.handle(p);await f.handle(p);
  await f.handle(interaction('10002'));assert.equal(f.tickets().length,1);assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.binding.projectId).n,2);
  assert.throws(()=>f.host.receive(interaction('10001','333')),/DISCORD_INTERACTION_ID_CONFLICT/);
});
test('lifecycle insert failure rolls back raw archive and index; durable inbox recovers without Interaction replay',async t=>{
  const f=ticketFixture(t),p=interaction();f.host.receive(p);
  f.runtime.store.exec("CREATE TRIGGER fail_ticket BEFORE INSERT ON discord_module_state WHEN NEW.state_key LIKE 'ticket:%' BEGIN SELECT RAISE(ABORT,'INJECTED_TICKET_FAILURE'); END");
  await assert.rejects(f.module.handle(p,new AbortController().signal),/INJECTED_TICKET_FAILURE/);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.binding.projectId).n,0);assert.equal(f.tickets().length,0);assert.equal(f.host.list('open:').length,0);
  f.runtime.store.exec('DROP TRIGGER fail_ticket');await f.restart();const pending=f.host.next();assert.ok(pending);await f.module.handle(pending.packet,new AbortController().signal);assert.equal(f.tickets().length,1);assert.equal(f.host.next(),null);
});
test('ticket create response loss is reconciled by exact category/topic marker without a second channel create',async t=>{
  const f=ticketFixture(t);await f.handle(interaction());f.api.mode='lost_create';await f.module.tick(new AbortController().signal);assert.equal(f.tickets()[0].value.status,'unknown_create');
  await f.restart();await f.module.tick(new AbortController().signal);assert.equal(f.tickets()[0].value.status,'open');assert.equal(f.api.calls.filter(c=>c.method==='POST'&&c.route==='/guilds/100/channels').length,1);
  const created=f.api.calls.find(c=>c.method==='POST'&&c.route==='/guilds/100/channels').body;
  assert.ok((BigInt(created.permission_overwrites.find(p=>p.id==='100').deny)&1024n)>0n);assert.ok((BigInt(created.permission_overwrites.find(p=>p.id==='111').allow)&1024n)>0n);
});
test('requester owns only their ticket, current staff may claim/delete, and close/reopen retain history',async t=>{
  const f=ticketFixture(t);await f.handle(interaction());await f.module.tick(new AbortController().signal);const ticket=f.tickets()[0].value;
  await assert.rejects(f.handle(interaction('10002','333','view',{ticket:ticket.id})),/DISCORD_TICKET_FORBIDDEN/);
  await assert.rejects(f.handle(interaction('10003','111','claim',{ticket:ticket.id})),/DISCORD_TICKET_FORBIDDEN/);
  await f.handle(interaction('10004','222','claim',{ticket:ticket.id}));assert.equal(f.tickets()[0].value.claimedBy,'222');
  await f.handle(interaction('10005','111','close',{ticket:ticket.id}));assert.equal(f.tickets()[0].value.status,'closed');
  await f.handle(interaction('10006','111','reopen',{ticket:ticket.id}));assert.equal(f.tickets()[0].value.status,'open');assert.equal(f.host.list('history:'+ticket.id+':').length,4);
  await f.handle(interaction('10007','111','close',{ticket:ticket.id}));await f.handle(interaction('10008','222','delete',{ticket:ticket.id}));await f.module.tick(new AbortController().signal);assert.equal(f.tickets()[0].value.status,'deleted');assert.equal(f.host.list('history:'+ticket.id+':').length,6);
});
test('retired module port cannot write, binding changes cannot adopt another private project',async t=>{
  const f=ticketFixture(t),port=f.host.port();f.host.revoke();await assert.rejects(port.commit([{key:'ticket:bad',expectedVersion:null,value:{}}]),/DISCORD_MODULE_HOST_CLOSED/);
  assert.throws(()=>new DiscordModuleHost(f.runtime.store,{...f.binding,projectId:'foreign-private'},{assertOwner:()=>{}}),/DISCORD_MODULE_BINDING_CHANGED/);
});
test('long ticket originals are paged in authorized ephemeral replies without exposing a different requester',async t=>{
  const f=ticketFixture(t),body='原文内容'.repeat(600),p=interaction('10001','111','new',{body});await f.handle(p);const id=f.tickets()[0].value.id;
  for(const page of [1,2]){const request=interaction(String(11000+page),'111','view',{ticket:id,page});await f.module.acknowledge(request);await f.handle(request);}
  const replies=f.api.calls.filter(c=>c.method==='PATCH'&&c.route.startsWith('/webhooks/'));assert.equal(replies.length,2);assert.match(replies[1].body.content,/第 2\/2 页/);assert.ok(replies.every(r=>r.body.allowed_mentions.parse.length===0));
});
test('channel reclamation pages a full history and unknown delete never issues a second DELETE',async t=>{
  const f=ticketFixture(t);await f.handle(interaction());await f.module.tick(new AbortController().signal);const id=f.tickets()[0].value.id,channel=f.tickets()[0].value.channelId;
  const request=f.api.request.bind(f.api);f.api.request=async(method,route,body,signal)=>{
    if(method==='GET'&&route.startsWith(`/channels/${channel}/messages?`)&&!route.includes('before='))return Array.from({length:100},(_,i)=>({id:String(9000-i),channel_id:channel,guild_id:'100',content:'private history '+i,timestamp:'2026-11-02T00:00:00.000Z',author:{id:'111'},attachments:[]}));
    return request(method,route,body,signal);
  };
  await f.handle(interaction('10002','111','close',{ticket:id}));await f.handle(interaction('10003','222','delete',{ticket:id}));f.api.mode='delete_fail';await assert.rejects(f.module.tick(new AbortController().signal),/OUTCOME_UNKNOWN/);
  assert.equal(f.runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.binding.projectId).n,101);await f.module.tick(new AbortController().signal);
  assert.equal(f.api.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(f.tickets()[0].value.status,'blocked');
});
test('namespaced Discord migration coexists with a later global migration without rewriting either ledger',async t=>{
  const f=ticketFixture(t);await f.handle(interaction());const before=f.runtime.store.all('SELECT * FROM schema_migrations ORDER BY name');f.runtime.close();
  const store=new SqliteStore(f.filename,{migrations:[...bundledMigrations(),{name:'013_future_parallel.sql',sql:'CREATE TABLE future_parallel_feature(id TEXT PRIMARY KEY);'}]});
  try{assert.deepEqual(store.all('SELECT * FROM schema_migrations ORDER BY name').slice(0,before.length),before);assert.equal(store.get('SELECT count(*) n FROM discord_feature_migrations').n,1);assert.equal(store.get("SELECT count(*) n FROM discord_module_state WHERE state_key LIKE 'ticket:%'").n,1);}finally{store.close();}
});
test('actual process death inside/after the archive transaction recovers without relying on Gateway replay',async t=>{
  for(const mode of ['inside','after'])await t.test(mode,async t=>{
    const f=ticketFixture(t);f.runtime.close();
    const child=spawn(process.execPath,['tests/integration/discord-ticket-crash-child.mjs',f.filename,mode],{cwd:new URL('../..',import.meta.url),windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',b=>stderr+=b);
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}});
    const [ready]=await bounded(Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(stderr);})]),10000);assert.equal(ready.stage,mode==='inside'?'inside':'committed');
    const done=once(child,'exit');child.kill('SIGKILL');await done;
    const runtime=await f.restart();assert.equal(runtime.store.get('PRAGMA quick_check').quick_check,'ok');
    assert.equal(f.tickets().length,mode==='inside'?0:1);
    if(mode==='inside'){const pending=f.host.next();assert.ok(pending);await f.module.handle(pending.packet,new AbortController().signal);}
    assert.equal(f.tickets().length,1);assert.equal(f.host.list('open:').length,1);assert.equal(f.host.list('receipt:').length,1);assert.equal(f.host.next(),null);
    assert.equal(runtime.store.get('SELECT count(*) n FROM source_events WHERE project_id=?',f.binding.projectId).n,1);
  });
});
