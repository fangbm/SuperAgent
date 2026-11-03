import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderReportMarkdown } from '@superagent/web-console';

const parse=markdown=>parseHTML(`<main>${renderReportMarkdown(markdown)}</main>`).document.querySelector('main');

test('Web report Markdown renders structured headings, lists, emphasis, links and literal code',()=>{
  const root=parse('# 半日报\n\n## Bug\n\n**崩溃**与*建议*\n\n- 联机\n  - Windows\n\n3. 复现\n4. 修复\n\n> 引用\n\n[文档](https://example.com/docs) 与 `a < b`\n\n```js\n<script>原样代码</script>\n```\n\n***');
  assert.equal(root.querySelector('h1').textContent,'半日报');assert.equal(root.querySelector('h2').textContent,'Bug');assert.equal(root.querySelector('strong').textContent,'崩溃');assert.equal(root.querySelector('em').textContent,'建议');assert.equal(root.querySelector('ul ul li').textContent.trim(),'Windows');assert.equal(root.querySelector('ol').getAttribute('start'),'3');assert.equal(root.querySelector('blockquote').textContent.trim(),'引用');assert.equal(root.querySelector('pre code').textContent,'<script>原样代码</script>\n');assert.ok(root.querySelector('hr'));
  const link=root.querySelector('a');assert.equal(link.getAttribute('href'),'https://example.com/docs');assert.equal(link.getAttribute('rel'),'noopener noreferrer');assert.equal(link.getAttribute('target'),'_blank');assert.equal(root.querySelector('script'),null);
});

test('Web Markdown treats HTML as text, blocks active URLs and never embeds untrusted images',()=>{
  const root=parse('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)></svg>\n\n[js](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [data](data:text/html,hello) [file](file:///private)\n\n![玩家图片](https://attacker.invalid/track) [bad](https://user:pass@example.com/)\n\n[正常](https://example.com/?q=%22test%22)');
  assert.equal(root.querySelector('script,img,svg,iframe,style,object'),null);assert.match(root.textContent,/<script>alert\(1\)<\/script>/);assert.match(root.textContent,/玩家图片/);assert.equal(root.querySelectorAll('a').length,1);
  const tags=new Set(['MAIN','P','A']);for(const node of root.querySelectorAll('*')){assert.ok(tags.has(node.tagName));for(const attr of node.attributes)assert.ok(['href','target','rel'].includes(attr.name));}
  assert.equal(root.querySelector('a').textContent,'正常');
});
