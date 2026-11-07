/* climate.js — WHERE each biome is, once a world has more than one.
 *
 * A world has always worn exactly one palette: `params.biome` picks it, and
 * every metre of ground from the coast to the summit is that biome's ramp.
 * Elevation varies the colour; nothing varies the PLACE. A world whose
 * lowlands are marsh, whose interior is dry and whose heights are tundra is
 * not expressible, and that inexpressibility is a real part of why any two
 * worlds here resemble each other.
 *
 * So: two slow fields, TEMPERATURE and MOISTURE, drawn from their own seed
 * channel, and a table of anchors saying what climate each biome is native
 * to. A point's biome is whichever anchor its climate lands nearest, blended
 * toward the runner-up near the boundary so the border is a band and not a
 * contour line.
 *
 * ── what this deliberately is not ──
 * It is not a per-point palette REPLACEMENT. The primary biome
 * (`params.biome`) keeps everything it has always owned — the water tint, the
 * sky, the fog, the grass, the four splat materials, the minimap's sea. What
 * varies spatially is the GROUND COLOUR, because that is the one channel the
 * renderer already evaluates per vertex (the elevation ramp), so varying it
 * costs two field reads where the vertex already pays nine sampler calls for
 * its shade. Making the MATERIALS spatial would mean per-vertex splat-slot
 * selection — a different shader, for a different change.
 *
 * ── why the anchors are an argument and not an import ──
 * This file is engine/core: it may not import engine/style/palettes.js,
 * because a palette is CONTENT and the core holds algorithms and contracts
 * (see src/kernel/core/index.js). So the anchor table travels in: the caller
 * reads each palette's own `climate` field and hands the list over. The core
 * decides HOW climate picks a biome; the palettes say WHAT climate each biome
 * is native to.
 *
 * Pure JS. No three.js, no DOM, no Math.random, no clock — the boundary test
 * walks this file.
 */

import { seedChannel } from "../seed.js";
import { fbm } from "./noise.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* How many times the climate varies across the world, as a fraction of the
   terrain's own frequency — and MEASURED, not judged by eye, because the
   failure mode is quiet. The first value here was 0.35, which on the default
   frequency is 0.6 climate cycles across the whole plate: less than one wave,
   so a single world sits inside one narrow band of climate space and one
   anchor wins everywhere. The feature then looks configured and does nothing,
   on most seeds, forever.

   Swept over twenty seeds with the verdant/tundra/badlands triple, counting
   how many of the three actually appear on a 30×30 sampling of the plate:

       0.35   all three on  7/20 seeds
       0.80   all three on 16/20
       1.20   all three on 20/20
       2.00   all three on 20/20, regions visibly smaller

   1.2 is the smallest value that reliably delivers every listed biome — about
   two cycles across the plate — and smallest is what you want, because a
   region has to be large enough to read as a place rather than as
   camouflage. `params.climate.scale` multiplies it. */
export const CLIMATE_FREQUENCY = 1.2;

/** Is spatial climate asked for at all? Needs at least two biomes to blend
    between; null, absent, or a single name all mean the world it always was. */
export function hasClimate(params) {
  const c = params?.climate;
  return !!c && Array.isArray(c.biomes) && c.biomes.filter((b) => typeof b === "string").length >= 2;
}

/* How far the climate wanders from the world's own. fbm returns roughly ±0.55
   at three octaves (the weights sum below 1 and the extremes never line up),
   so this spreads it across most of the unit square without clipping whole
   regions flat against an end. */
export const CLIMATE_SPREAD = 0.9;

/**
 * `(x, z) → { temp, moist }`, both in [0, 1]. Deterministic from the seed's
 * own "climate" channel, so the same world always has its cold end in the
 * same place — and so the terrain channel is untouched: turning climate on
 * or off cannot move a single vertex of ground.
 *
 * ── WHY IT IS CENTRED ON THE WORLD'S OWN BIOME ──
 * `centre` defaults to the middle of climate space, and for a while that was
 * all it did — which quietly handed the world to whichever biome happened to
 * sit nearest the middle. Measured on Farshore, whose primary is shoreland
 * (0.42, 0.72) and whose second is parkland (0.60, 0.50): the field's mean sat
 * at about (0.48, 0.48), which is 0.12 from parkland and 0.24 from shoreland,
 * so PARKLAND COVERED 63% of the plate and up to 80% on some seeds. The world
 * still called itself shoreland, still took its water, sky and materials from
 * shoreland, and mostly looked like somewhere else.
 *
 * The primary biome is not one option among several — it is what the world
 * IS. So the field is centred on its anchor and wanders from there: the world
 * reads as itself, and the others appear where the climate has genuinely
 * drifted toward them.
 */
export function createClimateSampler(params, centre = { temp: 0.5, moist: 0.5 }) {
  const t = params.terrain;
  const seed = seedChannel(params.seed, "climate");
  const scale = params.climate?.scale ?? 1;
  const inv = (t.frequency * CLIMATE_FREQUENCY * scale) / t.size;
  const ct = clamp01(centre?.temp ?? 0.5), cm = clamp01(centre?.moist ?? 0.5);
  return function climate(x, z) {
    const nx = x * inv, nz = z * inv;
    return {
      temp: clamp01(fbm(nx + 13.7, nz - 41.3, seed, 3) * CLIMATE_SPREAD + ct),
      moist: clamp01(fbm(nx - 57.1, nz + 7.9, seed ^ 0x7f4a7c15, 3) * CLIMATE_SPREAD + cm),
    };
  };
}

/* ── the blend band ──
 * `w` below is d0/(d0+d1): 0 exactly on the nearest anchor, 0.5 on the
 * boundary with the runner-up. Inside BLEND_START the point is purely its own
 * biome; from there the runner-up fades in, reaching an even mix exactly at
 * the boundary. Because the roles swap by symmetry on the far side, the mix is
 * 0.5 from both directions at w = 0.5 and the band is seam-free.
 *
 * ── AND THE NUMBER IS MEASURED, because "most of the map" was wrong ──
 * This started at 0.25, on the reasoning that a quarter of the way to the
 * boundary is a generous pure region. That reasoning ignores what w actually
 * is: a RELATIVE distance. w < 0.25 means being three times closer to one
 * anchor than the other, which on a two-anchor world is a small disc around
 * each anchor rather than most of the plate. Measured on Farshore over eight
 * seeds — the percentage of the plate that comes out PURE (mix < 0.05):
 *
 *     anchors      0.25   0.30   0.35   0.40   0.45
 *     0.082 apart     2%     3%     6%    15%    47%
 *     0.188 apart    12%    19%    33%    55%    81%
 *     0.483 apart    36%    48%    60%    72%    86%
 *
 * At 0.25 even well-separated biomes had two thirds of the world sitting in a
 * blend band — which does not read as two places with a border between them,
 * it reads as one world painted in the average of two palettes. Nothing about
 * that throws; it just quietly makes the feature pointless, which is the same
 * failure CLIMATE_FREQUENCY had.
 *
 * 0.40 commits the majority of a well-separated world to a biome and still
 * leaves a fifth of the w range as a transition — a band you walk across, not
 * a line you step over. Above ~0.45 the band gets narrow enough to read as an
 * edge, which is the opposite failure.
 */
export const BLEND_START = 0.40;

/* ── how far apart two biomes have to be to be two biomes ──
 * From the same sweep, across every pair in the catalogue at BLEND_START 0.40:
 *
 *     0.082 apart (shoreland/weald)      9% of the plate pure
 *     0.132 apart (verdant/shoreland)   32%
 *     0.188 apart (meadow/shoreland)    46%
 *     0.284 apart (shoreland/parkland)  71%
 *
 * Under about 0.15 there is no setting of the blend band that helps, because
 * the two climates genuinely are the same climate — shoreland is a cool wet
 * coast and weald is cool and damp, and no amount of arithmetic makes those
 * different places. Pairing them does not produce a border; it produces a
 * world painted in the average of two palettes, on every seed, silently.
 *
 * So an anchor closer than this to one already accepted is DROPPED, the same
 * way an unknown biome name is, and for the same reason: a list the engine
 * cannot honour should come back visibly shorter rather than quietly wrong.
 * `createBiomeField` reports what it dropped and why, so an editor can say so.
 */
export const MIN_ANCHOR_SEPARATION = 0.15;

/**
 * Which biome a climate lands in, and how much of the runner-up shows.
 * `anchors` is [{ temp, moist }, …] in caller order. Returns
 * `{ a, b, mix }`: indices into that list, `mix` ∈ [0, 0.5] = the runner-up's
 * share. With one anchor the answer is trivially that anchor.
 */
export function biomeBlendAt(climate, anchors) {
  let a = 0, b = 0, d0 = Infinity, d1 = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const dt = climate.temp - anchors[i].temp, dm = climate.moist - anchors[i].moist;
    const d = Math.sqrt(dt * dt + dm * dm);
    if (d < d0) { d1 = d0; b = a; d0 = d; a = i; }
    else if (d < d1) { d1 = d; b = i; }
  }
  if (anchors.length < 2 || !(d0 + d1 > 0)) return { a, b: a, mix: 0 };
  const w = d0 / (d0 + d1);
  return { a, b, mix: 0.5 * smooth(BLEND_START, 0.5, w) };
}

/**
 * Everything a renderer needs, in one object, or null when the params do not
 * ask for spatial climate: the sampler, the anchor list, and the biome names
 * in anchor order. `resolveAnchor` maps a biome name to its anchor — the
 * caller supplies it (typically `(name) => PALETTES[name]?.climate`), for the
 * boundary reasons in the header. Names that resolve to no anchor are
 * dropped; fewer than two survivors means no climate, exactly as if the list
 * had never been written.
 */
export function createBiomeField(params, resolveAnchor) {
  if (!hasClimate(params)) return null;
  const names = [], anchors = [], dropped = [];
  for (const name of params.climate.biomes) {
    const a = typeof name === "string" ? resolveAnchor(name) : null;
    if (!a || typeof a.temp !== "number" || typeof a.moist !== "number") {
      dropped.push({ name, reason: "names no biome this build knows" });
      continue;
    }
    const anchor = { temp: clamp01(a.temp), moist: clamp01(a.moist) };
    /* First one in wins, so the list's own order decides which of two
       near-identical climates survives — the author wrote it, and the primary
       biome is conventionally first. */
    let near = -1;
    for (let i = 0; i < anchors.length; i++) {
      if (Math.hypot(anchor.temp - anchors[i].temp, anchor.moist - anchors[i].moist) < MIN_ANCHOR_SEPARATION) { near = i; break; }
    }
    if (near >= 0) {
      dropped.push({ name, reason: `too close to ${names[near]} in climate to read as a second place` });
      continue;
    }
    names.push(name);
    anchors.push(anchor);
  }
  if (names.length < 2) return null;
  /* Centred on the FIRST surviving anchor: the list's head is the world's own
     biome by convention (it is written there first, and it is the one that
     owns the water, the sky and the materials), so the world reads as itself
     and the rest appear where the climate has drifted toward them. */
  const sample = createClimateSampler(params, anchors[0]);
  return {
    names,
    anchors,
    dropped,
    sample,
    blendAt: (x, z) => biomeBlendAt(sample(x, z), anchors),
  };
}
