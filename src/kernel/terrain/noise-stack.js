/* noise-stack.js — the SHAPE of the ground, as an ordered list.
 *
 * ── what this replaces, and what it deliberately does not ──
 *
 * `heightfield.js` has always held one recipe: warp the coordinates, blend fbm
 * against a ridged crest, add a continent mask, optionally pull a radial
 * island out of it and optionally terrace the result. Ten sliders drive it and
 * they are good sliders, but the STRUCTURE is fixed — every world this tool
 * has ever made is that recipe wearing a different palette, which is most of
 * why Badlands and Verdant read as the same land in two colours rather than as
 * two places. There is no arrangement of those ten numbers that puts a crater
 * field on a world, or cracks a mud flat, or runs a canyon across it.
 *
 * So the shape becomes a list of typed layers, each blended into what the
 * layers before it accumulated, each optionally masked to part of the world.
 *
 * WHAT IT DOES NOT TOUCH is the plate discipline underneath — sea level, the
 * square edge falloff that sinks the world's rim into open water, the gentler
 * sea floor and the vertical scale. Those are not part of the recipe, they are
 * what makes a finite square of noise into a walkable island with a coastline
 * instead of a cliff into the void, and they run after ANY stack. A layer can
 * make a world unrecognisable; it cannot make one that ends in a wall.
 *
 * ── why there is no GLSL here ──
 * Because this engine bakes. The height field is evaluated on the CPU at
 * CANONICAL_RES, eroded, and handed to the renderer as data (terrain/
 * canonical.js), so the stack needs one evaluator rather than a CPU one and a
 * shader one kept in step. That is a straightforward consequence of the bake
 * and it removes the entire class of bug where the ground you walk on and the
 * ground you see are computed by two different programs.
 *
 * ── determinism, and where a layer's seed comes from ──
 * From its own `seedOffset` and nothing else — not from its position in the
 * list. Deriving it from the index would mean DRAGGING A LAYER CHANGED WHAT IT
 * DREW, which is indefensible in an editor: reordering is a statement about
 * compositing order, not about content. The consequence is that two layers of
 * the same type sharing an offset are the same field, which is the honest
 * reading of "same seed, same parameters" and is what a stack wants when it
 * blends a field against itself under two different masks.
 *
 * Pure JS: no three.js, no DOM, no Math.random, no clock. Runs in the erosion
 * worker, in the Node suite and under JavaScriptCore, like everything else the
 * core is made of.
 */

import { valueNoise, fbm, ridged, billow, voronoi, crater, dune, channel } from "./noise.js";

export const NOISE_STACK_VERSION = 1;

/* A ceiling on evaluated layers. Every sample of the height field walks this
   list, and the field is baked at 513² and then eroded by tens of thousands of
   droplets that each re-read it — so a stack is not a thing you pay for once.
   Twelve is well past any world in the catalogue and cheap to hold. */
export const MAX_LAYERS = 12;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/* ── blend modes ──
 * `eff` is the layer's effective contribution: strength × opacity × its mask
 * chain. Every mode honours it as a mix toward the blended result, so a masked
 * layer fades out where the mask is zero rather than switching off at an edge.
 *
 * `carve` and `flatten` are the two that are not symmetric and are the two
 * that get used most. Carve only ever removes material, which is what a river
 * or a canyon is: a valley layer under `subtract` also lifts the ground
 * wherever its field happens to be negative, and a world with an inverted
 * riverbed running across it is a bug nobody reads as one. Flatten pulls
 * toward zero rather than toward the layer, which is how a plain gets laid
 * under a mountain range without inventing a second surface to blend to.
 */
export const BLEND_MODES = ["add", "subtract", "multiply", "max", "min", "replace", "difference", "carve", "flatten"];

function blend(mode, h, v, eff) {
  switch (mode) {
    case "add": return h + v * eff;
    case "subtract": return h - v * eff;
    case "multiply": return h + (h * v - h) * eff;
    case "max": return h + (Math.max(h, v) - h) * eff;
    case "min": return h + (Math.min(h, v) - h) * eff;
    case "replace": return h + (v - h) * eff;
    case "difference": return h + (Math.abs(h - v) - h) * eff;
    case "carve": return h - Math.max(v, 0) * eff;
    case "flatten": return h + (h * (1 - Math.abs(v)) - h) * eff;
    default: return h + v * eff;
  }
}

/* ── the type registry ──
 * Each entry carries its own parameter defaults, so a layer saved by an older
 * build and reloaded by a newer one gains the new knob at its default instead
 * of evaluating to NaN. `kind` separates the fields, which produce a value to
 * blend, from the modifiers, which change the state the layers after them see.
 *
 * `controls` is the same knobs with the range a person may move them through,
 * and it lives HERE rather than in the editor because a registry that
 * describes a type everywhere except on screen is a registry the editor has
 * to duplicate — and the duplicate is what goes stale. tests/noise-stack
 * asserts controls and defaults name exactly the same keys, so adding a
 * parameter without a way to reach it, or a slider for a parameter nothing
 * reads, both fail rather than ship.
 *
 * `RANGE` is the shared spatial-frequency control: every field type that
 * samples a position has one, and it means the same thing on all of them.
 */
const RANGE = { key: "scale", label: "Scale", min: 0.1, max: 8, step: 0.05 };
const OCTAVES = [
  { key: "octaves", label: "Octaves", min: 1, max: 8, step: 1 },
  { key: "lacunarity", label: "Lacunarity", min: 1.5, max: 3.5, step: 0.01 },
  { key: "gain", label: "Gain", min: 0.15, max: 0.85, step: 0.01 },
];
export const NOISE_TYPES = [
  {
    id: "legacy", label: "Classic Terrain", kind: "field", blend: "replace", strength: 1,
    about: "The recipe this engine shipped with — warped fbm against a ridged crest, on a continent mask. Driven by the Terrain sliders, not by this layer.",
    defaults: {},
    controls: [],
    // Supplied by the caller: the stack cannot reach params, and this layer is
    // the one place the two systems meet.
    sample: (x, z, seed, p, ctx) => (ctx.legacy ? ctx.legacy(ctx.worldX, ctx.worldZ) : 0),
  },
  {
    id: "fbm", label: "Fractal", kind: "field", blend: "add", strength: 0.4,
    about: "Layered value noise. General relief — rolling country, and the broad variation everything else sits on.",
    defaults: { scale: 1, octaves: 5, lacunarity: 2, gain: 0.5 },
    controls: [RANGE, ...OCTAVES],
    sample: (x, z, seed, p) => fbm(x, z, seed, octaves(p), p.lacunarity, p.gain),
  },
  {
    id: "ridged", label: "Ridged", kind: "field", blend: "add", strength: 0.5,
    about: "Sharp crests and chains. Alpine ranges, canyon rims, anything that should have a spine.",
    defaults: { scale: 1, octaves: 5, lacunarity: 2, gain: 0.5 },
    controls: [RANGE, ...OCTAVES],
    sample: (x, z, seed, p) => ridged(x, z, seed, octaves(p), p.lacunarity, p.gain),
  },
  {
    id: "billow", label: "Billow", kind: "field", blend: "add", strength: 0.4,
    about: "Rounded lobes. Soft hills and dune fields seen from above — ridged's opposite temperament.",
    defaults: { scale: 1, octaves: 5, lacunarity: 2, gain: 0.5 },
    controls: [RANGE, ...OCTAVES],
    sample: (x, z, seed, p) => billow(x, z, seed, octaves(p), p.lacunarity, p.gain),
  },
  {
    id: "value", label: "Value", kind: "field", blend: "add", strength: 0.3,
    about: "One octave of the base noise. Broad zones and mask material rather than terrain in its own right.",
    defaults: { scale: 1 },
    controls: [RANGE],
    sample: (x, z, seed) => valueNoise(x, z, seed),
  },
  {
    id: "constant", label: "Constant", kind: "field", blend: "add", strength: 1,
    about: "A flat value. Raises or lowers everything under it, or gives a mask something to reveal.",
    defaults: { value: 0.1 },
    controls: [{ key: "value", label: "Value", min: -1, max: 1, step: 0.01 }],
    sample: (x, z, seed, p) => p.value,
  },
  {
    id: "voronoi", label: "Cellular", kind: "field", blend: "add", strength: 0.4,
    about: "Cell noise. Tectonic plates, cracked flats, ice — the Edge mode draws the walls between cells.",
    defaults: { scale: 2, jitter: 1, mode: 2 },
    controls: [RANGE, { key: "jitter", label: "Jitter", min: 0, max: 1, step: 0.01 },
      { key: "mode", label: "Reading", min: 0, max: 2, step: 1, choices: ["Cell", "Distance", "Edge"] }],
    sample: (x, z, seed, p) => voronoi(x, z, seed, p.jitter, p.mode | 0),
  },
  {
    id: "crater", label: "Crater", kind: "field", blend: "add", strength: 0.5,
    about: "Impact bowls inside raised rims. Dead worlds, and one good way to break up a plain.",
    defaults: { scale: 1.5, density: 0.55, depth: 0.6, rim: 0.3, rimWidth: 0.35 },
    controls: [RANGE, { key: "density", label: "Density", min: 0, max: 1, step: 0.01 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01 },
      { key: "rim", label: "Rim", min: 0, max: 1, step: 0.01 },
      { key: "rimWidth", label: "Rim width", min: 0.05, max: 1, step: 0.01 }],
    sample: (x, z, seed, p) => crater(x, z, seed, p),
  },
  {
    id: "dune", label: "Dune", kind: "field", blend: "add", strength: 0.35,
    about: "Wind-shaped crests running across a bearing, with a finer ripple along the faces.",
    defaults: { scale: 1.2, direction: 0.7, sharpness: 1.4, rippleScale: 4, rippleStrength: 0.12 },
    controls: [RANGE, { key: "direction", label: "Wind bearing", min: 0, max: 6.28, step: 0.01 },
      { key: "sharpness", label: "Sharpness", min: 0.3, max: 4, step: 0.05 },
      { key: "rippleScale", label: "Ripple scale", min: 0.5, max: 12, step: 0.1 },
      { key: "rippleStrength", label: "Ripple", min: 0, max: 0.6, step: 0.01 }],
    sample: (x, z, seed, p) => dune(x, z, seed, p),
  },
  {
    id: "channel", label: "Channel", kind: "field", blend: "carve", strength: 0.5,
    about: "A meandering trough along a bearing. Under Carve — its default — it is a river valley; it never lifts ground.",
    defaults: { scale: 1, direction: 1.2, width: 0.3, meander: 1.2, meanderScale: 0.6 },
    controls: [RANGE, { key: "direction", label: "Bearing", min: 0, max: 6.28, step: 0.01 },
      { key: "width", label: "Width", min: 0.02, max: 1.5, step: 0.01 },
      { key: "meander", label: "Meander", min: 0, max: 4, step: 0.05 },
      { key: "meanderScale", label: "Meander scale", min: 0.05, max: 3, step: 0.05 }],
    sample: (x, z, seed, p) => channel(x, z, seed, p),
  },
  {
    id: "warp", label: "Domain Warp", kind: "modifier", blend: "replace", strength: 1,
    about: "Bends the coordinates every layer BELOW it samples at. Breaks the grain out of anything too regular.",
    defaults: { scale: 1, amount: 0.5 },
    controls: [RANGE, { key: "amount", label: "Amount", min: 0, max: 2, step: 0.01 }],
    modify: (state, seed, p, eff) => {
      const wx = fbm(state.x * p.scale + 31.7, state.z * p.scale + 11.3, seed, 3);
      const wz = fbm(state.x * p.scale - 24.1, state.z * p.scale - 47.9, seed ^ 0x517cc1b7, 3);
      state.x += wx * p.amount * eff;
      state.z += wz * p.amount * eff;
    },
  },
  {
    id: "terrace", label: "Terrace", kind: "modifier", blend: "replace", strength: 1,
    about: "Steps everything accumulated so far into plateaus. Strata, rice terraces, mesa country.",
    defaults: { count: 12, smoothness: 0.5 },
    controls: [{ key: "count", label: "Steps", min: 2, max: 40, step: 1 },
      { key: "smoothness", label: "Softness", min: 0.02, max: 1, step: 0.01 }],
    modify: (state, seed, p, eff) => {
      const steps = Math.max(1, Math.round(p.count));
      const t = state.h * steps;
      const frac = t - Math.floor(t);
      const s = smoothstep(0.5 - p.smoothness * 0.5, 0.5 + p.smoothness * 0.5, frac);
      const stepped = (Math.floor(t) + s) / steps;
      state.h += (stepped - state.h) * eff;
    },
  },
];

// fbm/ridged/billow divide by an accumulated norm, so zero octaves is 0/0 and
// NaN for the whole plate — the same failure worldfile.js refuses at the door
// for terrain.octaves. Clamped here so a stack cannot reach it at all.
const octaves = (p) => Math.max(1, Math.min(8, Math.round(p.octaves || 1)));

const TYPES = new Map(NOISE_TYPES.map((t) => [t.id, t]));
export function getNoiseType(id) { return TYPES.get(id) || null; }

/* ── masks ──
 * A layer's contribution multiplied by a 0..1 chain, so it lands on part of
 * the world rather than all of it. Two kinds, which between them cover what
 * masks are actually reached for:
 *
 *   height  a band on what the layers BELOW have already built — "put scree
 *           only above the treeline", "crack only the floor of the basin".
 *           It reads the accumulated value, so it is a statement about the
 *           terrain rather than about the coordinates.
 *   noise   a soft threshold on a field of its own — regions, patchiness,
 *           "this happens over here and not over there".
 *
 * There is no slope mask, deliberately: slope is a derivative, a sampler here
 * evaluates one point with no neighbours, and faking it with two extra samples
 * would triple the cost of every layer that used one. terrain/masks.js already
 * derives a real slope mask from the baked field, which is the right place for
 * it and the wrong stage to feed back into generation.
 */
export const MASK_TYPES = ["height", "noise"];

function maskValue(mask, state, seed) {
  const p = mask.params || {};
  let m = 1;
  if (mask.type === "height") {
    const lo = p.min ?? 0, hi = p.max ?? 1, f = Math.max(p.falloff ?? 0.06, 1e-4);
    m = smoothstep(lo - f, lo + f, state.h) * (1 - smoothstep(hi - f, hi + f, state.h));
  } else if (mask.type === "noise") {
    const v = fbm(state.x * (p.scale ?? 1), state.z * (p.scale ?? 1), seed ^ 0x1b873593, 4);
    const soft = Math.max(p.softness ?? 0.12, 1e-4);
    const th = (p.threshold ?? 0.5) * 2 - 1; // the dial is 0..1, the field is -1..1
    m = smoothstep(th - soft, th + soft, v);
  }
  return clamp01(mask.invert ? 1 - m : m);
}

/* Each layer's own noise seed. Mixed off the world's terrain channel so two
   worlds never share a stack's fields, and off `seedOffset` so a layer is the
   same field wherever it sits in the list. */
function layerSeed(baseSeed, layer) {
  const off = (layer.seedOffset | 0);
  return (Math.imul((baseSeed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(off + 1, 0x27d4eb2d)) >>> 0;
}

// ── the data model ──────────────────────────────────────────────────────────

export function makeLayer(type, overrides = {}) {
  const def = getNoiseType(type);
  if (!def) return null;
  return {
    name: overrides.name ?? def.label,
    enabled: overrides.enabled ?? true,
    type,
    blend: overrides.blend ?? def.blend,
    strength: overrides.strength ?? def.strength,
    opacity: overrides.opacity ?? 1,
    seedOffset: overrides.seedOffset ?? 0,
    params: { ...def.defaults, ...(overrides.params || {}) },
    masks: (overrides.masks || []).map((m) => ({ type: m.type, invert: !!m.invert, params: { ...(m.params || {}) } })),
  };
}

export function makeStack(layers = []) {
  return { version: NOISE_STACK_VERSION, layers: layers.filter(Boolean).slice(0, MAX_LAYERS) };
}

/** True when this params object asks for a stack at all. Absent, empty, or
    holding nothing evaluable all mean "use the built-in recipe", which is what
    every world saved before stacks existed says by saying nothing. */
export function hasStack(stack) {
  return !!stack && Array.isArray(stack.layers)
    && stack.layers.some((l) => l && l.enabled !== false && TYPES.has(l.type));
}

/** Fill a stack read off a file against the current type defaults, dropping
    layers whose type this build does not know. Never throws: a stack is
    author-supplied data arriving from a file, and the reader's job is to make
    it evaluable or to leave it out. */
export function normalizeStack(raw) {
  if (!raw || !Array.isArray(raw.layers)) return null;
  const layers = [];
  for (const l of raw.layers) {
    if (!l || !TYPES.has(l.type)) continue;
    layers.push(makeLayer(l.type, l));
    if (layers.length >= MAX_LAYERS) break;
  }
  return layers.length ? { version: NOISE_STACK_VERSION, layers } : null;
}

// ── evaluation ──────────────────────────────────────────────────────────────

/**
 * The stack's contribution at one point, in the same unitless space the
 * built-in recipe works in — the caller applies sea level, the edge falloff
 * and the vertical scale afterwards, exactly as it does for the recipe.
 *
 * `nx`/`nz` are noise-space coordinates (world × frequency ÷ size). `ctx`
 * carries the world coordinates and the built-in shape, for the one layer type
 * that needs them.
 */
export function evaluateStack(stack, nx, nz, baseSeed, ctx = {}) {
  const state = { x: nx, z: nz, h: 0, worldX: ctx.worldX ?? 0, worldZ: ctx.worldZ ?? 0, legacy: ctx.legacy || null };
  let evaluated = 0;
  for (const layer of stack.layers) {
    if (!layer || layer.enabled === false) continue;
    const def = TYPES.get(layer.type);
    if (!def) continue;
    if (++evaluated > MAX_LAYERS) break;

    const seed = layerSeed(baseSeed, layer);
    let eff = (layer.strength ?? 1) * (layer.opacity ?? 1);
    for (const mask of layer.masks || []) {
      if (!mask || mask.enabled === false) continue;
      eff *= maskValue(mask, state, seed);
    }
    if (eff === 0) continue;

    if (def.kind === "modifier") {
      def.modify(state, seed, layer.params, eff);
      continue;
    }
    const scale = layer.params.scale ?? 1;
    const v = def.sample(state.x * scale, state.z * scale, seed, layer.params, state);
    state.h = blend(layer.blend, state.h, Number.isFinite(v) ? v : 0, eff);
  }
  // A layer list that produced a non-finite height would take the whole plate
  // with it — every reader downstream, from the flood fill to the spawn
  // scorer, treats NaN as ground. Refused here rather than propagated.
  return Number.isFinite(state.h) ? state.h : 0;
}
