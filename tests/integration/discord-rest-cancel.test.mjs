import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordREST } from '@superagent/discord-community';

test('cancelling an attempted mutation is unknown; a pre-aborted request never reaches Discord', async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = new DiscordREST('synthetic-token', { fetch: async () => {
    calls++; controller.abort(); throw new DOMException('Aborted after possible receipt', 'AbortError');
  } });
  await assert.rejects(api.request('POST', '/guilds/100/channels', { name: 'test' }, controller.signal), /OUTCOME_UNKNOWN/);
  assert.equal(calls, 1);
  await assert.rejects(api.request('POST', '/guilds/100/channels', {}, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
