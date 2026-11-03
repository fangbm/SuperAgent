import assert from 'node:assert/strict';
import test from 'node:test';
import { ReportService, latestClosedWindow, nextReportEnd, reportWindow } from '@superagent/reporting';
import { m5Fixture } from './m5-helpers.mjs';
import { binding, scope, event, count } from './helpers.mjs';
test('report windows use Beijing 00:00/18:00, half-open boundaries and grace independent of host timezone',()=>{
  const day=reportWindow('p','2026-11-02T10:00:00Z');assert.equal(day.startInclusive,'2026-11-01T16:00:00.000Z');
  const night=reportWindow('p','2026-11-02T16:00:00Z');assert.equal(night.startInclusive,'2026-11-02T10:00:00.000Z');
  assert.equal(latestClosedWindow('p','2026-11-02T10:02:59Z').endExclusive,'2026-11-01T16:00:00.000Z');assert.equal(latestClosedWindow('p','2026-11-02T10:03:00Z').endExclusive,day.endExclusive);
  assert.equal(nextReportEnd(day.endExclusive),'2026-11-02T16:00:00.000Z');assert.throws(()=>reportWindow('p','2026-11-02T12:00:00Z'),/BOUNDARY/);
});
test('mixed intent counts, pending analysis, source coverage, seal and delivery intent commit together',async t=>{
  const f=await m5Fixture(t);f.add('mixed');await f.worker.tick();f.add('pending','仍未分析的联机崩溃');const report=f.generate();
  assert.equal(report.counts.newFeedbackItems,2);assert.equal(report.counts.newDefectItems,1);assert.equal(report.counts.newSuggestionItems,1);assert.equal(report.uniqueSourceEventCount,2);assert.equal(report.counts.pendingAnalysis,1);
  assert.equal(count(f.runtime.store,'report_revision_seals'),1);assert.equal(count(f.runtime.store,'report_delivery_plans'),1);
  assert.deepEqual(f.reports.generate(report.window),report);assert.equal(count(f.runtime.store,'report_revisions'),1);
  assert.throws(()=>f.runtime.store.run('UPDATE report_revisions SET report_json=?','{}'),/IMMUTABLE/);
  assert.throws(()=>f.runtime.store.run('DELETE FROM report_work_evidence'),/IMMUTABLE/);
});
test('late analysis creates explicit revision without changing earlier navigation or automatically sending corrections',async t=>{
  const f=await m5Fixture(t);f.add('mixed');await f.worker.tick();f.add('late','延迟分析的另一条崩溃');const first=f.generate();
  const page=f.control.reportPage(f.principal,binding.projectId,first.reportId,1,'bugs');await f.worker.tick();
  const second=f.reports.generate(first.window,{revise:true,expectedRevision:1});assert.equal(second.revision,2);assert.equal(second.counts.pendingAnalysis,0);assert.equal(first.counts.pendingAnalysis,1);
  assert.deepEqual(f.control.reportPage(f.principal,binding.projectId,first.reportId,1,'bugs'),page);assert.deepEqual(f.reports.getExact(binding.projectId,first.reportId,1),first);assert.equal(count(f.runtime.store,'report_delivery_plans'),1);
  assert.throws(()=>f.reports.generate(first.window,{revise:true,expectedRevision:1}),/REVISION_CONFLICT/);
});
test('snapshot failure rolls back report, memberships, seal and outgoing plan',async t=>{
  const f=await m5Fixture(t);f.add('mixed');await f.worker.tick();f.setTime('2026-11-02T10:04:00Z');const original=f.runtime.store.run.bind(f.runtime.store);
  f.runtime.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO report_revision_seals'))throw new Error('injected-seal-failure');return original(sql,...args);};
  assert.throws(()=>f.reports.generate(reportWindow(binding.projectId,'2026-11-02T10:00:00Z')),/injected/);f.runtime.store.run=original;
  for(const table of ['report_series','report_revisions','report_snapshot_entries','report_work_evidence','report_revision_seals','report_delivery_plans'])assert.equal(count(f.runtime.store,table),0);
});
test('missed schedule windows and report jobs recover once across reopening',async t=>{
  const f=await m5Fixture(t);f.setTime('2026-11-03T16:04:00Z');f.reports.registerSchedule(binding.projectId,'2026-11-01T16:00:00Z');
  assert.equal(f.reports.scheduleDue(),4);assert.equal(f.reports.scheduleDue(),0);for(let n=0;n<4;n++)assert.equal(f.reports.tick().status,'succeeded');
  const other=f.open();const service=new ReportService(other.store,f.domain,other.queue,{clock:f.clock});assert.equal(service.scheduleDue(),0);assert.equal(count(other.store,'report_revisions'),4);
});
test('Steam snapshot deduplicates reviews, selects latest observable negative version, preserves original and excludes boundary events',async t=>{
  const f=await m5Fixture(t);const steam={projectId:binding.projectId,sourceId:'steam-reviews',sourceUri:'urn:superagent:source:steam',platform:'steam-reviews'};f.runtime.ingress.registerSource(steam);
  const add=(id,externalId,sentiment,time)=>{f.setTime(time);const e=event(id,{text:`原文 ${id}`,time});e.source=steam.sourceUri;e.type='com.superagent.feedback.review.'+(id.endsWith('create')?'created':'updated')+'.v1';e.data.sourceId=steam.sourceId;e.data.platform=steam.platform;e.data.object={kind:'review',externalId,revision:id};e.data.attributes={sentiment};f.runtime.ingress.commitBatch(steam,[e]);};
  add('a-create','a','negative','2026-11-02T01:00:00Z');add('a-edit','a','negative','2026-11-02T02:00:00Z');add('b-create','b','negative','2026-11-02T03:00:00Z');add('b-positive','b','positive','2026-11-02T09:00:00Z');add('boundary-create','boundary','negative','2026-11-02T10:00:00Z');
  const report=f.generate();assert.equal(report.steamNegativeReviews.length,1);const member=report.steamNegativeReviews[0];assert.equal(member.reviewExternalId,'a');assert.equal(member.triggerEventIds.length,2);assert.equal(member.updatedInWindow,true);
  const page=f.control.reportPage(f.principal,binding.projectId,report.reportId,1,'steam_negative_reviews');assert.equal(page.entries[0].originalText,'原文 a-edit');
  add('a-positive','a','positive','2026-11-02T10:10:00Z');assert.equal(f.control.reportPage(f.principal,binding.projectId,report.reportId,1,'steam_negative_reviews').entries[0].originalText,'原文 a-edit');
});
test('received_at assigns delayed source events to the actual observation window',async t=>{
  const f=await m5Fixture(t);f.setTime('2026-11-02T10:00:00Z');f.runtime.ingress.commitBatch(scope,[event('late-source',{time:'2026-11-01T20:00:00Z'})]);f.setTime('2026-11-02T16:04:00Z');
  const day=f.reports.generate(reportWindow(binding.projectId,'2026-11-02T10:00:00Z'));const evening=f.reports.generate(reportWindow(binding.projectId,'2026-11-02T16:00:00Z'));assert.equal(day.uniqueSourceEventCount,0);assert.equal(evening.uniqueSourceEventCount,1);
});
