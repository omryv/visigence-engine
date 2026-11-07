/* canonical.js — THE GROUND A WORLD ACTUALLY HAS.
 *
 * A world's params describe a terrain function. Its GROUND is what you get
 * when that function is run all the way through: baked onto the 513² grid,
 * eroded by its own droplet budget on its own seed channel, then flooded from
 * the sea edge and drained. Four stages, in that order, and the answer is
 * bit-exact for a given params object.
 *
 * There used to be three copies of those four stages — hero/library-worker.js
 * for the shelf, engine/Engine.js for the editor, scripts/world-file.mjs for
 * the committed files — and three copies of a deterministic pipeline is three
 * chances for one of them to drift into being a different world wearing the
 * same seed. That is not hypothetical: it is exactly the class of bug this
 * module was extracted to close.
 *
 * ── 513 IS NOT A CHOICE ──
 * Droplet erosion is resolution-dependent: a drop steps one CELL per
 * iteration, so the same seed on a coarser grid walks further in metres and
 * cuts a different valley. Every consumer of this module therefore bakes at
 * the same grid, and CANONICAL_RES is where that number lives. A renderer may
 * tessellate its MESH at any density it likes — that is presentation — but it
 * may not re-derive the FIELD at another resolution.
 *
 * ── AND EROSION RUNS ONCE ──
 * bakeCanonicalGround takes an explicit `erode` flag, and `masksFor` exists
 * separately, so a caller that already HOLDS an eroded field can derive its
 * masks without going anywhere near the simulation again. Re-running a stage
 * over ground that has already been through it is the other half of the same
 * bug, and the shape of this module is what makes it hard to write.
 *
 * Pure JS — no three.js, no DOM. Runs in a worker, in the Node suite and
 * under JavaScriptCore.
 */

import { createHeightSampler, bakeHeightField } from "./heightfield.js";
import { erodeWithDelta } from "./erosion.js";
import { bakeFlow } from "./masks.js";
import { seedChannel } from "../seed.js";
import { floodFromSea } from "../water/flood.js";

/* The erosion grid. engine/Engine.js (_kickErosion), hero/library-worker.js and
   scripts/world-file.mjs all bake here; a field that arrives at anything else
   is a field from another program. */
export const CANONICAL_RES = 513;

/** The canonical grid's cell size in metres — the ONE reference step every
    reader that colours the ground shades at (see terrainShadeAt). The editor's
    tiles, the shelf's slab and the export mesh used to each shade at their own
    mesh spacing, which made the AO probe radius differ by up to 11× between
    three pictures of the same world — and made the ground recolour whenever a
    tile changed LOD level. One step, one answer. */
export const canonicalStep = (size) => size / (CANONICAL_RES - 1);

/** Recompute a field's own min/max in place, and return it. Erosion moves
    both ends, and every reader downstream (the slab's thickness, the elevation
    ramp's range readout) wants the eroded extremes rather than the analytic
    ones. */
export function remeasure(field) {
  let min = Infinity, max = -Infinity;
  for (const v of field.data) { if (v < min) min = v; if (v > max) max = v; }
  field.min = min; field.max = max;
  return field;
}

/** The two masks a baked field implies: which cells the sea reaches (a
    hollow with no path to open water is dry ground, not a lake) and how much
    water drains through each. Takes the FIELD, never the params, precisely so
    it cannot be mistaken for a stage that regenerates anything. */
export function masksFor(field, level = 0) {
  return {
    wet: floodFromSea(field, null, level).wet,
    flow: bakeFlow(field.data, field.res),
  };
}

/**
 * The surface: `{ field, delta }`.
 *
 *   field   { res, size, data, min, max } — heights in world metres
 *   delta   Float32Array of (after − before) per cell, or null when nothing
 *           eroded. The only record of which ground was STRIPPED and which
 *           was BURIED — the terrain shader's deposition mask needs it, and it
 *           cannot be re-derived from the final surface.
 *
 * `sampler` overrides the analytic one (the engine passes its sculpt-free base
 * sampler). `erode: false` stops before the simulation, which is what the
 * shelf's first sweep wants: a surface to stand on within the first beat, to
 * be REPLACED by this same function's eroded answer a second later.
 *
 * `mark(stage)`, when given, is called once as each stage FINISHES — "bake",
 * then "erode" only if the simulation actually ran. It is a hook and nothing
 * more: it receives a name, its return value is ignored, and it cannot see or
 * change the field. It exists so src/kernel/terrain/ground.js can time the stages
 * of THIS bake rather than re-implementing the stages to time its own copy,
 * which is the duplication this module was extracted to end. There is no
 * clock in here; whoever passes a mark brings one.
 */
export function bakeErodedField(params, { res = CANONICAL_RES, sampler = null, erode = true, mark = null } = {}) {
  const field = bakeHeightField(params, res, sampler || createHeightSampler(params));
  if (mark) mark("bake");
  const e = params.terrain?.erosion;
  if (!erode || !e?.enabled) return { field, delta: null };
  const out = erodeWithDelta(field.data, res, field.size / (res - 1), e, seedChannel(params.seed, "erosion"));
  field.data = out.data;
  remeasure(field);
  if (mark) mark("erode");
  return { field, delta: out.delta };
}

/** The whole ground of a world: the surface plus the two masks it implies —
    `{ field, wet, flow, delta }`. Everything a second renderer needs to draw
    this world without deriving one stage of it for itself. `opts.mark`, if
    given, also hears "masks" once both masks exist (see bakeErodedField). */
export function bakeCanonicalGround(params, opts = {}) {
  const { field, delta } = bakeErodedField(params, opts);
  const { wet, flow } = masksFor(field, params.water?.level || 0);
  if (opts.mark) opts.mark("masks");
  return { field, wet, flow, delta };
}
