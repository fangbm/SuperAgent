import assert from 'node:assert/strict';
import test from 'node:test';
import {QQAPI,validateQQMenu} from '@superagent/qq-official';
import {fixture} from './helpers.mjs';
import {readSecret} from './qq-helpers.mjs';
import {createQQMenuManager} from '../../scripts/qq-menu-service.mjs';
const desired={items:[{name:'待办',type:'send_message',send_message:'/pending'},{name:'新增',type:'send_message',send_message:'/recent'},{name:'报告',type:'send_message',send_message:'/reports'},{name:'更多',type:'menu',sub_menu_items:[{name:'全部 Bug',type:'send_message',send_message:'/all-bugs'},{name:'全部建议',type:'send_message',send_message:'/all-suggestions'},{name:'Steam差评',type:'send_message',send_message:'/steam-negative'},{name:'Web工作台',type:'send_message',send_message:'/web'}]}]};
function setup(t){const f=fixture(t),calls=[],remote={version:1,menu:{items:[]}},behavior={timeout:false};const api=new QQAPI(readSecret,{fetch:async(url,init)=>{
  const path=new URL(url).pathname;if(path==='/app/getAppAccessToken')return Response.json({access_token:'fixture',expires_in:7200});assert.equal(path,'/v2/menu');calls.push({method:init.method??'GET',body:init.body?JSON.parse(init.body):undefined});
  if(init.method==='PUT'){remote.menu=JSON.parse(init.body).menu;remote.version=(remote.version??0)+1;if(behavior.timeout)throw new Error('CONTROLLED_CONNECTION_LOSS');return Response.json({version:remote.version});}return Response.json(remote);
}});return{...f,remote,calls,behavior,manager:createQQMenuManager({store:f.runtime.store,api,appRef:'fixture-app',clock:f.clock})};}
test('official menu shape validates four entries, submenu and platform name/type/URL restrictions',()=>{
  assert.equal(validateQQMenu(desired).items.length,4);
  for(const menu of [{items:Array(11).fill(desired.items[0])},{items:[{name:'太长太长太长',type:'send_message',send_message:'/pending'}]},{items:[{name:'more',type:'menu',sub_menu_items:[{name:'nested',type:'menu',sub_menu_items:[]}]}]},{items:[{name:'web',type:'link',link:'https://example.com/?admin_token=secret'}]},{items:[{name:'web',type:'link',link:'http://example.com'}]}])assert.throws(()=>validateQQMenu(menu));
});
test('read/plan/diff/dry-run never PUT; missing or altered approval refuses global update',async t=>{
  const f=setup(t),plan=await f.manager.plan(desired);assert.equal(plan.dryRun,true);assert.equal(plan.diff.changed,true);assert.deepEqual(plan.before.menu,{items:[]});assert.ok(f.calls.every(c=>c.method==='GET'));
  await assert.rejects(f.manager.apply(plan),/QQ_MENU_APPROVAL_REQUIRED/);await assert.rejects(f.manager.apply({...plan,desired:{items:[]}},plan.approvalHash),/QQ_MENU_APPROVAL_REQUIRED/);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
  await assert.rejects(f.manager.apply({...plan,diff:{changed:false,before:plan.before.menu,after:plan.before.menu}},plan.approvalHash),/QQ_MENU_APPROVAL_REQUIRED/);
});
test('approved plan saves backup before single PUT, is idempotent, and restores using a newly reviewed plan',async t=>{
  const f=setup(t),plan=await f.manager.plan(desired);assert.equal((await f.manager.apply(plan,plan.approvalHash)).state,'succeeded');assert.equal((await f.manager.apply(plan,plan.approvalHash)).state,'already_applied');
  const backup=f.manager.backup()[0];assert.deepEqual(JSON.parse(backup.before_json).menu,{items:[]});assert.deepEqual(f.calls.find(c=>c.method==='PUT').body,{menu:desired});
  f.advance(16000);const restore=await f.manager.plan(JSON.parse(backup.before_json).menu);await f.manager.apply(restore,restore.approvalHash);assert.deepEqual(f.remote.menu,{items:[]});assert.equal(f.calls.filter(c=>c.method==='PUT').length,2);
});
test('changed baseline and expired plan cannot overwrite a newer global menu',async t=>{
  const f=setup(t),plan=await f.manager.plan(desired);f.remote.version++;await assert.rejects(f.manager.apply(plan,plan.approvalHash),/QQ_MENU_BASELINE_CHANGED/);f.advance(600001);await assert.rejects(f.manager.apply(plan,plan.approvalHash),/QQ_MENU_APPROVAL_REQUIRED/);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
});
test('real untouched menu without version can be planned, but later configuration invalidates approval',async t=>{
  const f=setup(t);delete f.remote.version;f.remote.menu={};
  const plan=await f.manager.plan(desired);assert.equal(plan.before.version,null);assert.deepEqual(plan.before.menu,{items:[]});
  f.remote.version=1;f.remote.menu=desired;
  await assert.rejects(f.manager.apply(plan,plan.approvalHash),/QQ_MENU_BASELINE_CHANGED/);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
});
test('unversioned nonempty or malformed menu responses cannot be approved',async t=>{
  const f=setup(t);delete f.remote.version;
  for(const menu of [desired,{unexpected:true},[],false]){f.remote.menu=menu;await assert.rejects(f.manager.current(),/QQ_MENU_INVALID_RESPONSE/);}
  delete f.remote.menu;await assert.rejects(f.manager.current(),/QQ_MENU_INVALID_RESPONSE/);
  f.remote.menu={};f.remote.version=null;await assert.rejects(f.manager.current(),/QQ_MENU_INVALID_RESPONSE/);
});
test('approved untouched-menu plan applies once and can be read back after version assignment',async t=>{
  const f=setup(t);delete f.remote.version;f.remote.menu={};const plan=await f.manager.plan(desired);
  assert.equal((await f.manager.apply(plan,plan.approvalHash)).state,'succeeded');assert.deepEqual(await f.manager.current(),{version:1,menu:desired});assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('GET normalizes platform-added read-only icons without relaxing writable menu validation',async t=>{
  const f=setup(t);f.remote.menu=structuredClone(desired);f.remote.menu.items[0].icon='https://example.com/icon.png';f.remote.menu.items[3].sub_menu_items[0].icon='https://example.com/sub.png';
  assert.deepEqual((await f.manager.current()).menu,desired);assert.equal((await f.manager.plan(desired)).diff.changed,false);assert.throws(()=>validateQQMenu(f.remote.menu),/QQ_MENU_INVALID/);
  f.remote.menu.items[0].unexpected=true;await assert.rejects(f.manager.current(),/QQ_MENU_INVALID/);
});
test('lost PUT response persists unknown; reopen/replay never repeats PUT and GET reconciliation resolves actual success',async t=>{
  const f=setup(t),plan=await f.manager.plan(desired);f.behavior.timeout=true;await assert.rejects(f.manager.apply(plan,plan.approvalHash),/REQUIRES_RECONCILIATION/);assert.equal(f.manager.backup()[0].state,'unknown');
  await assert.rejects(f.manager.apply(plan,plan.approvalHash),/REQUIRES_RECONCILIATION/);assert.equal((await f.manager.reconcile(plan.approvalHash)).state,'succeeded');assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('menu update frequency limit survives a new manager and failures do not stop M1',async t=>{
  const f=setup(t),plan=await f.manager.plan(desired);await f.manager.apply(plan,plan.approvalHash);const second=await f.manager.plan({items:[]});await assert.rejects(f.manager.apply(second,second.approvalHash),/QQ_MENU_RATE_LIMITED/);
  for(let n=0;n<30;n++)try{await f.manager.current();}catch{}await assert.rejects(f.manager.current(),/QQ_MENU_RATE_LIMITED/);assert.doesNotThrow(()=>f.runtime.tick());
});
