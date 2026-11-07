import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, runtimeAssets, writeAssetManifest } from '../build/asset-manifest.mjs';
const files = runtimeAssets();
assert.equal(new Set(files).size, files.length);
assert(files.some(f => f.startsWith('assets/v2/arcade/')));
assert(files.every(f => !/assets\/(source|review)\/|\.blend\d?$|uv-layout/.test(f)));
const manifest = writeAssetManifest();
for (const item of manifest.files) {
  const bytes = fs.readFileSync(path.join(root, item.path));
  assert.equal(item.bytes, bytes.length);
  assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(manifest.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
console.log(`${files.length} runtime files: dependencies exist, hashes match, authoring/review assets excluded.`);
