import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { M1Runtime } from '@superagent/agent-core';

const { values } = parseArgs({ options: { database: { type: 'string' }, once: { type: 'boolean', default: false }, 'poll-ms': { type: 'string', default: '1000' } } });
if (!values.database) throw new Error('Usage: pnpm worker:m1 --database <local SQLite file> [--once] [--poll-ms 1000]');
const filename = path.resolve(values.database);
mkdirSync(path.dirname(filename), { recursive: true });
const policy = JSON.parse(readFileSync(new URL('../config/batching.default.json', import.meta.url), 'utf8')).feedbackBatching;
const runtime = new M1Runtime(filename, { policy });
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (values.once) console.log(JSON.stringify({ tick: runtime.tick(), metrics: runtime.metrics() }));
  else await runtime.run(controller.signal, { pollIntervalMs: Number(values['poll-ms']), onTick: result => {
    if (Object.values(result).some(value => value > 0)) console.log(JSON.stringify(result));
  } });
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); runtime.close(); }
