/**
 * Every suite of the engine that needs no browser and no npm install, from the repository root:
 *
 *   node tools/test/run.mjs            # all of them
 *   node tools/test/run.mjs kernel     # only the ones whose name contains "kernel"
 *
 * Five groups. KERNEL suites hold the Genesis Kernel (src/kernel/) to its own records: seed vectors, terrain, intent,
 * reach, claims. GENESIS suites hold the world engine World mode runs (src/genesis/): its composition (towns, woods,
 * footings), the world file and its certificate, the exporters, the genesis CLI and MCP server. ATLAS is the reconstruction's suites (src/atlas/), run by their own runner, the slowest job here
 * (minutes, not seconds). PURE suites import src/ modules that import nothing from three, so they run
 * under bare node. VENDORED suites load src/ modules that import `three`, resolved to
 * vendor/three by tools/lib/_three-real-hook.mjs — the same bytes a page would load. Neither
 * group needs a registry, which is the point: this runs in a sandbox with no network.
 *
 * THE WORLD LAYER IS DELIBERATELY IN THE PURE GROUP. src/world/* and src/sim/Terrain.js
 * import no three, and that is a property worth defending rather than a coincidence:
 * tools/build/bake-level.mjs has to compute the same ground the runtime stands on, and a
 * generator that could reach the renderer would eventually depend on it and stop being
 * bakeable. If one of these suites ever has to move to VENDORED, something has gone
 * wrong upstream of the test.
 *
 * THERE IS NO DEVICE-PROFILE SUITE. Upstream's was written against the quality ladder this
 * engine replaced (it asserts the old scores and calls an `applyPreference` that no longer
 * exists), so it was dropped rather than shipped red. core/DeviceProfile.js is untested.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = './tools/lib/_three-real-hook.mjs';
/**
 * THE ART IS OPTIONAL. A fresh checkout has no assets/ (runtime art is hosted on R2 and
 * excluded from Git), and a contributor or a CI job with no access to that bucket must
 * still be able to run every suite that is about logic rather than files. So the suites
 * are split one more way: ASSET_BACKED suites read GLBs, audio or studio images from
 * assets/ (or fetch them from the asset origin) and are SKIPPED, loudly, when the verified
 * cache is absent; everything else runs regardless. `--require-assets` (or
 * VISIGAMES_REQUIRE_ASSETS=1) turns that skip into a failure, which is what a job that
 * restored the cache with `npm run assets:fetch` should pass so a missing file cannot hide
 * as a skip.
 */
const inventory=JSON.parse(fs.readFileSync(path.join(ROOT,'tools/assets/runtime-manifest.json')));
const missingAssets=inventory.files.filter(f=>!fs.existsSync(path.join(ROOT,f.path)));
const requireAssets=process.argv.includes('--require-assets')||process.env.VISIGAMES_REQUIRE_ASSETS==='1';
if(missingAssets.length&&requireAssets){
  console.error(`${missingAssets.length} of ${inventory.files.length} local test assets are missing (first: ${missingAssets[0].path}). Run npm run assets:fetch to restore the verified R2 cache.`);
  process.exit(1);
}
/** Suites that open files under assets/ or reach the asset origin. Everything else is offline. */
const ASSET_BACKED = new Set([
  'test-performance-assets', 'test-asset-inventory', 'test-default-audio', 'test-category-art', 'test-game-export',
  'test-pack', 'test-player-experience', 'test-mission-polish', 'test-shooter-project',
  'test-catalog-animation',
]);


const PURE = [
  /** The project file contract: format version, migration and field-named validation. */
  'test-project-schema',
  /** A level's hand edits: the edit document, painted regions, a game of levels, and the compiler applying them. */
  'test-level-edits',
  /** The editor's live checks: reachability through doors, locks and keys, wires, budgets, orphaned edits. */
  'test-level-checks',
  /** The level editor's store: named undo steps, drags as one step, levels, wires, painting, autosave. */
  'test-level-store', 'test-level-library', 'test-game-run',
  /** A typed vision becomes a project: the English and Hebrew lexicon, genres, counts, every entry pair compiles. */
  'test-vision',
  'test-session-quality', 'test-asset-delivery', 'test-asset-inventory', 'test-reload-audio',
  'test-buildspec', 'test-default-audio', 'test-terrain', 'test-game-export',
  /**
   * The pack suites read the art. They stay in PURE because src/world/pack.js and
   * placement.js import no three and the GLB parse is tools/lib/_glb.mjs — but unlike
   * every other suite here they SKIP rather than fail when assets/ is empty, because
   * the terrain-only runtime can also be used without category art.
   */
  'test-pack', 'test-placement',
  /** The studio's looks and quality ladder: tables, no three. */
  'test-looks', 'test-editor-generation',
  /**
   * The repository kernel this engine stands on: the Blender kit's Python seed port against the kernel's own
   * cross-language vectors (skips without python3), and a mission's demands on the ground, stated as kernel intent
   * and met by the kernel's solver on real worlds.
   */
  'test-kernel-parity', 'test-mission-intent',
  /** See yourself: the reconstruction's boundary in the studio, and a figure from a photograph through the importer. */
  'test-see-yourself',
  /** Play here: a level cut from the world World mode made (its params, its own intent, its sculpt), and the link. */
  'test-world-handoff',
  /** Generated houses: the grammar, its Python port's parity fixtures and a constraint sweep. */
  'test-house-grammar',
  /** Generated trees: the L-system, its Python port's parity fixtures and a constraint sweep. */
  'test-tree-grammar',
];
const VENDORED = [
  /** The loader's own limits on an untrusted asset: load deadline and decoded-texture budget. */
  'test-asset-guards',
  /** The genre seam: registry, contract (retired choices included), compiler and systems bag. */
  'test-creature-grammar', 'test-wildlife',
  'test-genres', 'test-genre-content',
  /** The collapsed-viewport rule behind the Safari first-frame failure. */
  'test-viewport',
  'test-player-experience', 'test-mission-polish',
  'test-mobile-batches', 'test-shooter-project', 'test-blueprint',
  'test-game',
  'test-enemies',
  'test-terrain-combat',
  'test-objectives',
  /** A hand-built level played: keys, doors, levers, zones, sleeping critters, drops, checkpoints, lives, the trace. */
  'test-level-script', 'test-level-templates',
  /**
   * The village layout and its landmarks: noise fields, Poisson-disc scatter, the route graph, Python-port
   * parity and reachability. The generators are pure, but these suites also mesh the ground and the
   * landmarks through render/, so they need three.
   */
  'test-world-placement', 'test-world-landmarks',
  'test-rendering-cpu', 'test-render-contracts', 'test-creature-assembly', 'test-house-assembly', 'test-tree-assembly', 'test-catalog-animation',
  /** Arcade's first-person arms: the skinned outline shell, the viewmodels' timelines and sounds, and (with the art) the GLBs. */
  'test-arcade-fp',
  /**
   * The walker drives the real PlayerController over real baked terrain at the real fixed
   * step, so it needs three — hence VENDORED rather than PURE. It is the only suite here
   * that tests the SEAM between the offline baker and the runtime body, which is exactly
   * where a mock would have hidden the floating-downhill bug it found.
   */
  'walk-world',
  /**
   * A level on its seed's Visigenesis world: the ground is the kernel's, the mission is met, and the level is played:
   * the kernel's walker and the nav grid agree, and the real body walks inside par.
   */
  'test-kernel-ground',
];

/**
 * THE STATIC CHECKS RUN HERE TOO. `npm run check` is the import resolver (every specifier lands on
 * a real file inside the repository, by path and by URL alike; only three.js is external; the kernel
 * and the reconstruction import nothing outside themselves) and the vendored-three check. There is
 * no CI: check.sh at the root runs this file and nothing else, so a check that lived only in
 * package.json would be a rule nobody runs. They go first because they take tens of milliseconds
 * and a broken import makes every suite after them noise.
 */
const CHECKS = [
  ['check-imports', 'tools/check-imports.mjs'],
  ['check-three', 'tools/three/check.mjs'],
];
/**
 * A suite that cannot run here at all (test-kernel-parity without python3) exits 0 and prints a
 * line `SUITE-SKIPPED: <reason>`. It is reported as a skip with its reason, never as "ok": this
 * runner shows a child's output only on failure, so without the marker the reason would never
 * reach check.sh's output.
 */
const SUITE_SKIPPED = /^SUITE-SKIPPED: (.+)$/m;

const filter = process.argv.slice(2).find(a => !a.startsWith('--')) || '';
const results = [];
const skipped = [];
let artSkips = 0;
/** The kernel's suites, and the world engine's (src/genesis/: the world editor's engine, its composition, the world
 *  file, certificates, the genesis CLI and MCP server): each a bare .js file run under node with the harness's shim. */
const KERNEL = fs.readdirSync(path.join(ROOT, 'tools/test/kernel')).filter(f => f.endsWith('.test.js')).sort();
const GENESIS = fs.readdirSync(path.join(ROOT, 'tools/test/genesis')).filter(f => f.endsWith('.test.js')).sort();
const jobs = [
  ...CHECKS.map(([name, file]) => ({ name, file, args: [] })),
  ...KERNEL.map(f => ({ name: 'kernel-' + f.replace(/\.test\.js$/, ''), file: `tools/test/kernel/${f}`, args: ['--import', './tools/test/kernel/shim.mjs'] })),
  ...GENESIS.map(f => ({ name: 'genesis-' + f.replace(/\.test\.js$/, ''), file: `tools/test/genesis/${f}`, args: ['--import', './tools/test/kernel/shim.mjs'] })),
  ...PURE.map(name => ({ name, file: `tools/test/${name}.mjs`, args: [] })),
  ...VENDORED.map(name => ({ name, file: `tools/test/${name}.mjs`, args: ['--import', HOOK] })),
  { name: 'atlas', file: 'tools/test/atlas/run.mjs', args: [] },
];
for (const { name, file, args } of jobs) {
  if (filter && !name.includes(filter)) continue;
  if (missingAssets.length && ASSET_BACKED.has(name)) { skipped.push(name); artSkips++; console.log(`skip ${name} (needs assets/)`); continue; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...args, file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  const ok = r.status === 0;
  const skip = ok && (r.stdout ?? '').match(SUITE_SKIPPED);
  if (skip) { skipped.push(name); console.log(`skip ${name} (${skip[1]})`); continue; }
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${Date.now() - t0} ms)`);
  if (!ok) console.log((r.stdout + r.stderr).trim().split('\n').slice(-15).map(l => '     ' + l).join('\n'));
}
const failed = results.filter(r => !r.ok);
const otherSkips = skipped.length - artSkips;
console.log(`\n${results.length - failed.length}/${results.length} passed${artSkips ? `, ${artSkips} skipped for want of the local art (npm run assets:fetch restores it; --require-assets makes this a failure)` : ''}${otherSkips ? `, ${otherSkips} skipped for a missing tool (reason printed above)` : ''}`);
process.exit(failed.length ? 1 : 0);
