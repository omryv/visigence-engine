import './game-manifest.mjs';
/** Static hosting bundle. Keep development files and local metadata out of the output. */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeAssetManifest } from './asset-manifest.mjs';
import { bundlePages } from './bundle-pages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'dist');
const directories = ['editor', 'src', 'vendor', 'packs', 'specs'];
writeAssetManifest(); // Validate the committed inventory; art is served from R2.

// This path is fixed to the repository's generated output; never take it from user input.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// The one tool is the site, exactly as in a checkout: the editor (the world and the game) at index.html; the pages
// of its views, the game runtime it plays in and exports (game.html), and the 2D builder (2d.html); and
// the icons they link.
for (const page of ['index.html', 'game.html', '2d.html', 'favicon.png', 'apple-touch-icon.png'])
  cpSync(path.join(root, page), path.join(output, page));
for (const directory of directories) {
  cpSync(path.join(root, directory), path.join(output, directory), {
    recursive: true,
    filter: source => {
      const name = path.basename(source);
      return !name.startsWith('.') && !name.endsWith('.local.json') && !/\.blend[0-9]*$/.test(name);
    },
  });
}
// Each page as one minified bundle and its chunks (tools/build/bundle-pages.mjs); the sources stay beside them.
const bundled = await bundlePages(root, output);
if (bundled) for (const b of bundled) console.log(`  ${b.page}: ${b.files} bundle files, ${(b.bytes / 1048576).toFixed(2)} MB minified`);
else console.log('  esbuild is not installed (npm ci): the pages are served unbundled');
console.log('Visigence Engine built in dist/ (the editor at /; the pages of its views at /game and /2d; the kernel at src/kernel/, the world engine at src/genesis/; art served from R2)');
