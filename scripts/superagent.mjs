import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readCoreConfig } from './core-config.mjs';
import { createCore, validateCoreConfiguration } from './core-runtime.mjs';

export async function runCore(config, options = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const control = message => { if (message?.type === 'stop') stop(); }; process.on('message', control);
  let app;
  try {
    app = await createCore(config, { ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
    if (!options.quiet) console.log(JSON.stringify({ state: 'starting', owner: 'core', projectId: config.projectId,
      analysis: config.analysis?.enabled ? 'enabled' : 'disabled', plugins: config.plugins.length }));
    const result = await app.run(options);
    if (options.once || options.setupOnly) console.log(JSON.stringify(result));
    return result;
  } finally {
    controller.abort(); await app?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('message', control);
    if (process.connected) process.disconnect();
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, database: { type: 'string' },
    once: { type: 'boolean', default: false }, setup: { type: 'boolean', default: false }, 'check-config': { type: 'boolean', default: false } } });
  if (!values.config || values.once && values.setup) throw new Error('INVALID_ARGUMENTS');
  const config = readCoreConfig(values.config);
  if (values.database) config.database = values.database;
  if (values['check-config']) { validateCoreConfiguration(config); console.log(JSON.stringify({ valid: true, owner: 'core', projectId: config.projectId, sources: config.sources.length, plugins: config.plugins.length })); return; }
  return runCore(config, { once: values.once, setupOnly: values.setup });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'CORE_FAILED'); process.exitCode = 1;
  }
}
