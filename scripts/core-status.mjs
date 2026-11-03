import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Read-only Core status; does not migrate or require platform credentials. */
export function botStatus(database, config) {
  if (!existsSync(database)) return { healthy: false, state: 'archive_missing' };
  const store = new DatabaseSync(path.resolve(database), { readOnly: true });
  try {
    if (!store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_leases'").get()) return { healthy: false, state: 'not_configured' };
    const namespace = 'discord-community:' + config.guildId;
    const lease = store.prepare('SELECT lease_until FROM community_leases WHERE namespace=?').get(namespace);
    const row = store.prepare("SELECT value_json FROM community_state WHERE namespace=? AND state_key='runtime:health'").get(namespace);
    const health = row ? JSON.parse(row.value_json) : null;
    const healthy = !!lease && lease.lease_until > new Date().toISOString() && health?.mode === 'run' && Number.isFinite(Date.parse(health.checkedAt))
      && Date.now() - Date.parse(health.checkedAt) < 45000;
    return { healthy, state: healthy ? 'running' : 'stopped_or_starting', guildId: config.guildId, analysis: health?.analysis ?? 'disabled',
      events: store.prepare('SELECT count(*) count FROM source_events WHERE project_id IN (?,?)').get(config.projectId, config.privateProjectId).count,
      sources: store.prepare('SELECT source_id,coverage FROM sources WHERE project_id IN (?,?) ORDER BY source_id').all(config.projectId, config.privateProjectId) };
  } finally { store.close(); }
}
