/* planting.js — the woods a seed's world grows: trees and shrubs as `params.props.scatter` records.
 *
 * Deterministic: every draw comes from the seed's own "landform:planting" stream and the woods field from its
 * "landform:woods" channel (the channel names the archived world builder used, kept so a world planted there and here
 * is the same world). Nothing here reads a clock or Math.random. The editor's "Plant woods" command calls
 * plantWorld(); the result lives in params, so it saves, exports and undoes with the world.
 *
 * Pure: no three.js, no DOM.
 */
import { mulberry32, seedChannel } from "../../kernel/seed.js";
import { fbm } from "../../kernel/terrain/noise.js";
import { surveyField } from "../../kernel/core/survey.js";
import { climateOf } from "./archetype.js";

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* What grows, by the world's climate. Repeats are weights. */
export const SPECIES = Object.freeze({
  cold: ["pine", "pine", "pine", "birch", "bush"],
  temperate: ["tree", "tree", "birch", "pine", "bush"],
  hot: ["palm", "palm", "bush", "tree-small"],
});

/**
 * Plant a whole world: the woods its seed and its ground make, away from the water and from anything standing in
 * `keepClear` ({x, z, r} discs: placed buildings, the spawn). `count` is the most stems; the ground decides how many
 * of them find a place.
 */
export function plantWorld({ params, sampler, keepClear = [], count = 3600 }) {
  const size = params.terrain.size;
  const waterLevel = params.water?.enabled === false ? -Infinity : (params.water?.level || 0);
  const field = surveyField({ sampler, size, res: 96, level: waterLevel });
  return plantCountry({
    seed: params.seed, size, sampler, waterLevel: Number.isFinite(waterLevel) ? waterLevel : -1e9,
    species: SPECIES[climateOf(params.biome)] || SPECIES.temperate,
    count, heightRef: params.terrain.height, field, sites: keepClear,
  });
}


/* ── where things grow ──
   Planting used to be uniform rejection sampling with a height band, and
   uniform is the one distribution vegetation never has: it produces an even
   green fuzz over the whole map, which is the tell that says "procedural"
   louder than anything else in a generated world.

   So density is a low-frequency noise field — woods and clearings, at a
   wavelength set per world — multiplied by the band and slope rules that were
   already right. A world can then ask for a forest that starts at the edge of
   a village (`near`), for scattered stands over a plain (`clumping` low, a
   long wavelength), or for the dense unbroken cover of a wet valley.

   Nothing is planted on a street, in a settlement, on a road, in the water, or
   on ground a tree could not hold. `taken` is a coarse hash of everything
   already built rather than a distance test against every record — four
   thousand candidates against two thousand records is eight million tests,
   and this has to fit inside one frame's worth of patience. */
function plantCountry({
  seed, size, sampler, waterLevel = 0, species, count, bands = [0.05, 0.6],
  heightRef = 520, sites = [], roads = [], cell = 26, field = null,
  clumping = 0.62, grain = 3.4, contrast = 2.4, near = null, nearPull = 0,
}) {
  if (!count || !species?.length) return [];
  const rng = mulberry32(seedChannel(seed, "landform:planting"));
  const noiseSeed = seedChannel(seed, "landform:woods");
  const taken = new Set();
  const key = (x, z) => `${Math.round(x / cell)},${Math.round(z / cell)}`;
  const mark = (x, z, r) => {
    const n = Math.ceil(r / cell);
    const ci = Math.round(x / cell), cj = Math.round(z / cell);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) taken.add(`${ci + i},${cj + j}`);
  };
  for (const s of sites) mark(s.x, s.z, (s.r || 60) * 1.15);
  for (const p of roads) mark(p.x, p.z, p.r || 13);

  const half = size * 0.47;
  const out = [];
  /* ── where the candidates come from ──
     Uniform draws over the whole plate are the obvious thing and they are why
     coastal worlds came up bald: on a map that is two-thirds sea, two thirds
     of every draw is spent proposing a tree in the water, and the forest runs
     out of attempts long before it runs out of ground. When the caller has a
     survey grid — plantWorld builds one — candidates are drawn from
     its DRY CELLS instead, which is the same distribution with the wasted
     two-thirds removed. Everything downstream still re-checks the real
     height: the grid is a hint about where to look, never an answer. */
  const dry = [];
  if (field) {
    for (let j = 1; j < field.res - 1; j++) {
      for (let i = 1; i < field.res - 1; i++) {
        if (field.at(i, j) > waterLevel + 2) dry.push(j * field.res + i);
      }
    }
  }
  const tries = count * (dry.length ? 5 : 9);
  for (let t = 0; t < tries && out.length < count; t++) {
    let x, z;
    if (dry.length) {
      const k = dry[(rng() * dry.length) | 0];
      const i = k % field.res, j = (k - i) / field.res;
      x = field.xOf(i) + (rng() - 0.5) * field.step;
      z = field.zOf(j) + (rng() - 0.5) * field.step;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
    } else {
      x = (rng() * 2 - 1) * half; z = (rng() * 2 - 1) * half;
    }
    if (taken.has(key(x, z))) continue;
    const y = sampler(x, z);
    if (y < waterLevel + 2.5) continue;
    const band = y / heightRef;
    if (band < bands[0] || band > bands[1]) continue;
    // Slope: a canopy on a 30° face reads as a tree lying down.
    const d = 7;
    const slope = Math.max(
      Math.abs(sampler(x + d, z) - sampler(x - d, z)),
      Math.abs(sampler(x, z + d) - sampler(x, z - d))) / (2 * d);
    if (slope > 0.5) continue;
    // Thinning with height: the tree line is what makes a mountain read as
    // one, and a forest that stops abruptly reads as a mask.
    const up = (band - bands[0]) / Math.max(1e-3, bands[1] - bands[0]);
    if (rng() < up * up * 0.75) continue;
    /* The woods. `clumping` is how much of the density comes from the field
       rather than from chance: 0 is the old uniform fuzz, 1 is hard-edged
       stands with bare ground between them. */
    if (clumping > 0) {
      /* THE CONTRAST TERM IS NOT A FUDGE. Value-noise fBm at three octaves
         almost never reaches its own bounds — the raw field sits inside about
         ±0.4 — so mapping it straight to a density gives woods only slightly
         thicker than the clearings, which measures as uniform and LOOKS
         uniform. Gaining it up before the clamp is what turns a gentle
         undulation in probability into stands of trees with open ground
         between them. */
      const n = fbm((x / size) * grain, (z / size) * grain, noiseSeed, 3) * contrast;
      let dens = (n + 1) / 2;
      if (near) {
        // A forest that begins where the town ends. Distance is measured in
        // world half-extents so it means the same on any size of world.
        const dd = Math.hypot(x - near.x, z - near.z) / (size * 0.5);
        dens += nearPull * Math.max(0, 1 - dd / (near.reach ?? 0.4));
      }
      if (rng() > (1 - clumping) + clumping * clamp(dens, 0, 1)) continue;
    }
    out.push({
      id: species[Math.floor(rng() * species.length)],
      x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10,
      rotationY: Math.round(rng() * TAU * 1000) / 1000,
      scale: Math.round((0.72 + rng() * 0.66) * 100) / 100,
    });
  }
  return out;
}
