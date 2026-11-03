import { parseArgs } from 'node:util';
import { runM4Source } from './core-legacy.mjs';
const { values } = parseArgs({ options: { connector: { type: 'string' }, config: { type: 'string' }, database: { type: 'string' },
  project: { type: 'string' }, source: { type: 'string' }, once: { type: 'boolean', default: false }, probe: { type: 'boolean', default: false },
  'archive-only': { type: 'boolean', default: false } } });
try { await runM4Source(values); } catch (error) {
  const code = error instanceof Error ? error.message.split(':')[0] : '';
  console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'CONNECTOR_FAILED'); process.exitCode = 1;
}
