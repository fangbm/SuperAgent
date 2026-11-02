import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'contracts.freeze.json'), 'utf8'));
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [path.relative(root, file).replaceAll(path.sep, '/')];
  });
}
const covered = [
  ...walk(path.join(root, 'packages/contracts/src')),
  ...walk(path.join(root, 'packages/contracts/schemas')),
  ...walk(path.join(root, 'packages/contracts/fixtures')),
  ...walk(path.join(root, 'packages/plugin-sdk/src')),
  ...walk(path.join(root, 'config')),
  ...walk(path.join(root, 'docs/reference/v0.9/migrations')),
].sort();
const listed = Object.keys(manifest.files).sort();
if (JSON.stringify(covered) !== JSON.stringify(listed)) throw new Error('Frozen contract inventory changed; record an explicit contract revision');
for (const file of covered) {
  const actual = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  if (actual !== manifest.files[file]) throw new Error(`Frozen contract changed: ${file}`);
}
console.log(`PASS: M0 contract freeze (${covered.length} files, baseline ${manifest.baseline})`);
