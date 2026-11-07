// Sky visibility — the engine's indirect light. Pure horizon mapping over a
// heightfield, so it is fully testable: hand it a shape whose answer is known
// by inspection and check the light it derives.

import { test, eq, ok, close, report } from "./harness.js";
import { bakeSkyVisibility, packSkyVisibility, AZIMUTHS } from "../../../src/kernel/terrain/skyvis.js";

const RES = 17, SIZE = 160;
// Index of the grid cell nearest a world coordinate.
const cellOf = (x, z) => {
  const step = SIZE / (RES - 1);
  const i = Math.round((x + SIZE / 2) / step), j = Math.round((z + SIZE / 2) / step);
  return j * RES + i;
};
const bake = (sampler) => bakeSkyVisibility({ sampler, size: SIZE, res: RES });

test("open flat ground sees the whole sky, straight up", () => {
  const b = bake(() => 0);
  for (let k = 0; k < RES * RES; k++) {
    close(b.vis[k], 1, 1e-9, `cell ${k} is fully open`);
    close(b.bentY[k], 1, 1e-9, "and the sky is directly overhead");
    close(b.bentX[k], 0, 1e-9);
    close(b.bentZ[k], 0, 1e-9);
  }
});

test("a slope still sees most of the sky; only what rises above you blocks it", () => {
  // A constant ramp: uphill blocks, downhill cannot. Visibility must sit
  // strictly between a wall and open ground.
  const b = bake((x) => x * 0.6);
  const mid = cellOf(0, 0);
  ok(b.vis[mid] < 1, "the uphill side takes some sky away");
  ok(b.vis[mid] > 0.5, "but a 31° ramp is nothing like a pit");
  // The open sky lies downhill, i.e. toward −x for an upward ramp in +x.
  ok(b.bentX[mid] < -0.05, `bent normal leans downhill, got ${b.bentX[mid]}`);
});

test("a pit loses sky by the closed form, and the way out is still up", () => {
  /* For a cone of uniform slope s the horizon sits at atan(s) in every
     direction, and the cosine-weighted fraction of the dome still visible is
     exactly cos²(atan(s)) = 1/(1+s²). Checking against the analytic answer
     rather than a hand-picked threshold is what makes this a test of the
     model and not of a magic number — a 42° pit really does still receive
     more than half the sky's light, which is the sort of result an eyeballed
     expectation gets wrong. */
  for (const slope of [0.5, 0.9, 2.5]) {
    const b = bake((x, z) => Math.min(Math.hypot(x, z) * slope, 400));
    const centre = cellOf(0, 0);
    close(b.vis[centre], 1 / (1 + slope * slope), 1e-6, `slope ${slope}`);
  }
  const b = bake((x, z) => Math.min(Math.hypot(x, z) * 2.5, 400));
  const centre = cellOf(0, 0);
  ok(b.vis[centre] < 0.2, `a steep shaft is genuinely shut in, got ${b.vis[centre]}`);
  // Symmetric occlusion cancels sideways, leaving straight up.
  close(b.bentX[centre], 0, 0.05, "a symmetric pit has no preferred direction");
  close(b.bentZ[centre], 0, 0.05);
  ok(b.bentY[centre] > 0.9, "and the way out is upward");
  // The flat rim beyond the cone sees the whole sky.
  ok(b.vis[cellOf(70, 70)] > b.vis[centre] + 0.4, "the rim is far more open");
});

test("visibility is bounded and the bent normal is a unit vector", () => {
  const b = bake((x, z) => Math.sin(x * 0.05) * 30 + Math.cos(z * 0.04) * 25);
  for (let k = 0; k < RES * RES; k++) {
    ok(b.vis[k] >= 0 && b.vis[k] <= 1, `vis ${b.vis[k]} in range`);
    close(Math.hypot(b.bentX[k], b.bentY[k], b.bentZ[k]), 1, 1e-5, "unit length");
    ok(b.bentY[k] > 0, "the sky is never below the horizon");
  }
});

test("the bake is a pure function of the heightfield", () => {
  const f = (x, z) => Math.sin(x * 0.03) * 20 + Math.cos(z * 0.05) * 14;
  const a = bake(f), c = bake(f);
  for (let k = 0; k < RES * RES; k++) {
    eq(a.vis[k], c.vis[k], `cell ${k} re-derives identically`);
    eq(a.bentX[k], c.bentX[k]);
  }
});

test("packing survives the round trip into 8 bits", () => {
  const b = bake((x, z) => Math.min(Math.hypot(x, z) * 0.8, 35));
  const rgba = packSkyVisibility(b);
  eq(rgba.length, RES * RES * 4);
  for (let k = 0; k < RES * RES; k++) {
    close(rgba[k * 4 + 3] / 255, b.vis[k], 1 / 255, "alpha carries visibility");
    // RGB is the bent normal remapped to [0,1]; straight up decodes to +y.
    close((rgba[k * 4 + 1] / 255) * 2 - 1, b.bentY[k], 2 / 255, "green carries bent y");
  }
  // Every byte must be a byte — a NaN anywhere lands as 0 and would light a
  // whole region wrong.
  for (const v of rgba) ok(Number.isInteger(v) && v >= 0 && v <= 255, `byte ${v}`);
});

test("a taller obstruction shades more than a short one", () => {
  const shallow = bake((x, z) => Math.min(Math.hypot(x, z) * 0.3, 12));
  const deep = bake((x, z) => Math.min(Math.hypot(x, z) * 1.6, 60));
  const c = cellOf(0, 0);
  ok(deep.vis[c] < shallow.vis[c], "the deeper hollow is darker");
});

test("the azimuth count is the resolution of the horizon sweep", () => {
  // Documented as the point where banding stops being visible; if this is
  // ever lowered the hillsides facet, so it is pinned.
  eq(AZIMUTHS, 16);
});

report("skyvis");
