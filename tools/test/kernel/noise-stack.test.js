// The layer stack: the contracts a world's SHAPE now rests on.
//
// The first of them is the one worth stating plainly, because it is the only
// reason this change was safe to make at all. `createHeightSampler` used to be
// one function holding one recipe; it is now a SHAPE run through a PLATE, and
// a world with no stack has to come out of the new arrangement as the exact
// float it came out of the old one. Not "close" — the field is baked at 513²,
// eroded by droplets that each re-read it, flooded, and then scored for a
// spawn, so a difference in the last bit of one sample is a different world
// three stages downstream. The heights in GOLDEN below were sampled from the
// old function before the split and pasted in.
import { test, eq, close, ok, report } from "./harness.js";
import { createHeightSampler, EDGE_START } from "../../../src/kernel/terrain/heightfield.js";
import { makeParams, DEFAULT_PARAMS } from "../../../src/kernel/presets.js";
import {
  makeLayer, makeStack, normalizeStack, hasStack, evaluateStack, getNoiseType,
  NOISE_TYPES, BLEND_MODES, MASK_TYPES, MAX_LAYERS,
} from "../../../src/kernel/terrain/noise-stack.js";
import { valueNoise, fbm, ridged, billow, voronoi, crater, dune, channel } from "../../../src/kernel/terrain/noise.js";

/* [seed, variant, x, z, height] — variant 1 turns on island + plateau, which
   the default world leaves at zero and which are the two branches inside the
   recipe that a careless refactor would drop. */
const GOLDEN = [
  ["K7QN-3F2A-9XBD", 0, 0, 0, 116.79544901957317],
  ["K7QN-3F2A-9XBD", 0, 137.5, -902.25, 131.34861251230524],
  ["K7QN-3F2A-9XBD", 0, -1800, 1800, 63.367927395505674],
  ["K7QN-3F2A-9XBD", 0, 2047, 2047, -205.05693036551574],
  ["K7QN-3F2A-9XBD", 0, -2047, -2047, -192.6825365350428],
  ["K7QN-3F2A-9XBD", 0, 900.125, 13.75, 146.45202097478105],
  ["K7QN-3F2A-9XBD", 1, 0, 0, 205.8772694117439],
  ["K7QN-3F2A-9XBD", 1, 137.5, -902.25, 138.5654394609659],
  ["K7QN-3F2A-9XBD", 1, -1800, 1800, -216.29227552138047],
  ["K7QN-3F2A-9XBD", 1, 2047, 2047, -530.1771609961377],
  ["K7QN-3F2A-9XBD", 1, -2047, -2047, -510.1525246978539],
  ["K7QN-3F2A-9XBD", 1, 900.125, 13.75, 148.9279689430153],
  ["ZZ11-0000-AAAA", 0, 0, 0, 124.90257146394825],
  ["ZZ11-0000-AAAA", 0, 137.5, -902.25, 160.7562542484653],
  ["ZZ11-0000-AAAA", 0, -1800, 1800, -10.804574029265797],
  ["ZZ11-0000-AAAA", 0, 2047, 2047, -161.0443607759549],
  ["ZZ11-0000-AAAA", 0, -2047, -2047, -150.85859404908408],
  ["ZZ11-0000-AAAA", 0, 900.125, 13.75, 177.57338334748695],
  ["ZZ11-0000-AAAA", 1, 0, 0, 210.74154287836896],
  ["ZZ11-0000-AAAA", 1, 137.5, -902.25, 156.21002450266192],
  ["ZZ11-0000-AAAA", 1, -1800, 1800, -252.48436033572642],
  ["ZZ11-0000-AAAA", 1, 2047, 2047, -478.5696192424011],
  ["ZZ11-0000-AAAA", 1, -2047, -2047, -472.45815920627854],
  ["ZZ11-0000-AAAA", 1, 900.125, 13.75, 195.6007863666388],
];

function sampler(seed, variant = 0, patch = null) {
  const p = makeParams({ seed });
  if (variant === 1) { p.terrain.island = 0.6; p.terrain.plateau = 0.4; }
  if (patch) Object.assign(p.terrain, patch);
  return createHeightSampler(p);
}

// ── 1. the world without a stack is the world there always was ──────────────

test("a world with no stack is bit-identical to the recipe before the split", () => {
  const cache = new Map();
  for (const [seed, variant, x, z, want] of GOLDEN) {
    const key = `${seed}|${variant}`;
    if (!cache.has(key)) cache.set(key, sampler(seed, variant));
    eq(cache.get(key)(x, z), want, `${seed} v${variant} at ${x},${z}`);
  }
});

test("the default params carry no stack, and the sampler says so", () => {
  eq(DEFAULT_PARAMS.terrain.stack, null);
  eq(sampler("K7QN-3F2A-9XBD").kind, "analytic");
});

test("an empty or unrecognisable stack falls back to the recipe", () => {
  const want = sampler("K7QN-3F2A-9XBD")(137.5, -902.25);
  for (const stack of [null, undefined, {}, { layers: [] }, { layers: [{ type: "no-such-type" }] }, { layers: [null] }]) {
    const h = sampler("K7QN-3F2A-9XBD", 0, { stack });
    eq(h(137.5, -902.25), want, `stack ${JSON.stringify(stack)} takes the recipe`);
    eq(h.kind, "analytic");
  }
});

// ── 2. the plate always runs ────────────────────────────────────────────────

test("the edge falloff runs on a stacked world exactly as on a recipe one", () => {
  /* The point of splitting shape from plate. The rim has to fall away or the
     finite plate ends in a cliff and walk-world starts failing worlds for a
     reason no world file explains — and the falloff is arithmetic applied to
     whatever the shape returned, so a stack gets it whether or not its author
     thought about the edge. */
  const size = DEFAULT_PARAMS.terrain.size;
  const stack = makeStack([makeLayer("fbm", { blend: "replace", strength: 1 })]);
  const stacked = sampler("K7QN-3F2A-9XBD", 0, { stack });
  ok(stacked(size * 0.5 - 1, 0) < 0, "the rim of a stacked world is under water");
  ok(stacked(size * 0.5 - 1, size * 0.5 - 1) < 0, "and so is the corner");

  /* A uniform shape shows the falloff on its own, with nothing else varying:
     the middle keeps its height and the rim is carried well under. The drop is
     not simply 1.15 × height, because everything the falloff pushes below zero
     then meets the sea-floor rule (`h *= 0.45`) on the way out — which is the
     whole reason this asserts a relationship rather than a constant. That the
     plate is the SAME plate on both paths is proved exactly, and much more
     strongly, by the legacy-layer test below: bit-identity end to end. */
  const flatStack = sampler("K7QN-3F2A-9XBD", 0, {
    stack: makeStack([makeLayer("constant", { blend: "replace", params: { value: 0.2 } })]),
  });
  const middle = flatStack(0, 0), rim = flatStack(size * 0.5 - 1, 0);
  ok(middle > 100, `a uniform shape stands at ${middle.toFixed(1)} m inland`);
  ok(rim < -100, `and is carried to ${rim.toFixed(1)} m at the rim`);
});

test("a shape pinned at its maximum outruns the falloff, and that is a known limit", () => {
  /* Not an assertion that the engine is right — an assertion about how much
     headroom it actually has, so that the day someone widens the shape range
     or softens the edge, the number moves in a test rather than in a world.

     A constant of 1.0 everywhere is the worst case a stack can express: the
     falloff removes 1.15 and the shape plus the sea-level offset stands at
     1.16, so eleven millimetres of unit height survive at the rim. Ordinary
     noise never comes close — over 400 seeds the highest the recipe's rim ever
     reaches is −40 m — but a constant layer is one click to add. */
  const size = DEFAULT_PARAMS.terrain.size;
  const saturated = sampler("K7QN-3F2A-9XBD", 0, {
    stack: makeStack([makeLayer("constant", { blend: "replace", params: { value: 1 } })]),
  });
  const rim = saturated(size * 0.5 - 1, 0);
  ok(rim > 0 && rim < 10, `a saturated shape leaves the rim at ${rim.toFixed(2)} m — above water, barely`);

  // What the recipe does at the same corner, for the margin this is measured against.
  const plain = sampler("K7QN-3F2A-9XBD");
  ok(plain(size * 0.5 - 1, 0) < -20, "the recipe's own rim is well under");
});

test("sea level still moves a stacked world the way it moves a recipe one", () => {
  const stack = makeStack([makeLayer("fbm", { blend: "replace", strength: 1 })]);
  const low = sampler("K7QN-3F2A-9XBD", 0, { stack, seaLevel: 0.2 });
  const high = sampler("K7QN-3F2A-9XBD", 0, { stack, seaLevel: 0.8 });
  for (const [x, z] of [[0, 0], [500, -250], [-1200, 300]]) {
    ok(high(x, z) < low(x, z), `raising sea level lowers the land at ${x},${z}`);
  }
});

// ── 3. determinism ──────────────────────────────────────────────────────────

test("the same stack and seed produce the same ground, every time", () => {
  const stack = makeStack([
    makeLayer("fbm", { blend: "replace" }),
    makeLayer("ridged", { seedOffset: 3 }),
    makeLayer("crater", { seedOffset: 9 }),
  ]);
  const a = sampler("K7QN-3F2A-9XBD", 0, { stack });
  const b = sampler("K7QN-3F2A-9XBD", 0, { stack: JSON.parse(JSON.stringify(stack)) });
  for (let i = 0; i < 200; i++) {
    const x = (i * 37) % 2000 - 1000, z = (i * 91) % 2000 - 1000;
    eq(a(x, z), b(x, z), `at ${x},${z}`);
  }
});

test("a different world seed moves a stack's fields with it", () => {
  const stack = makeStack([makeLayer("fbm", { blend: "replace" })]);
  const a = sampler("K7QN-3F2A-9XBD", 0, { stack });
  const b = sampler("ZZ11-0000-AAAA", 0, { stack });
  let differing = 0;
  for (let i = 0; i < 100; i++) {
    const x = i * 17 - 800, z = i * 23 - 900;
    if (a(x, z) !== b(x, z)) differing++;
  }
  ok(differing > 90, `${differing}/100 samples differ between seeds`);
});

test("reordering a layer does not change what that layer draws", () => {
  /* The reason a layer's seed comes off its own seedOffset and never off its
     index. Dragging a layer is a statement about compositing order; if it also
     re-rolled the noise, every reorder would be a reroll and the list would be
     unusable as an editing surface. Two single-layer stacks holding the same
     layer at different depths of an otherwise-identical list must agree. */
  const ridge = () => makeLayer("ridged", { blend: "replace", seedOffset: 5 });
  const first = evaluateStack(makeStack([ridge()]), 0.3, -0.7, 12345);
  const later = evaluateStack(
    makeStack([makeLayer("constant", { blend: "replace", params: { value: 0 } }), ridge()]),
    0.3, -0.7, 12345);
  eq(first, later, "the ridged layer draws the same field at either depth");
});

test("layers of the same type differ only when their seedOffset does", () => {
  const at = (off) => evaluateStack(
    makeStack([makeLayer("fbm", { blend: "replace", seedOffset: off })]), 0.31, 0.77, 999);
  eq(at(0), at(0), "same offset, same field");
  ok(at(0) !== at(1), "a different offset is a different field");
  ok(at(1) !== at(2), "and again");
});

// ── 4. blending, masking, modifiers ─────────────────────────────────────────

test("every blend mode is evaluable and finite", () => {
  for (const mode of BLEND_MODES) {
    const stack = makeStack([
      makeLayer("constant", { blend: "replace", params: { value: 0.5 } }),
      makeLayer("fbm", { blend: mode, seedOffset: 1 }),
    ]);
    for (const [x, z] of [[0, 0], [1.7, -0.3], [-4.2, 9.1]]) {
      const v = evaluateStack(stack, x, z, 7);
      ok(Number.isFinite(v), `${mode} at ${x},${z} produced ${v}`);
    }
  }
});

test("carve only ever removes ground", () => {
  // The asymmetric blend that exists because `subtract` lifts the terrain
  // wherever the field is negative, and an inverted riverbed is a bug that
  // does not read as one.
  const base = makeLayer("constant", { blend: "replace", params: { value: 0.5 } });
  for (let i = 0; i < 120; i++) {
    const x = i * 0.31 - 18, z = i * 0.17 - 9;
    const carved = evaluateStack(makeStack([base, makeLayer("channel", { blend: "carve" })]), x, z, 5);
    ok(carved <= 0.5 + 1e-12, `carve at ${x.toFixed(2)},${z.toFixed(2)} gave ${carved}`);
  }
});

test("strength and opacity scale a layer's contribution, and zero removes it", () => {
  const base = () => makeLayer("constant", { blend: "replace", params: { value: 0.4 } });
  const only = evaluateStack(makeStack([base()]), 1, 1, 3);
  const full = evaluateStack(makeStack([base(), makeLayer("fbm", { blend: "add", strength: 1, seedOffset: 2 })]), 1, 1, 3);
  const half = evaluateStack(makeStack([base(), makeLayer("fbm", { blend: "add", strength: 0.5, seedOffset: 2 })]), 1, 1, 3);
  const none = evaluateStack(makeStack([base(), makeLayer("fbm", { blend: "add", strength: 0, seedOffset: 2 })]), 1, 1, 3);
  eq(none, only, "a layer at zero strength contributes nothing");
  close(half - only, (full - only) * 0.5, 1e-12, "half strength is half the contribution");
});

test("a height mask keeps a layer to the band it names", () => {
  /* Built on a constant base so the accumulated height is known exactly: the
     mask reads what the layers below built, which is what makes it a statement
     about the terrain rather than about the coordinates. */
  const masked = (baseValue) => evaluateStack(makeStack([
    makeLayer("constant", { blend: "replace", params: { value: baseValue } }),
    makeLayer("constant", {
      blend: "add", strength: 1, params: { value: 1 },
      masks: [{ type: "height", params: { min: 0.4, max: 0.8, falloff: 0.01 } }],
    }),
  ]), 0, 0, 1);
  close(masked(0.6), 1.6, 1e-6, "inside the band the layer lands in full");
  close(masked(0.1), 0.1, 1e-6, "below the band it contributes nothing");
  close(masked(0.95), 0.95, 1e-6, "above the band it contributes nothing");
});

test("an inverted mask is the complement of the mask", () => {
  const build = (invert) => evaluateStack(makeStack([
    makeLayer("constant", { blend: "replace", params: { value: 0.6 } }),
    makeLayer("constant", {
      blend: "add", strength: 1, params: { value: 1 },
      masks: [{ type: "height", invert, params: { min: 0.4, max: 0.8, falloff: 0.01 } }],
    }),
  ]), 0, 0, 1);
  close(build(false) - 0.6, 1, 1e-6, "the plain mask admits it");
  close(build(true) - 0.6, 0, 1e-6, "the inverted one refuses it");
});

test("a warp modifier bends what the layers after it sample, and nothing before", () => {
  const field = () => makeLayer("fbm", { blend: "add", seedOffset: 4 });
  const straight = evaluateStack(makeStack([field()]), 0.5, 0.5, 11);
  const warpedAfter = evaluateStack(makeStack([makeLayer("warp", { params: { scale: 1, amount: 0.5 } }), field()]), 0.5, 0.5, 11);
  const warpedBefore = evaluateStack(makeStack([field(), makeLayer("warp", { params: { scale: 1, amount: 0.5 } })]), 0.5, 0.5, 11);
  ok(straight !== warpedAfter, "a warp above the layer moves it");
  eq(straight, warpedBefore, "a warp below the layer leaves it alone");
});

test("a terrace modifier steps what is already there", () => {
  const stepped = (v) => evaluateStack(makeStack([
    makeLayer("constant", { blend: "replace", params: { value: v } }),
    makeLayer("terrace", { params: { count: 10, smoothness: 0.02 } }),
  ]), 0, 0, 1);
  // Ten steps over the unit interval: values either side of a tread land on it.
  close(stepped(0.41), stepped(0.44), 1e-3, "0.41 and 0.44 share a tread");
  ok(Math.abs(stepped(0.41) - stepped(0.56)) > 0.05, "0.41 and 0.56 do not");
});

// ── 5. the legacy layer, and mixing the two systems ─────────────────────────

test("a lone legacy layer reproduces the recipe exactly", () => {
  // The bridge between the two systems: a stack that opens with `legacy` is
  // building ON the world the sliders describe rather than instead of it.
  const plain = sampler("K7QN-3F2A-9XBD");
  const viaStack = sampler("K7QN-3F2A-9XBD", 0, {
    stack: makeStack([makeLayer("legacy", { blend: "replace", strength: 1 })]),
  });
  eq(viaStack.kind, "stack");
  for (const [, , x, z] of GOLDEN.filter((g) => g[0] === "K7QN-3F2A-9XBD" && g[1] === 0)) {
    eq(viaStack(x, z), plain(x, z), `legacy layer at ${x},${z}`);
  }
});

test("a stack can build on the recipe rather than replacing it", () => {
  const plain = sampler("K7QN-3F2A-9XBD");
  const withCraters = sampler("K7QN-3F2A-9XBD", 0, {
    stack: makeStack([
      makeLayer("legacy", { blend: "replace" }),
      makeLayer("crater", { blend: "add", strength: 0.5, seedOffset: 1 }),
    ]),
  });
  let moved = 0;
  for (let i = 0; i < 300; i++) {
    const x = (i * 53) % 3000 - 1500, z = (i * 71) % 3000 - 1500;
    if (Math.abs(withCraters(x, z) - plain(x, z)) > 1e-9) moved++;
  }
  ok(moved > 30, `craters moved ${moved}/300 samples off the recipe`);
});

// ── 6. the data model, and what a file can carry ────────────────────────────

test("every declared type builds, evaluates and stays finite", () => {
  for (const def of NOISE_TYPES) {
    const layer = makeLayer(def.id);
    ok(layer, `${def.id} builds`);
    eq(layer.type, def.id);
    const stack = makeStack([makeLayer("constant", { blend: "replace", params: { value: 0.3 } }), layer]);
    for (const [x, z] of [[0, 0], [2.5, -1.25], [-7.75, 3.5], [100.5, 100.5]]) {
      const v = evaluateStack(stack, x, z, 4321, { worldX: x * 100, worldZ: z * 100, legacy: () => 0.5 });
      ok(Number.isFinite(v), `${def.id} at ${x},${z} produced ${v}`);
    }
  }
});

test("every field returns inside [-1, 1], which is what makes blending mean anything", () => {
  const seed = 20260813;
  for (let i = 0; i < 400; i++) {
    const x = i * 0.37 - 74, z = i * 0.53 - 106;
    const samples = {
      valueNoise: valueNoise(x, z, seed),
      fbm: fbm(x, z, seed),
      ridged: ridged(x, z, seed),
      billow: billow(x, z, seed),
      voronoiCell: voronoi(x, z, seed, 1, 0),
      voronoiDist: voronoi(x, z, seed, 1, 1),
      voronoiEdge: voronoi(x, z, seed, 1, 2),
      crater: crater(x, z, seed),
      dune: dune(x, z, seed),
      channel: channel(x, z, seed),
    };
    for (const [name, v] of Object.entries(samples)) {
      ok(v >= -1 && v <= 1, `${name} at ${x.toFixed(2)},${z.toFixed(2)} returned ${v}`);
    }
  }
});

test("normalizeStack drops what it cannot evaluate and fills what it can", () => {
  const raw = { layers: [
    { type: "fbm" },                       // no params at all
    { type: "not-a-type" },                // dropped
    { type: "ridged", params: { scale: 3 } }, // partial params
  ] };
  const norm = normalizeStack(raw);
  eq(norm.layers.length, 2, "the unknown type is gone");
  eq(norm.layers[0].params.octaves, getNoiseType("fbm").defaults.octaves, "defaults filled");
  eq(norm.layers[1].params.scale, 3, "the author's value kept");
  eq(norm.layers[1].params.gain, getNoiseType("ridged").defaults.gain, "and the rest defaulted");
});

test("a stack longer than the cap is cut to it", () => {
  const many = Array.from({ length: MAX_LAYERS + 6 }, (_, i) => makeLayer("fbm", { seedOffset: i }));
  eq(makeStack(many).layers.length, MAX_LAYERS);
  eq(normalizeStack({ layers: many }).layers.length, MAX_LAYERS);
});

test("hasStack answers the question the sampler actually asks", () => {
  eq(hasStack(null), false);
  eq(hasStack({ layers: [] }), false);
  eq(hasStack({ layers: [{ type: "nope" }] }), false);
  eq(hasStack({ layers: [{ type: "fbm", enabled: false }] }), false, "all-disabled is not a stack");
  eq(hasStack({ layers: [{ type: "fbm" }] }), true);
});

test("a stack is plain JSON — it survives a round trip through a file", () => {
  // params is the whole world, and a stack has to travel in it: no class
  // instances, no functions, nothing that JSON.stringify quietly drops.
  const stack = makeStack([
    makeLayer("legacy", { blend: "replace" }),
    makeLayer("ridged", { seedOffset: 2, masks: [{ type: "height", params: { min: 0.2, max: 0.9, falloff: 0.05 } }] }),
    makeLayer("terrace", { params: { count: 8 } }),
  ]);
  const round = JSON.parse(JSON.stringify(stack));
  eq(JSON.stringify(round), JSON.stringify(stack), "byte-identical through JSON");
  const a = sampler("K7QN-3F2A-9XBD", 0, { stack });
  const b = sampler("K7QN-3F2A-9XBD", 0, { stack: round });
  for (const [x, z] of [[0, 0], [612.5, -318.25], [-1500, 900]]) eq(a(x, z), b(x, z), `at ${x},${z}`);
});

test("a stack that would produce NaN produces ground instead", () => {
  /* worldfile.js refuses terrain.octaves below 1 at the door because fbm
     averages over nothing and NaNs the whole plate. A stack is author data
     from the same file and reaches the same arithmetic, so it is clamped
     rather than refused — a layer is a smaller thing to be wrong about than a
     world, and a world that loads flat is recoverable where one that loads NaN
     is not. */
  for (const params of [{ octaves: 0 }, { octaves: -5 }, { octaves: NaN }]) {
    const h = sampler("K7QN-3F2A-9XBD", 0, {
      stack: makeStack([makeLayer("fbm", { blend: "replace", params })]),
    });
    ok(Number.isFinite(h(100, 100)), `octaves ${params.octaves} still gives ground`);
  }
});

test("every knob a type has is a knob the editor can reach, and vice versa", () => {
  /* The registry describes a type for the evaluator, for serialisation AND
     for the panel. A parameter with no control is one nothing on screen can
     move; a control with no parameter is a slider wired to nothing. Both
     ship silently — the layer just behaves as though the knob were at its
     default forever — so the two lists are asserted equal rather than kept
     in step by hand. */
  for (const def of NOISE_TYPES) {
    const defaults = Object.keys(def.defaults).sort();
    const controls = def.controls.map((c) => c.key).sort();
    eq(controls.join(","), defaults.join(","), `${def.id}: controls vs defaults`);
    for (const c of def.controls) {
      ok(c.label, `${def.id}.${c.key} has a label`);
      ok(c.max > c.min, `${def.id}.${c.key} has a usable range`);
      ok(c.step > 0, `${def.id}.${c.key} has a step`);
      const d = def.defaults[c.key];
      ok(d >= c.min && d <= c.max, `${def.id}.${c.key} default ${d} is inside [${c.min}, ${c.max}]`);
      if (c.choices) eq(c.choices.length, c.max - c.min + 1, `${def.id}.${c.key} names every choice in its range`);
    }
  }
});

test("the mask types the module offers are the ones it implements", () => {
  // A registry that lists a mask nobody wrote is a UI with a dead control in
  // it — World ships two marked "soon", and they read as broken rather than
  // as absent.
  eq(MASK_TYPES.length, 2);
  /* Each mask is given a setting that can actually refuse something, and is
     then swept rather than sampled at a point. Both halves of that were wrong
     first time round and each hid the other: the height mask ran on its
     default 0..1 band, which admits every height there is, and the noise mask
     was asked at one coordinate where its field happened to sit below the
     threshold — so the plain mask read zero, the INVERTED mask read one, and a
     working mask presented as a dead one. A mask's job is to VARY, and a test
     of one has to look at more than one place to see it. */
  const SETTINGS = {
    // The base below stands at 0.5; this band sits entirely under it.
    height: { min: 0.0, max: 0.3, falloff: 0.02 },
    noise: { scale: 1, threshold: 0.5, softness: 0.05 },
  };
  for (const t of MASK_TYPES) {
    let gated = 0, open = 0;
    for (let i = 0; i < 120; i++) {
      const x = i * 0.41 - 24, z = i * 0.29 - 17;
      const base = () => makeLayer("constant", { blend: "replace", params: { value: 0.5 } });
      const plain = evaluateStack(makeStack([
        base(), makeLayer("constant", { blend: "add", params: { value: 1 } }),
      ]), x, z, 8);
      const masked = evaluateStack(makeStack([
        base(),
        makeLayer("constant", { blend: "add", params: { value: 1 }, masks: [{ type: t, params: SETTINGS[t] }] }),
      ]), x, z, 8);
      if (Math.abs(masked - plain) > 1e-9) gated++; else open++;
    }
    ok(gated > 0, `the ${t} mask holds a layer back (${gated}/120 samples)`);
  }
  // And the noise mask, unlike the height one, has to do BOTH across a sweep —
  // it is the mask whose whole purpose is "here and not there".
  let through = 0;
  for (let i = 0; i < 120; i++) {
    const x = i * 0.41 - 24, z = i * 0.29 - 17;
    const v = evaluateStack(makeStack([
      makeLayer("constant", { blend: "replace", params: { value: 0.5 } }),
      makeLayer("constant", { blend: "add", params: { value: 1 }, masks: [{ type: "noise", params: SETTINGS.noise }] }),
    ]), x, z, 8);
    if (v > 0.5 + 1e-9) through++;
  }
  ok(through > 0 && through < 120, `the noise mask admits the layer in ${through}/120 places, not all or none`);
});

report("noise-stack");
