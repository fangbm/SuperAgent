import { m3Fixture } from './m3-helpers.mjs';
import { ReportService, reportWindow } from '@superagent/reporting';
import { ControlPlane, OperatorAuth, TokenService } from '@superagent/control-plane';
import { binding } from './helpers.mjs';
export const accessKey='fixture-operator-key-at-least-32-characters';
export const readerKey='fixture-reader-key-at-least-32-characters';
export async function m5Fixture(t,options={}){
  const f=await m3Fixture(t,options);const store=f.runtime.store;
  const reports=new ReportService(store,f.domain,f.runtime.queue,{clock:f.clock,recipients:['developer']});
  const auth=new OperatorAuth(store,f.clock);auth.register({actorRef:'developer',role:'developer',projects:[binding.projectId]},accessKey);auth.register({actorRef:'reader',role:'reader',projects:[binding.projectId]},readerKey);
  const tokens=new TokenService(store,'fixture-cursor-signing-key-32-characters',f.clock);const control=new ControlPlane(store,f.domain,reports,auth,tokens,f.clock);
  const principal=auth.principal('developer'),reader=auth.principal('reader');
  const generate=()=>{f.setTime('2026-11-02T10:04:00.000Z');return reports.generate(reportWindow(binding.projectId,'2026-11-02T10:00:00.000Z'));};
  return{...f,reports,auth,tokens,control,principal,reader,generate};
}
