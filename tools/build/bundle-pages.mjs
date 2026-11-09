/**
 * THE PAGES, BUNDLED FOR THE SITE. In a checkout every page loads its modules one file at a time (no build step,
 * which is what keeps development a save-and-reload). On the site that is hundreds of requests, chained import after
 * import: the editor alone asked for 147 files and 3.7 MB before its world was up, and with every view open, 536 files
 * and 10.6 MB (tools/test/measure-load.mjs). So the site build (build-preview.mjs) gives each page one minified entry
 * and its chunks, made by esbuild:
 *
 *   index.html          editor/world/studio.js         the editor (World, and the shell around every view)
 *   game.html           editor/studio.js               the game runtime: Play, Mission, Level
 *   2d.html             src/play2d/editor/app.js       2D
 *
 * Each page is its own build (each runs in its own document), split at its dynamic imports so what a page loads on
 * demand still loads on demand. three is bundled in (`three`, `three/webgpu`, `three/tsl` and `three/addons/` are the
 * vendored build the import maps name), once per page.
 *
 * WHAT STAYS UNBUNDLED, AND WHY. Every source file is still in dist/ beside the bundles:
 *   - workers: a worker loads its own module graph, and the engine's workers are found relative to the module that
 *     starts them (`new URL("./w.js", import.meta.url)`). A bundle moves that code, so the plugin below roots each such
 *     URL at the file's place in the repository (`/src/genesis/terrain/masks-worker.js`), where the unbundled worker
 *     is served;
 *   - a downloaded game: editor/exportGame.js packs the unbundled runtime listed in editor/runtime-files.json, from the
 *     unbundled page, which the build keeps as game.source.html.
 *
 * Without esbuild installed (a checkout that never ran `npm ci`), the build says so and serves the pages unbundled:
 * slower, and otherwise the same site.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PAGES = [
  { page: 'index.html', entry: 'editor/world/studio.js', name: 'index' },
  { page: 'game.html', entry: 'editor/studio.js', name: 'game', keepSource: 'game.source.html' },
  { page: '2d.html', entry: 'src/play2d/editor/app.js', name: '2d' },
];

/** `new URL("./x", import.meta.url)` in a file of the repository, rooted at that file's own place on the site. */
function rootRelativeURLs(root) {
  return {
    name: 'root-relative-urls',
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        if (!source.includes('import.meta.url')) return null;
        const dir = path.dirname(args.path);
        const contents = source.replace(/new URL\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g, (_, q, rel) => {
          const target = '/' + path.relative(root, path.resolve(dir, rel)).split(path.sep).join('/');
          return `new URL(${JSON.stringify(target)}, self.location.href)`;
        });
        return { contents, loader: 'js' };
      });
    },
  };
}

/**
 * Bundle every page into `output` and point each page at its bundle. Returns what was done, per page, or null when
 * esbuild is not installed.
 */
export async function bundlePages(root, output) {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { return null; }
  const three = path.join(root, 'vendor/three/build/three.webgpu.min.js');
  const done = [];
  for (const { page, entry, name, keepSource } of PAGES) {
    const outdir = path.join(output, 'bundle', name);
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: { [name]: path.join(root, entry) },
      bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2022',
      outdir, entryNames: '[name]', chunkNames: 'c-[hash]', metafile: true, logLevel: 'warning',
      alias: {
        three: three, 'three/webgpu': three,
        'three/tsl': path.join(root, 'vendor/three/build/three.tsl.min.js'),
        'three/addons': path.join(root, 'vendor/three/examples/jsm'),
      },
      plugins: [rootRelativeURLs(root)],
    });
    const file = path.join(output, page);
    const html = fs.readFileSync(file, 'utf8');
    if (keepSource) fs.writeFileSync(path.join(output, keepSource), html);
    const src = new RegExp(`(<script type="module" src=")(?:\\.?/)?${entry.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(")`);
    if (!src.test(html)) throw new Error(`${page} does not load ${entry} as its module script`);
    fs.writeFileSync(file, html.replace(src, `$1/bundle/${name}/${name}.js$2`));
    const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.js'));
    done.push({ page, files: outputs.length, bytes: outputs.reduce((n, [, o]) => n + o.bytes, 0) });
  }
  return done;
}
