import { mkdirSync,writeFileSync } from 'node:fs';
import { Parser,HtmlRenderer } from 'commonmark';
import { qqReport,qqList,qqWork,qqEvidence } from '@superagent/reporting';
import { createDemo } from './m5-demo-data.mjs';
const directory='.artifacts/qq-template-preview';mkdirSync(directory,{recursive:true});
const app=await createDemo(':memory:');
try{
  const report=app.reports.list('starport-demo',1)[0];if(!report)throw new Error('DEMO_REPORT_MISSING');
  const bugs=app.reports.section(report.window.projectId,report.reportId,1,'bugs').entries;
  const suggestions=app.reports.section(report.window.projectId,report.reportId,1,'suggestions').entries;
  const steam=app.reports.section(report.window.projectId,report.reportId,1,'steam_negative_reviews').entries;
  const work=app.domain.getWork(report.window.projectId,'defect',report.issueIds[0]);const evidence=app.domain.evidence(report.window.projectId,work.evidence[0].eventId);
  const cards=[['report',qqReport(report),['查看 Bug','查看建议','Steam 差评']],['bugs',qqList(report,'bugs',bugs,0,'仅展示已接入来源；空列表不表示没有反馈。'),['详情 1','详情 2','详情 3']],['suggestions',qqList(report,'suggestions',suggestions,0,'仅展示已接入来源；空列表不表示没有反馈。'),['详情 1','详情 2','详情 3']],['steam',qqList(report,'steam_negative_reviews',steam,0,'仅展示已接入来源；空列表不表示没有反馈。'),['原文 1']],['work',qqWork(report,'defect',work,true),['查看原文','开始调查','标记修复']],['evidence',qqEvidence({platform:evidence.event.data.platform,createdAt:evidence.event.time,original:evidence.text,item:1,items:work.evidence.length,start:1,end:Array.from(evidence.text).length,characters:Array.from(evidence.text).length,revision:1,hasNavigation:work.evidence.length>1}),['下一条原文']]];
  const parser=new Parser(),renderer=new HtmlRenderer({safe:true});const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const html=cards.map(([name,card,buttons])=>{writeFileSync(`${directory}/${name}.md`,card.text+'\n');return `<article><span class="label">${escape(name)}</span>${renderer.render(parser.parse(card.text))}<footer>${buttons.map(label=>`<button type="button" disabled>${escape(label)}</button>`).join('')}</footer></article>`;}).join('');
  writeFileSync(`${directory}/index.html`,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 模板排版预览</title><style>body{margin:0;padding:32px;background:#121619;color:#e6edf1;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:auto}aside{color:#a8b5bd;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px}article{background:#20272c;border:1px solid #36434b;border-radius:18px;padding:26px;overflow-wrap:anywhere}.label{font-size:12px;color:#8ab7c9}h1{font-size:24px;margin:8px 0 20px}h2{font-size:18px;margin:20px 0 12px}p{white-space:pre-wrap}blockquote{border-left:3px solid #69b9ba;margin:16px 0;padding-left:14px;color:#b7cbd2}hr{border:0;border-top:1px solid #405058;margin:24px 0}strong{color:#fff}footer{display:flex;gap:8px;flex-wrap:wrap;padding-top:16px}button{border:1px solid #60a9b1;background:#263e45;color:#b4e5ea;border-radius:8px;padding:8px 12px;opacity:1}</style><main><aside>离线排版预览 · 合成数据 · 按钮仅示意 · 未向 QQ 发送。实际 QQ 渲染需另行验收。</aside><div class="grid">${html}</div></main></html>`);
  console.log(JSON.stringify({directory,cards:cards.length,externalWrites:false,renderer:'CommonMark offline preview; not QQ client verification'}));
}finally{app.runtime.close();}
