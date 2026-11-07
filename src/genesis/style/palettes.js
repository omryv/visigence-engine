// Canonical biome palettes. Each palette is the single source of colour truth:
// terrain vertex colours, water tint, sky/fog tint, minimap and the Unity
// TerrainLayer colours are all derived from these stops.
// Stops are [t, hexColor] with t ∈ [0,1] over normalized terrain height.
//
// WHERE THE LAND ACTUALLY IS, and it is not where the numbers suggest.
// `elevNorm` maps a world height through (h/amplitude + 0.45) / 1.45, so the
// natural coastline — h = 0 — always lands at t ≈ 0.31, and the noise fields
// this engine generates reach about a third of their stated amplitude. On a
// typical world every metre of DRY GROUND therefore lives in t ∈ [0.31, 0.58]
// and everything above 0.6 is a stop nobody will ever see.
//
// The first five palettes below predate that measurement and spend half their
// range on peaks; the five after them are laid out against it, which is most
// of why they read as different places rather than as tinted versions of one.
//
// ── AND EACH PALETTE NOW NAMES ITS MATERIALS, NOT ONLY ITS COLOURS ──
// A palette used to be a colour ramp plus three tints, and the ground was
// turf-rock-sand on every world in the catalogue: Badlands and Tundra were
// the same three materials wearing different paint. `layers` is the other
// half — which of terrain/detail-layers.js's ten physical materials this
// biome is actually MADE of, one per splat slot.
//
// The four slots are the four the terrain shader has always had; naming them
// is what turns them from hard-coded materials into a selection:
//
//   ground  flat, dry, above the shore — the biome's default surface
//   steep   what a slope exposes once turf can no longer hold on
//   low     the band at and just above the waterline
//   wet     what a drainage channel is floored with, wherever flow says one
//           ran, whether or not the water plane ever reaches it
//   high    OPTIONAL, and the only one decided by altitude: what a summit
//           wears above the line. Omit it and the biome has no snowline, no
//           scree cap and no extra cost — the fifth tap is gated on the band
//           reaching, so a palette that names one pays for it on its peaks
//           and nowhere else. `highBand: [from, to]` states the line in
//           metres; without it the band is a fraction of the world's own
//           amplitude, which is the only honest default when the palette
//           cannot know how tall the world it is dressing will be.
//
// Four load-bearing slots and ten layers is deliberate. The stack is scalable
// — a new material costs one more layer in an array texture that is already
// bound — while the SHADER stays four wide plus an optional fifth, so the
// height blend stays an unrolled function with no dynamic indexing and the
// per-fragment cost of ten materials is identical to the cost of three.
//
// The high layers below are read against each palette's own top stop: verdant
// tops out white, so its summits are snow; badlands, meadow, parkland and
// weald top out in pale stone, so theirs are scree; tundra is snow all the
// way down and its summits are the bare rock the wind has stripped, which is
// the inversion that makes the biome read as cold rather than as white.
// Oasis and atoll name none — nothing on either world climbs far enough for
// a line to mean anything, and a slot that never triggers is a fetch nobody
// should pay for.

/* ── AND EACH PALETTE NAMES THE CLIMATE IT IS NATIVE TO ──
   `climate: { temp, moist }`, both 0..1. Nothing here reads it: the anchor is
   DATA for engine/terrain/climate.js, which cannot import this file (it is
   core, and a palette is content). When a world lists several biomes in
   params.climate.biomes, a point belongs to whichever anchor its local
   temperature and moisture land nearest, blended toward the runner-up near
   the border. The anchors are placed so that neighbours in climate space are
   plausible neighbours on the ground — tundra is alone at the cold end
   because nothing should ever blend halfway into snow. */
export const PALETTES = {
  verdant: {
    label: "Verdant",
    stops: [[0.0, 0x1d4e46], [0.30, 0x2e6b4f], [0.46, 0x4d8a56], [0.62, 0x7aa05e],
            [0.76, 0x8d8a70], [0.88, 0x9d9d9d], [1.0, 0xf2f4f5]],
    water: { shallow: 0x3fa08c, deep: 0x0d3a45 },
    sky: { horizon: 0xbfd9e2, zenith: 0x3d6db5 },
    fog: 0xa9c4cc,
    grass: 0x4d8a3f,
    rock: 0x6f6d64,
    sand: 0xcabf9c,
    layers: { ground: "turf", steep: "rock", low: "sand", wet: "silt", high: "snow" },
    climate: { temp: 0.55, moist: 0.70 },   // temperate and wet — the default middle of the map
  },
  badlands: {
    label: "Badlands",
    stops: [[0.0, 0x5a3524], [0.30, 0x7a4a2b], [0.48, 0xa4653a], [0.64, 0xc08552],
            [0.80, 0xd8a877], [0.92, 0xe8cba0], [1.0, 0xf4e4c8]],
    water: { shallow: 0x7fa088, deep: 0x2a4a44 },
    sky: { horizon: 0xe8c9a0, zenith: 0x6a89c0 },
    fog: 0xd8b890,
    grass: 0x8a7a3f,
    rock: 0x8a5a3a,
    sand: 0xe2c496,
    layers: { ground: "dirt", steep: "cliff", low: "sand", wet: "gravel", high: "gravel" },
    climate: { temp: 0.80, moist: 0.15 },   // hot and arid
  },
  tundra: {
    label: "Tundra",
    stops: [[0.0, 0x3a4a52], [0.30, 0x54646a], [0.48, 0x6f7f7e], [0.64, 0x93a09a],
            [0.80, 0xc2ccc9], [1.0, 0xf4f8fa]],
    water: { shallow: 0x6fa8b8, deep: 0x14323e },
    sky: { horizon: 0xd8e4ea, zenith: 0x4a6a95 },
    fog: 0xc2d2da,
    grass: 0x5f7a62,
    rock: 0x6d757b,
    sand: 0xbcc4c6,
    layers: { ground: "snow", steep: "rock", low: "gravel", wet: "silt", high: "rock" },
    climate: { temp: 0.10, moist: 0.40 },   // the cold end; nothing else is within reach of it
  },
  volcanic: {
    label: "Volcanic",
    stops: [[0.0, 0x14100f], [0.30, 0x241c1a], [0.50, 0x3a2c26], [0.66, 0x554038],
            [0.82, 0x6f5a4a], [0.94, 0x8a4a30], [1.0, 0xd85a28]],
    water: { shallow: 0x486a6a, deep: 0x0a1e22 },
    sky: { horizon: 0xc08a6a, zenith: 0x3a3550 },
    fog: 0x9a8074,
    grass: 0x4a4a2f,
    rock: 0x3d342f,
    sand: 0x6d5c4c,
    layers: { ground: "dirt", steep: "cliff", low: "gravel", wet: "silt", high: "gravel" },
    climate: { temp: 0.92, moist: 0.30 },   // the hot extreme, dry but not desert-dry
  },
  oasis: {
    label: "Oasis",
    stops: [[0.0, 0x2a6a58], [0.28, 0x54a06a], [0.44, 0xa0b060], [0.60, 0xd0b878],
            [0.78, 0xe0c890], [1.0, 0xf8ecd0]],
    water: { shallow: 0x4fd0b8, deep: 0x0e4a52 },
    sky: { horizon: 0xf0dcb0, zenith: 0x4a8ac8 },
    fog: 0xe0d0a8,
    grass: 0x6aa04a,
    rock: 0xa89a7a,
    sand: 0xead9ab,
    layers: { ground: "drygrass", steep: "rock", low: "sand", wet: "silt" },
    climate: { temp: 0.85, moist: 0.50 },   // desert heat over a water table
  },

  /* ── the five world palettes ──
     One per world grammar, and they are the loudest thing about the
     difference between them: at thumbnail size a person reads colour before
     they read composition.

     EVERY STOP THAT MATTERS IS BETWEEN 0.30 AND 0.55, and that is arithmetic
     rather than taste. The coastline is always t ≈ 0.31, and the noise these
     worlds are grown from reaches about a third of its stated amplitude — so
     on Crownway, where the land runs from sea level to a hundred and twenty
     metres, EVERY BLADE OF GRASS IN THE WORLD lives in t ∈ [0.31, 0.54].
     Stops spread evenly to 1.0 spend two thirds of a palette on ground that
     does not exist and leave the ground that does as one flat green. */

  // Sage and meadow greens under warm limestone, with cool blue water — the
  // ceremonial kingdom. Green stays muted so the castle's own cream and blue
  // are the only saturated things on the plate.
  meadow: {
    label: "Meadow",
    /* One notch greener than it was, judged against the ceremonial kingdom's
       reference plate (docs/shots/cronway.png): the country there is a
       clear spring lawn, and the old sage read as late summer. Still the
       most restrained green of the four — the castle is the saturated
       thing, and the ground must not argue with it. */
    stops: [[0.0, 0x11384c], [0.20, 0x1d5773], [0.292, 0x8d9f74], [0.325, 0x62984a],
            [0.375, 0x72a556], [0.43, 0x84ae61], [0.49, 0x96b574], [0.56, 0xb0b78e],
            [0.66, 0xc9c1a6], [1.0, 0xeae6d8]],
    water: { shallow: 0x5aa8cc, deep: 0x123f5e },
    sky: { horizon: 0xd6e6ee, zenith: 0x4a7fc4 },
    fog: 0xc2d6dd,
    grass: 0x74a851,
    rock: 0xa39c86,
    sand: 0xd6cdae,
    layers: { ground: "turf", steep: "rock", low: "sand", wet: "silt", high: "gravel" },
    climate: { temp: 0.50, moist: 0.55 },   // mild in both axes
  },

  // Fresh grass over warm dirt, a bright sand shelf and dark evergreen above:
  // the small coastal beginning. The beach band is deliberately wide, because
  // on this world the shoreline is most of the composition — and the whole
  // land band is squeezed into a fifth of the range, so the greens have to
  // travel a long way in a short distance.
  shoreland: {
    label: "Shoreland",
    stops: [[0.0, 0x0d394a], [0.19, 0x1a6180], [0.288, 0xd2c199], [0.313, 0xe4d4a8],
            [0.328, 0x6aa64c], [0.372, 0x549639], [0.42, 0x437f31], [0.48, 0x35682c],
            [0.58, 0x5c6f44], [1.0, 0xb0b09c]],
    water: { shallow: 0x54c0d8, deep: 0x0d4762 },
    sky: { horizon: 0xd2e8f0, zenith: 0x3f7fd0 },
    fog: 0xc4dde8,
    grass: 0x5aa346,
    rock: 0x8a7f68,
    sand: 0xe2d2a6,
    layers: { ground: "turf", steep: "rock", low: "sand", wet: "gravel", high: "moss" },
    climate: { temp: 0.42, moist: 0.72 },   // cool wet coast
  },

  // Almost all of this palette is under water, which is the point: a broad
  // desaturated turquoise shelf, then pale warm sand, then nothing. The two
  // stops above 0.36 exist so the highest handful of metres has somewhere to
  // go; nothing on this world will ever reach them.
  atoll: {
    label: "Atoll",
    stops: [[0.0, 0x0c3c46], [0.16, 0x146069], [0.24, 0x3f9aa0], [0.288, 0xc9b894],
            [0.312, 0xe8dcbc], [0.345, 0xdfd3b0], [0.40, 0xc6c298], [0.56, 0x9aa878],
            [1.0, 0xcfc9ae]],
    water: { shallow: 0x66c8c2, deep: 0x1a6a74 },
    sky: { horizon: 0xdff0f2, zenith: 0x4fa0c8 },
    fog: 0xd0e6e8,
    grass: 0x7fa860,
    rock: 0xb8a888,
    sand: 0xe8dcbc,
    layers: { ground: "drygrass", steep: "rock", low: "sand", wet: "silt" },
    climate: { temp: 0.78, moist: 0.88 },   // tropical marine — the wet extreme
  },

  // Bright lawn straight to a clean blue waterline, cream stone on the tops.
  // Cheerful without going to toy-store saturation: the hues are strong but
  // the value range is narrow, so the terrain still reads as one rolling mass
  // rather than as a set of coloured bands.
  parkland: {
    label: "Parkland",
    stops: [[0.0, 0x113f66], [0.20, 0x1d6fa8], [0.288, 0x9dba8c], [0.322, 0x74b84e],
            [0.37, 0x66ac44], [0.42, 0x78bb52], [0.48, 0x8cc55f], [0.55, 0xa9c87e],
            [0.66, 0xcfc9a4], [1.0, 0xf0ece0]],
    water: { shallow: 0x5fbde8, deep: 0x14508c },
    sky: { horizon: 0xdaeefa, zenith: 0x3c86e0 },
    fog: 0xcfe6f4,
    grass: 0x6fb84a,
    rock: 0xb2ab92,
    sand: 0xdcd2b2,
    layers: { ground: "turf", steep: "rock", low: "sand", wet: "silt", high: "gravel" },
    climate: { temp: 0.60, moist: 0.50 },   // warm and even
  },

  /* Deep forest green climbing into rugged stone, over turquoise water: the
     lush alpine country the landing page's hero is cut from.

     THE GREEN IS DARK AND IT HAS TO BE. Every other green palette here is a
     lawn — parkland's 0x74b84e, meadow's 0x72a556 — and a lawn on a steep
     mountain reads as felt. Conifer sits two thirds of the way down that
     value range, and the whole point of the band from 0.312 to 0.46 is that
     it is DENSER at the bottom than at the top: valley floor darkest, timber
     line lifting toward moss, so a slope carries a gradient the eye reads as
     forest depth rather than as one flat colour with shading on it.

     ABOVE THE TREES IT TURNS TO ROCK IN ONE STOP, not three. A gradual green
     → grey ramp is what makes a mountain look mossy; a real timber line is
     abrupt, and putting the whole transition inside 0.03 of t is what gives
     the peaks their rugged read.

     THE WATER IS THE LOUDEST THING IN THE PALETTE, deliberately. A shallow of
     0x4ad2c4 against a deep of 0x0a4351 is a wide extinction span, so the
     lakes go from bright turquoise at a shelving edge to near-black in a
     drowned valley — which is what draws the intricate coastline this world
     is grown to have.

     And its fog is the photograph's own air (0x2e2114, hero/world-air.js's
     ATMOSPHERE — a cream for a sunrise over cloud, then 0x9c876a for a gorge
     at dusk, and now nearly out, because the current frame is a dark room and
     what stands at the back of a dark room is a black wall). Every other
     palette carries the fog of the sky it imagines; this one hangs in a
     specific photograph and takes that photograph's air, so the hero's own
     distance and the frame's own distance are one colour. */
  alpine: {
    label: "Alpine",
    stops: [[0.0, 0x06303c], [0.19, 0x0d5765], [0.272, 0x2a8f92], [0.292, 0x8a9c7c],
            [0.312, 0x2c5f38], [0.355, 0x21512e], [0.405, 0x2b6636], [0.46, 0x3c7c41],
            [0.492, 0x55854b], [0.523, 0x767468], [0.565, 0x918d81], [0.63, 0xbdb8ac],
            [1.0, 0xf4f6f7]],
    water: { shallow: 0x4ad2c4, deep: 0x0a4351 },
    sky: { horizon: 0xf0d6a8, zenith: 0x3f6ea8 },
    fog: 0x2e2114,
    grass: 0x3f8244,
    rock: 0x77786e,
    sand: 0xc3b995,
    layers: { ground: "turf", steep: "cliff", low: "gravel", wet: "silt", high: "snow" },
    climate: { temp: 0.33, moist: 0.66 },   // cool and wet — mountain temperate
  },

  // Olive grass, weathered green, desaturated stone and a cold river: the
  // kingdom that outlived whoever built it. Nothing here is dark enough to be
  // horror — it is late-afternoon light on a place nobody has swept.
  weald: {
    label: "Weald",
    stops: [[0.0, 0x16323e], [0.19, 0x22505e], [0.288, 0x7d7c5e], [0.325, 0x92955a],
            [0.375, 0x84904d], [0.43, 0x76853f], [0.49, 0x87895a], [0.56, 0x9a9678],
            [0.68, 0xa9a48f], [1.0, 0xc4c0b2]],
    water: { shallow: 0x4e8ea0, deep: 0x123846 },
    sky: { horizon: 0xd0cdb8, zenith: 0x5a7ba8 },
    fog: 0xbfbca8,
    grass: 0x6b7a3f,
    rock: 0x77746a,
    sand: 0xa89c80,
    layers: { ground: "drygrass", steep: "rock", low: "moss", wet: "silt", high: "gravel" },
    climate: { temp: 0.40, moist: 0.80 },   // cool and damp
  },
};

export function paletteColor(palette, t) {
  const stops = palette.stops;
  t = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return lerpHex(c0, c1, f);
    }
  }
  return stops[stops.length - 1][1];
}

export function lerpHex(a, b, f) {
  const ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255;
  const br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
  return ((ar + (br - ar) * f) << 16) | ((ag + (bg - ag) * f) << 8) | (ab + (bb - ab) * f) & 255;
}

export function hexToCss(hex) {
  return "#" + (hex >>> 0).toString(16).padStart(6, "0");
}

/* ── the ramp, as a lookup ──
   paletteColor walks the stop list and lerps. That is fine once and expensive
   4225 times a tile: measured on this project's own terrain it is about a
   fifth of the cost of building a tile and almost all of the cost of
   recolouring one for a new palette.

   The stops are PIECEWISE LINEAR in t, so sampling them into a dense table
   and lerping between entries is not an approximation of the ramp — it
   reproduces it exactly, except inside the single table cell that straddles a
   stop. At 2048 entries that cell is a thousandth of the range, and the
   closest pair of stops in any palette here is twenty times further apart
   than that. */
export const LUT_N = 2048;

export function paletteLut(palette) {
  const lut = new Float32Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const c = paletteColor(palette, i / (LUT_N - 1));
    lut[i * 3] = ((c >> 16) & 255) / 255;
    lut[i * 3 + 1] = ((c >> 8) & 255) / 255;
    lut[i * 3 + 2] = (c & 255) / 255;
  }
  return lut;
}

/* Write lut(t) x shade into a flat rgb array at vertex p. Takes the shade so
   the multiply happens here rather than in three more lines at every call
   site — this is the innermost loop of the whole terrain build. */
export function shadeInto(col, p, lut, t, shade) {
  const f = (t < 0 ? 0 : t > 1 ? 1 : t) * (LUT_N - 1);
  const i = f | 0, k = f - i, j = i < LUT_N - 1 ? i + 1 : i;
  const a = i * 3, b = j * 3;
  col[p * 3] = (lut[a] + (lut[b] - lut[a]) * k) * shade;
  col[p * 3 + 1] = (lut[a + 1] + (lut[b + 1] - lut[a + 1]) * k) * shade;
  col[p * 3 + 2] = (lut[a + 2] + (lut[b + 2] - lut[a + 2]) * k) * shade;
}

/* The two-palette form, for ground inside a climate border's blend band:
   lutA(t) and lutB(t) mixed by `mix`, then shaded. `mix` 0 collapses to
   shadeInto(lutA) exactly — the pure interior of a biome pays one extra
   comparison and nothing else, which matters because the interior is most of
   the world. Same innermost-loop discipline as shadeInto: no allocation, no
   calls out. */
export function shadeIntoBlend(col, p, lutA, lutB, mix, t, shade) {
  if (mix <= 0) { shadeInto(col, p, lutA, t, shade); return; }
  const f = (t < 0 ? 0 : t > 1 ? 1 : t) * (LUT_N - 1);
  const i = f | 0, k = f - i, j = i < LUT_N - 1 ? i + 1 : i;
  const a = i * 3, b = j * 3;
  const r = lutA[a] + (lutA[b] - lutA[a]) * k, r2 = lutB[a] + (lutB[b] - lutB[a]) * k;
  const g = lutA[a + 1] + (lutA[b + 1] - lutA[a + 1]) * k, g2 = lutB[a + 1] + (lutB[b + 1] - lutB[a + 1]) * k;
  const bl = lutA[a + 2] + (lutA[b + 2] - lutA[a + 2]) * k, b2 = lutB[a + 2] + (lutB[b + 2] - lutB[a + 2]) * k;
  col[p * 3] = (r + (r2 - r) * mix) * shade;
  col[p * 3 + 1] = (g + (g2 - g) * mix) * shade;
  col[p * 3 + 2] = (bl + (b2 - bl) * mix) * shade;
}
