// Terrain masks: the derived fields a shader wants and a heightmap alone does
// not give — slope, curvature, ambient occlusion and flow accumulation.
//
// These exist so a buyer can RE-AUTHOR the look instead of accepting ours. A
// baked colour map says "this is what the ground is"; a slope and a flow mask say
// "here is where rock shows through and here is where water has run", which is
// what someone blending their own materials actually needs.
//
// Everything here is a pure function of the baked heightfield, so the same world
// always yields the same masks. `ao` reuses src/kernel/terrain/shading.js rather than
// re-deriving it, because the renderer and the export must not drift.
//
// Pure JS, no three.js — runs under the JavaScriptCore test suite.

import { epsFor, aoRadiusFor, aoFromConcavity } from "./shading.js";

/* Slope as a 0–1 fraction of a reference grade. 45° (grade 1.0) maps to 1.0, so
   the mask saturates on genuinely steep ground rather than on gentle hills. */
export const SLOPE_REFERENCE_GRADE = 1.0;

/* Curvature is signed in nature — convex ridges and concave valleys — and an
   8-bit mask cannot hold a sign, so it is remapped with 0.5 as flat. The scale
   is metres of second derivative per metre; ±0.05 covers ordinary terrain. */
export const CURVATURE_RANGE = 0.05;

/* Flow accumulation is heavy-tailed: a handful of cells collect most of the
   drainage, so a linear mask would be black everywhere but the main channel. The
   mask stores log(1 + accumulation) normalized to its own maximum. */
export const FLOW_LOG_BASE = Math.E;

/* ── the two masks that come out of the EROSION, not out of the heightfield ──

   Everything above is derived from the surface as it stands. These two are
   derived from what the water DID to it, which is a different question and one
   no amount of looking at the final surface can answer: a flat shelf of laid
   sediment and a flat shelf of scoured bedrock have the same slope, the same
   curvature and very nearly the same flow, and they are not the same ground.

   The particle simulation already knows — it moves material — and until now it
   threw the answer away, returning only the reshaped heights. It returns the
   NET DELTA now (engine/terrain/erosion-worker.js), and these turn it into
   something a shader can read.

   DEPOSITION_RANGE is the half-range in metres the signed mask covers, so 128
   is "nothing moved here", 255 is a metre and a half of sediment laid down and
   0 is a metre and a half stripped away. Chosen against this engine's own
   default erosion (35 000 drops over a 4 km plate, 420 m of amplitude), where
   the tail of the delta distribution sits a little under a metre: wide enough
   that channels do not clip, tight enough that ordinary ground is not all
   crushed into the middle two codes. */
export const DEPOSITION_RANGE = 1.5;

/* Wetness is where water LINGERS, which is not where it flows. A steep
   channel drains as fast as it fills; the same drainage over flat ground is a
   marsh. So the mask is the drainage, weighted by how flat the ground is, and
   again by whether it is a hollow or a shoulder — and the sediment the water
   dropped counts too, because fine material is what holds water once the
   channel has moved on.

   WET_GRADE_LIMIT is the grade at which flatness has run out entirely: 0.35
   is about 19°, past which running water does not stand around. */
export const WET_GRADE_LIMIT = 0.35;

/* Samples the four derived fields on a `res`² grid over the whole world.

   `sampleAt(ix, iz)` returns the world (x, z) for a grid cell, so the caller
   decides the orientation and this module never needs to know about
   handedness. That indirection was written for an exporter that wanted the
   masks in its own space; the exporter is gone and the renderer passes plain
   world coordinates, but the seam stays because it costs one call and it is
   what keeps a second consumer from having to fork the file.

   `deposition` is optional: the erosion pass's net height change per cell, on
   this same grid. It is not derivable from the surface at all (see
   DEPOSITION_RANGE), so it is passed in rather than computed, and omitting it
   leaves the two erosion masks at their neutral values.

   Returns six Uint8Array grids, row-major, in whatever order sampleAt implies. */
export function bakeTerrainMasks({ sampler, res, spacingMeters, sampleAt, deposition = null }) {
  const n = res * res;
  const slope = new Uint8Array(n);
  const curvature = new Uint8Array(n);
  const ao = new Uint8Array(n);
  const heights = new Float64Array(n);

  const eps = epsFor(spacingMeters);
  const aoR = aoRadiusFor(spacingMeters);

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const [x, z] = sampleAt(ix, iz);
      const y = sampler(x, z);
      const hE = sampler(x + eps, z), hW = sampler(x - eps, z);
      const hS = sampler(x, z + eps), hN = sampler(x, z - eps);
      const i = iz * res + ix;
      heights[i] = y;

      // Gradient magnitude — the same central difference the renderer uses.
      const grade = Math.hypot(hE - hW, hS - hN) / (2 * eps);
      slope[i] = quantize(grade / SLOPE_REFERENCE_GRADE);

      // Laplacian: positive in a bowl, negative on a ridge. 0.5 is flat.
      const laplacian = ((hE + hW + hS + hN) * 0.25 - y) / (eps * eps);
      curvature[i] = quantize(0.5 + laplacian / (2 * CURVATURE_RANGE));

      const micro = ((hE + hW + hS + hN) * 0.25 - y) / eps;
      const macro = ((sampler(x + aoR, z) + sampler(x - aoR, z) +
                      sampler(x, z + aoR) + sampler(x, z - aoR)) * 0.25 - y) / aoR;
      ao[i] = quantize(aoFromConcavity(micro, macro));
    }
  }

  const flow = bakeFlow(heights, res);
  return {
    slope, curvature, ao, flow,
    ...bakeErosionMasks({ slope, curvature, flow, deposition, res }),
  };
}

/* Deposition and wetness, from the four fields above plus the erosion delta.

   Split out rather than inlined so it can be called on its own — the delta
   arrives from a different worker than the surface does, and a caller that
   already holds slope/curvature/flow should not have to re-bake 600k samples
   to ask what the water left behind. Pure, like everything else here.

   `deposition` is a Float32Array of NET height change in metres on the same
   grid, or null for a world that never eroded — in which case the deposition
   mask is flat neutral and the wetness mask is the topographic answer alone,
   which is exactly how this rendered before the delta existed. */
export function bakeErosionMasks({ slope, curvature, flow, deposition = null, res }) {
  const n = res * res;
  const deposit = new Uint8Array(n);
  const wetness = new Uint8Array(n);
  const aligned = deposition && deposition.length === n;

  for (let i = 0; i < n; i++) {
    const d = aligned ? deposition[i] : 0;
    deposit[i] = quantize(0.5 + d / (2 * DEPOSITION_RANGE));

    // Flatness: 1 on the level, 0 at WET_GRADE_LIMIT and steeper. slope[i] is
    // already the grade over SLOPE_REFERENCE_GRADE, so put it back in grades.
    const grade = (slope[i] / 255) * SLOPE_REFERENCE_GRADE;
    const flat = Math.max(0, 1 - grade / WET_GRADE_LIMIT);
    // Hollows hold, shoulders shed. curvature is 0.5-centred (see the header).
    const hollow = Math.max(0, (curvature[i] - CURVATURE_NEUTRAL) / (255 - CURVATURE_NEUTRAL));
    /* The drainage, curved. flow is already log-normalised, so the channels
       are near 1 and everything else is spread across the low end; the 0.65
       power lifts the merely damp out of the floor without flattening the
       channel's own lead. */
    const drain = Math.pow(flow[i] / 255, 0.65);
    // Laid sediment holds water after the channel has wandered off it.
    const sed = aligned ? Math.max(0, Math.min(1, d / DEPOSITION_RANGE)) : 0;
    wetness[i] = quantize((drain * (0.62 + 0.5 * hollow) + sed * 0.35) * flat);
  }
  return { deposit, wetness };
}

/* D8 flow accumulation: every cell drains to its lowest of eight neighbours, and
   each cell's accumulation is one plus everything that drains into it.

   Processing cells from highest to lowest is what makes a single pass correct —
   by the time a cell is visited, everything upslope of it has already pushed its
   water down. That is O(n log n) for the sort and O(n) for the routing, where a
   naive per-cell trace would be O(n · path length).

   Flat and pit cells simply keep their own 1: without a depression-filling pass
   there is nowhere for their water to go, and inventing an outlet would be
   inventing terrain. */
export function bakeFlow(heights, res) {
  const n = res * res;
  const accum = new Float64Array(n).fill(1);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Descending height — Int32Array sort needs a comparator for numeric order.
  const sorted = Array.prototype.slice.call(order).sort((a, b) => heights[b] - heights[a]);

  for (const i of sorted) {
    const ix = i % res, iz = (i / res) | 0;
    let lowest = -1, drop = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= res || jz >= res) continue;
        const j = jz * res + jx;
        // Diagonal steps cover √2 cells, so compare gradient rather than raw drop.
        const dist = dx && dz ? Math.SQRT2 : 1;
        const d = (heights[i] - heights[j]) / dist;
        if (d > drop) { drop = d; lowest = j; }
      }
    }
    if (lowest >= 0) accum[lowest] += accum[i];
  }

  // Log-normalize: a linear mask would be black everywhere but the main channel.
  let max = 0;
  for (let i = 0; i < n; i++) {
    accum[i] = Math.log(1 + accum[i]);
    if (accum[i] > max) max = accum[i];
  }
  const flow = new Uint8Array(n);
  if (max > 0) for (let i = 0; i < n; i++) flow[i] = quantize(accum[i] / max);
  return flow;
}

/* One byte per value. A deliberate asymmetry to know about: quantize(0.5) is
   exactly 128 (Math.round(127.5) rounds up), so "flat" encodes exactly as
   CURVATURE_NEUTRAL — but the shader's decode, 128/255, comes back as
   0.50196, a +0.002 bias no 8-bit channel can avoid. Invisible at this
   depth, and re-centring the encoding would shift every mask ever baked, so
   it is documented here and asserted in tools/test/kernel/masks.test.js instead. */
const quantize = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/* The four masks as one RGBA buffer, ready to become a DataTexture.

   Four separate single-channel textures would be four samplers and four
   fetches per fragment for data that is always wanted together; packed, the
   terrain shader pays ONE fetch for all four. The channel order is the
   contract with that shader, and it is written down here rather than there
   because this is the side that can be tested:

     R  slope       0 = flat,     255 = 45° or steeper
     G  curvature   128 = flat,   <128 convex ridge, >128 concave hollow
     B  ao          0 = occluded, 255 = open sky
     A  flow        0 = ridge,    255 = the main channel

   Note G's midpoint: curvature is signed and eight bits cannot hold a sign,
   so 0.5 is flat and a consumer must subtract before it means anything. A
   shader that reads G raw gets a terrain that is uniformly "half concave",
   which looks like a plausible dirt tint and is why this is stated twice. */
export function packTerrainMasks({ slope, curvature, ao, flow }) {
  const n = slope.length;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    rgba[o] = slope[i];
    rgba[o + 1] = curvature[i];
    rgba[o + 2] = ao[i];
    rgba[o + 3] = flow[i];
  }
  return rgba;
}

/* The two erosion masks as one RG buffer, ready to become a DataTexture.

   A second texture rather than two more channels on the first, because the
   first has no room: all four of its channels are spoken for and the shader
   reads three of them every fragment. RG8 is the narrowest format that holds
   these two, and it is filterable everywhere.

     R  deposition  128 = nothing moved · >128 sediment laid down ·
                    <128 material stripped away. ±DEPOSITION_RANGE metres
                    full scale, so a consumer must centre it before it means
                    anything — the same trap curvature sets, for the same
                    reason, which is why both are stated here.
     G  wetness     0 = sheds · 255 = holds water

   Note what the neutral values are: a world that never eroded packs
   (128, 0) everywhere, and both of those are the identity in the shader —
   no sediment, no marsh — so the map's absence and its presence over
   untouched ground render the same. */
export function packErosionMasks({ deposit, wetness }) {
  const n = deposit.length;
  const rg = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    rg[i * 2] = deposit[i];
    rg[i * 2 + 1] = wetness[i];
  }
  return rg;
}

/* Flat in the packed encoding, so a consumer never has to remember that 128
   rather than 0 is the neutral curvature. Deposition shares the convention
   and the trap, so it shares the constant. */
export const CURVATURE_NEUTRAL = 128;
export const DEPOSITION_NEUTRAL = 128;
