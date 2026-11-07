/** Runtime inventory shared by static hosting, audits and R2 upload preparation. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CATALOG } from '../../src/world/catalog.js';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export function discoverRuntimeAssets() {
  const files = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const file = value.replace(/^\//, '').split('?')[0];
    if (!file.startsWith('assets/') || /[${}]/.test(file)) return;
    if (file.startsWith('assets/source/') || file.startsWith('assets/review/')) return;
    if (!fs.existsSync(path.join(root, file))) throw Error(`Missing runtime asset: ${file}`);
    if(!fs.statSync(path.join(root,file)).isFile())return;
    files.add(file);
  };
  const visit = value => {
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const [theme, catalog] of Object.entries(CATALOG)) {
    visit(JSON.parse(fs.readFileSync(path.join(root, `packs/${theme}/pack.json`))));
    for (const kind of ['world', 'weapons', 'enemies', 'doors', 'props']) {
      for (const asset of catalog[kind]) {
        visit(asset);
        // Arcade cards are explicit previews (visited above); an entry without one shows a rendered catalog card.
        if (!asset.preview) add(`assets/catalog/${theme}-${kind}-${asset.id}.png`);
      }
    }
  }
  for (const file of JSON.parse(fs.readFileSync(path.join(root, 'tools/assets/studio-manifest.json'))).files) add(file.path);
  for (const file of fs.readdirSync(path.join(root, 'assets/audio/default'))) if (file.endsWith('.mp3')) add(`assets/audio/default/${file}`);
  // Preserve shipped legacy configuration assets that still exist; do not invent old missing files.
  for (const file of fs.readdirSync(path.join(root, 'src/config')).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(root, 'src/config', file), 'utf8');
    for (const match of text.matchAll(/["'`](\/?assets\/[^"'`?]+)(?:\?[^"'`]*)?["'`]/g)) {
      const candidate = match[1].replace(/^\//, '');
      if (!/[${}]/.test(candidate) && fs.existsSync(path.join(root, candidate))) add(candidate);
    }
  }
  // Resolve every external glTF resource relative to its GLB, as the browser does.
  for (const file of files) if (/\.(glb|gltf)$/.test(file)) {
    const bytes = fs.readFileSync(path.join(root, file));
    const gltf = JSON.parse(file.endsWith('.glb')?bytes.subarray(20,20+bytes.readUInt32LE(12)):bytes.toString('utf8'));
    for (const item of [...(gltf.images ?? []), ...(gltf.buffers ?? [])]) if (item.uri && !item.uri.startsWith('data:')) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(item.uri)));
      if (!dependency.startsWith('assets/')) throw Error(`External resource escapes assets/: ${file}`);
      add(dependency);
    }
  }
  return [...files].sort();
}

export function runtimeAssets() {
  return JSON.parse(fs.readFileSync(path.join(root, 'tools/assets/runtime-manifest.json'))).files.map(f => f.path);
}
export function writeAssetManifest({refresh=false}={}) {
  if (!refresh) return JSON.parse(fs.readFileSync(path.join(root, 'tools/assets/runtime-manifest.json')));
  const files = discoverRuntimeAssets().map(file => {
    const bytes = fs.readFileSync(path.join(root, file));
    return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const manifest = { version: 1, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), files };
  fs.writeFileSync(path.join(root, 'tools/assets/runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = writeAssetManifest({refresh:process.argv.includes('--refresh')});
  console.log(`${result.files.length} runtime assets, ${(result.totalBytes / 1048576).toFixed(1)} MiB`);
}
