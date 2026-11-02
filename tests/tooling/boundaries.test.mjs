import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { checkBoundaries } from '../../scripts/check-boundaries.mjs';

function workspace(t, packages) {
  const root = mkdtempSync(path.join(tmpdir(), 'superagent-boundary-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  for (const [directory, manifest, code] of packages) {
    const target = path.join(root, 'packages', directory);
    mkdirSync(path.join(target, 'src'), { recursive: true });
    writeFileSync(path.join(target, 'package.json'), JSON.stringify({ private: true, ...manifest }));
    writeFileSync(path.join(target, 'src/index.ts'), code);
  }
  return root;
}

test('boundary checker accepts the actual workspace', () => assert.deepEqual(checkBoundaries(), []));
test('boundary checker blocks business dependencies of contracts', t => {
  const root = workspace(t, [['contracts', { name: '@superagent/contracts', dependencies: { '@superagent/domain': 'workspace:*' } }, '']]);
  assert.ok(checkBoundaries(root).some(e => e.includes('forbidden dependency')));
});
test('boundary checker blocks Core dynamic platform imports', t => {
  const root = workspace(t, [['agent-core', { name: '@superagent/agent-core' }, "const platform = import('@superagent/connectors-qq');"]]);
  assert.ok(checkBoundaries(root).some(e => e.includes('forbidden import')));
});
test('boundary checker checks inline import types and computed Core imports', t => {
  const root = workspace(t, [['agent-core', { name: '@superagent/agent-core' }, "type Platform = import('@superagent/connectors-qq').Client; const platform = import(moduleName);"]]);
  const errors = checkBoundaries(root);
  assert.ok(errors.some(e => e.includes('forbidden import')));
  assert.ok(errors.some(e => e.includes('computed module import')));
});
test('boundary checker blocks relative imports bypassing package APIs', t => {
  const root = workspace(t, [
    ['persistence', { name: '@superagent/persistence' }, ''],
    ['connectors/qq', { name: '@superagent/qq' }, "import type { Repository } from '../../../persistence/src/index.js';"],
  ]);
  assert.ok(checkBoundaries(root).some(e => e.includes('cross-package relative import')));
});
test('boundary checker blocks runtime implementations in SDK', t => {
  const root = workspace(t, [['plugin-sdk', { name: '@superagent/plugin-sdk', dependencies: { '@superagent/contracts': 'workspace:*' } }, "export * from '@superagent/contracts';"]]);
  assert.ok(checkBoundaries(root).some(e => e.includes('type-only')));
});
test('boundary checker enforces private workspace packages', t => {
  const root = workspace(t, [['contracts', { name: '@superagent/contracts', private: false }, '']]);
  assert.ok(checkBoundaries(root).some(e => e.includes('private')));
});
test('platform connectors may depend only on the plugin SDK within the workspace', t => {
  const root = workspace(t, [['connectors/qq', { name: '@superagent/qq', dependencies: { '@superagent/job-queue': 'workspace:*', '@superagent/memory': 'workspace:*' } }, "import { x } from '@superagent/memory';"]]);
  const errors = checkBoundaries(root);
  assert.ok(errors.some(e => e.includes('forbidden dependency @superagent/job-queue')));
  assert.ok(errors.some(e => e.includes('forbidden import @superagent/memory')));
});
