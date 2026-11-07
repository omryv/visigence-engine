/**
 * THE GROUND — your game supplies this, and the default is the floor the engine
 * always had.
 *
 * `PlayerController` used to resolve its vertical position against the literal `y = 0`,
 * with a comment saying the level is a single floor plane. That was true of the level
 * this engine was extracted from and it is the one assumption that stops a generated
 * world being walkable at all. This module is the seam that replaces it.
 *
 * Like the other two seams (`sim/grid.js`, `core/progression.js`)
 * it ships with a WORKING EMPTY DEFAULT: `FLAT_GROUND` answers height 0 and normal up
 * everywhere, so an engine handed no terrain behaves exactly as it did before this file
 * existed. That is not politeness — it is what lets the change be adopted without
 * re-testing every level that was already flat.
 *
 * ---------------------------------------------------------------------------
 * NO THREE.JS HERE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * Normals are written into any `{x, y, z}` the caller owns rather than returned as a
 * `Vector3`. `tools/build/bake-level.mjs` needs exactly these queries to decide which
 * cells are walkable, and a baker that imports the renderer is a baker that cannot run
 * in the test harness. The runtime passes its `Vector3` in; it satisfies `{x,y,z}`.
 *
 * ---------------------------------------------------------------------------
 * THE RUNTIME READS A BAKED FIELD, NOT THE RECIPE
 * ---------------------------------------------------------------------------
 * `createHeightSampler` is tens of noise octaves per query and the player asks for a
 * height every fixed step. More importantly, the baker decided which cells are walkable
 * by sampling SOMETHING, and if the runtime samples something else — even by a
 * floating-point hair — the player can stand where collision says they cannot. So the
 * baked field is the single source of truth for both, and the analytic sampler is an
 * offline input to it.
 */

/* The height field is the repository's kernel (src/kernel/terrain/heightfield.js at the root): the
   same sampler, baker and bilinear reader every world in the repository is built with, imported
   rather than ported. The ground NORMAL below is this engine's own: the kernel has no use for one
   (its walker reads slopes), and the body needs one every fixed step. */
import { createBakedSampler, slopeAt as fieldSlopeAt } from '../kernel/terrain/heightfield.js';

/**
 * The ground normal at a point, written into `out` as a plain {x,y,z}.
 *
 * Central differences, the same `eps` either side as the kernel's `slopeAt`, so the two agree by
 * construction: |(nx, nz)| / ny is the slope `slopeAt` reports for the same sampler, point and eps.
 * It is a property of the height field rather than of the body, and it lives here because this is
 * the module the body and the baker both read the ground through.
 */
export function normalAt(sampler, x, z, out, eps = 2) {
  const dx = sampler(x + eps, z) - sampler(x - eps, z);
  const dz = sampler(x, z + eps) - sampler(x, z - eps);
  const nx = -dx, nz = -dz, ny = 2 * eps;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  out.x = nx / len; out.y = ny / len; out.z = nz / len;
  return out;
}

/**
 * A height field plus the traversal rules that were baked against it.
 *
 * @param {{res: number, size: number, data: Float32Array, min: number, max: number}} field
 * @param {object} [traversal]  the spec's traversal block; only `maxSlope`, `seaLevel`
 *   and `wadeDepth` are read here, and only to answer `standableAt`.
 */
export class Terrain {
  constructor(field, traversal = {}) {
    this.field = field;
    this.size = field.size;
    this.min = field.min;
    this.max = field.max;
    this.sampler = createBakedSampler(field);
    this.maxSlope = traversal.maxSlope ?? 0.85;
    /**
     * Water surface height in metres. The height field is already normalised about sea
     * level by the plate (see src/kernel/terrain/heightfield.js), so this is 0 unless a spec deliberately
     * floods or drains a world after the fact.
     */
    this.waterLevel = traversal.waterLevel ?? 0;
    this.wadeDepth = traversal.wadeDepth ?? 0.9;
    /**
     * How far the body may be set down onto ground that has dropped away beneath it
     * without going airborne. Defaults to the spec's `stepUp` deliberately: the baker
     * flooded the mask by refusing neighbours more than `stepUp` apart, so a drop the
     * body cannot step down is, by construction, a neighbour the mask never joined.
     * One number, two consumers, no drift. See PlayerController's vertical resolve.
     */
    this.stepDown = traversal.stepDown ?? traversal.stepUp ?? 0.55;
    /**
     * The slope probe distance. Kept on the instance rather than passed per call so the
     * baker and the runtime cannot disagree about it — they ask the same object.
     */
    this.slopeEps = traversal.slopeEps ?? 2;
    /**
     * Local water, when the world has ponds and brooks at their own levels rather than one sea: a baked grid of
     * depths ({res, size, data}, metres of water over the ground, 0 where dry) sampled like the heights. Arcade's
     * village (world/worldTerrain.js) supplies one; without it the sea level above answers.
     */
    this.depthSampler = traversal.depth ? createBakedSampler(traversal.depth) : null;
  }

  /** Ground height in metres at a world (x, z). */
  heightAt(x, z) { return this.sampler(x, z); }

  /** Slope in metres per metre. */
  slopeAt(x, z) { return fieldSlopeAt(this.sampler, x, z, this.slopeEps); }

  /** Unit ground normal written into `out` ({x,y,z} — a Vector3 qualifies). */
  normalAt(x, z, out) { return normalAt(this.sampler, x, z, out, this.slopeEps); }

  /** How deep the water is over this point, or 0 on dry land. */
  depthAt(x, z) {
    if (this.depthSampler) return Math.max(0, this.depthSampler(x, z));
    return Math.max(0, this.waterLevel - this.heightAt(x, z));
  }

  /**
   * Can a player stand here?
   *
   * Two tests, and they fail for different reasons worth keeping apart: too steep is a
   * cliff face, too deep is open water. Both are "not walkable"; only one of them is
   * somewhere you can swim past later.
   */
  standableAt(x, z) {
    if (this.depthAt(x, z) > this.wadeDepth) return false;
    return this.slopeAt(x, z) <= this.maxSlope;
  }

  /** Is this point outside the baked plate entirely? */
  outsideAt(x, z) {
    const h = this.size * 0.5;
    return x < -h || x > h || z < -h || z > h;
  }
}

/**
 * The empty default: the flat floor at y = 0 this engine assumed before terrain
 * existed. Anything that takes a terrain accepts this and behaves as it always did.
 */
export const FLAT_GROUND = {
  field: null,
  size: Infinity,
  min: 0,
  max: 0,
  waterLevel: -Infinity,
  maxSlope: Infinity,
  /**
   * Irrelevant on a plane — the ground never drops away, so the step-down branch cannot
   * fire — but present so that anything reading it off a terrain gets a number rather
   * than `undefined`, which would compare false against every drop and silently make
   * the player airborne.
   */
  stepDown: 0.55,
  heightAt() { return 0; },
  slopeAt() { return 0; },
  normalAt(x, z, out) { out.x = 0; out.y = 1; out.z = 0; return out; },
  depthAt() { return 0; },
  standableAt() { return true; },
  outsideAt() { return false; },
};

/**
 * Rebuild a Terrain from what `tools/build/bake-level.mjs` wrote.
 *
 * The baked module stores heights as a base64 Float32Array rather than a JSON number
 * array: a 257x257 field is 66k floats, which is ~700 KB as text and 264 KB as bytes,
 * and it parses in one pass instead of sixty-six thousand.
 */
export function terrainFromBaked(baked, traversal) {
  const bin = atob(baked.HEIGHT_PACKED);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const data = new Float32Array(bytes.buffer);
  const res = baked.HEIGHT_RES;
  if (data.length !== res * res) {
    throw new Error(
      `terrainFromBaked: HEIGHT_PACKED holds ${data.length} floats, expected ${res * res}`);
  }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return new Terrain({ res, size: baked.WORLD_SCALE, data, min, max }, traversal);
}
