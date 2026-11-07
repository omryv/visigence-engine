/**
 * WORLD MODE'S DATA: what src/world/worldMap.js hands the view is the kernel's world, and the sites it marks are where
 * levels stand.
 *
 *   1. bakeWorld is the kernel's canonical ground for the seed (groundBundle at 513², eroded): its heights, masks and
 *      heightHash are groundBundle's, bit for bit, and the same seed bakes the same world twice;
 *   2. the quick look is the analytic ground at QUICK_RES, uneroded, and marks no sites;
 *   3. the colours are one finite linear RGB per sample, the sea floor reads as sea, and the drainage on land as water;
 *   4. the sites are kernelGround's ranking (rankSites), the first SITE_TRIES of it in its order, and a mission compiled
 *      on the seed stands on one of them: World's markers are the places a level can be;
 *   5. a seed that is not one is refused; the buffers a worker transfers are the bake's own;
 *   6. the worker answers with the quick look, then the world, under the request's id (its protocol, read as text).
 *
 * Run:  node tools/test/test-world-map.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bakeWorld, worldColors, transferables, QUICK_RES, LEVEL_SIZE, WORLD_PALETTE } from '../../src/world/worldMap.js';
import { rankSites, SITE_SCALE, SITE_TRIES } from '../../src/world/kernelGround.js';
import { makeParams } from '../../src/kernel/presets.js';
import { createHeightSampler } from '../../src/kernel/terrain/heightfield.js';
import { groundBundle } from '../../src/kernel/terrain/ground.js';
import { CANONICAL_RES } from '../../src/kernel/terrain/canonical.js';
import { hex } from '../../src/kernel/terrain/fingerprint.js';
import { compileShooterProject } from '../../src/world/shooterProject.js';
import { quickMission } from '../../src/world/missionCard.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';

const ok = msg => console.log(`  ok   ${msg}`);
const SEEDS = ['K7QN-3F2A-9XBD', 'AB12-CD34-EF56'];
const pack = resolvePack(JSON.parse(fs.readFileSync(new URL('../../packs/arcade/pack.json', import.meta.url))), CATALOG.arcade.measurements);
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

for (const seed of SEEDS) {
  // ── 1. the kernel's ground ────────────────────────────────────────────────
  const w = bakeWorld(seed), params = makeParams({ seed }), g = groundBundle(params);
  assert.equal(w.res, CANONICAL_RES); assert.equal(w.size, params.terrain.size); assert.equal(w.quick, false);
  assert.equal(w.manifest.heightHash, hex(g.manifest.heightHash));
  assert.equal(w.manifest.landMaskHash, hex(g.manifest.landMaskHash));
  assert(same(w.heights, g.field.data) && same(w.wet, g.wet) && same(w.flow, g.flow) && same(w.delta, g.delta), 'the bake is groundBundle\'s, bit for bit');
  const again = bakeWorld(seed);
  assert(same(again.heights, w.heights) && same(again.colors, w.colors) && JSON.stringify(again.sites) === JSON.stringify(w.sites), 'the same seed bakes the same world');
  const dry = w.wet.reduce((n, v) => n + (v ? 0 : 1), 0) / w.wet.length;
  assert.equal(w.land, dry);
  ok(`${seed}: the canonical ground, ${w.res}², heightHash ${w.manifest.heightHash}, ${(w.land * 100).toFixed(0)}% land, the same twice`);

  // ── 2. the quick look ──────────────────────────────────────────────────────
  const q = bakeWorld(seed, { quick: true }), qg = groundBundle(params, { res: QUICK_RES, erode: false });
  assert.equal(q.res, QUICK_RES); assert.equal(q.delta, null); assert.deepEqual(q.sites, []);
  assert(same(q.heights, qg.field.data), 'the quick look is the analytic ground at QUICK_RES');
  ok(`${seed}: the quick look is the analytic ground at ${QUICK_RES}², uneroded, with no sites`);

  // ── 3. colours ─────────────────────────────────────────────────────────────
  assert.equal(w.colors.length, w.res * w.res * 3);
  assert(w.colors.every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'every channel is finite, in 0..1');
  let sea = 0, seaBlue = 0, drain = 0, drainBluer = 0;
  for (let k = 0; k < w.res * w.res; k++) {
    const [r, gr, b] = [w.colors[k * 3], w.colors[k * 3 + 1], w.colors[k * 3 + 2]];
    if (w.wet[k]) { sea++; if (b > r) seaBlue++; }
    else if (w.flow[k] / 255 > 0.85) { drain++; if (b > r) drainBluer++; }
  }
  assert.equal(seaBlue, sea, 'the sea floor reads as sea');
  assert(drain === 0 || drainBluer / drain > 0.9, `the main drainage reads as water (${drainBluer}/${drain})`);
  assert(same(worldColors(g.field, g, params.water.level), w.colors), 'worldColors of the bundle is the bake\'s colours');
  ok(`${seed}: colours finite, ${sea.toLocaleString()} sea cells as sea, ${drainBluer}/${drain} main-drainage cells as water`);

  // ── 4. the sites ───────────────────────────────────────────────────────────
  const ranked = rankSites(createHeightSampler(params), params.terrain, LEVEL_SIZE * SITE_SCALE).sites.slice(0, SITE_TRIES);
  assert.deepEqual(w.sites.map(s => [s.x, s.z]), ranked.map(s => [s.x, s.z]), 'the sites are kernelGround\'s ranking, in its order');
  assert(w.sites.every(s => s.span === LEVEL_SIZE * SITE_SCALE));
  const level = compileShooterProject(quickMission('arcade', seed, 'shooter'), pack), G = level.ground;
  assert.equal(G.kind, 'world', `${seed}: the mission stands on its world`);
  const at = w.sites.findIndex(s => s.x === G.site.x && s.z === G.site.z);
  assert(at >= 0, `${seed}: the level's site (${G.site.x}, ${G.site.z}) is one World marks`);
  ok(`${seed}: ${w.sites.length} sites, kernelGround's ranking; the shooter mission stands on choice ${at + 1}`);
}

// ── 5. refusals and transfer ─────────────────────────────────────────────────
assert.throws(() => bakeWorld(''), /not a seed/);
{
  const q = bakeWorld('K7QN-3F2A-9XBD', { quick: true }), t = transferables(q);
  assert.equal(t.length, 4, 'heights, wet, flow, colours (no delta on the quick look)');
  assert(t.includes(q.heights.buffer) && t.includes(q.colors.buffer));
  assert(Object.values(WORLD_PALETTE).every(c => c.length === 3 && c.every(v => v >= 0 && v <= 1)));
  ok('a non-seed is refused; a worker transfers the bake\'s own buffers');
}

// ── 6. the worker's protocol ─────────────────────────────────────────────────
{
  const worker = fs.readFileSync(new URL('../../src/world/worldWorker.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../../editor/worldMode.js', import.meta.url), 'utf8');
  for (const type of ['quick', 'world', 'error']) assert(worker.includes(`type: '${type}'`) && page.includes(`'${type}'`), `both sides speak '${type}'`);
  assert(/postMessage\(\{ id, type: 'quick'[\s\S]*postMessage\(\{ id, type: 'world'/.test(worker), 'the quick look goes first');
  assert(page.includes('data.id !== ask'), 'the page drops an answer to a request it no longer wants');
  ok('the worker answers quick, then world (or error), under the request\'s id; the page drops stale answers');
}
console.log('World map: OK');
