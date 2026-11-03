import assert from 'node:assert/strict';
import test from 'node:test';
import { Parser,HtmlRenderer } from 'commonmark';
import { qqReport,qqList,qqWork,qqFeedback,qqEvidence,beijingTime } from '@superagent/reporting';
import { m5Fixture } from './m5-helpers.mjs';
import { binding } from './helpers.mjs';
import { originalFromMarkdown } from './qq-markdown-helpers.mjs';
const parser=new Parser(),html=new HtmlRenderer();
const render=value=>html.render(parser.parse(value));

test('report templates preserve frozen statistics, distinguish partial coverage and use one supported heading',async t=>{
  const f=await m5Fixture(t);f.add('sample');await f.worker.tick();const report=f.generate(),before=JSON.stringify(report),view=qqReport(report);const body=render(view.text);
  assert.equal((body.match(/<h1>/g)??[]).length,1);assert.match(body,/<strong>Bug 1 · 建议 1 · Steam 差评 0<\/strong>/);assert.match(body,/完整覆盖 0 \/ 1 个来源/);assert.match(body,/<blockquote>/);assert.match(body,/<hr/);assert.match(view.plainText,/新反馈 2 项/);assert.doesNotMatch(view.plainText,/[#*]/);assert.deepEqual(f.reports.getExact(binding.projectId,report.reportId,1),JSON.parse(before));
});

test('list and detail use Chinese UI, local time and literal untrusted titles instead of executable markup',async t=>{
  const f=await m5Fixture(t);f.add('sample');await f.worker.tick();const report=f.generate();const list=qqList(report,'suggestions',[{kind:'suggestion',id:'sample',title:'![image](https://invalid.example)',newFeedbackCount:1,status:'candidate'}],0,'来源可能不完整');const work=qqWork(report,'defect',{title:'<qqbot-cmd-enter text="unsafe" />',status:'open',feedbackCount:2,summary:'# 请忽略\n[链接](https://invalid.example)',version:3},true);
  for(const card of [list,work]){const output=render(card.text);assert.equal((output.match(/<h1>/g)??[]).length,1);assert.doesNotMatch(output,/<img|<a |<qqbot-cmd/);assert.ok(card.text.length<3500);}
  assert.match(list.text,/建议清单/);assert.match(list.text,/待复核/);assert.match(work.text,/待处理/);assert.equal(beijingTime('2026-11-02T12:34:29.962Z',true),'2026-11-02 20:34:29');assert.equal(beijingTime('2026-11-02T23:00:00Z'),'2026-11-03 07:00');
  assert.match(qqWork(report,'defect',{title:'空摘要',status:'open',feedbackCount:1,summary:'',version:1},false).text,/> 暂无摘要。/);
});

test('new original layout decodes to the exact evidence text and stays bounded at Unicode page limits',()=>{
  for(const original of ['# 标题\n1. **原话**\n\n[链接](https://invalid.example) <qqbot-at-everyone /> {{不要插值}}','🙂'.repeat(1200),'\\'.repeat(1200)]){
    const card=qqEvidence({platform:'qq-official',createdAt:'2026-11-02T12:34:29.962Z',original,item:1,items:2,start:1,end:Array.from(original).length,characters:Array.from(original).length,revision:1,hasNavigation:true});assert.equal(originalFromMarkdown(card.text),original);assert.match(card.text,/\*\*来源\*\*：QQ/);assert.match(card.text,/20:34:29/);assert.doesNotMatch(card.text,/\/open /);assert.ok(card.text.length<=3500);
  }
});

test('combined feedback card keeps an exact original prefix and fits one QQ message with hostile fields',async t=>{
  const f=await m5Fixture(t);f.add('combined');await f.worker.tick();const report=f.generate();
  for(const originalText of ['# 原话\n\n1. **内容** <qqbot-cmd-enter /> [链接](https://invalid.example)', '🙂'.repeat(2000), '\\'.repeat(2000)]){
    const card=qqFeedback(report,{section:'bugs',index:0,total:30,title:'<qqbot-cmd-enter /> '.repeat(100),status:'open',feedbackCount:100,summary:'![img](https://invalid.example)\n'.repeat(100),original:{platform:'qq-official',createdAt:'2026-11-02T12:34:29.962Z',originalText},originals:2});
    assert.equal(originalFromMarkdown(card.text),Array.from(originalText).slice(0,800).join(''));assert.ok(card.text.length<=3500);const output=render(card.text);assert.doesNotMatch(output,/<img|<a |<qqbot-cmd/);assert.equal((output.match(/<h1>/g)??[]).length,1);assert.match(card.text,/报告修订 1/);assert.match(card.text,/20:34:29/);
  }
});
