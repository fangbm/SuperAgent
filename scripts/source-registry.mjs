import path from 'node:path';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { QQSource } from '@superagent/qq-official';

/** Only trusted application code supplies registrations; JSON cannot name executable modules. */
export function createSourceRegistry(definitions) {
  const entries=new Map(Object.entries(definitions).map(([key,value])=>{
    if(!/^[a-z][a-z0-9-]*$/.test(key)||!value||typeof value.factory!=='function'||typeof value.id!=='string'
      ||typeof value.platform!=='string'||!['background','blocking'].includes(value.mode)
      ||['configure','normalize','unavailableCode'].some(k=>value[k]!==undefined&&typeof value[k]!=='function'))throw new Error('INVALID_SOURCE_REGISTRATION');
    return [key,Object.freeze({...value})];
  }));
  return Object.freeze({
    get(key){const value=entries.get(key);if(!value)throw new Error('UNKNOWN_SOURCE_PLUGIN');return value;},
    has:key=>entries.has(key),
  });
}
export const builtinSources=createSourceRegistry({
  'qq-official':{
    factory:c=>new QQSource(c),id:'qq-official-source',platform:'qq-official',mode:'background',
    configure:(config,{operator})=>({...config,...(operator?{operator}:{})}),
    normalize:(config,{entry})=>{if((config.transport??'webhook')==='webhook'&&entry.enabled&&entry.port===undefined)throw new Error('QQ_WEBHOOK_PORT_REQUIRED');return config;},
  },
  discord:{factory:c=>new DiscordConnector(c),id:'superagent.discord',platform:'discord',mode:'blocking'},
  'steam-reviews':{factory:c=>new SteamReviewsConnector(c),id:'superagent.steam-reviews',platform:'steam-reviews',mode:'blocking'},
  'steam-discussions':{
    factory:c=>new SteamDiscussionsConnector(c),id:'superagent.steam-discussions',platform:'steam-discussions',mode:'blocking',
    normalize:(config,{directory})=>({...config,...(config.snapshotPath?{snapshotPath:path.resolve(directory,config.snapshotPath)}:{})}),
    unavailableCode:config=>config.mode!=='snapshot'?'UNSUPPORTED_CAPABILITY':null,
  },
});
