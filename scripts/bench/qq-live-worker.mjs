import assert from 'node:assert/strict';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {M1Runtime} from '@superagent/agent-core';
import {HybridMemory} from '@superagent/memory';
import {DomainService} from '@superagent/domain';
import {ReportService,reportWindow} from '@superagent/reporting';
import {ControlPlane,OperatorAuth,TokenService,QQLiveQueries} from '@superagent/control-plane';
import {parseContract} from '@superagent/contract-validation';

const [directory,workText,feedbackText,sampleText]=process.argv.slice(2),works=Number(workText),feedback=Number(feedbackText),samples=Number(sampleText);
const perWork=feedback/works,project='qq-query-benchmark',source='qq-query-benchmark-source',uri='urn:superagent:benchmark:qq-query',conversation='benchmark-group';
const now='2026-11-05T04:00:00.000Z',historical='2026-10-01T08:00:00.000Z',recent='2026-11-05T03:55:00.000Z',clock=()=>now;
const policy=JSON.parse(readFileSync(new URL('../../config/batching.default.json',import.meta.url),'utf8')).feedbackBatching;
const filename=path.join(directory,'state.sqlite'),runtime=new M1Runtime(filename,{policy,clock}),store=runtime.store;
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const diskBytes=()=>['','-wal','-shm'].reduce((total,suffix)=>{try{return total+statSync(filename+suffix).size;}catch{return total;}},0);
const round=n=>Math.round(n*1000)/1000;
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{samples:values.map(round),median:round(sorted[Math.floor(sorted.length/2)]),max:round(sorted.at(-1))};};
let pendingWorks=0,recentWorks=0;
const progress={works,analyzedFeedback:feedback,pendingMessages:Math.floor(feedback/100),measurements:[]};
const checkpoint=()=>writeFileSync(path.join(directory,'partial.json'),JSON.stringify(progress));
const phase=(name,extra={})=>{progress.lastPhase={name,...extra,startedAt:new Date().toISOString()};checkpoint();process.stderr.write('BENCHMARK_PHASE '+JSON.stringify(progress.lastPhase)+'\n');};
try{
  phase('seed');
  runtime.ingress.registerSource({projectId:project,sourceId:source,sourceUri:uri,platform:'qq-official'});
  const domain=new DomainService(store,new HybridMemory(store),{clock});
  const reports=new ReportService(store,domain,runtime.queue,{clock,recipients:[]});
  reports.generate(reportWindow(project,'2026-11-04T16:00:00.000Z'));
  const auth=new OperatorAuth(store,clock);auth.register({actorRef:'benchmark-reader',role:'reader',projects:[project]},'synthetic-benchmark-access-key-at-least-32');
  const tokens=new TokenService(store,'synthetic-benchmark-signing-key-at-least-32',clock),control=new ControlPlane(store,domain,reports,auth,tokens,clock),queries=new QQLiveQueries(control),principal=auth.principal('benchmark-reader');
  const pending=Math.floor(feedback/100),seedStart=performance.now();
  const seedEvent=(n,receivedAt)=>{
    const id=uuid(n),externalId=`bench-message-${n}`,text=`合成查询样例 ${n}：多人联机发生异常`;
    const event={specversion:'1.0',id:`bench-native-${n}`,source:uri,type:'com.superagent.feedback.message.created.v1',time:receivedAt,datacontenttype:'application/json',data:{schemaVersion:'1.0',projectId:project,sourceId:source,platform:'qq-official',object:{kind:'message',externalId,revision:'original',threadExternalId:conversation},actor:{opaqueId:`bench-anonymous-${n}`,isBot:false},content:{text,attachments:[]},attributes:{qqScope:'group'}}};
    if(n===0)parseContract('normalized-event-v1',event);
    store.run('INSERT INTO source_events VALUES(?,?,?,?,?,?,?,?)',id,uri,event.id,project,source,event.type,JSON.stringify(event),receivedAt);
    store.run('INSERT INTO source_objects VALUES(?,?,?,?,?,?,0,?,0)',source,externalId,'message',id,'original',receivedAt,`thread:${conversation}`);
    store.run('INSERT INTO source_event_routes VALUES(?,?,?,?)',id,source,`thread:${conversation}`,receivedAt);
    store.run('INSERT INTO event_outbox(event_id,handler_version,status) VALUES(?,?,?)',id,'admission-v1',n<feedback?'completed':'pending');
    return{id,externalId,text};
  };
  store.transaction(()=>{
    for(let w=0;w<works;w++){
      const kind=w%2?'suggestion':'defect',id=`bench-work-${w}`,batchId=`bench-batch-${w}`,triageId=`bench-triage-${w}`,segmentId=`bench-segment-${w}`,hasRecent=Math.floor(w/2)%20===0;
      const bucket=Math.floor(Math.floor(w/2)/20)%10,status=kind==='defect'?(bucket===0?'open':bucket===1?'investigating':bucket===2?'fixed':'verified'):(bucket===0?'candidate':bucket===1?'reviewing':'accepted');
      if(kind==='defect'?['open','investigating','fixed'].includes(status):['candidate','reviewing'].includes(status))pendingWorks++;
      if(hasRecent)recentWorks++;
      const records=[];for(let j=0;j<perWork;j++){const receivedAt=hasRecent&&j===perWork-1?recent:historical;records.push({...seedEvent(w*perWork+j,receivedAt),receivedAt});}
      const evidence=records.map(e=>({eventId:e.id,role:'primary',quote:e.text}));
      const items=records.map(e=>({kind,category:kind==='defect'?'bug':'feature_request',title:`合成工作项 ${w}`,description:e.text,confidence:0.9,...(kind==='defect'?{observedBehavior:e.text}:{requestedOutcome:e.text}),evidence:[{eventId:e.id,role:'primary',quote:e.text}]}));
      const batch={schemaVersion:'1.0',batchId,projectId:project,sourceId:source,segmentIds:[segmentId],candidateEventIds:records.map(e=>e.id),contextEventIds:[],policyVersion:runtime.buffer.policy.policyVersion,revision:1,reason:'quiet_timeout',createdAt:now};
      const result={schemaVersion:'2.0',batchId,pipelineVersion:'benchmark-v1',revision:1,items,requiresHumanReview:false};
      if(w<2){parseContract('feedback-batch-v1',batch);parseContract('triage-result-v2',result);}
      store.run("INSERT INTO conversation_segments(segment_id,project_id,source_id,segment_key,policy_version,revision,state,opened_at,last_related_at,quiet_due_at,max_due_at,candidate_count,policy_json) VALUES(?,?,?,?,?,1,'flushed',?,?,?,?,?,?)",segmentId,project,source,segmentId,batch.policyVersion,historical,now,now,now,records.length,JSON.stringify(runtime.buffer.policy));
      store.run('INSERT INTO feedback_batches VALUES(?,?,?,?,?,?,?,0)',batchId,project,source,batch.policyVersion,now,'quiet_timeout',JSON.stringify(batch));
      store.run('INSERT INTO batch_segments VALUES(?,?)',batchId,segmentId);
      store.run('INSERT INTO analysis_requests VALUES(?,?,?,1,?)',triageId,batchId,'benchmark-v1',now);
      store.run("INSERT INTO triage_extractions VALUES(?,?,?,1,'2.0',?,NULL,?)",triageId,batchId,'benchmark-v1',JSON.stringify(result),now);
      store.run("INSERT INTO jobs(job_id,project_id,kind,payload_json,idempotency_key,lane,priority,created_at,available_at,status,max_attempts,completed_at) VALUES(?,?,'feedback.batch.triage',?,?,'full_agent',0,?,?,'completed',3,?)",`bench-job-${w}`,project,JSON.stringify({batchId}),`triage:${batchId}`,now,now,now);
      store.run(`INSERT INTO ${kind==='defect'?'issues':'suggestions'} VALUES(?,?,?,?,?,1,?,?)`,id,project,`合成工作项 ${w}`,'只用于查询性能的合成数据',status,historical,hasRecent?recent:historical);
      const work={id,projectId:project,kind,title:`合成工作项 ${w}`,summary:'只用于查询性能的合成数据',status,version:1,reviewRequired:false,priority:20,feedbackCount:records.length,evidence,content:items[0]};
      store.run('INSERT INTO work_metadata(work_kind,work_id,project_id,fingerprint,content_json,review_required,priority) VALUES(?,?,?,?,?,0,20)',kind,id,project,id,JSON.stringify(work));
      records.forEach((e,j)=>{
        const itemId=`bench-item-${w}-${j}`,item=items[j];
        store.run('INSERT INTO admission_decisions VALUES(?,?,\'candidate\',\'BENCHMARK_SYNTHETIC_ANALYZED\',?)',e.id,batch.policyVersion,now);
        store.run("INSERT INTO segment_events VALUES(?,?,'candidate')",segmentId,e.id);store.run("INSERT INTO batch_events VALUES(?,?,'candidate')",batchId,e.id);
        store.run('INSERT INTO feedback_items VALUES(?,?,?,?,?,?,?,0.9,1,?)',itemId,triageId,j,kind,item.category,item.title,item.description,now);
        store.run("INSERT INTO feedback_item_evidence VALUES(?,0,?,'primary',?,NULL,NULL)",itemId,e.id,e.text);
        store.run('INSERT INTO feedback_item_metadata VALUES(?,?,?,?,?)',itemId,project,itemId,JSON.stringify(item),'synthetic-not-a-model-call');
        store.run('INSERT INTO feedback_primary_objects VALUES(?,?,?,?)',itemId,source,e.externalId,e.id);
        store.run('INSERT INTO work_feedback_links VALUES(?,?,?)',kind,id,itemId);
      });
    }
    for(let n=feedback;n<feedback+pending;n++)seedEvent(n,recent);
  });
  assert.deepEqual(store.all('PRAGMA foreign_key_check'),[]);
  assert.equal(store.get('SELECT count(*) n FROM feedback_items').n,feedback);
  assert.equal(store.get('SELECT count(*) n FROM source_events').n,feedback+pending);
  assert.equal(store.get('SELECT count(*) n FROM work_metadata').n,works);
  assert.equal(store.get('SELECT count(*) n FROM model_calls').n,0);assert.equal(store.get('SELECT count(*) n FROM external_operations').n,0);
  const seedMs=performance.now()-seedStart;store.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const seedBytes=diskBytes(),measurements=[];
  Object.assign(progress,{recentWorks,pendingWorks,seedMs:round(seedMs),seedDatabaseBytes:seedBytes});checkpoint();
  process.stderr.write(`BENCHMARK seeded ${feedback} feedback + ${pending} pending messages in ${round(seedMs)} ms\n`);
  for(const mode of ['pending','recent','all-bugs','all-suggestions']){
    const wall=[],timerDelay=[],navigation=[],counts=[];let members=0;
    for(let sample=0;sample<samples;sample++){
      phase('query',{mode,sample});
      const methods=['get','all','run','exec'],originals={},calls={get:0,all:0,run:0,exec:0,feedbackLookups:0,linkLookups:0};
      for(const method of methods){originals[method]=store[method];store[method]=function(sql,...args){calls[method]++;if(sql.startsWith('SELECT min((SELECT min(first.received_at)')){calls.feedbackLookups++;if(!progress.evidencePlan){progress.evidencePlan=originals.all.call(this,'EXPLAIN QUERY PLAN '+sql,...args).map(row=>row.detail);checkpoint();}}if(sql.startsWith('SELECT external_issue_id FROM external_work_links'))calls.linkLookups++;return originals[method].call(this,sql,...args);};}
      const start=performance.now();let fired;const timer=new Promise(resolve=>setTimeout(()=>{fired=performance.now()-start;resolve();},0));let snapshot;
      try{snapshot=queries.create(principal,project,mode,now);wall.push(performance.now()-start);}finally{for(const method of methods)store[method]=originals[method];}
      await timer;phase('navigation',{mode,sample});timerDelay.push(fired);counts.push(calls);members=snapshot.total;
      const expected=mode==='pending'?pendingWorks+pending:mode==='recent'?recentWorks+pending:works/2;assert.equal(members,expected);
      const offsets=[0,Math.floor(members/2),Math.max(0,members-3)];
      for(let n=0;n<30;n++){const pageStart=performance.now();queries.page(principal,project,snapshot.id,now,offsets[n%offsets.length]);navigation.push(performance.now()-pageStart);}
      progress.measurements=measurements.concat({mode,members,snapshotMs:summary(wall),delayedZeroTimerMs:summary(timerDelay),pageMs:summary(navigation),storeCalls:counts});checkpoint();
    }
    const result={mode,members,snapshotMs:summary(wall),delayedZeroTimerMs:summary(timerDelay),pageMs:summary(navigation),storeCalls:counts};measurements.push(result);
    process.stderr.write(`BENCHMARK ${mode}: snapshot median ${result.snapshotMs.median} ms; page median ${result.pageMs.median} ms\n`);
  }
  const pagePlan=store.all('EXPLAIN QUERY PLAN SELECT payload_json FROM qq_query_members WHERE snapshot_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal','benchmark-plan',10000,10003).map(row=>row.detail);
  assert.ok(pagePlan.some(line=>line.includes('SEARCH')));
  phase('complete');process.stdout.write(JSON.stringify({...progress,finalDatabaseBytes:diskBytes(),peakProcessRSSKiB:process.resourceUsage().maxRSS,pagePlan,measurements}));
}finally{runtime.close();}
