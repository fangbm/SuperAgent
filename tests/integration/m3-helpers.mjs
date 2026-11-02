import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, event, scope, binding } from './helpers.mjs';
import { CompatibleChatModel } from '@superagent/llm';
import { HybridMemory } from '@superagent/memory';
import { DomainService } from '@superagent/domain';
import { AnalysisWorker } from '@superagent/agent-workers';

export function fixtureAnswer(task) {
  if(task.task==='extract'){
    const primary=task.messages.find(m=>m.role==='candidate');const quote=primary.text;
    const evidence=[{eventId:primary.eventId,role:'primary',quote}];
    const items=[{kind:'defect',category:'bug',title:'联机载入90%时崩溃',description:'Windows 1.2.0 多人联机载入90%时崩溃',confidence:0.95,productVersion:'1.2.0',observedBehavior:'载入90%时崩溃退出',evidence}];
    if(quote.includes('自动重连'))items.push({kind:'suggestion',category:'feature_request',title:'断线自动重连',description:'希望断线后自动重连',confidence:0.95,requestedOutcome:'网络断开后自动重连',evidence});
    return {schemaVersion:'2.0',batchId:task.batchId,pipelineVersion:task.pipelineVersion,revision:task.revision,items,requiresHumanReview:false};
  }
  const evidence=[{eventId:task.item.evidence[0].eventId},{eventId:task.candidate.evidence[0].eventId}];
  if(task.task==='match_bug')return{candidateIssueId:task.candidateId,relationship:'same_issue',supportingEvidence:evidence,conflictingEvidence:[],missingInformation:[],rationale:'相同平台版本、触发条件与表现，双方原文支持'};
  return{candidateSuggestionId:task.candidateId,relationship:'same_request',evidence,matchingOutcome:['断线自动重连'],conflictingRequirements:[],distinguishingDetails:[],rationale:'请求目标一致'};
}
export async function modelServer(t,responder=fixtureAnswer){
  const requests=[];const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part.toString();
    const wire=JSON.parse(body);const request=JSON.parse(wire.messages[1].content);const task=JSON.parse(request.task);requests.push({wire,task});
    try{
      const answer=await responder(task,wire,requests.length);
      if(answer?.httpStatus){res.writeHead(answer.httpStatus);res.end(JSON.stringify({error:'fixture-secret-error-body'}));return;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}],usage:{prompt_tokens:10,completion_tokens:20}}));
    }catch{res.writeHead(500);res.end('{}');}
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return{requests,baseURL:`http://127.0.0.1:${server.address().port}`};
}
export async function m3Fixture(t,options={}){
  const f=fixture(t,options.policyOverrides);const server=await modelServer(t,options.responder);
  const model=new CompatibleChatModel({baseURL:server.baseURL,allowLoopbackHTTP:true,model:'fixture-model',apiKey:'fixture-only-not-a-real-key'});
  const memory=new HybridMemory(f.runtime.store,options.embeddings);
  const domain=new DomainService(f.runtime.store,memory,{clock:f.clock,repositories:options.repositories??{[binding.projectId]:'owner/private-test'},authorizedActors:['developer']});
  const worker=new AnalysisWorker(f.runtime.store,f.runtime.queue,domain,memory,model,{clock:f.clock,...options.workerOptions});
  const add=(id,text='Windows 1.2.0 联机载入90%时崩溃，希望自动重连',other)=>{
    let e=event(id,{text});let source=scope;
    if(other){f.runtime.ingress.registerSource(other);e.source=other.sourceUri;e.data.projectId=other.projectId;e.data.sourceId=other.sourceId;e.data.platform=other.platform;source={projectId:other.projectId,sourceId:other.sourceId};}
    const receipt=f.runtime.ingress.commitBatch(source,[e]);f.runtime.tick();
    for(const s of f.runtime.store.all("SELECT segment_id FROM conversation_segments WHERE state='open'"))f.runtime.buffer.flushSync(s.segment_id,'replay');
    return receipt.refs[0].eventId;
  };
  return{...f,server,model,memory,domain,worker,add};
}

export class FixtureGitHub {
  repository='owner/private-test';private=true;authorId='robot-1';issuesMap=new Map();commentsMap=new Map();posts=0;commentPosts=0;patches=0;
  issueMode='ok';commentMode='ok';pages=[];
  async inspect(){return{private:this.private,authorId:this.authorId};}
  async createIssue(title,body){this.posts++;const issue={number:String(this.posts),title,body,state:'open',stateReason:null};this.issuesMap.set(issue.number,issue);if(this.issueMode==='timeout')throw new (await import('@superagent/issue-tracker')).GitHubError('SIMULATED_TIMEOUT');return issue;}
  async issue(number){return this.issuesMap.get(number);}
  async issues(page){if(this.pages.length)return this.pages[page-1]??{items:[],next:false};return{items:[...this.issuesMap.values()],next:false};}
  async createComment(number,body){this.commentPosts++;const comment={id:String(this.commentPosts),body,authorId:this.authorId,issueNumber:number};this.commentsMap.set(comment.id,comment);if(this.commentMode==='timeout')throw new (await import('@superagent/issue-tracker')).GitHubError('SIMULATED_TIMEOUT');return comment;}
  async comment(id){return this.commentsMap.get(id);}
  async updateComment(id,body){this.patches++;const comment={...this.commentsMap.get(id),body};this.commentsMap.set(id,comment);return comment;}
  async comments(number,page){return{items:[...this.commentsMap.values()].filter(c=>c.issueNumber===number),next:false};}
}
