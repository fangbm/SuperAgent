import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';
import { TrustedSourceRegistry } from '@superagent/plugin-host';

/** The main program owns one archive/runtime; platform adapters receive scoped hosts only. */
export function openCoreStore(config, options = {}) {
  const filename = path.resolve(config.database);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const policy = options.policy ?? JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
  const runtime = new M1Runtime(filename, { policy, ...(options.clock ? { clock: options.clock } : {}) });
  try {
    const registry = new TrustedSourceRegistry(runtime.ingress, config.sources);
    registry.apply();
    return { runtime, registry, filename, close: () => runtime.close() };
  } catch (error) { runtime.close(); throw error; }
}
