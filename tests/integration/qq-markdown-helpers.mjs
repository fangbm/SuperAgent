import assert from 'node:assert/strict';
import { Parser } from 'commonmark';
const parser=new Parser();
export function originalFromMarkdown(markdown){
  const root=parser.parse(markdown);let node=root.firstChild;
  while(node){if(node.type==='heading'&&node.level===2&&node.firstChild?.literal==='原始反馈')break;node=node.next;}
  assert.ok(node,'original section must be present');let result='';
  for(node=node.next;node&&node.type!=='thematic_break';node=node.next){const walker=node.walker();let event;while((event=walker.next()))if(event.entering){assert.ok(!['link','image','html_inline','html_block','emph','strong','code_block'].includes(event.node.type),'original must remain literal text');if(event.node.type==='text')result+=event.node.literal;if(['linebreak','softbreak'].includes(event.node.type))result+='\n';}}
  return result;
}
