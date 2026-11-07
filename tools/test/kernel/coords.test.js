// Seed identity, noise determinism and heightfield coordinate contracts.
import { test, eq, close, ok, report } from "./harness.js";
import { randomSeed, normalizeSeed, hashSeed, seedChannel, mulberry32 } from "../../../src/kernel/seed.js";
import { valueNoise, fbm, ridged } from "../../../src/kernel/terrain/noise.js";
import { createHeightSampler, bakeHeightField, createBakedSampler, elevNorm } from "../../../src/kernel/terrain/heightfield.js";
import { DEFAULT_PARAMS, makeParams, mergeParams } from "../../../src/kernel/presets.js";

test("randomSeed format", () => {
  const s = randomSeed(mulberry32(42));
  ok(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(s), s);
});

test("normalizeSeed round-trips and cleans", () => {
  eq(normalizeSeed("k7qn 3f2a 9xbd"), "K7QN-3F2A-9XBD");
  eq(normalizeSeed("K7QN-3F2A-9XBD"), "K7QN-3F2A-9XBD");
  eq(normalizeSeed(""), null);
  eq(normalizeSeed("AB"), "AB22-2222-2222"); // short seeds pad deterministically
});

test("hashSeed is stable and channelized", () => {
  eq(hashSeed("K7QN-3F2A-9XBD"), hashSeed("K7QN-3F2A-9XBD"));
  ok(hashSeed("A") !== hashSeed("B"));
  ok(seedChannel("X", "terrain") !== seedChannel("X", "sky"), "channels must differ");
});

test("mulberry32 is deterministic and uniform-ish", () => {
  const a = mulberry32(123), b = mulberry32(123);
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const va = a(), vb = b();
    eq(va, vb, "same seed, same stream:");
    ok(va >= 0 && va < 1);
    sum += va;
  }
  ok(Math.abs(sum / 1000 - 0.5) < 0.05, "mean drifted: " + sum / 1000);
});

test("valueNoise/fbm/ridged: deterministic, bounded", () => {
  for (const f of [valueNoise, (x, z, s) => fbm(x, z, s), (x, z, s) => ridged(x, z, s)]) {
    for (let i = 0; i < 200; i++) {
      const x = (i * 0.77) - 70, z = (i * 1.31) - 100;
      const v1 = f(x, z, 999), v2 = f(x, z, 999);
      eq(v1, v2, "determinism:");
      ok(v1 >= -1.01 && v1 <= 1.01, `bounds: ${v1}`);
    }
  }
});

test("height sampler: same params → identical heights", () => {
  const p1 = makeParams({ seed: "K7QN-3F2A-9XBD", preset: "highlands" });
  const p2 = makeParams({ seed: "K7QN-3F2A-9XBD", preset: "highlands" });
  const h1 = createHeightSampler(p1), h2 = createHeightSampler(p2);
  for (let i = 0; i < 100; i++) {
    const x = i * 37.3 - 1800, z = i * 53.7 - 2000;
    eq(h1(x, z), h2(x, z), `at ${x},${z}:`);
  }
});

test("height sampler: different seeds → different worlds", () => {
  const a = createHeightSampler(makeParams({ seed: "AAAA-AAAA-AAAA" }));
  const b = createHeightSampler(makeParams({ seed: "BBBB-BBBB-BBBB" }));
  let diff = 0;
  for (let i = 0; i < 50; i++) if (a(i * 91, i * 47) !== b(i * 91, i * 47)) diff++;
  ok(diff > 45, `only ${diff}/50 samples differ`);
});

test("bakeHeightField covers the world symmetrically", () => {
  const params = makeParams({ seed: "K7QN-3F2A-9XBD" });
  const field = bakeHeightField(params, 65);
  eq(field.res, 65);
  eq(field.size, params.terrain.size);
  eq(field.data.length, 65 * 65);
  ok(field.min < field.max);
  const sampler = createHeightSampler(params);
  // corners map to ±size/2 (grid stores Float32, sampler runs in doubles)
  close(field.data[0], sampler(-field.size / 2, -field.size / 2), 1e-3, "corner 0,0:");
  close(field.data[64 * 65 + 64], sampler(field.size / 2, field.size / 2), 1e-3, "corner n,n:");
});

test("baked sampler agrees with the grid at nodes", () => {
  const params = makeParams({ seed: "K7QN-3F2A-9XBD" });
  const field = bakeHeightField(params, 65);
  const baked = createBakedSampler(field);
  const size = field.size;
  // interior nodes only: the baked sampler clamps at the far edge by design
  for (let j = 0; j < 64; j += 8) {
    for (let i = 0; i < 64; i += 8) {
      const x = (i / 64 - 0.5) * size, z = (j / 64 - 0.5) * size;
      close(baked(x, z), field.data[j * 65 + i], 1e-3, `node ${i},${j}:`);
    }
  }
});

test("elevNorm is clamped and monotonic", () => {
  eq(elevNorm(-1e6, 400), 0);
  eq(elevNorm(1e6, 400), 1);
  ok(elevNorm(0, 400) > 0.25 && elevNorm(0, 400) < 0.40, "sea level should sit near the shore band");
  ok(elevNorm(100, 400) < elevNorm(200, 400));
});

test("mergeParams patches deep without mutating", () => {
  const merged = mergeParams(DEFAULT_PARAMS, { terrain: { ridged: 0.85 }, water: { preset: "glacial" } });
  ok(DEFAULT_PARAMS.terrain.ridged !== 0.85, "DEFAULT_PARAMS mutated");
  eq(merged.terrain.ridged, 0.85);
  eq(merged.terrain.size, DEFAULT_PARAMS.terrain.size, "unpatched keys survive:");
  eq(merged.water.preset, "glacial");
});

test("makeParams produces a full, isolated params object", () => {
  const p = makeParams({ seed: "K7QN-3F2A-9XBD", theme: "village" });
  ok(p.terrain.size > 0 && p.terrain.height > 0 && p.sky && p.water && p.props, "shape");
  eq(p.structure.theme, "village");
  eq(makeParams({}).structure.theme, "neutral");
  // Deep clone: mutating a made params object must never leak into defaults.
  p.terrain.sculpt.push({ x: 1 });
  p.props.grass.patches.push({ x: 0, z: 0 });
  p.sky.timeOfDay = 23;
  eq(DEFAULT_PARAMS.terrain.sculpt.length, 0, "sculpt leaked:");
  eq(DEFAULT_PARAMS.props.grass.patches.length, 0, "grass leaked:");
  eq(DEFAULT_PARAMS.sky.timeOfDay, 10.5, "sky leaked:");
});

report("coords");
