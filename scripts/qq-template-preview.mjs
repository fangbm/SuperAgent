import { mkdirSync,writeFileSync } from 'node:fs';
import { Parser,HtmlRenderer } from 'commonmark';
import { QQOperatorService } from '@superagent/control-plane';
import { createDemo } from './m5-demo-data.mjs';
const directory='.artifacts/qq-template-preview';mkdirSync(directory,{recursive:true});
const app=await createDemo(':memory:');
try{
  const report=app.reports.list('starport-demo',1)[0];if(!report)throw new Error('DEMO_REPORT_MISSING');
  const actor='qq-preview';app.control.auth.register({actorRef:actor,role:'reader',projects:[report.window.projectId]},'offline-qq-preview-key-at-least-32-characters');
  const qq=new QQOperatorService(app.control,{projectId:report.window.projectId,actorRef:actor,recipientRef:actor,clock:app.clock});let sequence=0;
  const query=(kind,content)=>{qq.receive({interactionId:`preview-${sequence++}`,kind,content,reply:kind==='command'?{messageId:'offline'}:{eventId:'INTERACTION_CREATE:offline'}});const result=qq.tick();const row=app.runtime.store.get('SELECT request_json,message_options_json FROM operator_reply_plans WHERE delivery_id=?',result.deliveryId);return{...JSON.parse(row.request_json),buttons:JSON.parse(row.message_options_json).buttons};};
  const overview=query('command','/reports'),bug=query('button',overview.buttons.find(b=>b.label==='查看 Bug').token),next=query('button',bug.buttons.find(b=>b.label==='下一条').token),suggestion=query('button',overview.buttons.find(b=>b.label==='查看建议').token),steam=query('button',overview.buttons.find(b=>b.label==='查看 Steam 差评').token);
  let evidenceCard=bug;while(!evidenceCard.buttons.some(b=>b.label==='下一条原文')){const forward=evidenceCard.buttons.find(b=>b.label==='下一条');if(!forward)throw new Error('DEMO_MULTI_ORIGINAL_CARD_MISSING');evidenceCard=query('button',forward.token);}
  const original=query('button',evidenceCard.buttons.find(b=>b.label==='下一条原文').token);
  const cards=[['report',overview],['bugs',bug],['bugs-next',next],['suggestions',suggestion],['steam',steam],['evidence',original]].map(([name,card])=>[name,card,card.buttons.map(b=>b.label)]);
  const parser=new Parser(),renderer=new HtmlRenderer({safe:true});const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const html=cards.map(([name,card,buttons])=>{writeFileSync(`${directory}/${name}.md`,card.text+'\n');return `<article><span class="label">${escape(name)}</span>${renderer.render(parser.parse(card.text))}<footer>${buttons.map(label=>`<button type="button" disabled>${escape(label)}</button>`).join('')}</footer></article>`;}).join('');
  writeFileSync(`${directory}/index.html`,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 模板排版预览</title><style>body{margin:0;padding:32px;background:#121619;color:#e6edf1;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:auto}aside{color:#a8b5bd;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px}article{background:#20272c;border:1px solid #36434b;border-radius:18px;padding:26px;overflow-wrap:anywhere}.label{font-size:12px;color:#8ab7c9}h1{font-size:24px;margin:8px 0 20px}h2{font-size:18px;margin:20px 0 12px}p{white-space:pre-wrap}blockquote{border-left:3px solid #69b9ba;margin:16px 0;padding-left:14px;color:#b7cbd2}hr{border:0;border-top:1px solid #405058;margin:24px 0}strong{color:#fff}footer{display:flex;gap:8px;flex-wrap:wrap;padding-top:16px}button{border:1px solid #60a9b1;background:#263e45;color:#b4e5ea;border-radius:8px;padding:8px 12px;opacity:1}</style><main><aside>离线排版预览 · 合成数据 · 按钮仅示意 · 未向 QQ 发送。实际 QQ 渲染需另行验收。</aside><div class="grid">${html}</div></main></html>`);
  console.log(JSON.stringify({directory,cards:cards.length,externalWrites:false,renderer:'CommonMark offline preview; not QQ client verification'}));
}finally{app.runtime.close();}
