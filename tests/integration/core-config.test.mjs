import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readCoreConfig } from '../../scripts/core-config.mjs';
import { validateCoreConfiguration } from '../../scripts/core-runtime.mjs';
import { fixture } from './helpers.mjs';

test('offline Core validation checks platform files and source identities without secrets or database creation', t => {
  const f = fixture(t);
  const config = readCoreConfig('community/idle-abyss-princesses/core-config.json');
  config.database = path.join(f.directory, 'not-created.sqlite');
  assert.equal(validateCoreConfiguration(config, { env: {} }).prepared.length, 2);
  const bad = structuredClone(config); bad.sources[2].sourceUri = 'urn:wrong:source';
  assert.throws(() => validateCoreConfiguration(bad, { env: {} }), /CORE_PLUGIN_SOURCE_MISMATCH/);
  bad.sources[2].sourceUri = config.sources[2].sourceUri; bad.plugins[1].config = 'missing-platform-config.json';
  assert.throws(() => validateCoreConfiguration(bad, { env: {} }), /ENOENT/);
  assert.equal(existsSync(config.database), false);
});
