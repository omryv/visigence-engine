/* The ground's materials.
 *
 * This code could not be tested at all until it was made pure. The old
 * three-material generator reached for `new ImageData(...)` and
 * `document.createElement`, so the module that decides what every world is
 * made of was invisible to a suite that is DOM-free by design — and a tiling
 * material has exactly the failure modes a suite is good at catching and an
 * eye is bad at: a seam one pixel wide, a mean that drifts, a layer that
 * silently reproduces the layer before it.
 *
 * Every assertion below is against a property the shader RELIES on, not
 * against a golden image. Nothing here would survive a golden-image test
 * anyway: the fields are seeded, and reseeding is the point.
 */
import { test, ok, eq, report } from "../kernel/harness.js";
import {
  makeLayerStack, LAYER_NAMES, LAYER_INDEX, LAYER_PARAMS, LAYER_RES,
  srgbToLinear,
} from "../../../src/genesis/terrain/detail-layers.js";

const R = LAYER_RES;
const STRIDE = R * R * 4;
const SEED = "ATRB-68XS-EFK5";

// Generated once: ten layers is ~400 ms and every test below reads the same
// stack. A test file that regenerated per assertion would be the slowest
// thing in the suite by an order of magnitude.
const stack = makeLayerStack(SEED);

const lum = (buf, layer, x, y) => {
  const o = layer * STRIDE + (y * R + x) * 4;
  return (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
};
const meanLum = (buf, layer) => {
  let s = 0;
  for (let p = 0; p < STRIDE; p += 4) {
    const o = layer * STRIDE + p;
    s += (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
  }
  return s / (R * R) / 255;
};

/* ── the shape of the thing ── */

test("the stack is ten layers, and the names index them", () => {
  eq(stack.count, 10, "layer count:");
  eq(LAYER_NAMES.length, 10, "names:");
  eq(stack.albedo.length, STRIDE * 10, "albedo bytes:");
  eq(stack.normal.length, STRIDE * 10, "normal bytes:");
  for (let i = 0; i < LAYER_NAMES.length; i++) {
    eq(LAYER_INDEX[LAYER_NAMES[i]], i, `${LAYER_NAMES[i]} indexes to ${i}:`);
  }
});

test("every layer declares the constants the shader reads", () => {
  // Five uniforms are filled from these. A layer missing one renders as a
  // black hole in the middle of the ground, so this is not pedantry.
  for (const name of LAYER_NAMES) {
    const p = LAYER_PARAMS[name];
    ok(p, `${name} has params`);
    ok(p.tiling > 0.5 && p.tiling < 12, `${name} tiling ${p.tiling} is a sane metre count`);
    ok(p.roughness >= 0 && p.roughness <= 1, `${name} roughness ${p.roughness} in range`);
    ok(Math.abs(p.height) <= 0.25, `${name} height bias ${p.height} is a nudge, not a veto`);
    ok(p.triplanar === 0 || p.triplanar === 1, `${name} triplanar is a flag`);
  }
});

/* ── what makes a tiling material tileable ── */

test("every layer tiles seamlessly on both axes", () => {
  /* The test that matters most and is hardest to eyeball. These maps repeat
     every couple of metres of world, so a seam is not one line — it is a grid
     of lines to the horizon.

     The bar is relative rather than absolute: the difference across the wrap
     must be no worse than the difference between two ADJACENT interior
     columns of the same layer. A fixed threshold would either pass a seam in
     a high-contrast layer like cliff or fail a clean wrap in a smooth one
     like snow. */
  for (let i = 0; i < stack.count; i++) {
    let wrapX = 0, wrapY = 0, innerX = 0, innerY = 0;
    for (let k = 0; k < R; k++) {
      wrapX += Math.abs(lum(stack.albedo, i, 0, k) - lum(stack.albedo, i, R - 1, k));
      wrapY += Math.abs(lum(stack.albedo, i, k, 0) - lum(stack.albedo, i, k, R - 1));
      innerX += Math.abs(lum(stack.albedo, i, R >> 1, k) - lum(stack.albedo, i, (R >> 1) + 1, k));
      innerY += Math.abs(lum(stack.albedo, i, k, R >> 1) - lum(stack.albedo, i, k, (R >> 1) + 1));
    }
    const name = LAYER_NAMES[i];
    // +1 so a layer whose interior is perfectly flat (innerX ≈ 0) does not
    // set itself an impossible bar.
    ok(wrapX / R <= innerX / R + 1, `${name} wraps in x (${(wrapX / R).toFixed(2)} vs ${(innerX / R).toFixed(2)} adjacent)`);
    ok(wrapY / R <= innerY / R + 1, `${name} wraps in y (${(wrapY / R).toFixed(2)} vs ${(innerY / R).toFixed(2)} adjacent)`);
  }
});

test("the normal maps wrap too", () => {
  // A seamless albedo over a seamed normal map is worse than both seamed:
  // the lighting breaks along a line the colour says is not there.
  for (let i = 0; i < stack.count; i++) {
    let wrap = 0, inner = 0;
    for (let k = 0; k < R; k++) {
      const a = i * STRIDE + (k * R + 0) * 4, b = i * STRIDE + (k * R + R - 1) * 4;
      const c = i * STRIDE + (k * R + (R >> 1)) * 4, d = c + 4;
      wrap += Math.abs(stack.normal[a] - stack.normal[b]);
      inner += Math.abs(stack.normal[c] - stack.normal[d]);
    }
    ok(wrap / R <= inner / R + 2, `${LAYER_NAMES[i]} normal wraps (${(wrap / R).toFixed(2)} vs ${(inner / R).toFixed(2)})`);
  }
});

/* ── what makes a material MULTIPLY rather than repaint ── */

test("every layer's albedo is centred near mid-grey", () => {
  /* The shader multiplies the palette colour by this map. A layer whose mean
     is 0.7 does not look like a bright material — it looks like the whole
     biome has been washed out, because it has. That is the trap snow walked
     into on the first draft (mean 0.69) and it is why the bound is here
     rather than in a comment. */
  for (let i = 0; i < stack.count; i++) {
    const m = meanLum(stack.albedo, i);
    ok(m > 0.40 && m < 0.60, `${LAYER_NAMES[i]} mean luminance ${m.toFixed(3)} is near 0.5`);
  }
});

test("albedo luminance carries real relief, because the height blend reads it", () => {
  /* wgHeightBlend5 asks "which material is physically higher here" and is
     answered with the luminance of this albedo. A flat-coloured layer would
     make the interlock silently degrade to the crossfade it replaced — and
     it would still LOOK like a material, which is what makes this worth an
     assertion. So every layer must have real luminance spread. */
  for (let i = 0; i < stack.count; i++) {
    let mn = 255, mx = 0;
    for (let p = 0; p < STRIDE; p += 4) {
      const o = i * STRIDE + p;
      const l = (stack.albedo[o] + stack.albedo[o + 1] + stack.albedo[o + 2]) / 3;
      if (l < mn) mn = l;
      if (l > mx) mx = l;
    }
    ok(mx - mn > 20, `${LAYER_NAMES[i]} spans ${(mx - mn).toFixed(0)}/255 of luminance`);
  }
});

test("each layer reports the reciprocal that makes it a neutral multiplier", () => {
  /* THE BUG THIS EXISTS TO STOP COMING BACK.
     The albedo layers are uploaded as sRGB, so the GPU sampler DECODES them:
     a texel authored at byte 128 arrives as 0.216, not 0.502. The shader
     multiplies the palette by these maps, and the renormaliser was a
     hardcoded `* 2.0` chosen against the BYTE mean — so against the linear
     mean of ~0.21, with two taps rather than the one it was written for, the
     product's mean was ~0.09 and the ground within ~600 m of the camera
     rendered at a quarter of its palette brightness.

     A constant cannot be right here, because the right number is a property
     of each layer's own pixels. So it is measured, and this asserts what it
     has to be measuring: tap × norm must have mean 1.0, because 1.0 is the
     identity for a multiplier. */
  eq(stack.norm.length, stack.count, "one reciprocal per layer:");
  for (let i = 0; i < stack.count; i++) {
    let m = 0;
    for (let p = 0; p < STRIDE; p += 4) {
      const o = i * STRIDE + p;
      m += (srgbToLinear(stack.albedo[o]) + srgbToLinear(stack.albedo[o + 1]) + srgbToLinear(stack.albedo[o + 2])) / 3;
    }
    m /= R * R;
    const neutral = m * stack.norm[i];
    ok(Math.abs(neutral - 1) < 0.005, `${LAYER_NAMES[i]} tap×norm = ${neutral.toFixed(4)}`);
    // And the reciprocal must be of the LINEAR mean, not the byte mean —
    // the two differ by more than a factor of two, which is exactly the size
    // of the mistake this is guarding.
    ok(stack.norm[i] > 2.5, `${LAYER_NAMES[i]} norm ${stack.norm[i].toFixed(2)} is a linear-space reciprocal, not a byte-space one`);
  }
});

test("normals are unit-ish and point outward", () => {
  // z < 0.5 after decoding would be a normal pointing INTO the surface.
  for (let i = 0; i < stack.count; i++) {
    let worstZ = 255, worstLen = 1;   // 1 is a perfect normal — start at the best, not at zero
    for (let p = 0; p < STRIDE; p += 4 * 37) {   // stride-sample: 37 is coprime with the row
      const o = i * STRIDE + p;
      if (stack.normal[o + 2] < worstZ) worstZ = stack.normal[o + 2];
      const x = stack.normal[o] / 127.5 - 1, y = stack.normal[o + 1] / 127.5 - 1, z = stack.normal[o + 2] / 127.5 - 1;
      const len = Math.sqrt(x * x + y * y + z * z);
      if (Math.abs(len - 1) > Math.abs(worstLen - 1)) worstLen = len;
    }
    ok(worstZ > 127, `${LAYER_NAMES[i]} normals face out (min z byte ${worstZ})`);
    ok(Math.abs(worstLen - 1) < 0.12, `${LAYER_NAMES[i]} normals are unit-ish (worst |n| ${worstLen.toFixed(3)})`);
  }
});

/* ── seeded, and genuinely distinct ── */

test("the same seed grows the same ground", () => {
  const again = makeLayerStack(SEED);
  // Spot-check rather than 2.5 MB byte-for-byte: a generator that drifted
  // would drift everywhere, and this keeps the suite quick.
  for (let i = 0; i < stack.count; i++) {
    for (const [x, y] of [[0, 0], [17, 200], [128, 128], [255, 255]]) {
      eq(lum(again.albedo, i, x, y), lum(stack.albedo, i, x, y), `${LAYER_NAMES[i]} at ${x},${y}:`);
    }
  }
});

test("a different seed grows different ground", () => {
  const other = makeLayerStack("SOME-OTHER-SEED");
  for (let i = 0; i < stack.count; i++) {
    let same = 0, n = 0;
    for (let y = 0; y < R; y += 8) {
      for (let x = 0; x < R; x += 8, n++) {
        if (lum(other.albedo, i, x, y) === lum(stack.albedo, i, x, y)) same++;
      }
    }
    ok(same / n < 0.5, `${LAYER_NAMES[i]} reseeds (${((same / n) * 100).toFixed(0)}% identical samples)`);
  }
});

test("no two layers are the same material wearing a different name", () => {
  /* Ten layers that are one layer ten times would pass every test above and
     be worth nothing. Compare each pair by mean absolute luminance
     difference — two genuinely different materials cannot agree closely
     everywhere. */
  for (let a = 0; a < stack.count; a++) {
    for (let b = a + 1; b < stack.count; b++) {
      let d = 0, n = 0;
      for (let y = 0; y < R; y += 4) {
        for (let x = 0; x < R; x += 4, n++) d += Math.abs(lum(stack.albedo, a, x, y) - lum(stack.albedo, b, x, y));
      }
      ok(d / n > 3, `${LAYER_NAMES[a]} vs ${LAYER_NAMES[b]} differ (mean Δ ${(d / n).toFixed(1)})`);
    }
  }
});

test("a restricted stack generates only what was asked for, and the rest stay inert", () => {
  /* `only` exists so a caller that knows it needs four materials can pay for
     four. The layers it skips must be INERT rather than absent: mid-grey
     albedo multiplies to no change and (128,128,255) is the normal that
     bends no light, so an unselected layer renders as untextured ground
     rather than as a black hole. */
  const few = makeLayerStack(SEED, { only: ["turf", "rock"] });
  eq(few.count, 10, "the stack keeps its shape:");
  for (const name of ["turf", "rock"]) {
    const i = LAYER_INDEX[name];
    eq(lum(few.albedo, i, 40, 90), lum(stack.albedo, i, 40, 90), `${name} is generated identically:`);
  }
  const i = LAYER_INDEX.snow;
  eq(lum(few.albedo, i, 40, 90), 128, "an unasked layer is mid-grey:");
  const o = i * STRIDE + (90 * R + 40) * 4;
  eq(few.normal[o], 128, "…and its normal is flat in x:");
  eq(few.normal[o + 1], 128, "…and in y:");
  eq(few.normal[o + 2], 255, "…and points straight out:");
});

report("detail-layers");
