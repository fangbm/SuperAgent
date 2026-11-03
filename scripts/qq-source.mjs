import { parseArgs } from 'node:util';
import { runQQSource, sourceArgs } from './core-qq.mjs';

const { values } = parseArgs({ options: { ...sourceArgs, port: { type: 'string', default: '8080' } } });
await runQQSource(values);
