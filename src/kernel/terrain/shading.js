// Terrain shading: the slope darkening and baked ambient occlusion that turn a
// flat palette ramp into readable ground.
//
// This lives on its own because TWO readers need to agree bit-for-bit: the
// quadtree that writes it into vertex colours, and the Unity exporter that
// bakes it into a per-tile colour map. When the formula lived only inside
// QuadtreeTerrain._buildTile, the exporter's approximation of it was wrong by
// up to a third of the colour range — and nothing could catch that, because
// there was nothing to compare against.
//
// Pure JS, no three.js: runs under the JavaScriptCore test suite.

export const SLOPE_GAIN = 0.55;   // how fast steepness darkens ground
export const SLOPE_CAP = 0.42;    // …and how dark it is allowed to get
export const AO_MACRO = 1.35;     // valley-scale concavity weight
export const AO_MICRO = 0.22;     // texel-scale concavity weight
export const AO_GAIN = 1.5;
export const AO_CAP = 0.5;

// Central-difference half-width, and the AO probe radius. Both follow the
// sample spacing so a coarse grid does not reach across half the world for its
// average — clamped to valley scale, which is what makes bowls and gullies
// darken while ridges stay bright.
export const epsFor = (step) => Math.max(step * 0.5, 1);
export const aoRadiusFor = (step) => Math.min(Math.max(step * 3, 8), 90);

export const slopeShade = (slope) => 1 - Math.min(slope * SLOPE_GAIN, SLOPE_CAP);

export const aoFromConcavity = (micro, macro) =>
  1 - Math.min(Math.max(macro * AO_MACRO + micro * AO_MICRO, 0) * AO_GAIN, AO_CAP);

/* The whole term, for callers that do not already have the derivatives in hand.
   `step` is the grid spacing in metres the caller is shading at; the multiplier
   returned scales a linear palette colour. */
export function terrainShadeAt(sampler, x, z, step) {
  const eps = epsFor(step);
  const aoR = aoRadiusFor(step);
  const y = sampler(x, z);
  const hE = sampler(x + eps, z), hW = sampler(x - eps, z);
  const hS = sampler(x, z + eps), hN = sampler(x, z - eps);
  const dx = hE - hW, dz = hS - hN;
  const micro = ((hE + hW + hS + hN) * 0.25 - y) / eps;
  const macro = ((sampler(x + aoR, z) + sampler(x - aoR, z) +
                  sampler(x, z + aoR) + sampler(x, z - aoR)) * 0.25 - y) / aoR;
  return slopeShade(Math.hypot(dx, dz) / (2 * eps)) * aoFromConcavity(micro, macro);
}
