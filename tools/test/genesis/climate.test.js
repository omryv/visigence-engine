// Spatial climate: two slow fields, an anchor per palette, and the blend that
// turns them into WHERE each biome is. The renderer's use of it is three.js
// and out of the suite's reach; everything decided here — the fields, the
// nearest-anchor pick, the border band, the off-by-default — is pure and is
// pinned here.
import { test, eq, close, ok, report } from "../kernel/harness.js";
import {
  hasClimate, createClimateSampler, biomeBlendAt, createBiomeField,
  CLIMATE_FREQUENCY, BLEND_START, MIN_ANCHOR_SEPARATION,
} from "../../../src/kernel/terrain/climate.js";
import { makeParams, DEFAULT_PARAMS } from "../../../src/kernel/presets.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { PALETTES } from "../../../src/genesis/style/palettes.js";

const resolveAnchor = (name) => PALETTES[name]?.climate;

function climParams(biomes = ["verdant", "tundra", "badlands"], seed = "K7QN-3F2A-9XBD") {
  const p = makeParams({ seed });
  p.climate = { biomes, scale: 1 };
  return p;
}

// ── off by default ──────────────────────────────────────────────────────────

test("no world has spatial climate until it asks", () => {
  eq(DEFAULT_PARAMS.climate, null);
  eq(hasClimate(makeParams({ seed: "X" })), false);
  eq(createBiomeField(makeParams({ seed: "X" }), resolveAnchor), null);
});

test("a malformed or single-biome climate block is no climate at all", () => {
  const p = makeParams({ seed: "X" });
  for (const c of [null, {}, { biomes: null }, { biomes: [] }, { biomes: ["verdant"] },
                   { biomes: [42, {}] }, { biomes: ["no-such-biome", "also-not"] }]) {
    p.climate = c;
    eq(createBiomeField(p, resolveAnchor), null, JSON.stringify(c));
  }
});

test("unknown biome names are dropped, and the survivors carry on", () => {
  const p = climParams(["verdant", "no-such-biome", "tundra"]);
  const f = createBiomeField(p, resolveAnchor);
  eq(f.names.length, 2);
  eq(f.names[0], "verdant");
  eq(f.names[1], "tundra");
});

// ── the fields ──────────────────────────────────────────────────────────────

test("the climate fields are deterministic and stay inside [0, 1]", () => {
  const a = createClimateSampler(climParams());
  const b = createClimateSampler(climParams());
  for (let i = 0; i < 200; i++) {
    const x = (i * 137) % 4000 - 2000, z = (i * 251) % 4000 - 2000;
    const ca = a(x, z), cb = b(x, z);
    eq(ca.temp, cb.temp, `temp at ${x},${z}`);
    eq(ca.moist, cb.moist, `moist at ${x},${z}`);
    ok(ca.temp >= 0 && ca.temp <= 1, `temp ${ca.temp} in range`);
    ok(ca.moist >= 0 && ca.moist <= 1, `moist ${ca.moist} in range`);
  }
});

test("a different seed is a different climate, on its own channel", () => {
  const a = createClimateSampler(climParams(undefined, "K7QN-3F2A-9XBD"));
  const b = createClimateSampler(climParams(undefined, "ZZ11-0000-AAAA"));
  let differ = 0;
  for (let i = 0; i < 100; i++) {
    const x = i * 37 - 1800, z = i * 59 - 1800;
    if (a(x, z).temp !== b(x, z).temp) differ++;
  }
  ok(differ > 90, `${differ}/100 temperature samples differ between seeds`);
});

test("turning climate on cannot move a single vertex of ground", () => {
  // The climate draws from its own seed channel; the terrain channel and the
  // sampler that reads it are untouched by the block's presence.
  const off = createHeightSampler(makeParams({ seed: "K7QN-3F2A-9XBD" }));
  const on = createHeightSampler(climParams());
  for (const [x, z] of [[0, 0], [612.5, -318.25], [-1500, 900], [2047, 2047]]) {
    eq(on(x, z), off(x, z), `height at ${x},${z}`);
  }
});

test("the fields actually vary across a default plate", () => {
  // CLIMATE_FREQUENCY is meant to put two or three regions on a world; a
  // field that never leaves a narrow band would make every anchor pick the
  // same winner and the feature a no-op that looks configured.
  const c = createClimateSampler(climParams());
  let tmin = 1, tmax = 0;
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 200 - 1900, z = Math.floor(i / 20) * 200 - 1900;
    const { temp } = c(x, z);
    if (temp < tmin) tmin = temp;
    if (temp > tmax) tmax = temp;
  }
  ok(tmax - tmin > 0.3, `temperature spans ${(tmax - tmin).toFixed(2)} of the unit range`);
});

// ── the blend ───────────────────────────────────────────────────────────────

test("on an anchor, the answer is that anchor, pure", () => {
  const anchors = [{ temp: 0.2, moist: 0.3 }, { temp: 0.8, moist: 0.7 }];
  const r = biomeBlendAt({ temp: 0.2, moist: 0.3 }, anchors);
  eq(r.a, 0);
  eq(r.mix, 0);
});

test("the border is an even mix, approached continuously from both sides", () => {
  const anchors = [{ temp: 0.2, moist: 0.5 }, { temp: 0.8, moist: 0.5 }];
  // Walk temp across the midline at 0.5: mix must rise to 0.5 exactly there
  // and fall symmetrically beyond it, with the roles swapped.
  const atMid = biomeBlendAt({ temp: 0.5, moist: 0.5 }, anchors);
  close(atMid.mix, 0.5, 1e-9, "even mix on the boundary");
  /* The bound is DERIVED from BLEND_START rather than fitted to the output,
     so tightening the band moves this bound honestly instead of turning the
     test red for the wrong reason. On this line w = |t−0.2|/0.6, so
     dw/dt = 1/0.6. mix = 0.5·smoothstep(BLEND_START, 0.5, w), and a
     smoothstep's steepest slope is 1.5/(e1−e0), so d(mix)/dw is at most
     0.75/(0.5 − BLEND_START). A 0.01 step in t therefore cannot move the
     weight by more than the product, plus a little slack for the sampling.
     Anything larger is a discontinuity, which on the ground is a painted line
     where a border band should be. */
  const maxStep = 1.1 * 0.01 * (1 / 0.6) * (0.75 / (0.5 - BLEND_START));
  let prev = null;
  for (let t = 0.2; t <= 0.8001; t += 0.01) {
    const r = biomeBlendAt({ temp: t, moist: 0.5 }, anchors);
    ok(r.mix >= 0 && r.mix <= 0.5, `mix ${r.mix} in [0, 0.5]`);
    const eff = r.a === 0 ? r.mix : 1 - r.mix;   // weight of anchor 1
    if (prev !== null) {
      ok(Math.abs(eff - prev) <= maxStep,
        `weight step ${Math.abs(eff - prev).toFixed(4)} exceeds ${maxStep.toFixed(4)} at temp ${t.toFixed(2)}`);
    }
    prev = eff;
  }
});

test("inside BLEND_START of its own anchor a point is purely its biome", () => {
  const anchors = [{ temp: 0.2, moist: 0.5 }, { temp: 0.8, moist: 0.5 }];
  // w = d0/(d0+d1) < BLEND_START ⇔ temp < 0.2 + 0.6·BLEND_START.
  const r = biomeBlendAt({ temp: 0.2 + 0.6 * BLEND_START - 0.02, moist: 0.5 }, anchors);
  eq(r.a, 0);
  eq(r.mix, 0, "no runner-up this deep inside the region");
});

test("with one anchor, or on a degenerate tie, the blend is well-defined", () => {
  const one = biomeBlendAt({ temp: 0.9, moist: 0.9 }, [{ temp: 0.1, moist: 0.1 }]);
  eq(one.a, 0); eq(one.b, 0); eq(one.mix, 0);
  // Standing exactly on two coincident anchors: d0 = d1 = 0.
  const tie = biomeBlendAt({ temp: 0.5, moist: 0.5 },
    [{ temp: 0.5, moist: 0.5 }, { temp: 0.5, moist: 0.5 }]);
  eq(tie.mix, 0, "a zero-distance tie resolves pure rather than NaN");
});

// ── the field object, and the palette data it depends on ────────────────────

test("createBiomeField wires names, anchors and blendAt together", () => {
  const f = createBiomeField(climParams(["tundra", "badlands"]), resolveAnchor);
  eq(f.names.length, 2);
  eq(f.anchors.length, 2);
  for (let i = 0; i < 50; i++) {
    const r = f.blendAt(i * 80 - 2000, i * 61 - 1500);
    ok(r.a === 0 || r.a === 1, "index a in range");
    ok(r.b === 0 || r.b === 1, "index b in range");
    ok(r.mix >= 0 && r.mix <= 0.5, "mix in range");
  }
});

test("the world reads as its own biome, not as whichever sits nearest the middle", () => {
  /* The field is centred on the first anchor because otherwise it is centred
     on the middle of climate space, which hands the world to whichever biome
     happens to sit nearest there. Measured before the fix on a shoreland
     world listing parkland second: parkland covered 63% of the plate, up to
     80% on some seeds — a world that called itself shoreland, took its water
     and sky and materials from shoreland, and mostly looked like somewhere
     else. The primary is not one option among several; it is what the world
     IS. */
  const f = createBiomeField(climParams(["shoreland", "parkland"]), resolveAnchor);
  let primary = 0, total = 0;
  for (let i = 0; i < 60; i++) {
    for (let j = 0; j < 60; j++) {
      const x = (i / 59 - 0.5) * 3800, z = (j / 59 - 0.5) * 3800;
      if (f.blendAt(x, z).a === 0) primary++;
      total++;
    }
  }
  const share = primary / total;
  ok(share > 0.55, `the primary holds ${(share * 100).toFixed(0)}% of the plate`);
  ok(share < 0.97, `and the second biome still appears (primary at ${(share * 100).toFixed(0)}%)`);
});

test("a multi-biome world lands in more than one biome", () => {
  // Anchors far apart in climate space, fields spanning most of the unit
  // square: if every sample still picked one biome, the frequency or the
  // spread would be wrong and the feature decorative.
  const f = createBiomeField(climParams(["tundra", "badlands", "verdant"]), resolveAnchor);
  const seen = new Set();
  for (let i = 0; i < 900; i++) {
    const x = (i % 30) * 136 - 1970, z = Math.floor(i / 30) * 136 - 1970;
    seen.add(f.blendAt(x, z).a);
  }
  ok(seen.size >= 2, `${seen.size} of 3 biomes actually appear on the plate`);
});

test("two biomes too alike to be two places are dropped, and say so", () => {
  /* shoreland is a cool wet coast and weald is cool and damp: 0.082 apart,
     and measured, a pairing of them leaves 9% of the plate committed to
     either one. That is not a border, it is one world painted in the average
     of two palettes — so the list comes back visibly shorter rather than
     quietly wrong. */
  const p = climParams(["shoreland", "weald"]);
  eq(createBiomeField(p, resolveAnchor), null, "one survivor is not a climate");

  const three = createBiomeField(climParams(["shoreland", "weald", "parkland"]), resolveAnchor);
  eq(three.names.length, 2, "the indistinct one is gone, the distinct one stays");
  eq(three.names[0], "shoreland");
  eq(three.names[1], "parkland");
  eq(three.dropped.length, 1);
  eq(three.dropped[0].name, "weald");
  ok(/too close to shoreland/.test(three.dropped[0].reason), three.dropped[0].reason);
});

test("first in the list wins a collision, so the author's order decides", () => {
  const a = createBiomeField(climParams(["weald", "shoreland", "parkland"]), resolveAnchor);
  eq(a.names[0], "weald", "the one written first survives");
  ok(!a.names.includes("shoreland"), "the later near-identical one is dropped");
});

test("an unknown name is reported as dropped rather than silently skipped", () => {
  const f = createBiomeField(climParams(["shoreland", "no-such-biome", "parkland"]), resolveAnchor);
  eq(f.names.length, 2);
  eq(f.dropped.length, 1);
  eq(f.dropped[0].name, "no-such-biome");
});

test("every anchor a world could pair is far enough apart to mean it", () => {
  // The separation floor is only worth having if the catalogue can satisfy
  // it: at least one usable partner for every palette, or the constant is a
  // rule that forbids the feature.
  for (const [name, pal] of Object.entries(PALETTES)) {
    const partners = Object.entries(PALETTES).filter(([other, p2]) =>
      other !== name && Math.hypot(pal.climate.temp - p2.climate.temp, pal.climate.moist - p2.climate.moist) >= MIN_ANCHOR_SEPARATION);
    ok(partners.length > 0, `${name} has no biome far enough from it to pair with`);
  }
});

test("every palette in the catalogue names a climate anchor, and no two share one", () => {
  const seen = new Map();
  for (const [name, pal] of Object.entries(PALETTES)) {
    const c = pal.climate;
    ok(c && typeof c.temp === "number" && typeof c.moist === "number",
      `${name} carries a climate anchor`);
    ok(c.temp >= 0 && c.temp <= 1 && c.moist >= 0 && c.moist <= 1,
      `${name}'s anchor is in range`);
    const key = `${c.temp},${c.moist}`;
    ok(!seen.has(key), `${name} and ${seen.get(key)} share the anchor ${key} — the blend between them would be undefined`);
    seen.set(key, name);
  }
});

test("climate params survive a JSON round trip untouched", () => {
  const p = climParams(["verdant", "atoll"], "AB12-CD34-EF56");
  const round = JSON.parse(JSON.stringify(p));
  const a = createBiomeField(p, resolveAnchor);
  const b = createBiomeField(round, resolveAnchor);
  for (const [x, z] of [[0, 0], [777, -777], [-1900, 1400]]) {
    const ra = a.blendAt(x, z), rb = b.blendAt(x, z);
    eq(ra.a, rb.a, `index at ${x},${z}`);
    eq(ra.mix, rb.mix, `mix at ${x},${z}`);
  }
});

report("climate");
