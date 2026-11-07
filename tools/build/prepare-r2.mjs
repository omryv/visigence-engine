/** Local staging only: no credentials, network requests or remote deletion. */
import fs from 'node:fs';
import path from 'node:path';
import { root, writeAssetManifest } from './asset-manifest.mjs';
const output = path.join(root, '.r2-upload');
const manifest = writeAssetManifest();
// Fixed generated directory, never a user-supplied path.
fs.rmSync(output, { recursive: true, force: true });
for (const item of manifest.files) {
  const target = path.join(output, item.remotePath??item.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, item.path), target);
}
console.log(`Ready: ${output}/assets/ (${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MiB). Upload with the assets/ prefix intact.`);
