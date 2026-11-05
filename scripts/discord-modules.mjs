import { DiscordModuleHost } from '@superagent/plugin-host';
import { stableId } from '@superagent/persistence';

export function prepareDiscordModules(runtime,config,owner){
  const specs=new Map();
  for(const entry of config.sources.filter(e=>e.enabled&&e.plugin==='discord')){
    const tickets=entry.config.tickets;
    if(tickets?.enabled){
      if(!tickets.projectId||tickets.projectId===config.projectId)throw new Error('DISCORD_PRIVATE_PROJECT_REQUIRED');
      const binding={namespace:stableId('discord-tickets',config.projectId,entry.id),kind:'tickets',guildId:entry.config.guildId,projectId:tickets.projectId,publicProjectId:config.projectId,sourceId:entry.id+':tickets',sourceUri:'urn:superagent:source:discord-tickets:'+encodeURIComponent(entry.id)};
      if(config.sources.some(e=>e.id===binding.sourceId||e.config.sourceUri===binding.sourceUri))throw new Error('DISCORD_PRIVATE_SOURCE_CONFLICT');
      // Register binding, quarantine and feature metadata as one startup transaction.
      runtime.store.transaction(()=>{
        runtime.ingress.registerSource({...binding,platform:'discord'});
        const host=new DiscordModuleHost(runtime.store,binding,{assertOwner:()=>owner.assert()});host.revoke();
      });
      specs.set(entry.id,{tickets:binding});
    }
    if(entry.config.voice?.enabled){
      const binding={namespace:stableId('discord-voice',config.projectId,entry.id),kind:'voice',guildId:entry.config.guildId,projectId:config.projectId,publicProjectId:config.projectId,sourceId:entry.id+':voice',sourceUri:'urn:superagent:module:discord-voice:'+encodeURIComponent(entry.id)};
      if(config.sources.some(e=>e.id===binding.sourceId))throw new Error('DISCORD_MODULE_SOURCE_CONFLICT');
      const host=new DiscordModuleHost(runtime.store,binding,{assertOwner:()=>owner.assert()});host.revoke();specs.set(entry.id,{...specs.get(entry.id),voice:binding});
    }
  }
  return {bind(entry,plugin){
    const definitions=specs.get(entry.id);if(!definitions)return;
    if(typeof plugin.bindModules!=='function')throw new Error('DISCORD_MODULE_HOST_REQUIRED');
    const modules={};
    for(const [name,binding] of Object.entries(definitions)){
      const scope={projectId:binding.projectId,sourceId:binding.sourceId};
      const host=new DiscordModuleHost(runtime.store,binding,{assertOwner:()=>owner.assert(),...(binding.kind==='tickets'?{commit:events=>runtime.ingress.commitBatch(scope,events),getEvent:id=>runtime.ingress.getEvent(binding.projectId,id)?.event}:{})});
      modules[name]={port:host.port(),receive:p=>host.receive(p),next:()=>host.next(),fail:(...args)=>host.fail(...args),revoke:()=>host.revoke()};
    }
    plugin.bindModules(modules);
  }};
}
