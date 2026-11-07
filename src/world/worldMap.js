/**
 * THE SEED'S WHOLE WORLD, as World mode shows it: the canonical ground the kernel grows for a seed, its colours, and
 * the sites a level on that seed would stand on.
 *
 * Every seed is a world (src/kernel/presets.js makeParams({ seed })): a 4 km plate, eroded, flooded from the sea and
 * drained (src/kernel/terrain/ground.js groundBundle, the canonical ground at 513², the same bake and the same
 * heightHash a sibling is held to). A level on that seed is 640 m of it, played at 1:8 (world/kernelGround.js). World
 * mode is where the whole plate is seen and the level's place on it is chosen to be played, so this module is the
 * plate as data, and render/WorldView.js only draws what it is handed.
 *
 * Pure: no three, no DOM, no clock unless one is handed in (for the stage timings only), no Math.random. The same seed
 * gives the same bake, colours and sites, bit for bit, in a worker (world/worldWorker.js) or in a test.
 */
import { makeParams } from '../kernel/presets.js';
import { normalizeSeed } from '../kernel/seed.js';
import { createHeightSampler } from '../kernel/terrain/heightfield.js';
import { groundBundle } from '../kernel/terrain/ground.js';
import { CANONICAL_RES } from '../kernel/terrain/canonical.js';
import { hex } from '../kernel/terrain/fingerprint.js';
import { rankSites, SITE_SCALE, SITE_TRIES } from './kernelGround.js';

/** Bump when the same seed gives different colours or sites (the bake itself is versioned by the kernel). */
export const WORLD_MAP_VERSION = 1;
/** A level's edge in level metres: the Arcade village's `world.size` (packs/arcade/pack.json), so a site is 640 m. */
export const LEVEL_SIZE = 80;
/** The quick look: the analytic ground at 129², uneroded, drawn within a frame while the canonical bake runs. */
export const QUICK_RES = 129;

/**
 * Bake a seed's world.
 *
 * @param {string} seedInput  any seed; normalised as everywhere else (src/kernel/seed.js normalizeSeed)
 * @param {{quick?: boolean, now?: (() => number)|null, levelSize?: number}} [o]
 *   quick: the analytic ground at QUICK_RES, uneroded (no sites; they need the full sampler, and come with the
 *   canonical bake); now: a millisecond clock for the stage timings; levelSize: the level edge the sites are for
 * @returns {{version: number, seed: string, quick: boolean, res: number, size: number, sea: number, min: number, max: number,
 *   heights: Float32Array, wet: Uint8Array, flow: Uint8Array, delta: Float32Array|null, colors: Float32Array, land: number,
 *   manifest: object, sites: {x: number, z: number, span: number, relief: number, slope: number}[]}}
 */
export function bakeWorld(seedInput, { quick = false, now = null, levelSize = LEVEL_SIZE } = {}) {
  const seed = normalizeSeed(String(seedInput ?? ''));
  if (!seed) throw new TypeError(`bakeWorld: "${seedInput}" is not a seed`);
  const params = makeParams({ seed });
  const g = groundBundle(params, { res: quick ? QUICK_RES : CANONICAL_RES, erode: !quick, now });
  const sea = params.water?.level || 0, res = g.field.res, N = res * res;
  let dry = 0;
  for (let i = 0; i < N; i++) if (!g.wet[i]) dry++;
  const span = levelSize * SITE_SCALE;
  const sites = quick ? [] : rankSites(createHeightSampler(params), params.terrain, span).sites.slice(0, SITE_TRIES)
    .map(s => ({ x: s.x, z: s.z, span, relief: s.relief, slope: s.slope }));
  const m = g.manifest;
  return {
    version: WORLD_MAP_VERSION, seed, quick, res, size: g.field.size, sea, min: g.field.min, max: g.field.max,
    heights: g.field.data, wet: g.wet, flow: g.flow, delta: g.delta, colors: worldColors(g.field, g, sea), land: dry / N,
    manifest: { heightHash: hex(m.heightHash), parameterHash: hex(m.parameterHash), landMaskHash: hex(m.landMaskHash),
      flowMaskHash: hex(m.flowMaskHash), generatorVersion: m.generatorVersion, stages: m.stages },
    sites,
  };
}

/**
 * THE PALETTE: World mode's presentation, not the kernel's. A biome palette is content (the kernel hands its climate
 * anchors in as data for exactly that reason), and this is one reading of the ground's own masks, chosen to make the
 * plate legible from the air: the sea floor by depth, sand at the waterline, grass, then darker upland, rock where it
 * is steep or the droplets stripped it, snow on the high flats, and the drainage the flow mask found, as water.
 * Linear RGB, as the renderer's vertex colours are.
 */
export const WORLD_PALETTE = Object.freeze({
  deep: [0.012, 0.045, 0.085], shelf: [0.08, 0.2, 0.22], sand: [0.62, 0.53, 0.36], meadow: [0.16, 0.3, 0.07],
  upland: [0.09, 0.17, 0.05], rock: [0.24, 0.22, 0.2], scree: [0.33, 0.3, 0.27], snow: [0.82, 0.85, 0.9],
  soil: [0.26, 0.19, 0.1], river: [0.05, 0.16, 0.24],
});
/** Thresholds of the palette, in the ground's own units. */
export const WORLD_BANDS = Object.freeze({
  beach: 2.5,      // metres above the sea that read as shore
  shelf: 40,       // metres of depth over which the sea floor goes from shelf to deep
  rock: 0.62,      // slope (rise over run) past which the ground is rock
  snowFrom: 0.72,  // fraction of the highest peak's height where snow can lie
  snowSlope: 0.45, // and the steepest it lies on
  river: 0.66,     // flow mask (0..1) from which a cell is drainage
  deposit: 0.4,    // metres of erosion deposit for full soil
});

const mixInto = (out, o, a, b, t) => { out[o] = a[0] + (b[0] - a[0]) * t; out[o + 1] = a[1] + (b[1] - a[1]) * t; out[o + 2] = a[2] + (b[2] - a[2]) * t; };
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Per-vertex colours of a baked ground: Float32Array of res² × RGB, linear.
 *
 * @param {{res: number, size: number, data: Float32Array}} field
 * @param {{wet: Uint8Array, flow: Uint8Array, delta: Float32Array|null}} masks
 * @param {number} sea  the sea level, metres
 */
export function worldColors(field, { wet, flow, delta }, sea = 0) {
  const { res, size, data } = field, P = WORLD_PALETTE, B = WORLD_BANDS;
  const step = size / (res - 1), out = new Float32Array(res * res * 3), c = [0, 0, 0];
  let peak = 0;
  for (let i = 0; i < data.length; i++) if (data[i] - sea > peak) peak = data[i] - sea;
  const at = (i, j) => data[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i, o = k * 3, h = data[k] - sea;
    if (wet[k]) {
      mixInto(out, o, P.shelf, P.deep, smooth(0, B.shelf, -h));
      continue;
    }
    const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), gz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
    const slope = Math.hypot(gx, gz), rel = peak > 0 ? h / peak : 0;
    // Grass, darkening with height; sand at the shore.
    mixInto(c, 0, P.meadow, P.upland, smooth(0.15, 0.6, rel));
    mixInto(c, 0, P.sand, c, smooth(B.beach * 0.4, B.beach, h));
    // Soil where the droplets laid ground down, scree where they stripped it.
    if (delta) {
      const d = delta[k];
      if (d > 0) mixInto(c, 0, c, P.soil, 0.6 * smooth(0, B.deposit, d));
      else mixInto(c, 0, c, P.scree, 0.5 * smooth(0, B.deposit, -d));
    }
    // Rock on the steep; snow on the high flats.
    mixInto(c, 0, c, P.rock, smooth(B.rock * 0.75, B.rock * 1.25, slope));
    mixInto(c, 0, c, P.snow, smooth(B.snowFrom, B.snowFrom + 0.1, rel) * (1 - smooth(B.snowSlope * 0.7, B.snowSlope, slope)));
    // The drainage, on land only: the flow mask is log-normalised, so the threshold is a share of the main channel.
    mixInto(c, 0, c, P.river, 0.85 * smooth(B.river, B.river + 0.12, flow[k] / 255));
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
  }
  return out;
}

/** The buffers of a bake a worker hands over without copying (postMessage's transfer list). */
export function transferables(bake) {
  return [bake.heights, bake.wet, bake.flow, bake.delta, bake.colors].filter(Boolean).map(a => a.buffer);
}
