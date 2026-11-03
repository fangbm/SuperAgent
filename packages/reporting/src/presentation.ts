import { readFileSync } from 'node:fs';
import type { ReportV2, ReportSectionV1, ReportNavigationEntryV1 } from '@superagent/contracts';

export interface QQMessageView {title:string;text:string;bodyIncludesTitle:true}
const templates=Object.fromEntries(['report','list','list-work-item','list-steam-item','work','evidence','notice'].map(name=>[name,readFileSync(new URL(`../templates/qq/${name}.md`,import.meta.url),'utf8').replace(/\r\n/g,'\n').trim()]));
const clip=(text:string,limit:number)=>{const chars=Array.from(text);return chars.length>limit?chars.slice(0,limit).join('')+'…':text;};
/** Escape presentation data without altering the underlying source text. */
export const qqLiteral=(value:string):string=>value.replace(/[\\`*_{}\[\]()<>!#|~+\-&]/g,'\\$&').replace(/^(\s*\d+)\./gm,'$1\\.').replace(/\n/g,'\\\n');
const inline=(value:string,limit=100)=>qqLiteral(clip(value.replace(/[\r\n]/g,' '),limit));
export function beijingTime(value:string,seconds=false):string{const time=Date.parse(value);return Number.isFinite(time)?new Date(time+8*3_600_000).toISOString().slice(0,seconds?19:16).replace('T',' '):'时间未知';}
const windowText=(report:ReportV2)=>`${beijingTime(report.window.startInclusive)} — ${beijingTime(report.window.endExclusive)}`;
const fill=(name:string,data:Record<string,string|number>):string=>templates[name]!.replace(/\{\{([A-Za-z]+)\}\}/g,(_,key:string)=>{const value=data[key];if(value===undefined)throw new Error('QQ_TEMPLATE_VALUE_MISSING');return String(value);});
const view=(name:string,title:string,data:Record<string,string|number>):QQMessageView=>({title,text:fill(name,data),bodyIncludesTitle:true});
const statuses:Record<string,string>={candidate:'待复核',open:'待处理',investigating:'调查中',fixed:'已修复',verified:'已验证',dismissed:'已忽略',merged:'已合并',reviewing:'评审中',accepted:'已接受',planned:'已计划',in_progress:'进行中',implemented:'已实现',declined:'已拒绝',archived:'已归档'};
export const qqStatus=(value:string):string=>statuses[value]??'状态待确认';
export const qqActionLabel=(value:string):string=>({investigate:'开始调查',fix:'标记修复',verify:'验证完成',reopen:'重新打开',dismiss:'忽略问题',review:'开始评审',accept:'接受建议',plan:'加入计划',start:'开始实现',implement:'标记已实现',decline:'拒绝建议',archive:'归档'} as Record<string,string>)[value]??'更新状态';
const sectionLabels:Record<ReportSectionV1,string>={bugs:'Bug 清单',suggestions:'建议清单',steam_negative_reviews:'Steam 差评'};
export function qqReport(report:ReportV2):QQMessageView&{plainText:string}{
  const full=report.coverage.filter(c=>c.status==='full').length;
  return{...view('report','社区反馈半日报',{window:windowText(report),bugs:report.counts.uniqueDefects,suggestions:report.counts.uniqueSuggestions,steam:report.steamNegativeReviews.length,feedback:report.counts.newFeedbackItems,pending:report.counts.pendingAnalysis,events:report.uniqueSourceEventCount,fullSources:full,sources:report.coverage.length,revision:report.revision,cutoff:beijingTime(report.snapshotCutoffAt)}),plainText:[`${windowText(report)} · 北京时间`,`Bug ${report.counts.uniqueDefects} · 建议 ${report.counts.uniqueSuggestions} · Steam 差评 ${report.steamNegativeReviews.length}`,`新反馈 ${report.counts.newFeedbackItems} 项 · 待分析 ${report.counts.pendingAnalysis} 项`,`来源事件 ${report.uniqueSourceEventCount} 条`,`完整覆盖 ${full}/${report.coverage.length} 个来源，仅统计已接入来源。`,`已归档 · 修订 ${report.revision}`].join('\n')};
}
export function qqList(report:ReportV2,section:ReportSectionV1,entries:readonly ReportNavigationEntryV1[],offset:number,coverage:string):QQMessageView{
  const total=section==='bugs'?report.issueIds.length:section==='suggestions'?report.suggestionIds.length:report.steamNegativeReviews.length;
  const rows=entries.map((entry,i)=>entry.kind==='steam_negative_review'?fill('list-steam-item',{number:i+1,time:beijingTime(entry.occurredAt,true),change:entry.updatedInWindow?'本期更新':'本期新增'}):fill('list-work-item',{number:i+1,title:inline(entry.title),feedback:entry.newFeedbackCount,status:entry.kind==='suggestion'?` · ${qqStatus(entry.status)}`:''}));
  return view('list',sectionLabels[section],{heading:sectionLabels[section],window:windowText(report),revision:report.revision,page:Math.floor(offset/3)+1,pages:Math.max(1,Math.ceil(total/3)),entries:rows.join('\n\n')||'本期暂无此类记录。',coverage:inline(coverage,180),hint:entries.length?'点击下方按钮查看详情或切换栏目。':'可使用下方按钮查看其他栏目。'});
}
export function qqWork(report:ReportV2,kind:'defect'|'suggestion',work:{title:string;status:string;feedbackCount:number;summary:string;version:number},canAct:boolean):QQMessageView{
  const summary=work.summary.trim()?qqLiteral(clip(work.summary,500)).split('\n').map(line=>'> '+line).join('\n'):'> 暂无摘要。';
  return view('work',kind==='defect'?'Bug 详情':'建议详情',{heading:kind==='defect'?'Bug 详情':'建议详情',title:inline(work.title),status:qqStatus(work.status),feedback:work.feedbackCount,summary:summary||'> 暂无摘要。',hint:canAct?'点击下方按钮查看玩家原文或更新处理状态。':'点击「查看原文」阅读玩家的完整反馈。',version:work.version,revision:report.revision});
}
export function qqEvidence(input:{platform:string;createdAt:string;original:string;item:number;items:number;start:number;end:number;characters:number;revision:number;hasNavigation:boolean}):QQMessageView{
  const platform=({'qq-official':'QQ',discord:'Discord','steam-reviews':'Steam 评价','steam-discussions':'Steam 讨论区'} as Record<string,string>)[input.platform]??'社区来源';
  return view('evidence','玩家原文',{platform,item:input.item,items:input.items,time:beijingTime(input.createdAt,true),original:qqLiteral(input.original),start:input.start,end:input.end,characters:input.characters,revision:input.revision,hint:input.hasNavigation?'使用下方按钮切换原文或继续阅读。':'本条原文已完整展示。'});
}
export const qqNotice=(title:string,message:string,hint=''):QQMessageView=>view('notice',title,{heading:inline(title),message:qqLiteral(message),hint:qqLiteral(hint)});
