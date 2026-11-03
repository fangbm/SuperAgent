import { readFileSync } from 'node:fs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && !!value.trim();
const platformKinds = ['qq-official', 'discord', 'steam-reviews', 'steam-discussions'];
const keys = ['schemaVersion', 'database', 'projectId', 'sources', 'plugins', 'analysis', 'web', 'githubWrite', 'pollMs'];

/** Trusted composition configuration. Platform configuration never determines source policies. */
export function parseCoreConfig(input) {
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key)) || input.schemaVersion !== 1
    || !text(input.database) || !text(input.projectId) || !Array.isArray(input.sources) || !Array.isArray(input.plugins)) throw new Error('INVALID_CORE_CONFIG');
  const result = structuredClone(input);
  result.analysis ??= { enabled: false }; result.web ??= { enabled: false }; result.githubWrite ??= false; result.pollMs ??= 1000;
  if (!object(result.analysis) || Object.keys(result.analysis).some(key => key !== 'enabled') || typeof result.analysis.enabled !== 'boolean'
    || !object(result.web) || Object.keys(result.web).some(key => !['enabled', 'port', 'accessConfig'].includes(key)) || typeof result.web.enabled !== 'boolean'
    || (result.web.port !== undefined && (!Number.isInteger(result.web.port) || result.web.port < 0 || result.web.port > 65535))
    || (result.web.accessConfig !== undefined && !text(result.web.accessConfig)) || typeof result.githubWrite !== 'boolean'
    || !Number.isInteger(result.pollMs) || result.pollMs < 10 || result.pollMs > 60000) throw new Error('INVALID_CORE_CONFIG');
  const sourceIds = new Set(), uris = new Set();
  for (const source of result.sources) {
    if (!object(source) || Object.keys(source).some(key => !['projectId', 'sourceId', 'sourceUri', 'platform', 'policy'].includes(key))
      || !['projectId', 'sourceId', 'sourceUri'].every(key => text(source[key])) || !platformKinds.includes(source.platform)
      || !URL.canParse(source.sourceUri) || sourceIds.has(source.sourceId) || uris.has(source.sourceUri)
      || !object(source.policy) || Object.keys(source.policy).some(key => !['visibility', 'processingMode'].includes(key))
      || !['public', 'staff'].includes(source.policy.visibility) || !['standard', 'archive_only'].includes(source.policy.processingMode)
      || source.policy.visibility === 'staff' && source.policy.processingMode !== 'archive_only') throw new Error('INVALID_CORE_SOURCE');
    sourceIds.add(source.sourceId); uris.add(source.sourceUri);
  }
  const used = new Set();
  for (const plugin of result.plugins) {
    if (!object(plugin) || Object.keys(plugin).some(key => !['kind', 'config', 'sourceId', 'privateSourceId', 'protectedConfig', 'port'].includes(key))
      || ![...platformKinds, 'discord-community'].includes(plugin.kind) || !(text(plugin.config) || object(plugin.config))
      || !text(plugin.sourceId) || (plugin.protectedConfig !== undefined && !text(plugin.protectedConfig))
      || (plugin.port !== undefined && (!Number.isInteger(plugin.port) || plugin.port < 0 || plugin.port > 65535))
      || (plugin.privateSourceId !== undefined && plugin.kind !== 'discord-community')) throw new Error('INVALID_CORE_PLUGIN');
    for (const id of [plugin.sourceId, ...(plugin.kind === 'discord-community' ? [plugin.privateSourceId] : [])]) {
      const source = result.sources.find(entry => entry.sourceId === id);
      if (!source || used.has(id) || source.platform !== (plugin.kind === 'discord-community' ? 'discord' : plugin.kind)) throw new Error('INVALID_CORE_PLUGIN_BINDING');
      used.add(id);
    }
    if (plugin.kind === 'discord-community') {
      const publicSource = result.sources.find(source => source.sourceId === plugin.sourceId);
      const privateSource = result.sources.find(source => source.sourceId === plugin.privateSourceId);
      if (publicSource.policy.visibility !== 'public' || privateSource.policy.visibility !== 'staff'
        || publicSource.projectId === privateSource.projectId) throw new Error('INVALID_CORE_PLUGIN_BINDING');
    }
  }
  return result;
}
export const readCoreConfig = filename => parseCoreConfig(JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')));
export const readPlatformConfig = value => typeof value === 'string' ? JSON.parse(readFileSync(value, 'utf8').replace(/^\uFEFF/, '')) : structuredClone(value);
