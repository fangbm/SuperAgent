/** A denial never uses report/domain data. Claim before send; duplicate/unknown is never resent. */
export function qqMenuDenial({runtime,plugin,host,enabled,allowWrites,clock=()=>new Date().toISOString()}){
  return async request=>{
    if(!enabled||!allowWrites)return;
    const {identity,actor,openid,reply}=request;
    if(!identity||!actor||!openid||!reply?.messageId&&!reply?.eventId)throw new Error('QQ_DENIAL_CONTEXT_REQUIRED');
    const now=clock(),cutoff=new Date(Date.parse(now)-60000).toISOString();
    const claimed=runtime.store.transaction(()=>{
      if(runtime.store.get('SELECT 1 FROM qq_menu_denials WHERE identity=?',identity))return false;
      if(runtime.store.get('SELECT count(*) n FROM qq_menu_denials WHERE actor=? AND created_at>?',actor,cutoff).n>=3||runtime.store.get('SELECT count(*) n FROM qq_menu_denials WHERE created_at>?',cutoff).n>=30)return false;
      runtime.store.run("INSERT INTO qq_menu_denials VALUES(?,?,'in_flight',?)",identity,actor,now);return true;
    });
    if(!claimed)return;
    try{await plugin.denyMenuAccess(openid,reply,host);runtime.store.run("UPDATE qq_menu_denials SET state='accepted' WHERE identity=?",identity);}
    catch{runtime.store.run("UPDATE qq_menu_denials SET state='unknown' WHERE identity=?",identity);}
  };
}
