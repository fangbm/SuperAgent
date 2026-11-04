import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SqliteStore} from '@superagent/persistence';
import {QQAPI} from '@superagent/qq-official';
import {loadApplicationConfig} from './application-config.mjs';
import {secretReader} from './application-plugin-host.mjs';
import {createQQMenuManager} from './qq-menu-service.mjs';
const {values}=parseArgs({options:{config:{type:'string'},delivery:{type:'string'},get:{type:'boolean'},'dry-run':{type:'boolean'},plan:{type:'string'},menu:{type:'string'},restore:{type:'string'},apply:{type:'string'},approve:{type:'string'},reconcile:{type:'string'},backup:{type:'string'}}});
let store;
try{
  if(values['dry-run']&&values.apply)throw new Error('QQ_MENU_DRY_RUN_CANNOT_APPLY');
  if([!!values.get,!!values.reconcile,!!values.apply,!!values.plan||!!values['dry-run']].filter(Boolean).length!==1)throw new Error('QQ_MENU_ONE_ACTION_REQUIRED');
  if(!values.config||!values.delivery)throw new Error('QQ_MENU_CONFIG_AND_DELIVERY_REQUIRED');
  const config=loadApplicationConfig(values.config),entry=config.deliveries.find(e=>e.id===values.delivery&&e.plugin==='qq-c2c');if(!entry)throw new Error('QQ_MENU_DELIVERY_NOT_FOUND');
  const read=secretReader(entry,process.env),appId=await read('QQ_APP_ID');
  store=new SqliteStore(config.database);const manager=createQQMenuManager({store,api:new QQAPI(read),appRef:createHash('sha256').update(appId).digest('hex')});
  const json=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  let result;
  if(values.get)result=await manager.current();
  else if(values.reconcile)result=await manager.reconcile(values.reconcile);
  else if(values.apply)result=await manager.apply(json(values.apply),values.approve);
  else if((values.plan||values['dry-run'])&&(values.menu||values.restore)){
    const desired=values.menu?json(values.menu).menu:json(values.restore).before.menu;
    result=await manager.plan(desired);if(values.plan)writeFileSync(values.plan,JSON.stringify(result,null,2),{flag:'wx'});
  }else throw new Error('QQ_MENU_ACTION_REQUIRED');
  if(values.backup)writeFileSync(values.backup,JSON.stringify(values.get?{before:result}:manager.backup(),null,2),{flag:'wx'});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(error.code??error.message)?error.code??error.message:'QQ_MENU_COMMAND_FAILED')+'\n');process.exitCode=1;}finally{store?.close();}
