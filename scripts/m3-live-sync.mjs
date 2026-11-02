// Desktop connector bridge. It contains no OAuth token and is opt-in for writes.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { M1Runtime } from '@superagent/agent-core';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { GitHubSyncManager, GitHubError } from '@superagent/issue-tracker';
const {values}=parseArgs({options:{write:{type:'boolean',default:false}}});
const input=createInterface({input:process.stdin});let serial=0;const pending=new Map();
input.on('line',line=>{const reply=JSON.parse(line);const waiter=pending.get(reply.rpcId);if(!waiter)return;pending.delete(reply.rpcId);clearTimeout(waiter.timer);if(reply.error)waiter.reject(new GitHubError(reply.error.code,reply.error.outcome??'unknown'));else waiter.resolve(reply.result);});
const rpc=(method,args=[])=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new GitHubError('CONNECTOR_REPLY_UNKNOWN'));},120_000);pending.set(id,{resolve,reject,timer});process.stdout.write(JSON.stringify({rpcId:id,method,args})+'\n');});
const live=JSON.parse(readFileSync('.artifacts/m3-live-latest.json','utf8'));const policy=JSON.parse(readFileSync('config/batching.default.json','utf8')).feedbackBatching;
const runtime=new M1Runtime(live.database,{policy});
const port={repository:live.repository,inspect:()=>rpc('inspect'),createIssue:(title,body)=>rpc('createIssue',[title,body]),issue:number=>rpc('issue',[number]),issues:page=>rpc('issues',[page]),
  createComment:(number,body)=>rpc('createComment',[number,body]),comment:id=>rpc('comment',[id]),updateComment:(id,body)=>rpc('updateComment',[id,body]),comments:(number,page)=>rpc('comments',[number,page])};
try{
  const domain=new DomainService(runtime.store,new HybridMemory(runtime.store),{repositories:{'m3-live-acceptance':live.repository}});
  const manager=new GitHubSyncManager(runtime.store,domain,port,{allowWrites:values.write,titlePrefix:'[M3 验收] ',leaseMs:120_000});
  if(!values.write){console.log(JSON.stringify({stage:'preview',drafts:await manager.preview()}));}
  else{
    const sends=[];
    for(let i=0;i<2;i++){const result=await manager.tick();sends.push(result);if(result.state!=='succeeded')throw new Error('LIVE_ISSUE_SYNC_NOT_CONFIRMED');}
    const bug=runtime.store.get("SELECT work_id FROM work_metadata WHERE work_kind='defect' AND project_id='m3-live-acceptance'");
    if(bug){runtime.store.run("UPDATE github_sync_outbox SET state='pending',available_at=? WHERE work_kind='defect' AND work_id=? AND repository=?",new Date().toISOString(),bug.work_id,live.repository);const result=await manager.tick();sends.push(result);if(result.state!=='succeeded')throw new Error('LIVE_STATS_SYNC_NOT_CONFIRMED');}
    const links=runtime.store.all('SELECT work_kind,work_id,repository,external_issue_id FROM external_work_links');const readbacks=[];
    for(const link of links)readbacks.push({kind:link.work_kind,workId:link.work_id,issue:await port.issue(link.external_issue_id)});
    const stats=runtime.store.all('SELECT * FROM github_stats_comments');const commentReadbacks=[];
    for(const row of stats){const link=links.find(l=>l.work_id===row.work_id&&l.work_kind===row.work_kind);const page=await port.comments(link.external_issue_id,1);const comment=page.items.find(c=>c.id===row.comment_id);if(!comment)throw new Error('LIVE_COMMENT_NOT_READ_BACK');commentReadbacks.push(comment);}
    const report={scope:'Real GitHub desktop connector; synthetic feedback; manual statistics refresh',repository:live.repository,sends,links,readbacks,commentReadbacks,operations:runtime.store.all('SELECT operation_id,kind,state,provider_object_id FROM external_operations')};
    writeFileSync('.artifacts/m3-live-github-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({stage:'complete',repository:live.repository,links,comments:commentReadbacks.map(c=>({id:c.id,authorId:c.authorId})),operations:report.operations}));
  }
}finally{runtime.close();input.close();process.stdin.destroy();}
