import { DiscordModuleHost,discordPacketKey } from '@superagent/plugin-host';
import { DiscordTickets } from '@superagent/connector-discord';
import { fixture } from './helpers.mjs';
export function interaction(id='10001',user='111',action='new',more={}){
  return{type:'INTERACTION_CREATE',sequence:Number(id),sessionId:'module-session',receivedAt:'2026-11-02T00:00:00.000Z',data:{id,guild_id:'100',application_id:'999',token:'fixture-volatile-token',member:{user:{id:user},roles:user==='222'?['500']:[]},type:2,data:{name:'sa-ticket',options:Object.entries({action,...(action==='new'?{kind:'bug',title:'Private bug',body:'Private original crash report'}:{}),...more}).map(([name,value])=>({name,value}))}}};
}
export class CommunityAPI {
  calls=[];channels=new Map();commands=[];next=700;mode='ok';
  constructor(){this.channels.set('400',{id:'400',guild_id:'100',type:4,permission_overwrites:[{id:'100',type:0,deny:'1024',allow:'0'},{id:'999',type:1,allow:'1024',deny:'0'}]});}
  async request(method,route,body,signal){
    signal?.throwIfAborted();this.calls.push({method,route,body});
    if(route==='/users/@me')return{id:'999'};
    if(route==='/gateway/bot')return{url:'wss://gateway.discord.gg/'};
    if(route==='/oauth2/applications/@me')return{id:'999',flags:1<<19};
    if(route==='/guilds/100/roles')return[{id:'100',permissions:'66560'},{id:'500',permissions:'66560'},{id:'600',permissions:String(16n|(1n<<28n)|1024n|65536n|2048n)}];
    if(route.startsWith('/guilds/100/members/')){const id=route.split('/').at(-1);return{user:{id},roles:id==='222'?['500']:id==='999'?['600']:[]};}
    if(route==='/applications/999/guilds/100/commands'){if(method==='POST'){this.commands.push({...body,id:'901'});return this.commands.at(-1);}return this.commands;}
    if(route==='/guilds/100/channels'){
      if(method==='POST'){const id=String(++this.next),channel={...body,id,guild_id:'100'};this.channels.set(id,channel);if(this.mode==='lost_create')throw new Error('OUTCOME_UNKNOWN');return channel;}return [...this.channels.values()];
    }
    const match=route.match(/^\/channels\/(\d+)$/);
    if(match){const channel=this.channels.get(match[1]);if(!channel)throw new Error('NOT_FOUND');if(method==='DELETE'){if(this.mode==='delete_fail')throw new Error('OUTCOME_UNKNOWN');this.channels.delete(match[1]);return null;}return channel;}
    if(route.includes('/permissions/'))return null;
    if(route.includes('/messages?'))return [];
    if(route.endsWith('/messages'))return{id:'9999',channel_id:route.split('/')[2],...body};
    if(route.startsWith('/interactions/')||route.startsWith('/webhooks/'))return null;
    throw new Error('UNEXPECTED_MODULE_ROUTE');
  }
}
export class ModuleSocket extends EventTarget {
  readyState=1;
  constructor(onSend=()=>{}){super();this.onSend=onSend;queueMicrotask(()=>this.receive({op:10,d:{heartbeat_interval:10000}}));}
  receive(p){if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(p)}));}
  dispatch(t,s,d){this.receive({op:0,t,s,d});}
  send(raw){const p=JSON.parse(raw);if(p.op===1)this.receive({op:11});this.onSend(p,this);}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.defineProperty(e,'code',{value:code});queueMicrotask(()=>this.dispatchEvent(e));}
}
export function ticketFixture(t,options={}){
  const f=fixture(t),api=options.api??new CommunityAPI();
  const binding={namespace:'ticket-fixture',kind:'tickets',guildId:'100',projectId:'staff-private',publicProjectId:'game-test',sourceId:'discord-private',sourceUri:'urn:superagent:source:discord-private'};
  const scope={projectId:binding.projectId,sourceId:binding.sourceId};
  f.runtime.ingress.registerSource({...binding,platform:'discord'});
  const makeHost=runtime=>new DiscordModuleHost(runtime.store,binding,{clock:f.clock,assertOwner:()=>{},commit:events=>runtime.ingress.commitBatch(scope,events),getEvent:id=>runtime.ingress.getEvent(binding.projectId,id)?.event});
  let host=makeHost(f.runtime),module=new DiscordTickets('100',{enabled:true,allowWrites:true,projectId:binding.projectId,categoryId:'400',staffRoleIds:['500']},host.port(),api);
  t.after(()=>module.stop());
  const handle=async p=>{host.receive(p);try{await module.handle(p,new AbortController().signal);}catch(error){host.fail(discordPacketKey(p),error.message,true);throw error;}};
  return{...f,api,binding,scope,get host(){return host;},get module(){return module;},handle,tickets:()=>host.list('ticket:'),async restart(){module.stop();host.revoke();f.runtime.close();const runtime=f.open();host=makeHost(runtime);module=new DiscordTickets('100',{enabled:true,allowWrites:true,projectId:binding.projectId,categoryId:'400',staffRoleIds:['500']},host.port(),api);return runtime;},key:discordPacketKey};
}
