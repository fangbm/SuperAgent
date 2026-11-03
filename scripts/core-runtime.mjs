import { chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableCommunityState, CommunitySubmissions } from '@superagent/plugin-host';
import { DiscordConnector } from '@superagent/connector-discord';
import { SteamReviewsConnector } from '@superagent/connector-steam-reviews';
import { SteamDiscussionsConnector } from '@superagent/connector-steam-discussions';
import { QQSource } from '@superagent/qq-official';
import { createConsoleServer } from '@superagent/web-console';
import { openCoreStore } from './core-store.mjs';
import { parseCoreConfig, readPlatformConfig } from './core-config.mjs';
import { environmentSecret, configuredSecrets } from './qq-secrets.mjs';
import { parseBotConfig } from './discord-bot-config.mjs';
import { createDiscordCommunityPlugin } from './discord-community-plugin.mjs';
import { createAnalysisServices } from './m3-services.mjs';
import { createM5 } from './m5-runtime.mjs';
import { createQQWebhookServer } from './qq-webhook.mjs';

const constructors = { discord: DiscordConnector, 'steam-reviews': SteamReviewsConnector, 'steam-discussions': SteamDiscussionsConnector, 'qq-official': QQSource };
export function createSourcePlugin(kind, config) {
  if (!Object.hasOwn(constructors, kind)) throw new Error('INVALID_CORE_PLUGIN');
  return new constructors[kind](config);
}
const scopeOf = binding => ({ projectId: binding.projectId, sourceId: binding.sourceId });
const untilAborted = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
const stateFacade = state => Object.freeze({ get: key => state.get(key), set: (key, value) => state.set(key, value),
  update: (key, reducer) => state.update(key, reducer), list: prefix => state.list(prefix) });

/** Offline validation includes platform configuration and exact Host binding, without opening an archive. */
export function validateCoreConfiguration(input, options = {}) {
  const config = parseCoreConfig(input), env = options.env ?? process.env;
  const prepared = config.plugins.map(entry => {
    const binding = config.sources.find(source => source.sourceId === entry.sourceId);
    const platform = entry.kind === 'discord-community' ? parseBotConfig(readPlatformConfig(entry.config)) : readPlatformConfig(entry.config);
    if (entry.kind === 'discord-community') {
      const privateBinding = config.sources.find(source => source.sourceId === entry.privateSourceId);
      if (platform.projectId !== binding.projectId || platform.privateProjectId !== privateBinding.projectId
        || binding.sourceUri !== `urn:superagent:source:discord:${platform.guildId}:public`
        || privateBinding.sourceUri !== `urn:superagent:source:discord:${platform.guildId}:tickets`) throw new Error('CORE_COMMUNITY_BINDING_MISMATCH');
      if (options.checkCredentials) environmentSecret(platform.tokenSecret, env);
      return { entry, binding, privateBinding, platform };
    }
    if (platform.sourceUri !== binding.sourceUri) throw new Error('CORE_PLUGIN_SOURCE_MISMATCH');
    const factory = options.sourceFactories?.[entry.kind];
    const plugin = factory ? factory(platform) : createSourcePlugin(entry.kind, platform);
    return { entry, binding, platform, plugin };
  });
  return { config, prepared };
}

/** Trusted application composition. Plugins receive bound capabilities, never this owner object. */
export async function createCore(input, options = {}) {
  const { config, prepared } = validateCoreConfiguration(input, { ...options, checkCredentials: true });
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const now = options.clock ?? (() => new Date().toISOString());
  if (config.analysis.enabled && !options.analysisFactory && (!env.SA_LLM_BASE_URL || !env.SA_LLM_MODEL)) throw new Error('LLM_BASE_URL_MODEL_REQUIRED');
  if (config.githubWrite && (!env.SA_GITHUB_REPOSITORY || !env.SA_GITHUB_TOKEN)) throw new Error('GITHUB_WRITE_CONFIGURATION_REQUIRED');
  process.umask(0o077);
  const owner = openCoreStore(config, options);
  const { runtime, registry, filename } = owner;
  const components = [], leases = [], servers = [];
  let services, web, closed = false, failure;
  const fail = error => { failure ??= error; controller.abort(); };
  const assertRunning = () => { signal.throwIfAborted(); };
  try {
    for (const file of [filename, filename + '-wal', filename + '-shm']) if (existsSync(file)) chmodSync(file, 0o600);
    if (config.analysis.enabled) services = (options.analysisFactory ?? createAnalysisServices)(runtime, {
      projectId: config.projectId, env, githubWrite: config.githubWrite,
      domainOptions: { authorizedActors: ['web-developer', 'qq-developer'] },
    });
    if (config.web.enabled) {
      web = await createM5({ database: filename, project: config.projectId, 'access-config': config.web.accessConfig,
        'github-write': config.githubWrite }, signal, { runtime, memory: services?.memory, domain: services?.domain, tickIngress: false });
    }
    for (const item of prepared) {
      const { entry, binding, privateBinding, platform, plugin } = item;
      if (entry.kind === 'discord-community') {
        const namespace = 'discord-community:' + platform.guildId, leaseOwner = randomUUID();
        const state = new DurableCommunityState(runtime.store, namespace, { clock: now, leaseOwner });
        if (!state.acquireLease(leaseOwner, 45000)) throw new Error('BOT_ALREADY_RUNNING');
        const generation = state.getLeaseGeneration();
        let ready = false;
        const assertActive = ({ allowStopping = false } = {}) => {
          if (!allowStopping) assertRunning();
          state.assertLease(generation);
        };
        const writeHealth = () => state.setSync('runtime:health', { mode: ready ? 'run' : 'starting', checkedAt: now(),
          analysis: config.analysis.enabled ? 'enabled' : 'disabled' });
        const lease = { state, leaseOwner, heartbeat: undefined };
        leases.push(lease);
        writeHealth();
        lease.heartbeat = setInterval(() => {
          try { if (!state.renewLease(leaseOwner, 45000)) throw new Error('COMMUNITY_LEASE_LOST'); writeHealth(); }
          catch (error) { fail(error); }
        }, 10000);
        const bind = source => {
          const scope = scopeOf(source);
          const base = registry.sourceHost(scope, { secretKeys: [platform.tokenSecret], getSecret: async key => environmentSecret(key, env) });
          return Object.freeze({ ...base,
            commitBatch: async (events, checkpoint) => runtime.store.transaction(() => { assertActive(); return runtime.ingress.commitBatch(scope, events, checkpoint); }),
            getCheckpoint: async () => { assertActive(); return runtime.ingress.getCheckpoint(scope); },
            reportHealth: async health => { assertActive({ allowStopping: true });
              if (source.sourceId === binding.sourceId && health.coverage === 'unavailable') { ready = false; writeHealth(); }
              runtime.ingress.reportHealth(scope, health); },
          });
        };
        const submissions = new CommunitySubmissions(runtime.ingress, state, { scope: scopeOf(privateBinding), guildId: platform.guildId, clock: now });
        submissions.recover();
        const host = Object.freeze({ publicBinding: registry.binding(scopeOf(binding)), privateBinding: registry.binding(scopeOf(privateBinding)),
          publicArchive: bind(binding), privateArchive: bind(privateBinding), state: stateFacade(state), now, assertActive,
          submitTicket: async event => { assertActive(); return submissions.submitTicket(event); },
          getPrivateEvent: async eventId => { assertActive(); const record = runtime.ingress.getEvent(privateBinding.projectId, eventId);
            return record?.event.data.sourceId === privateBinding.sourceId ? record.event : null; },
          connectionReady: async value => { assertActive(); ready = value; writeHealth(); }, isConnectionReady: () => ready,
        });
        const component = (options.communityFactory ?? createDiscordCommunityPlugin)(platform, host, options.communityOptions);
        components.push({ ...component, kind: entry.kind, sourceId: entry.sourceId, instance: component,
          once: async setupOnly => component.start(signal, { setupOnly, once: true }) });
      } else {
        const read = entry.kind === 'qq-official' ? configuredSecrets({ 'protected-config': entry.protectedConfig }, env) : async key => environmentSecret(key, env);
        const host = registry.sourceHost(scopeOf(binding), { secretKeys: plugin.manifest.permissions.secretKeys, getSecret: read });
        let server;
        components.push({ kind: entry.kind, sourceId: entry.sourceId, instance: plugin,
          start: async () => {
            await plugin.start(host, signal);
            if (entry.kind === 'qq-official' && (platform.transport ?? 'webhook') === 'webhook') {
              server = createQQWebhookServer(plugin, () => runtime.store.get('SELECT coverage,health_reason FROM sources WHERE source_id=?', binding.sourceId));
              servers.push(server);
              await new Promise((resolve, reject) => { server.once('error', reject); server.listen(entry.port ?? 8080, '127.0.0.1', resolve); });
            }
            await untilAborted(signal);
          },
          once: async () => { if (entry.kind === 'qq-official') await plugin.start(host, signal); await plugin.sync(host, signal); },
          stop: () => plugin.stop(),
        });
      }
    }
    const tick = async () => {
      assertRunning();
      const ingress = runtime.tick();
      const analysis = services ? await services.tick(signal) : { analysis: { processed: false, state: 'not_enabled' } };
      const reports = web ? await web.tick() : undefined;
      return { ingress, ...analysis, ...(reports ? { reports } : {}) };
    };
    const close = async () => {
      if (closed) return; closed = true; controller.abort();
      for (const lease of leases) clearInterval(lease.heartbeat);
      await Promise.allSettled(components.map(component => component.stop()));
      await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
      try { await web?.close(); }
      finally {
        try { for (const lease of leases) lease.state.releaseLease(lease.leaseOwner); }
        finally { owner.close(); }
      }
    };
    const run = async ({ once = false, setupOnly = false, processing = true } = {}) => {
      try {
        if (setupOnly || once) {
          const results = [];
          for (const component of components) {
            if (setupOnly && component.kind !== 'discord-community') continue;
            results.push(await component.once(setupOnly));
          }
          if (!setupOnly && processing) await tick();
          return setupOnly ? results : runtime.metrics();
        }
        if (web) {
          const server = createConsoleServer(web.control); servers.push(server);
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.web.port ?? 8787, '127.0.0.1', resolve); });
        }
        const tasks = components.map(component => component.start(signal));
        const processor = (async () => { while (!signal.aborted) { if (processing) await tick(); await delay(config.pollMs, undefined, { signal }); } })();
        await Promise.race([processor, ...tasks]);
        if (failure) throw failure;
      } catch (error) { if (!signal.aborted || failure) throw failure ?? error; }
    };
    return { runtime, registry, components, config, signal, tick, run, close };
  } catch (error) {
    controller.abort();
    for (const lease of leases) clearInterval(lease.heartbeat);
    await Promise.allSettled(components.map(component => component.stop()));
    try { await web?.close(); }
    finally {
      try { for (const lease of leases) lease.state.releaseLease(lease.leaseOwner); }
      finally { owner.close(); }
    }
    throw error;
  }
}
