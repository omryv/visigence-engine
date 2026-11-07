/* detail-layers.js — the ground's materials, as data.
 *
 * WHAT MOVED AND WHY. detail-textures.js used to generate three albedo+normal
 * pairs — turf, rock, sand — straight into six CanvasTextures. Three was not
 * a design, it was the number the shader had samplers for: every new material
 * cost two more uniforms, two more fetches and another branch in a shader that
 * already had one arm per layer. The ground could never be gravel, or silt, or
 * snow, because there was nowhere to put them.
 *
 * So the generation is a LAYER STACK now, and it is pure. Nothing here touches
 * a canvas, an ImageData or three.js: every layer is written into one flat
 * Uint8Array with a per-layer stride, which is exactly the memory layout
 * THREE.DataArrayTexture wants (texStorage3D + texSubImage3D). The wrapper in
 * detail-textures.js hands the buffer over and nothing is copied.
 *
 * That purity is the real prize rather than a side effect. The old file could
 * not be tested at all — `new ImageData(...)` and `document.createElement`
 * exist in a browser and nowhere else, so the suite (which is DOM-free by
 * design) had to skip the code that decides what the ground is made of. This
 * module runs under JavaScriptCore like masks.js and shading.js do, and
 * tests/detail-layers.test.js holds it to what a tiling material has to be:
 * seamless, seeded, and centred near the mid-grey the shader multiplies by.
 *
 * ── ALBEDO LUMINANCE IS RELIEF, AND THAT IS LOAD-BEARING ──
 * Every layer is a HEIGHT FIELD first; the albedo is a shading of that field
 * and the normal map is its derivative. So the luminance of a layer's albedo
 * IS the material's relief, which is what makes the height blend in
 * render/chunks.js meaningful rather than decorative — wgHeightBlend5 asks
 * "which material is physically higher at this pixel" and the answer is a
 * texture fetch it was already making. Author a layer as flat colour and the
 * interlock silently degrades to a crossfade. Keep the field.
 */

import { channelRng } from "../../kernel/seed.js";

// One layer is 256². Big enough that the fine tap has real structure, small
// enough that ten of them are 2.6 MB rather than 42 — and the coarse tap in
// the shader is what carries large-scale variety, not resolution here.
export const LAYER_RES = 256;

/* The stack, in index order. THIS ORDER IS THE CONTRACT with the shader and
   with every palette that names a layer: indices are baked into uniforms, so
   append at the end and never reorder. Ten is not arbitrary — it is what the
   four splat slots can select from with room for a biome to be specific
   (a shore wants sand+silt, a summit wants rock+snow, a moor wants moss+peat)
   without any of them paying for the others at fragment time. */
export const LAYER_NAMES = [
  "turf",     // 0  clumpy living growth
  "drygrass", // 1  the same land in late summer
  "dirt",     // 2  bare fine earth
  "gravel",   // 3  loose stones, the highest-relief ground layer
  "rock",     // 4  bedded strata with cracks
  "cliff",    // 5  the same rock stood on end
  "sand",     // 6  wind ripples
  "silt",     // 7  what settles out of water: nearly flat, fills in
  "snow",     // 8  smooth drift with a wind crust
  "moss",     // 9  soft deep pads
];

export const LAYER_INDEX = Object.fromEntries(LAYER_NAMES.map((n, i) => [n, i]));

/* Per-layer material constants, read by the terrain shader through uniforms
   rather than compiled in, so a palette can lean on a layer without a new
   program. Kept beside the generator because they describe the SAME material
   the generator draws — a tiling figure that disagrees with the pattern it
   tiles is the classic way a stack like this drifts out of true.

   tiling      metres per repeat of the fine tap. Coarse is this × 6.2.
   roughness   the A3 figure this layer contributes to roughnessFactor.
   height      height-blend bias: how far this layer pushes into its
               neighbours before their own relief wins. Silt is negative on
               purpose — it is the material that fills in around others.
   triplanar   1 for materials that must survive a vertical face. Rock and
               cliff are projected on three axes; flat ground is not, because
               two of the three taps would be paid for nothing. */
export const LAYER_PARAMS = {
  turf:     { tiling: 2.75, roughness: 0.95, height: 0.00, triplanar: 0 },
  drygrass: { tiling: 2.90, roughness: 0.94, height: 0.00, triplanar: 0 },
  dirt:     { tiling: 2.40, roughness: 0.93, height: -0.04, triplanar: 0 },
  gravel:   { tiling: 1.60, roughness: 0.88, height: 0.10, triplanar: 0 },
  rock:     { tiling: 3.50, roughness: 0.72, height: 0.06, triplanar: 1 },
  cliff:    { tiling: 4.20, roughness: 0.70, height: 0.08, triplanar: 1 },
  sand:     { tiling: 1.80, roughness: 0.92, height: -0.02, triplanar: 0 },
  silt:     { tiling: 2.10, roughness: 0.55, height: -0.10, triplanar: 0 },
  snow:     { tiling: 3.20, roughness: 0.60, height: 0.04, triplanar: 0 },
  moss:     { tiling: 1.90, roughness: 0.97, height: 0.07, triplanar: 0 },
};

const S = LAYER_RES;

/* Tileable value noise: a wrapped random lattice per octave, bilinear-read.
   Unchanged from the three-material version — the turf, rock and sand layers
   below must generate byte-for-byte what they always did, or every existing
   world's ground changes under a commit that claims to be adding materials. */
function makeFbm(rng, octaves, baseFreq = 4, gain = 0.55) {
  const grids = [];
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const g = new Float32Array(freq * freq);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    grids.push({ g, freq });
    freq *= 2;
  }
  return (u, v) => { // u, v in [0,1), seamlessly tiling
    let sum = 0, amp = 1, norm = 0;
    for (const { g, freq } of grids) {
      const x = u * freq, y = v * freq;
      const x0 = Math.floor(x) % freq, y0 = Math.floor(y) % freq;
      const x1 = (x0 + 1) % freq, y1 = (y0 + 1) % freq;
      let fx = x - Math.floor(x), fy = y - Math.floor(y);
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const a = g[y0 * freq + x0], b = g[y0 * freq + x1];
      const c = g[y1 * freq + x0], d = g[y1 * freq + x1];
      sum += (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * amp;
      norm += amp;
      amp *= gain;
    }
    return sum / norm;
  };
}

/* Height field → RGBA bytes, written directly into `out` at a layer offset.
   `shade` maps a 0..1 height plus the pixel's uv to an [r,g,b] around 0.5. */
function writeAlbedo(out, base, height, shade) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const [r, g, b] = shade(height[i], x / S, y / S, i);
      const o = base + i * 4;
      out[o] = clamp255(r * 255);
      out[o + 1] = clamp255(g * 255);
      out[o + 2] = clamp255(b * 255);
      out[o + 3] = 255;
    }
  }
}

/* Tangent-space normal map from a WRAPPED height field — the modulo on both
   axes is what keeps the normals seamless where the albedo already tiles.
   Same convention as props/textures.js so both kinds of surface light alike. */
function writeNormal(out, base, h, strength) {
  for (let y = 0; y < S; y++) {
    const row = y * S, up = ((y - 1 + S) % S) * S, dn = ((y + 1) % S) * S;
    for (let x = 0; x < S; x++) {
      const xp = (x + 1) % S, xm = (x - 1 + S) % S;
      const dx = (h[row + xp] - h[row + xm]) * strength;
      const dy = (h[dn + x] - h[up + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = base + (row + x) * 4;
      out[o] = clamp255(127.5 * (1 - dx * inv));
      out[o + 1] = clamp255(127.5 * (1 + dy * inv));
      out[o + 2] = clamp255(255 * ((inv + 1) / 2));
      out[o + 3] = 255;
    }
  }
}

const clamp255 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
const field = () => new Float32Array(S * S);

/* ── the sRGB electro-optical transfer function, and why this file owes the
      shader a number ──

   The albedo layers are uploaded with SRGBColorSpace, so three gives them the
   SRGB8_ALPHA8 internal format and the GPU's sampler DECODES them: a texel
   authored at byte 128 arrives in the shader as 0.216, not 0.502.

   That decode is correct and wanted — these are colours. What is not wanted
   is what happened next. The maps are authored around a mean of 0.5 IN BYTES,
   the shader multiplies the palette by their product, and the renormaliser
   that was supposed to keep that product neutral was a hardcoded `* 2.0`
   chosen against the byte mean. Against the LINEAR mean of ~0.21, and with
   two taps rather than the one it was written for, the product's mean is
   about 0.09 — so `tCol *= mix(1.0, det, 0.82)` rendered near ground at a
   quarter of its palette brightness, fading back to full over ~600 m. Every
   world has been shipping a dark halo around the camera.

   A constant cannot fix this, because the right constant is a property of
   each layer's own pixels and changes the moment anyone edits a shade
   function. So it is MEASURED here, from the bytes that were actually
   written, and handed to the shader as a per-layer reciprocal. A tap
   multiplied by it has mean 1.0; the product of two has mean 1.0; and 1.0 is
   the identity for a multiplier, which is what "detail modulates the palette
   rather than darkening it" has to mean arithmetically. */
export const srgbToLinear = (b) => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

function meanLinear(buf, base) {
  let s = 0;
  for (let p = 0; p < S * S * 4; p += 4) {
    const o = base + p;
    s += (srgbToLinear(buf[o]) + srgbToLinear(buf[o + 1]) + srgbToLinear(buf[o + 2])) / 3;
  }
  return s / (S * S);
}

/* ── the ten materials ──
   Each returns { height, shade, strength }: the relief, how to colour it, and
   how hard its normal map bites. Every one is a pure function of its own
   seeded rng, so a layer added here cannot change the layer before it.

   turf, rock and sand reproduce the three-material version exactly — same
   channel names, same octave counts, same constants — because those three are
   the ground of every world that already exists. */
const GENERATORS = {
  turf(rng) {
    const fbm = makeFbm(rng, 5, 4);
    const clump = makeFbm(rng, 3, 8);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = fbm(u, v) * 0.7 + Math.pow(clump(u, v), 2.2) * 0.3;
      }
    }
    return {
      height: h, strength: 2.4,
      shade: (t, u, v) => {
        const speck = clump(v, u) < 0.22 ? -0.1 : 0;   // reuse the field, transposed
        const l = 0.36 + t * 0.3 + speck;
        return [l * 1.02, l * 1.05, l * 0.94];          // a breath of green-warm drift
      },
    };
  },

  // The same land in a dry season: the clumps have gone flat and open, so the
  // field is smoother and the speckle is bright straw instead of dark growth.
  drygrass(rng) {
    const fbm = makeFbm(rng, 5, 5);
    const straw = makeFbm(rng, 3, 12);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = fbm(u, v) * 0.82 + straw(u, v) * 0.18;
      }
    }
    return {
      height: h, strength: 1.9,
      shade: (t, u, v) => {
        const blade = straw(v, u) > 0.78 ? 0.07 : 0;
        const l = 0.40 + t * 0.26 + blade;
        return [l * 1.07, l * 1.02, l * 0.86];
      },
    };
  },

  // Bare earth: fine granular, low contrast, no structure to speak of. It is
  // the layer that has to look like nothing in particular, because that is
  // what makes the layers either side of it read as something.
  dirt(rng) {
    const fbm = makeFbm(rng, 5, 6);
    const lump = makeFbm(rng, 3, 3);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = fbm(u, v) * 0.6 + lump(u, v) * 0.4;
      }
    }
    return {
      height: h, strength: 1.6,
      shade: (t) => {
        const l = 0.38 + t * 0.22;
        return [l * 1.06, l * 0.97, l * 0.86];
      },
    };
  },

  // Loose stone. Worley-ish cells from a ridged field pushed hard, so the
  // relief is pebbles rather than lumps — the highest-relief ground layer,
  // which is what lets it break up through turf in the height blend.
  gravel(rng) {
    const fbm = makeFbm(rng, 4, 10);
    const grit = makeFbm(rng, 3, 20);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        // Ridged inversion turns smooth noise into packed rounded cells.
        const cell = 1 - Math.abs(2 * fbm(u, v) - 1);
        h[y * S + x] = Math.pow(cell, 1.6) * 0.74 + grit(u, v) * 0.26;
      }
    }
    return {
      height: h, strength: 3.0,
      shade: (t, u, v) => {
        // Individual stones take slightly different rock hues.
        const tint = grit(v, u);
        const l = 0.34 + t * 0.34;
        return [l * (0.97 + tint * 0.1), l * (0.98 + tint * 0.05), l * (1.0 - tint * 0.04)];
      },
    };
  },

  rock(rng) {
    const fbm = makeFbm(rng, 5, 4);
    const warp = makeFbm(rng, 3, 4);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const ridged = 1 - Math.abs(2 * fbm(u, v) - 1);
        // Strata: banded by v, warped so beds undulate rather than rule.
        const bands = 0.5 + 0.5 * Math.sin((v + warp(u, v) * 0.35) * Math.PI * 10);
        h[y * S + x] = ridged * 0.62 + bands * 0.38;
      }
    }
    return {
      height: h, strength: 3.4,
      shade: (t, u, v) => {
        // Cracks: thin dark seams where the ridged field pinches.
        const seam = 1 - Math.abs(2 * fbm(v, u) - 1);
        const l = 0.34 + t * 0.32 + (seam > 0.93 ? -0.16 : 0);
        return [l * 1.03, l, l * 0.97];
      },
    };
  },

  // Rock stood on end. Tighter beds running the other way and harder seams:
  // a cliff face is the same stone as the ledge above it, read across the
  // grain instead of along it, which is why this is its own layer rather
  // than rock with a different tiling number.
  cliff(rng) {
    const fbm = makeFbm(rng, 5, 5);
    const warp = makeFbm(rng, 3, 3);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const ridged = 1 - Math.abs(2 * fbm(u, v) - 1);
        const beds = 0.5 + 0.5 * Math.sin((u + warp(u, v) * 0.5) * Math.PI * 16);
        h[y * S + x] = ridged * 0.55 + beds * 0.45;
      }
    }
    return {
      height: h, strength: 4.0,
      shade: (t, u, v) => {
        const seam = 1 - Math.abs(2 * fbm(v, u) - 1);
        const l = 0.31 + t * 0.34 + (seam > 0.90 ? -0.2 : 0);
        return [l * 1.01, l * 0.99, l * 0.98];
      },
    };
  },

  sand(rng) {
    const fbm = makeFbm(rng, 4, 8);
    const warp = makeFbm(rng, 3, 4);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const ripple = 0.5 + 0.5 * Math.sin((u + warp(u, v) * 0.5) * Math.PI * 22);
        h[y * S + x] = ripple * 0.45 + fbm(u, v) * 0.55;
      }
    }
    return {
      height: h, strength: 1.8,
      shade: (t) => {
        const l = 0.4 + t * 0.24;
        return [l * 1.04, l * 1.0, l * 0.92];
      },
    };
  },

  // What settles out of still water. Almost no relief on purpose: its
  // LAYER_PARAMS height is negative, so in the blend it is the material that
  // fills the gaps between the others rather than one that competes.
  silt(rng) {
    const fbm = makeFbm(rng, 4, 5);
    const crack = makeFbm(rng, 3, 7);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = fbm(u, v) * 0.85 + crack(u, v) * 0.15;
      }
    }
    return {
      height: h, strength: 1.0,
      shade: (t, u, v) => {
        // Dried polygonal cracking, faint — this is the bed of something.
        const seam = 1 - Math.abs(2 * crack(u, v) - 1);
        const l = 0.40 + t * 0.18 + (seam > 0.95 ? -0.06 : 0);
        return [l * 0.99, l * 0.99, l * 0.97];
      },
    };
  },

  // Drift with a wind crust. Bright and low-contrast, because snow's whole
  // visual character is in its shading rather than its albedo — the normal
  // map is doing the work here, which is why strength is high on so soft a
  // field.
  snow(rng) {
    const fbm = makeFbm(rng, 4, 3);
    const crust = makeFbm(rng, 3, 14);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = fbm(u, v) * 0.8 + crust(u, v) * 0.2;
      }
    }
    return {
      height: h, strength: 2.6,
      shade: (t) => {
        // Bright-LOOKING snow is the palette's job, not this map's: every
        // layer multiplies the palette colour, so a mean above ~0.5 does not
        // read as snow, it reads as the whole biome being washed out. The
        // crust normal is what makes this snow; the albedo stays neutral.
        const l = 0.44 + t * 0.14;
        return [l * 0.99, l * 1.0, l * 1.04];
      },
    };
  },

  // Deep soft pads. High relief and the darkest layer in the stack, so where
  // a palette puts moss under turf the ground gains depth rather than a tint.
  moss(rng) {
    const fbm = makeFbm(rng, 5, 7);
    const pad = makeFbm(rng, 3, 5);
    const h = field();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        h[y * S + x] = Math.pow(pad(u, v), 1.4) * 0.62 + fbm(u, v) * 0.38;
      }
    }
    return {
      height: h, strength: 3.2,
      shade: (t, u, v) => {
        const l = 0.36 + t * 0.24;
        return [l * 0.88, l * 1.08, l * 0.82];
      },
    };
  },
};

/* Build the whole stack.
 *
 * Returns two flat RGBA buffers laid out layer by layer — exactly what
 * DataArrayTexture wants, so the wrapper copies nothing — plus the params in
 * index order. Deterministic per seed: the same world always grows the same
 * ground, and each layer draws from its OWN named channel, so adding a layer
 * cannot shift the noise of any layer before it.
 *
 * `only` restricts generation to a subset by name (the rest stay mid-grey and
 * flat-normal, which renders as untextured rather than as garbage). Callers
 * that know a biome touches four layers can pay for four; the default is the
 * whole stack, because the set is per-SEED while the palette that selects
 * from it can change at any time without a regeneration.
 */
export function makeLayerStack(seed, { only = null } = {}) {
  const count = LAYER_NAMES.length;
  const stride = S * S * 4;
  const albedo = new Uint8Array(stride * count);
  const normal = new Uint8Array(stride * count);
  // Neutral defaults, so a layer that is never generated is inert in the
  // shader rather than black: mid-grey albedo multiplies to no change, and
  // (128,128,255) is the tangent-space normal that bends nothing.
  albedo.fill(128);
  for (let i = 0; i < normal.length; i += 4) {
    normal[i] = 128; normal[i + 1] = 128; normal[i + 2] = 255; normal[i + 3] = 255;
  }
  for (let i = 3; i < albedo.length; i += 4) albedo[i] = 255;

  const wanted = only ? new Set(only) : null;
  // The reciprocal of each layer's linear mean — what the shader multiplies a
  // tap by to make it a neutral modulator. Measured, never guessed.
  const norm = new Float32Array(count);
  for (let li = 0; li < count; li++) {
    const name = LAYER_NAMES[li];
    const base = li * stride;
    if (wanted && !wanted.has(name)) {
      // An ungenerated layer is flat byte-128, whose linear value is 0.2159.
      norm[li] = 1 / srgbToLinear(128);
      continue;
    }
    const gen = GENERATORS[name];
    if (!gen) { norm[li] = 1 / srgbToLinear(128); continue; }
    const { height, shade, strength } = gen(channelRng(seed, "detail:" + name));
    writeAlbedo(albedo, base, height, shade);
    writeNormal(normal, base, height, strength);
    const m = meanLinear(albedo, base);
    norm[li] = m > 1e-4 ? 1 / m : 1;
  }

  return {
    res: S,
    count,
    albedo,
    normal,
    norm,
    names: LAYER_NAMES.slice(),
    params: LAYER_NAMES.map((n) => LAYER_PARAMS[n]),
  };
}
