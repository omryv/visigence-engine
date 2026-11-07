import { test, ok, eq, report } from "../kernel/harness.js";
import { PALETTES, paletteColor, paletteLut, shadeInto, LUT_N } from "../../../src/genesis/style/palettes.js";

test("the lookup reproduces the ramp it replaces", () => {
  /* The claim that justifies the table: the stops are piecewise linear, so
     lerping between dense samples of them is exact rather than approximate.
     Checked against paletteColor itself at 4001 values of t across every
     palette — including t=0 and t=1, where an off-by-one in the index lands.

     ONE 8-BIT STEP IS THE FLOOR HERE, and it is paletteColor's, not the
     table's: lerpHex works in integers and returns a packed int, so
     paletteColor is already quantised to 8 bits. Lerping between two
     quantised samples cannot agree to better than one step with the
     quantisation of an exact lerp — anywhere, not only at a stop. (The first
     draft of this test asked for a quarter of a step and failed at t=0.62,
     which is exactly a stop in `verdant`.) So the bound is one step: the
     table is within the last bit the ramp itself can represent, and being
     smooth where paletteColor stair-steps is if anything the better of the
     two.

     Two parts make up the bound. One 8-bit step is paletteColor's floor as
     above. The rest is the single table cell that straddles a stop, and it is
     largest where the ramp is steepest: `shoreland` puts stops at 0.288,
     0.313 and 0.328 to hold a crisp beach line, so its sand-to-grass edge
     moves ~120 units of red across 0.015 of t. Two steps total, at one value
     of t, on the sharpest colour edge in the catalogue. */
  const col = new Float32Array(3);
  for (const [name, pal] of Object.entries(PALETTES)) {
    const lut = paletteLut(pal);
    let worst = 0, worstT = 0;
    for (let k = 0; k <= 4000; k++) {
      const t = k / 4000;
      shadeInto(col, 0, lut, t, 1);
      const c = paletteColor(pal, t);
      const d = Math.max(
        Math.abs(col[0] - ((c >> 16) & 255) / 255),
        Math.abs(col[1] - ((c >> 8) & 255) / 255),
        Math.abs(col[2] - (c & 255) / 255));
      if (d > worst) { worst = d; worstT = t; }
    }
    ok(worst <= 2 / 255, `${name}: worst error ${(worst * 255).toFixed(3)}/255 at t=${worstT.toFixed(4)}`);
  }
});

test("the table is the declared size and its ends are the ramp's ends", () => {
  const pal = PALETTES.meadow, lut = paletteLut(pal);
  eq(lut.length, LUT_N * 3, "entries:");
  const first = paletteColor(pal, 0), last = paletteColor(pal, 1);
  ok(Math.abs(lut[0] - ((first >> 16) & 255) / 255) < 1e-6, "t=0 matches");
  ok(Math.abs(lut[(LUT_N - 1) * 3] - ((last >> 16) & 255) / 255) < 1e-6, "t=1 matches");
});

test("shade is a plain multiplier, and t is clamped rather than read out of bounds", () => {
  const pal = PALETTES.verdant, lut = paletteLut(pal), col = new Float32Array(6);
  shadeInto(col, 0, lut, 0.5, 1);
  shadeInto(col, 1, lut, 0.5, 0.25);
  for (let i = 0; i < 3; i++) ok(Math.abs(col[3 + i] - col[i] * 0.25) < 1e-7, `channel ${i} scales`);
  // Out of range must not sample past the table — it must pin to the ends.
  const lo = new Float32Array(3), hi = new Float32Array(3);
  shadeInto(lo, 0, lut, -5, 1);
  shadeInto(hi, 0, lut, 7, 1);
  ok(Number.isFinite(lo[0]) && Number.isFinite(hi[0]), "finite outside [0,1]");
  const at0 = new Float32Array(3), at1 = new Float32Array(3);
  shadeInto(at0, 0, lut, 0, 1); shadeInto(at1, 0, lut, 1, 1);
  for (let i = 0; i < 3; i++) {
    eq(lo[i], at0[i], `t<0 pins to t=0 on channel ${i}:`);
    eq(hi[i], at1[i], `t>1 pins to t=1 on channel ${i}:`);
  }
});

report("palette-lut");
