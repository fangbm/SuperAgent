import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** SQLite transaction serializes acquisition. Never evict a live or uncheckable owner. */
export function acquireApplicationOwner(store) {
  const token = randomUUID(), host = hostname();
  store.transaction(() => {
    const old = store.get('SELECT * FROM application_owner WHERE singleton=1');
    if (old) {
      if (old.hostname !== host) throw new Error('APPLICATION_OWNER_ON_OTHER_HOST');
      try { process.kill(old.pid, 0); throw new Error('APPLICATION_ALREADY_RUNNING'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    store.run('INSERT OR REPLACE INTO application_owner VALUES(1,?,?,?,?)', token, host, process.pid, new Date().toISOString());
  });
  return {
    assert() { if (store.get('SELECT token FROM application_owner WHERE singleton=1')?.token !== token) throw new Error('APPLICATION_OWNERSHIP_LOST'); },
    release() { store.run('DELETE FROM application_owner WHERE singleton=1 AND token=?', token); },
  };
}
