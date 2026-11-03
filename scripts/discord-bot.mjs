import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBotConfig, botInstallUrl } from './discord-bot-config.mjs';
import { runBot } from './core-legacy.mjs';
import { botStatus } from './core-status.mjs';
export { runBot, botStatus };

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { config: { type: 'string' }, database: { type: 'string' }, 'core-config': { type: 'string' },
    setup: { type: 'boolean', default: false }, status: { type: 'boolean', default: false }, 'check-config': { type: 'boolean', default: false },
    'install-url': { type: 'boolean', default: false }, 'application-id': { type: 'string' } } });
  if (!values.config || [values.setup, values.status, values['check-config'], values['install-url']].filter(Boolean).length > 1) throw new Error('INVALID_ARGUMENTS');
  const config = readBotConfig(values.config);
  if (values['check-config']) { console.log(JSON.stringify({ valid: true, guildId: config.guildId, publicProject: config.projectId, privateProject: config.privateProjectId })); return; }
  if (values['install-url']) { console.log(botInstallUrl(values['application-id'], config.guildId)); return; }
  if (!values.database) throw new Error('DATABASE_REQUIRED');
  if (values.status) { const status = botStatus(values.database, config); console.log(JSON.stringify(status)); process.exitCode = status.healthy ? 0 : 1; return; }
  return runBot(config, values.database, { setupOnly: values.setup, coreConfig: values['core-config'] });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0] : '';
    console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DISCORD_BOT_FAILED'); process.exitCode = 1;
  }
}
