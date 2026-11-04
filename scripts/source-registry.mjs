import path from 'node:path';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector, SteamReviewCommentsConnector } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { QQSource } from '@superagent/qq-official';
import {qqFeedbackConfig} from '@superagent/ingress';
import { initializeSteamReviewComments, initializePublicSteamDiscussions } from './steam-review-comments-state.mjs';

/** Only trusted application code supplies registrations; JSON cannot name executable modules. */
export function createSourceRegistry(definitions) {
  const entries=new Map(Object.entries(definitions).map(([key,value])=>{
    if(!/^[a-z][a-z0-9-]*$/.test(key)||!value||typeof value.factory!=='function'||typeof value.id!=='string'
      ||typeof value.platform!=='string'||!['background','blocking'].includes(value.mode)
      ||['configure','normalize','initialize','unavailableCode','stability'].some(k=>value[k]!==undefined&&typeof value[k]!=='function'))throw new Error('INVALID_SOURCE_REGISTRATION');
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
    initialize:({runtime,entry,binding})=>runtime.ingress.configureQQFeedback(binding,entry.config.feedbackCommands??{enabled:false}),
    normalize:(config,{entry})=>{if(config.feedbackCommands!==undefined)qqFeedbackConfig(config.feedbackCommands);if((config.transport??'webhook')==='webhook'&&entry.enabled&&entry.port===undefined)throw new Error('QQ_WEBHOOK_PORT_REQUIRED');return config;},
    stability:(config,health)=>({confirmed:config.transport==='websocket'&&/^QQ_GATEWAY_(?:CONNECTED|HEARTBEAT_ACK)/.test(health.reason??''),interrupted:health.coverage==='unavailable',maxGapMs:300000}),
  },
  discord:{factory:c=>new DiscordConnector(c),id:'superagent.discord',platform:'discord',mode:'blocking',
    stability:(_config,health)=>({confirmed:/^DISCORD_GATEWAY_(?:CONNECTED|HEARTBEAT_ACK)$/.test(health.reason??''),interrupted:health.coverage==='unavailable'||/^(?:Gateway (?:disconnected|session lost)|DISCORD_POLL_INTERRUPTED)/.test(health.reason??''),maxGapMs:300000})},
  'steam-reviews':{factory:c=>new SteamReviewsConnector(c),id:'superagent.steam-reviews',platform:'steam-reviews',mode:'blocking',
    stability:(config,health)=>({confirmed:health.coverage==='partial'&&/^Review scan (?:completed|incomplete)/.test(health.reason??''),interrupted:health.coverage==='unavailable'||/^STEAM_REVIEWS_POLL_INTERRUPTED/.test(health.reason??''),maxGapMs:Math.max(60000,3*(config.pollIntervalMs??60000))})},
  'steam-discussions':{
    factory:c=>new SteamDiscussionsConnector(c,{passiveProbe:true}),id:'superagent.steam-discussions',platform:'steam-discussions',mode:'blocking',
    initialize:initializePublicSteamDiscussions,
    normalize:(config,{directory})=>({...config,...(config.snapshotPath?{snapshotPath:path.resolve(directory,config.snapshotPath)}:{})}),
    unavailableCode:config=>!['snapshot','public'].includes(config.mode)?'UNSUPPORTED_CAPABILITY':null,
    stability:(config,health)=>({confirmed:config.mode==='snapshot'&&health.coverage==='partial'&&/^Operator snapshot committed/.test(health.reason??''),interrupted:health.coverage==='unavailable',maxGapMs:Math.max(60000,3*(config.pollIntervalMs??60000))}),
  },
  'steam-review-comments':{
    factory:c=>new SteamReviewCommentsConnector(c,{passiveProbe:true}),id:'superagent.steam-review-comments',platform:'steam-reviews',mode:'blocking',
    initialize:initializeSteamReviewComments,
  },
});
