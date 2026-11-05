import { readFileSync } from 'node:fs';
import path from 'node:path';
import { builtinSources } from './source-registry.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && !!v.trim();
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
export const readJSON = filename => JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));

/** One application config; all file paths resolve against its directory, not process cwd. */
export function parseApplicationConfig(input, directory = process.cwd(), registry=builtinSources) {
  if (!exact(input, ['schemaVersion','database','projectId','sources','deliveries','analysis','embeddings','github','reports','web','runtime','notifications','artifacts'])
    || input.schemaVersion !== 1 || !text(input.database) || !text(input.projectId)
    || !Array.isArray(input.sources) || !Array.isArray(input.deliveries)) throw new Error('INVALID_APPLICATION_CONFIG');
  const c = structuredClone(input);
  c.database = path.resolve(directory, c.database);
  c.analysis ??= { enabled:false, allowExternalCalls:false };
  c.embeddings ??= { enabled:false, allowExternalCalls:false };
  c.github ??= { enabled:false, allowWrites:false };
  c.reports ??= { enabled:true }; c.web ??= { enabled:false };
  c.notifications ??= { p0Enabled:false };
  c.artifacts??={enabled:true,root:path.join(path.dirname(c.database),'artifacts'),keyEnv:'SA_ARTIFACT_KEY'};
  if(!exact(c.artifacts,['enabled','root','keyEnv','maxBytes','maxFilesPerMessage','maxTotalBytes','ticketTtlMs','timeoutMs','dnsMode'])||typeof c.artifacts.enabled!=='boolean'||c.artifacts.dnsMode!==undefined&&!['system','aliyun-doh'].includes(c.artifacts.dnsMode)||c.artifacts.enabled&&(!text(c.artifacts.root)||!text(c.artifacts.keyEnv)||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.artifacts.keyEnv)))throw new Error('INVALID_ARTIFACT_CONFIG');
  for(const [key,min,max] of [['maxBytes',1,10485760],['maxFilesPerMessage',1,20],['maxTotalBytes',1,1073741824],['ticketTtlMs',1000,300000],['timeoutMs',100,30000]])if(c.artifacts[key]!==undefined&&!integer(c.artifacts[key],min,max))throw new Error('INVALID_ARTIFACT_CONFIG');
  if(c.artifacts.root)c.artifacts.root=path.resolve(directory,c.artifacts.root);
  c.runtime = { pollMs:1000, probeIntervalMs:30000, healthGraceMs:60000, maxRestarts:3, backoffMs:1000, maxBackoffMs:30000, stopTimeoutMs:10000,recoveryIntervalMs:900000,recoveryJitterRatio:0.2,stableResetMs:3600000, ...c.runtime };
  if (!exact(c.analysis, ['enabled','allowExternalCalls','baseURL','model','baseURLEnv','modelEnv','apiKeyEnv','allowLoopbackHTTP','timeoutMs','maxCalls','maxInputCharacters'])
    || typeof c.analysis.enabled !== 'boolean' || typeof c.analysis.allowExternalCalls !== 'boolean'
    || c.analysis.enabled && (!c.analysis.allowExternalCalls || !(text(c.analysis.baseURL)||text(c.analysis.baseURLEnv)) || !(text(c.analysis.model)||text(c.analysis.modelEnv)))
    || ['baseURLEnv','modelEnv','apiKeyEnv'].some(key=>c.analysis[key]!==undefined&&(!text(c.analysis[key])||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.analysis[key])))
    || !exact(c.github, ['enabled','allowWrites','repository','tokenEnv','baseURL','allowLoopbackHTTP','attachmentUploads'])
    || typeof c.github.enabled !== 'boolean' || typeof c.github.allowWrites !== 'boolean'
    || c.github.allowWrites && !c.github.enabled
    || c.github.enabled && (!/^[\w.-]+\/[\w.-]+$/.test(c.github.repository??'') || !text(c.github.tokenEnv))
    || !exact(c.reports,['enabled']) || typeof c.reports.enabled !== 'boolean'
    || !exact(c.web,['enabled','port','accessConfig','accessKeyEnv','signingKeyEnv']) || typeof c.web.enabled !== 'boolean'
    || c.web.port !== undefined && !integer(c.web.port,0,65535)
    || !exact(c.notifications,['p0Enabled','evaluationTimeoutMs']) || typeof c.notifications.p0Enabled !== 'boolean'
    || c.notifications.evaluationTimeoutMs!==undefined&&!integer(c.notifications.evaluationTimeoutMs,100,60000)) throw new Error('INVALID_APPLICATION_SERVICES');
  if(!exact(c.embeddings,['enabled','allowExternalCalls','baseURL','model','baseURLEnv','modelEnv','apiKeyEnv','allowLoopbackHTTP','timeoutMs','batchSize'])
    ||typeof c.embeddings.enabled!=='boolean'||typeof c.embeddings.allowExternalCalls!=='boolean'
    ||c.embeddings.enabled&&(!c.embeddings.allowExternalCalls||!(text(c.embeddings.baseURL)||text(c.embeddings.baseURLEnv))||!(text(c.embeddings.model)||text(c.embeddings.modelEnv)))
    ||['baseURLEnv','modelEnv','apiKeyEnv'].some(k=>c.embeddings[k]!==undefined&&(!text(c.embeddings[k])||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.embeddings[k])))
    ||c.embeddings.timeoutMs!==undefined&&!integer(c.embeddings.timeoutMs,100,60000)
    ||c.embeddings.batchSize!==undefined&&!integer(c.embeddings.batchSize,1,64)
    ||c.embeddings.allowLoopbackHTTP!==undefined&&typeof c.embeddings.allowLoopbackHTTP!=='boolean')throw new Error('INVALID_EMBEDDING_CONFIG');
  if(c.notifications.p0Enabled&&!c.analysis.enabled)throw new Error('P0_ANALYSIS_REQUIRED');
  const limits = {pollMs:[10,60000],probeIntervalMs:[10,3600000],healthGraceMs:[0,3600000],maxRestarts:[0,20],backoffMs:[1,60000],maxBackoffMs:[1,3600000],stopTimeoutMs:[10,120000],recoveryIntervalMs:[300000,86400000],stableResetMs:[60000,86400000]};
  if (!exact(c.runtime,[...Object.keys(limits),'recoveryJitterRatio']) || Object.entries(limits).some(([k,[a,b]])=>!integer(c.runtime[k],a,b))
    ||typeof c.runtime.recoveryJitterRatio!=='number'||!Number.isFinite(c.runtime.recoveryJitterRatio)||c.runtime.recoveryJitterRatio<0.1||c.runtime.recoveryJitterRatio>0.5
    || c.runtime.maxBackoffMs<c.runtime.backoffMs) throw new Error('INVALID_APPLICATION_RUNTIME');
  for (const [key,a,b] of [['timeoutMs',1,300000],['maxCalls',1,100],['maxInputCharacters',100,1000000]]) {
    if(c.analysis[key]!==undefined&&!integer(c.analysis[key],a,b))throw new Error('INVALID_ANALYSIS_PARAMETERS');
  }
  const ids = new Set(), uris = new Set();
  c.github.attachmentUploads??={enabled:c.github.enabled&&c.artifacts.enabled,allowWrites:c.github.enabled&&c.github.allowWrites&&c.artifacts.enabled};
  {const upload=c.github.attachmentUploads;if(!exact(upload,['enabled','allowWrites','tokenEnv','sessionEnv','sessionConfig'])||typeof upload.enabled!=='boolean'||typeof upload.allowWrites!=='boolean'||upload.allowWrites&&(!upload.enabled||!c.github.allowWrites)||upload.enabled&&(!c.github.enabled||!c.artifacts.enabled)||['tokenEnv','sessionEnv'].some(k=>upload[k]!==undefined&&(!text(upload[k])||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(upload[k])))||upload.sessionConfig!==undefined&&(!text(upload.sessionConfig)||upload.sessionEnv!==undefined))throw new Error('INVALID_GITHUB_ATTACHMENT_CONFIG');if(upload.sessionConfig)upload.sessionConfig=path.resolve(directory,upload.sessionConfig);else if(!upload.sessionEnv)upload.sessionConfig=path.join(path.dirname(c.database),'github-upload-session.dpapi');}
  for (const entry of [...c.sources,...c.deliveries]) {
    const source = c.sources.includes(entry);
    if (!exact(entry,['id','plugin','enabled','config','permissions','secrets','protectedConfig','port','allowWrites'])
      || !text(entry.id) || ids.has(entry.id) || typeof entry.enabled !== 'boolean'
      || !(source?registry.has(entry.plugin):entry.plugin==='qq-c2c')
      || !(text(entry.config)||object(entry.config))
      || !exact(entry.permissions,['networkHosts','secretKeys'])
      || !['networkHosts','secretKeys'].every(k=>Array.isArray(entry.permissions[k])&&entry.permissions[k].every(text)&&new Set(entry.permissions[k]).size===entry.permissions[k].length)
      || !object(entry.secrets??{}) || Object.entries(entry.secrets??{}).some(([k,v])=>!entry.permissions.secretKeys.includes(k)||!text(v)||!/^\w+$/.test(v))
      || entry.protectedConfig!==undefined&&!text(entry.protectedConfig)
      || entry.port!==undefined&&!integer(entry.port,0,65535)
      || source&&entry.allowWrites!==undefined || !source&&typeof entry.allowWrites!=='boolean') throw new Error('INVALID_APPLICATION_PLUGIN');
    ids.add(entry.id);
    if (entry.protectedConfig) entry.protectedConfig=path.resolve(directory,entry.protectedConfig);
    const configFile=typeof entry.config==='string'?path.resolve(directory,entry.config):null;
    let platform=configFile?readJSON(configFile):entry.config;
    if(!object(platform))throw new Error('INVALID_PLATFORM_CONFIG');
    if(source){
      if(entry.plugin==='qq-official'&&platform.captureAttachments===undefined)platform={...platform,captureAttachments:c.artifacts.enabled};
      const definition=registry.get(entry.plugin);
      if(definition.normalize)platform=definition.normalize(platform,{entry,directory:configFile?path.dirname(configFile):directory});
      if(!text(platform.sourceUri)||!URL.canParse(platform.sourceUri)||uris.has(platform.sourceUri))throw new Error('INVALID_SOURCE_URI');
      uris.add(platform.sourceUri);
    }else if(platform.projectId!==c.projectId||platform.recipientRef!=='qq-developer')throw new Error('DELIVERY_BINDING_MISMATCH');
    if(!source&&platform.operatorMenu!==undefined){
      const menu=platform.operatorMenu;
      if(!exact(menu,['enabled','autoDeploy','defaultRecentHours','webURL'])||typeof menu.enabled!=='boolean'||menu.autoDeploy!==undefined&&menu.autoDeploy!==false||menu.defaultRecentHours!==undefined&&!integer(menu.defaultRecentHours,1,168)||menu.webURL!==undefined&&!text(menu.webURL))throw new Error('QQ_MENU_CONFIG_INVALID');
      if(menu.webURL){const url=new URL(menu.webURL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('QQ_MENU_INVALID_WEB_URL');}
    }
    entry.config=platform;
    if(source&&entry.enabled&&platform.captureAttachments===true&&!c.artifacts.enabled)throw new Error('ARTIFACT_STORE_REQUIRED');
  }
  // Existing M5 supports one approved developer C2C binding per application project.
  if(c.deliveries.filter(e=>e.enabled).length>1)throw new Error('MULTIPLE_DELIVERY_BINDINGS_NOT_SUPPORTED');
  const discordCredentials=new Set();
  for(const entry of c.sources.filter(e=>e.enabled&&e.plugin==='discord')){
    const name=entry.secrets?.[entry.config.tokenSecret??'DISCORD_BOT_TOKEN'];
    if(name&&discordCredentials.has(name))throw new Error('DISCORD_DUPLICATE_GATEWAY_CREDENTIAL');if(name)discordCredentials.add(name);
  }
  if(c.web.accessConfig)c.web.accessConfig=path.resolve(directory,c.web.accessConfig);
  return c;
}
export function loadApplicationConfig(filename) { return parseApplicationConfig(readJSON(filename),path.dirname(path.resolve(filename))); }
