import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {QQLiveQueries,QQOperatorService} from '@superagent/control-plane';
import {reportWindow,nextReportEnd} from '@superagent/reporting';
import {SqliteStore,ensureQQFeatures} from '@superagent/persistence';
import {m5Fixture} from './m5-helpers.mjs';
import {binding,scope,event} from './helpers.mjs';
const crash='Windows 1.2.0 联机加载90%时崩溃';
function enqueue(f,id){
  f.runtime.ingress.commitBatch(scope,[event(id,{text:crash,time:f.clock()})]);f.runtime.tick();
  for(const row of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(row.segment_id,'replay');
}
function operator(f,actor='developer',project=binding.projectId){
  const service=new QQOperatorService(f.control,{projectId:project,actorRef:actor,recipientRef:'developer',clock:f.clock,menu:{enabled:true}});let sequence=0;
  return{service,receive(content,kind='command'){
    const id=`review-${actor}-${sequence++}`;service.receive({interactionId:id,kind,content,reply:kind==='command'?{messageId:id}:{eventId:`outer-${id}`}});
    const tick=service.tick(),row=f.runtime.store.get('SELECT request_json,message_options_json FROM operator_reply_plans WHERE delivery_id=?',tick.deliveryId);
    return{delivery:JSON.parse(row.request_json),options:JSON.parse(row.message_options_json)};
  }};
}
test('recent excludes pre-cutoff feedback even when extraction creates its work after cutoff; creation time remains separate',async t=>{
  const f=await m5Fixture(t),queries=new QQLiveQueries(f.control);f.setTime('2026-11-02T09:50:00.000Z');enqueue(f,'pre-cutoff');
  const report=f.generate(),frozen=structuredClone(report);f.setTime('2026-11-02T10:10:00.000Z');await f.worker.tick();
  const recent=queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(recent.start,report.window.endExclusive);assert.equal(recent.total,0);
  const work=queries.create(f.principal,binding.projectId,'all-bugs',f.clock()).entries[0];assert.equal(work.last,'2026-11-02T09:50:00.000Z');assert.equal(work.createdAt,'2026-11-02T10:10:00.000Z');
  const card=operator(f).receive('/all-bugs');assert.match(card.delivery.text,/最近反馈接收/);assert.match(card.delivery.text,/工作项创建/);assert.deepEqual(f.reports.getExact(binding.projectId,report.reportId,report.revision),frozen);
});
test('recent includes cutoff-boundary/new source feedback and excludes older primaries in the same matched work',async t=>{
  const f=await m5Fixture(t),queries=new QQLiveQueries(f.control);f.setTime('2026-11-02T09:59:59.999Z');enqueue(f,'old');
  f.setTime('2026-11-02T10:00:00.000Z');enqueue(f,'boundary');f.generate();f.setTime('2026-11-02T10:10:00.000Z');await f.worker.tick();await f.worker.tick();
  let recent=queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(recent.total,1);assert.equal(recent.entries[0].count,1);assert.equal(recent.entries[0].last,'2026-11-02T10:00:00.000Z');
  f.setTime('2026-11-02T10:15:00.000Z');enqueue(f,'new');await f.worker.tick();recent=queries.create(f.principal,binding.projectId,'recent',f.clock());assert.equal(recent.total,1);assert.equal(recent.entries[0].count,2);assert.equal(recent.entries[0].last,f.clock());
});
test('all-work summaries classify actual bug and suggestion states instead of counting terminal/accepted work as pending',async t=>{
  const f=await m5Fixture(t);f.add('one');await f.worker.tick();const store=f.runtime.store,queries=new QQLiveQueries(f.control);
  const insert=(kind,status)=>{const source=JSON.parse(store.get('SELECT content_json FROM work_metadata WHERE work_kind=?',kind).content_json),id=`${kind}-${status}`;
    store.run(`INSERT INTO ${kind==='defect'?'issues':'suggestions'} VALUES(?,?,?,?,?,1,?,?)`,id,binding.projectId,status,status,status,f.clock(),f.clock());
    store.run('INSERT INTO work_metadata(work_kind,work_id,project_id,fingerprint,content_json,review_required,priority) VALUES(?,?,?,?,?,0,0)',kind,id,binding.projectId,id,JSON.stringify({...source,id,status,evidence:[]}));
  };
  for(const status of ['candidate','investigating','fixed','verified','dismissed','merged'])insert('defect',status);
  for(const status of ['reviewing','accepted','planned'])insert('suggestion',status);
  const bugs=queries.create(f.principal,binding.projectId,'all-bugs',f.clock());assert.equal(bugs.total,7);assert.match(bugs.summary,/Bug 总计 7 · 未处理 Bug 3 · 待验证 1 · 已终结 3/);
  const entries=queries.page(f.principal,binding.projectId,bugs.id,f.clock(),0,50);for(const status of ['verified','dismissed','merged'])assert.equal(entries.find(e=>e.status===status).category,'已终结 Bug');
  const suggestions=queries.create(f.principal,binding.projectId,'all-suggestions',f.clock());assert.match(suggestions.summary,/建议总计 4 · 待复核建议 2 · 其他状态 2/);
  assert.equal(queries.page(f.principal,binding.projectId,suggestions.id,f.clock(),0,50).find(e=>e.status==='accepted').category,'建议');
  assert.match(queries.create(f.principal,binding.projectId,'pending',f.clock()).summary,/未处理 Bug 3 · 待复核建议 2 · 待验证 1/);
});
test('QQ history navigates beyond 100 sealed reports with stable keysets, reverse pages and exact frozen report opening',async t=>{
  const f=await m5Fixture(t),qq=operator(f),windows=[];f.setTime('2026-11-02T10:04:00.000Z');let end='2026-09-01T10:00:00.000Z';
  for(let n=0;n<112;n++){const window=reportWindow(binding.projectId,end);windows.push(window);f.reports.generate(window);end=nextReportEnd(end);}
  const all=f.runtime.store.all('SELECT report_id reportId,revision FROM report_revisions WHERE project_id=? ORDER BY window_end DESC,report_id DESC,revision DESC',binding.projectId).map(row=>({...row})),frozen=f.reports.getExact(binding.projectId,all.at(-1).reportId,1);
  const navs=page=>page.options.buttons.map(b=>({button:b,nav:f.tokens.read(f.principal,binding.projectId,'qq_navigation',b.token)}));
  const reportIds=page=>navs(page).filter(p=>p.nav.route==='report').map(p=>({reportId:p.nav.reportId,revision:p.nav.revision}));
  let current=qq.receive('/history');const seen=[...reportIds(current)];
  // Both insertions use exactly the old seal timestamp, proving the cutoff is
  // append identity rather than a timestamp that can admit concurrent rows.
  const added=f.reports.generate(reportWindow(binding.projectId,'2026-11-02T10:00:00.000Z'));
  f.reports.generate(windows[0],{revise:true,expectedRevision:1});
  for(let n=0;current.options.buttons.some(b=>b.label==='下一页');n++){assert.ok(n<50);current=qq.receive(current.options.buttons.find(b=>b.label==='下一页').token,'button');seen.push(...reportIds(current));}
  assert.deepEqual(seen,all);assert.equal(new Set(seen.map(r=>`${r.reportId}:${r.revision}`)).size,112);
  const previous=qq.receive(current.options.buttons.find(b=>b.label==='上一页').token,'button');assert.deepEqual(reportIds(previous),all.slice(108,111));
  const oldestButton=navs(current).find(p=>p.nav.route==='report').button;const opened=qq.receive(oldestButton.token,'button');assert.equal(opened.delivery.reportId,all.at(-1).reportId);assert.equal(opened.options.retainMessage,true);assert.deepEqual(f.reports.getExact(binding.projectId,all.at(-1).reportId,1),frozen);
  const refreshed=qq.receive('/history');assert.equal(reportIds(refreshed)[0].reportId,added.reportId);assert.equal(f.reports.historyPage(binding.projectId,{limit:3}).cutoff>112,true);
  const plan=f.runtime.store.all('EXPLAIN QUERY PLAN SELECT report_id FROM report_revisions WHERE project_id=? AND (window_end,report_id,revision)<(?,?,?) ORDER BY window_end DESC,report_id DESC,revision DESC LIMIT 3',binding.projectId,'9999','',1);assert.ok(plan.some(r=>r.detail.includes('qq_report_history_page')&&r.detail.includes('SEARCH')));
});
test('report history pages reject invalid cursors, stay project-scoped and recheck reader revocation',async t=>{
  const f=await m5Fixture(t);f.generate();const other={...binding,projectId:'other-project',sourceId:'other-source',sourceUri:'urn:other:reports'};f.runtime.ingress.registerSource(other);f.reports.generate(reportWindow(other.projectId,'2026-11-02T10:00:00.000Z'));
  const page=f.reports.historyPage(binding.projectId);assert.equal(page.items.length,1);assert.equal(f.reports.getExact(other.projectId,page.items[0].reportId,page.items[0].revision),null);
  assert.throws(()=>f.reports.historyPage(binding.projectId,{after:page.items[0]}),/INVALID_REPORT_HISTORY_PAGE/);assert.throws(()=>f.reports.historyPage(binding.projectId,{cutoff:page.cutoff,after:{...page.items[0],revision:0}}),/INVALID_REPORT_HISTORY_CURSOR/);
  const qq=operator(f,'reader'),first=qq.receive('/history'),token=first.options.buttons[0].token;f.runtime.store.run("UPDATE operator_accounts SET enabled=0 WHERE actor_ref='reader'");assert.throws(()=>qq.receive(token,'button'));
  assert.throws(()=>operator(f,'developer',other.projectId).receive('/history'),/FORBIDDEN/);
});
test('published QQ v1 upgrades additively to history index v2, preserving old feature and main migration hashes/data',async t=>{
  const f=await m5Fixture(t),filename=path.join(f.directory,'qq-v1-upgrade.sqlite'),sql=readFileSync(new URL('../../packages/persistence/features/qq-workbench-v1.sql',import.meta.url),'utf8'),digest=createHash('sha256').update(sql).digest('hex');
  const original=new SqliteStore(filename);original.exec('CREATE TABLE qq_feature_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');original.exec(sql);original.run("INSERT INTO qq_feature_migrations VALUES('workbench-v1',?)",digest);original.run("INSERT INTO qq_menu_deployments VALUES('saved','app',?,'{}','{}','unknown',NULL)",f.clock());const main=original.all('SELECT * FROM schema_migrations ORDER BY name');original.close();
  const upgraded=new SqliteStore(filename);try{ensureQQFeatures(upgraded);ensureQQFeatures(upgraded);assert.equal(upgraded.get('SELECT count(*) n FROM qq_feature_migrations').n,2);assert.equal(upgraded.get("SELECT sha256 FROM qq_feature_migrations WHERE name='workbench-v1'").sha256,digest);assert.equal(upgraded.get("SELECT state FROM qq_menu_deployments WHERE operation_id='saved'").state,'unknown');assert.deepEqual(upgraded.all('SELECT * FROM schema_migrations ORDER BY name'),main);assert.ok(upgraded.get("SELECT 1 FROM sqlite_master WHERE name='qq_report_history_page'"));}finally{upgraded.close();}
});
