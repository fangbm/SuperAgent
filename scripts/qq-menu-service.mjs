import {createHash} from 'node:crypto';
import {canonicalJSON,ensureQQFeatures} from '@superagent/persistence';
import {validateQQMenu} from '@superagent/qq-official';
const hash=v=>createHash('sha256').update(canonicalJSON(v)).digest('hex');
const safe=e=>e&&/^[A-Z][A-Z0-9_]+$/.test(e.code??e.message)?e.code??e.message:'QQ_MENU_REQUEST_FAILED';
export function createQQMenuManager({store,api,appRef,clock=()=>new Date().toISOString()}){
  ensureQQFeatures(store);
  const slot=method=>store.transaction(()=>{
    const now=clock(),cutoff=new Date(Date.parse(now)-60000).toISOString();
    store.run('DELETE FROM qq_menu_calls WHERE created_at<?',cutoff);
    const rows=store.all('SELECT created_at FROM qq_menu_calls WHERE app_ref=? AND method=? AND created_at>=? ORDER BY created_at DESC',appRef,method,cutoff);
    if(rows.length>=(method==='PUT'?4:30)||method==='PUT'&&rows[0]&&Date.parse(now)-Date.parse(rows[0].created_at)<15000)throw new Error('QQ_MENU_RATE_LIMITED');
    store.run('INSERT INTO qq_menu_calls VALUES(?,?,?)',appRef,method,now);
  });
  const current=async()=>{
    slot('GET');const response=await api.getMenu();
    // An untouched real Bot returns {menu:{}} without a version. Only this
    // empty baseline may be unversioned; configured menus still require one.
    const empty=response.menu==null||typeof response.menu==='object'&&!Array.isArray(response.menu)&&Object.keys(response.menu).length===0;
    const unversioned=response.version===undefined&&Object.hasOwn(response,'menu')&&empty;
    const version=unversioned?null:response.version;
    if(version!==null&&(!Number.isInteger(version)||version<0))throw new Error('QQ_MENU_INVALID_RESPONSE');
    if(version===null&&!unversioned)throw new Error('QQ_MENU_INVALID_RESPONSE');
    // QQ adds read-only icons to GET results even though they are not part of
    // the documented writable menu. Ignore that decoration, not other fields.
    const item=value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('QQ_MENU_INVALID_RESPONSE');
      const {icon,...rest}=value;
      if(icon!==undefined&&typeof icon!=='string')throw new Error('QQ_MENU_INVALID_RESPONSE');
      return{...rest,...(Array.isArray(rest.sub_menu_items)?{sub_menu_items:rest.sub_menu_items.map(item)}:{})};
    };
    const menu=!empty&&Array.isArray(response.menu?.items)?{...response.menu,items:response.menu.items.map(item)}:response.menu;
    return{version,menu:validateQQMenu(empty?{items:[]}:menu)};
  };
  const plan=async desired=>{
    desired=validateQQMenu(desired);const before=await current(),createdAt=clock();
    const value={appRef,before,desired,createdAt,expiresAt:new Date(Date.parse(createdAt)+600000).toISOString()};
    return{...value,approvalHash:hash(value),diff:{changed:hash(before.menu)!==hash(desired),before:before.menu,after:desired},dryRun:true};
  };
  const apply=async(p,approval)=>{
    const {appRef:target,before,desired,createdAt,expiresAt}=p;const value={appRef:target,before,desired,createdAt,expiresAt};
    if(target!==appRef||typeof approval!=='string'||approval!==hash(value)||approval!==p.approvalHash||!Number.isFinite(Date.parse(expiresAt))||expiresAt<=clock())throw new Error('QQ_MENU_APPROVAL_REQUIRED');
    validateQQMenu(desired);validateQQMenu(before.menu);
    if(canonicalJSON(p.diff)!==canonicalJSON({changed:hash(before.menu)!==hash(desired),before:before.menu,after:desired}))throw new Error('QQ_MENU_APPROVAL_REQUIRED');
    const old=store.get('SELECT state FROM qq_menu_deployments WHERE operation_id=?',approval);
    if(old){if(old.state==='succeeded')return{state:'already_applied',operationId:approval};throw new Error('QQ_MENU_OUTCOME_REQUIRES_RECONCILIATION');}
    const live=await current();if(live.version!==before.version||hash(live.menu)!==hash(before.menu))throw new Error('QQ_MENU_BASELINE_CHANGED');
    store.transaction(()=>{slot('PUT');store.run("INSERT INTO qq_menu_deployments VALUES(?,?,?,?,?,'in_flight',NULL)",approval,appRef,clock(),canonicalJSON(before),canonicalJSON(desired));});
    try{const response=await api.putMenu(desired);if(!Number.isInteger(response.version)||response.version<0)throw new Error('QQ_MENU_RESPONSE_UNKNOWN');store.run("UPDATE qq_menu_deployments SET state='succeeded' WHERE operation_id=?",approval);return{state:'succeeded',operationId:approval,version:response.version};}
    catch(error){store.run("UPDATE qq_menu_deployments SET state=?,error_code=? WHERE operation_id=?",error.outcome==='blocked'||error.outcome==='rejected'?'blocked':'unknown',safe(error),approval);throw new Error('QQ_MENU_OUTCOME_REQUIRES_RECONCILIATION');}
  };
  const reconcile=async id=>{const op=store.get('SELECT * FROM qq_menu_deployments WHERE operation_id=? AND app_ref=?',id,appRef);if(!op)throw new Error('QQ_MENU_OPERATION_NOT_FOUND');const live=await current();const matched=hash(live.menu)===hash(JSON.parse(op.desired_json));if(matched)store.run("UPDATE qq_menu_deployments SET state='succeeded',error_code=NULL WHERE operation_id=?",id);return{state:matched?'succeeded':'manual_review',operationId:id,current:live};};
  return{current,plan,apply,reconcile,backup:()=>store.all('SELECT * FROM qq_menu_deployments WHERE app_ref=? ORDER BY created_at DESC LIMIT 100',appRef)};
}
