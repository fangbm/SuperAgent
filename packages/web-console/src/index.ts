import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { ControlError, ControlPlane } from '@superagent/control-plane';
import type { AttachmentReview, CorrectionCommand, Principal, StatusCommand } from '@superagent/control-plane';
import type { ReportSectionV1 } from '@superagent/contracts';
import { latestClosedWindow } from '@superagent/reporting';
import { renderReportMarkdown } from './markdown.js';
export { renderReportMarkdown } from './markdown.js';

export function createConsoleServer(control:ControlPlane,options:{demo?:boolean;now?:()=>string}={}){
  const attempts=new Map<string,{n:number;reset:number}>();
  const assets=new Map([['/',{type:'text/html; charset=utf-8',body:readFileSync(new URL('../public/index.html',import.meta.url))}],['/app.js',{type:'text/javascript; charset=utf-8',body:readFileSync(new URL('../public/app.js',import.meta.url))}],['/style.css',{type:'text/css; charset=utf-8',body:readFileSync(new URL('../public/style.css',import.meta.url))}]]);
  const server=createServer({requestTimeout:10_000,headersTimeout:5000},async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      const address=server.address();const port=address&&typeof address==='object'?address.port:0;
      const allowedHosts=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
      if(!allowedHosts.includes(req.headers.host??''))throw new ControlError('HOST_NOT_ALLOWED',403);
      const origin=`http://${req.headers.host}`;const url=new URL(req.url??'/',origin);const method=req.method??'GET';
      if(url.pathname==='/favicon.ico'&&method==='GET'){res.writeHead(204);res.end();return;}
      if(!['GET','POST'].includes(method))throw new ControlError('METHOD_NOT_ALLOWED',405);
      if(method==='POST'&&req.headers.origin!==origin)throw new ControlError('ORIGIN_NOT_ALLOWED',403);
      if(method==='GET'&&assets.has(url.pathname)){const asset=assets.get(url.pathname)!;res.writeHead(200,{'Content-Type':asset.type});res.end(asset.body);return;}
      const cookies=Object.fromEntries((req.headers.cookie??'').split(';').map(c=>c.trim().split('=').slice(0,2)).filter(p=>p.length===2));
      if(url.pathname==='/api/session'&&method==='POST'){
        const ip=req.socket.remoteAddress??'local';const current=attempts.get(ip);if(current&&current.reset>Date.now()&&current.n>=10)throw new ControlError('LOGIN_RATE_LIMITED',429);
        if(attempts.size>1024)attempts.clear();attempts.set(ip,{n:current&&current.reset>Date.now()?current.n+1:1,reset:current&&current.reset>Date.now()?current.reset:Date.now()+60_000});
        const body=await readJSON(req);const auth=control.auth.login(String(body.accessKey??''));attempts.delete(ip);
        res.setHeader('Set-Cookie',[`sa_session=${auth.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,`sa_csrf=${auth.csrf}; SameSite=Strict; Path=/; Max-Age=28800`]);send(200,{principal:auth.principal,demo:Boolean(options.demo)});return;
      }
      const principal=control.auth.session(cookies.sa_session??'',method==='POST'?String(req.headers['x-csrf-token']??''):undefined);
      if(url.pathname==='/api/session'&&method==='GET'){send(200,{principal,demo:Boolean(options.demo)});return;}
      if(url.pathname==='/api/logout'&&method==='POST'){control.auth.logout(cookies.sa_session??'');res.setHeader('Set-Cookie',['sa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0','sa_csrf=; SameSite=Strict; Path=/; Max-Age=0']);send(200,{ok:true});return;}
      const projectId=url.searchParams.get('project')??'';control.auth.authorize(principal,projectId,method==='POST');
      if(url.pathname==='/api/attachments'&&method==='GET'){send(200,control.attachments(principal,projectId,url.searchParams.get('cursor')??undefined));return;}
      if(url.pathname==='/api/attachments/review-token'&&method==='POST'){send(200,{token:control.attachmentToken(principal,projectId,await readJSON(req) as unknown as AttachmentReview)});return;}
      if(url.pathname==='/api/attachments/review'&&method==='POST'){const body=await readJSON(req);send(200,control.reviewAttachment(principal,projectId,body.request as AttachmentReview,String(body.token)));return;}
      const path=url.pathname;
      if(path.startsWith('/api/artifacts/')&&method==='GET'){
        const id=path.slice('/api/artifacts/'.length);if(!/^artifact-[a-f0-9]{64}$/.test(id))throw new ControlError('ARTIFACT_NOT_FOUND',404);
        const file=control.artifact(principal,projectId,id),extension=file.mimeType==='image/png'?'png':file.mimeType==='image/jpeg'?'jpg':file.mimeType==='image/webp'?'webp':'txt';
        res.writeHead(200,{'Content-Type':file.mimeType,'Content-Length':file.bytes.length,'Content-Disposition':`attachment; filename="${id}.${extension}"`});res.end(file.bytes);return;
      }
      if(path==='/api/metrics'&&method==='GET'){send(200,control.metrics(principal,projectId));return;}
      if(path==='/api/p0'&&method==='GET'){send(200,control.p0Alerts(principal,projectId));return;}
      if(path==='/api/p0/token'&&method==='POST'){const body=await readJSON(req);send(200,{token:control.p0Token(principal,projectId,body as unknown as Parameters<ControlPlane['p0Token']>[2])});return;}
      if(path==='/api/p0/actions'&&method==='POST'){const body=await readJSON(req);send(200,control.p0Action(principal,projectId,String(body.token)));return;}
      if(path==='/api/reports'&&method==='GET'){send(200,control.reports.list(projectId));return;}
      if(path==='/api/reports/generate'&&method==='POST'){send(200,control.reports.generate(latestClosedWindow(projectId,(options.now??(()=>new Date().toISOString()))())));return;}
      if(path==='/api/reports/revise-token'&&method==='POST'){
        const body=await readJSON(req);const report=control.reports.getExact(projectId,String(body.reportId),Number(body.revision));if(!report)throw new ControlError('REPORT_NOT_FOUND',404);
        send(200,{token:control.tokens.issue(principal,projectId,'report_revise',{id:report.reportId,revision:report.revision})});return;
      }
      if(path==='/api/reports/revise'&&method==='POST'){
        const body=await readJSON(req);const report=control.reports.getExact(projectId,String(body.reportId),Number(body.revision));if(!report)throw new ControlError('REPORT_NOT_FOUND',404);
        const revised=control.store.transaction(()=>{const payload=control.tokens.read(principal,projectId,'report_revise',String(body.token),true);if(JSON.stringify(payload)!==JSON.stringify({id:report.reportId,revision:report.revision}))throw new ControlError('TOKEN_SCOPE_INVALID',403);return control.reports.generate(report.window,{revise:true,expectedRevision:report.revision});});send(200,revised);return;
      }
      const reportPath=path.match(/^\/api\/reports\/([^/]+)\/(\d+)(?:\/(section|content))?$/);
      if(reportPath&&method==='GET'){
        const id=decodeURIComponent(reportPath[1]!),revision=Number(reportPath[2]);if(reportPath[3]==='section')send(200,control.reportPage(principal,projectId,id,revision,url.searchParams.get('section') as ReportSectionV1,url.searchParams.get('cursor')??undefined));
        else{const report=control.reports.getExact(projectId,id,revision);if(!report)throw new ControlError('REPORT_NOT_FOUND',404);send(200,reportPath[3]==='content'?{html:renderReportMarkdown(report.markdown)}:report);}return;
      }
      const worksPath=path.match(/^\/api\/works\/(defect|suggestion)(?:\/([^/]+)(?:\/(evidence|items|history))?)?$/);
      if(worksPath&&method==='GET'){
        const kind=worksPath[1] as 'defect'|'suggestion',id=worksPath[2]?decodeURIComponent(worksPath[2]):null;
        if(!id)send(200,control.listWorks(principal,projectId,kind,url.searchParams.get('q')??''));
        else if(worksPath[3]==='items')send(200,control.linkedItems(principal,projectId,kind,id));
        else if(worksPath[3]==='history')send(200,control.history(principal,projectId,kind,id));
        else if(worksPath[3])send(200,control.evidence(principal,projectId,kind,id,{...(url.searchParams.has('reportId')?{reportId:url.searchParams.get('reportId')!,revision:Number(url.searchParams.get('revision'))}:{}),...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')!}:{} )}));
        else send(200,control.work(principal,projectId,kind,id));return;
      }
      if(path==='/api/actions/token'&&method==='POST'){const body=await readJSON(req);send(200,{token:control.issueActionToken(principal,projectId,body as unknown as StatusCommand)});return;}
      if(path==='/api/actions'&&method==='POST'){const body=await readJSON(req);send(200,control.executeAction(principal,projectId,body.request as StatusCommand,String(body.token),'web',String(body.interactionId)));return;}
      if(path==='/api/corrections/token'&&method==='POST'){const body=await readJSON(req);send(200,{token:control.correctionToken(principal,projectId,body as unknown as CorrectionCommand)});return;}
      if(path==='/api/corrections'&&method==='POST'){const body=await readJSON(req);send(200,control.correct(principal,projectId,body.request as CorrectionCommand,String(body.token),String(body.interactionId)));return;}
      throw new ControlError('NOT_FOUND',404);
    }catch(error){const e=error instanceof ControlError?error:new ControlError(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'INTERNAL_ERROR',500);if(!res.headersSent)send(e.status,{error:e.code});else res.end();}
  });
  return server;
}
async function readJSON(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(!(req.headers['content-type']??'').startsWith('application/json'))throw new ControlError('JSON_REQUIRED',415);
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>64_000)throw new ControlError('REQUEST_TOO_LARGE',413);chunks.push(Buffer.from(chunk));}
  try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}catch{throw new ControlError('INVALID_JSON');}
}
