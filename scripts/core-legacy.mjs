import { readFileSync } from 'node:fs';
import { createCore, createSourcePlugin } from './core-runtime.mjs';
import { readCoreConfig } from './core-config.mjs';
import { environmentSecret } from './qq-secrets.mjs';
import { runCore } from './superagent.mjs';

export const defaultCoreConfig = 'community/idle-abyss-princesses/core-config.json';

/** Old bot command now delegates ownership to the main program's explicit source configuration. */
export async function runBot(botConfig, database, options = {}) {
  environmentSecret(botConfig.tokenSecret, options.env ?? process.env);
  const config = typeof options.coreConfig === 'object' ? structuredClone(options.coreConfig) : readCoreConfig(options.coreConfig ?? defaultCoreConfig);
  config.database = database;
  const entry = config.plugins.find(plugin => plugin.kind === 'discord-community');
  if (!entry) throw new Error('CORE_COMMUNITY_CONFIGURATION_REQUIRED');
  entry.config = botConfig;
  return runCore(config, options);
}

/** Legacy source flags are trusted Core command-line configuration, never plugin policy setters. */
export async function runM4Source(values) {
  if (!['discord', 'steam-reviews', 'steam-discussions'].includes(values.connector) || !values.config) throw new Error('INVALID_ARGUMENTS');
  const platform = JSON.parse(readFileSync(values.config, 'utf8'));
  if (values.probe) {
    const plugin = createSourcePlugin(values.connector, platform);
    try { console.log(JSON.stringify(await plugin.probe())); } finally { await plugin.stop(); }
    return;
  }
  if (!values.database || !values.project?.trim() || !values.source?.trim()) throw new Error('DATABASE_PROJECT_SOURCE_REQUIRED');
  const source = { projectId: values.project, sourceId: values.source, sourceUri: platform.sourceUri, platform: values.connector,
    policy: { visibility: 'public', processingMode: values['archive-only'] ? 'archive_only' : 'standard' } };
  const config = { schemaVersion: 1, database: values.database, projectId: values.project, sources: [source],
    plugins: [{ kind: values.connector, sourceId: source.sourceId, config: platform }], analysis: { enabled: false } };
  if (!values.once) return runCore(config, { processing: !values['archive-only'] });
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let app;
  try {
    app = await createCore(config, { signal: controller.signal });
    await app.run({ once: true, processing: !values['archive-only'] });
    console.log(JSON.stringify({ capability: await app.components[0].instance.probe(), metrics: app.runtime.metrics() }));
  } finally {
    controller.abort(); await app?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
