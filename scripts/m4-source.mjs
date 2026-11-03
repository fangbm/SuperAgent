import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';

const { values } = parseArgs({ options: {
  connector: { type: 'string' }, config: { type: 'string' }, database: { type: 'string' },
  project: { type: 'string' }, source: { type: 'string' }, once: { type: 'boolean', default: false }, probe: { type: 'boolean', default: false },
  'archive-only': { type: 'boolean', default: false },
} });
const constructors = { discord: DiscordConnector, 'steam-reviews': SteamReviewsConnector, 'steam-discussions': SteamDiscussionsConnector };
if (!Object.hasOwn(constructors, values.connector ?? '') || !values.config) throw new Error('Usage: pnpm source:m4 --connector discord|steam-reviews|steam-discussions --config <JSON> [--probe | --database <SQLite> --project <id> --source <id> [--once] [--archive-only]]');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const plugin = new constructors[values.connector](config);
if (values.probe) {
  console.log(JSON.stringify(await plugin.probe()));
  await plugin.stop();
} else {
  if (!values.database || !values.project?.trim() || !values.source?.trim()) throw new Error('database, project and source are required');
  const filename = path.resolve(values.database);
  mkdirSync(path.dirname(filename), { recursive: true });
  const policy = JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
  const runtime = new M1Runtime(filename, { policy });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let worker;
  try {
    runtime.ingress.registerSource({ projectId: values.project, sourceId: values.source, sourceUri: config.sourceUri, platform: values.connector });
    const host = runtime.ingress.sourceHost({ projectId: values.project, sourceId: values.source }, {
      secretKeys: plugin.manifest.permissions.secretKeys,
      getSecret: async key => { const secret = process.env[key]; if (!secret) throw new Error('UNAUTHORIZED'); return secret; },
    });
    if (values.once) {
      await plugin.sync(host, controller.signal);
      if (!values['archive-only']) runtime.tick();
      // Do not print source text, credentials or checkpoint contents.
      console.log(JSON.stringify({ capability: await plugin.probe(), metrics: runtime.metrics() }));
    } else {
      if (values['archive-only']) await plugin.start(host, controller.signal);
      else {
        worker = runtime.run(controller.signal);
        await Promise.race([plugin.start(host, controller.signal), worker]);
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    console.error(/^(UNAUTHORIZED|PERMISSION_DENIED|RATE_LIMITED|PLATFORM_UNAVAILABLE|INVALID_CONFIG|INVALID_EVENT|INVALID_CHECKPOINT|TRANSIENT_NETWORK|UNSUPPORTED_CAPABILITY|SOURCE_IDENTITY_CONFLICT)$/.test(code) ? code : 'CONNECTOR_FAILED');
    process.exitCode = 1;
  } finally {
    controller.abort(); await plugin.stop(); await worker;
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); runtime.close();
  }
}
