// Structure themes: procedural re-dressing of builder blocks. A theme remaps
// every part by its texture ROLE (the `tex` kind doubles as semantics —
// plaster=walls, concrete=structure, wood/board=timber, shingle/rooftile=
// roofs, stone/brick=masonry, metal=fittings, foliage=leaves,
// paint=untextured painted parts). Per role: `tint` is a per-channel multiplier over the authored
// color (1 = untouched, so light/dark variation survives), `tex` swaps the
// procedural map. Theme-level: `style` picks the TEXTURE genre skin
// (real | toon | grim | fantasy — textures.js), `grime` multiplies each
// block's weathering height, `emissive` multiplies window/flame glow.
// The active theme travels in params.structure.theme, so VSight and exports
// dress the identical world. Pure data — no three.js here.

export const THEMES = {
  neutral: {
    label: "Neutral",
    swatch: ["#9aa0a8", "#8f959c", "#b0a894"],
    map: {},
  },
  // Battle-royale cartoon: flat posterized fills, inked seams, candy palette.
  toon: {
    label: "Toon",
    swatch: ["#f2d8a8", "#d8895c", "#8fc7e8"],
    style: "toon",
    grime: 0.25,
    emissive: 1.25,
    map: {
      plaster: { tint: [1.3, 1.22, 1.05] },
      concrete: { tint: [1.15, 1.12, 1.05] },
      stone: { tint: [1.1, 1.08, 1.02] },
      wood: { tint: [1.35, 1.05, 0.75] },
      board: { tint: [1.35, 1.05, 0.75] },
      shingle: { tint: [1.6, 0.9, 0.7] },
      rooftile: { tint: [1.55, 0.9, 0.7] },
      brick: { tint: [1.45, 0.95, 0.8] },
      metal: { tint: [1.1, 1.12, 1.18] },
      foliage: { tint: [1.2, 1.25, 0.85] },
      paint: { tint: [1.2, 1.15, 1.05] },
    },
  },
  // Survival horror: rot, damp stains, mold, cracks, near-dead lights.
  horror: {
    label: "Horror",
    swatch: ["#2f3236", "#4a4340", "#6a6f74"],
    style: "grim",
    grime: 2.6,
    // 0.37 × the 2.3 night ramp = the same final radiance the fixtures were
    // authored against under 0.25 × the old 3.4 ramp — Nightfall's lamps
    // keep their calibrated glow through the ramp change.
    emissive: 0.37,
    map: {
      plaster: { tint: [0.7, 0.72, 0.72] },
      concrete: { tint: [0.65, 0.66, 0.66] },
      stone: { tint: [0.6, 0.62, 0.64] },
      wood: { tint: [0.5, 0.44, 0.4] },
      board: { tint: [0.5, 0.44, 0.4] },
      shingle: { tint: [0.45, 0.44, 0.46] },
      rooftile: { tint: [0.48, 0.46, 0.48] },
      brick: { tint: [0.6, 0.52, 0.5] },
      metal: { tint: [0.55, 0.56, 0.58] },
      foliage: { tint: [0.42, 0.47, 0.44] },
      paint: { tint: [0.62, 0.63, 0.65] },
    },
  },
  // MMORPG medieval: carved borders, rune bands, dark oak, bronze fittings.
  mmorpg: {
    label: "Fantasy",
    swatch: ["#8a6a48", "#77818c", "#c9b489"],
    style: "fantasy",
    grime: 1.2,
    emissive: 1.35,
    map: {
      plaster: { tint: [1.1, 1.02, 0.86] },
      concrete: { tex: "stone", tint: [0.95, 0.92, 0.85] },
      stone: { tint: [0.92, 0.9, 0.85] },
      wood: { tint: [0.85, 0.68, 0.5] },
      board: { tint: [0.85, 0.68, 0.5] },
      shingle: { tint: [0.7, 0.6, 0.62] },
      rooftile: { tex: "shingle", tint: [0.72, 0.62, 0.6] },
      brick: { tex: "stone", tint: [1.0, 0.9, 0.8] },
      metal: { tint: [0.85, 0.76, 0.6] },
      foliage: { tint: [0.88, 1.0, 0.72] },
      paint: { tint: [0.95, 0.9, 0.8] },
    },
  },
  village: {
    label: "Village",
    swatch: ["#cbb794", "#b76e5a", "#9c7a52"],
    grime: 0.7,
    emissive: 1.15,
    map: {
      plaster: { tint: [1.18, 1.08, 0.92] },
      concrete: { tint: [1.06, 1.0, 0.92] },
      stone: { tint: [1.05, 1.0, 0.92] },
      wood: { tint: [1.15, 0.98, 0.8] },
      board: { tint: [1.15, 0.98, 0.8] },
      shingle: { tex: "rooftile", tint: [1.5, 1.02, 0.82] },
      rooftile: { tint: [1.35, 0.95, 0.78] },
      brick: { tint: [1.2, 0.95, 0.85] },
      metal: { tint: [1.05, 0.98, 0.88] },
      foliage: { tint: [1.05, 1.08, 0.88] },
      paint: { tint: [1.05, 1.0, 0.92] },
    },
  },
  battlefield: {
    label: "Battlefield",
    swatch: ["#4a4a48", "#5c5a55", "#6e6a62"],
    style: "grim",
    grime: 2.4,
    emissive: 0.35,
    map: {
      plaster: { tex: "concrete", tint: [0.62, 0.62, 0.6] },
      concrete: { tint: [0.66, 0.66, 0.64] },
      stone: { tint: [0.6, 0.6, 0.58] },
      wood: { tint: [0.5, 0.46, 0.42] },
      board: { tint: [0.5, 0.46, 0.42] },
      shingle: { tint: [0.45, 0.42, 0.4] },
      rooftile: { tex: "metal", tint: [0.55, 0.55, 0.55] },
      brick: { tint: [0.7, 0.6, 0.55] },
      metal: { tint: [0.6, 0.6, 0.62] },
      foliage: { tint: [0.55, 0.58, 0.5] },
      paint: { tint: [0.6, 0.6, 0.6] },
    },
  },
  coastal: {
    label: "Coastal",
    swatch: ["#e8ecef", "#7f98ad", "#b7a98e"],
    grime: 0.85,
    map: {
      plaster: { tint: [1.4, 1.4, 1.36] },
      concrete: { tint: [1.2, 1.22, 1.22] },
      stone: { tint: [1.15, 1.17, 1.18] },
      wood: { tint: [1.12, 1.08, 1.0] },
      board: { tint: [1.12, 1.08, 1.0] },
      shingle: { tint: [0.7, 0.82, 0.95] },
      rooftile: { tint: [0.75, 0.85, 1.0] },
      brick: { tint: [1.25, 1.2, 1.15] },
      metal: { tint: [1.05, 1.1, 1.15] },
      foliage: { tint: [1.0, 1.08, 0.94] },
      paint: { tint: [1.1, 1.12, 1.15] },
    },
  },
  desert: {
    label: "Desert",
    swatch: ["#d8b98a", "#c1885d", "#a8705a"],
    grime: 1.3,
    emissive: 1.1,
    map: {
      plaster: { tint: [1.32, 1.12, 0.82] },
      concrete: { tint: [1.2, 1.05, 0.85] },
      stone: { tint: [1.22, 1.08, 0.86] },
      wood: { tint: [1.2, 1.05, 0.85] },
      board: { tint: [1.2, 1.05, 0.85] },
      shingle: { tex: "rooftile", tint: [1.4, 1.0, 0.72] },
      rooftile: { tint: [1.35, 1.0, 0.75] },
      brick: { tint: [1.3, 1.05, 0.8] },
      metal: { tint: [1.1, 1.02, 0.9] },
      foliage: { tint: [1.18, 1.05, 0.68] },
      paint: { tint: [1.15, 1.05, 0.9] },
    },
  },
  fortress: {
    label: "Fortress",
    swatch: ["#5c6570", "#767f8c", "#3f464f"],
    grime: 1.6,
    emissive: 0.9,
    map: {
      plaster: { tex: "stone", tint: [0.78, 0.8, 0.85] },
      concrete: { tint: [0.75, 0.78, 0.83] },
      stone: { tint: [0.72, 0.75, 0.82] },
      wood: { tint: [0.72, 0.66, 0.6] },
      board: { tint: [0.72, 0.66, 0.6] },
      shingle: { tint: [0.55, 0.58, 0.66] },
      rooftile: { tint: [0.6, 0.62, 0.7] },
      brick: { tex: "stone", tint: [0.75, 0.78, 0.84] },
      metal: { tint: [0.75, 0.78, 0.85] },
      foliage: { tint: [0.78, 0.86, 0.8] },
      paint: { tint: [0.8, 0.82, 0.88] },
    },
  },
  frost: {
    label: "Frost",
    swatch: ["#e6edf6", "#9fb4cc", "#4d4a48"],
    grime: 0.6,
    emissive: 1.35,
    map: {
      plaster: { tint: [1.3, 1.34, 1.42] },
      concrete: { tint: [1.22, 1.26, 1.34] },
      stone: { tint: [1.18, 1.22, 1.32] },
      wood: { tint: [0.68, 0.64, 0.62] },
      board: { tint: [0.68, 0.64, 0.62] },
      shingle: { tint: [0.9, 0.98, 1.15] },
      rooftile: { tex: "shingle", tint: [0.95, 1.02, 1.2] },
      brick: { tint: [1.05, 1.08, 1.18] },
      metal: { tint: [1.05, 1.12, 1.25] },
      foliage: { tint: [0.82, 0.92, 1.02] },
      paint: { tint: [1.1, 1.15, 1.28] },
    },
  },

  /* ── the world dressings ──
     One per world grammar (plus `weathered`, which outlived its world as an
     ordinary re-dress), and the reason the four look like four different
     engines rather than one engine with four colour filters.

     THE TRICK IS THAT `shingle` AND `rooftile` ARE TWO ROLES. A block author
     picks one or the other for a roof; a theme then colours them separately,
     so a single castle emitter can wear royal-blue spires over a town of
     muted indigo tiles in one world and red cones over terracotta in another,
     with not one vertex different between them. Two roofing materials is also
     simply true of the places these are drawn from. */

  // Ceremonial kingdom: warm limestone walls, deep royal-blue spires, small
  // gold accents, sage foliage. The greens stay muted on purpose — the castle
  // is meant to be the only saturated thing on the plate.
  storybook: {
    label: "Storybook",
    swatch: ["#e8e0cc", "#2b3f95", "#c9a24f"],
    grime: 0.55,
    emissive: 1.15,
    /* THE TINTS LOOK OVERCOOKED ON PAPER AND ARE NOT. Every procedural
       surface map multiplies at around half luminance before the light gets
       to it, so a limestone authored and tinted to the cream you want renders
       as mid-grey, and a spire tinted to royal blue renders as black. These
       are the values that come out the other end as warm stone under deep
       blue — the numbers to judge are in the frame, not in the table. */
    /* Re-judged against the reference frame (docs/shots/cronway.png) rather
       than against the last guess: the spires were rendering NEAR-BLACK
       indigo and the keep olive — a royal castle in mourning. The surface
       map multiplies at roughly half luminance, so the blue that survives it
       has to be authored at roughly twice the target. */
    map: {
      plaster: { tint: [1.85, 1.78, 1.58] },
      concrete: { tint: [1.6, 1.56, 1.44] },
      /* AT THE CLIP CEILING, NOT PAST IT. 1.9 on a cream ashlar puts two
         of three channels over 1.0, the material colour clamps to white, and
         the surface map's half-luminance multiply then renders half of
         white — which is grey. The cream was not being darkened, it was
         being thrown away, and it took Sunhollow's warmer stone with it:
         both keeps came out of the frame as the same neutral. This is the
         brightest tint the authored ashlar survives with its ratio intact. */
      stone: { tint: [1.35, 1.35, 1.34] },
      wood: { tint: [1.05, 0.92, 0.76] },
      board: { tint: [1.05, 0.92, 0.76] },
      // Tuned for the spires, which author their own royal blue (0x6a86e8).
      // The slate cottage now authors one too, so this serves both.
      shingle: { tint: [0.8, 1.05, 1.2] },
      /* A blue multiplier over a maroon roof does not make blue, it makes
         VIOLET: 3.2 on the town's warm-brown tiles rendered h259, and a
         royal capital's roofscape came out lilac. Killing the red instead of
         piling on blue lands the same blocks at h214 — the slate the plate
         actually shows — without a channel going over. */
      rooftile: { tint: [0.37, 1.25, 3.1] },
      brick: { tint: [1.1, 0.96, 0.86] },
      metal: { tint: [1.35, 1.12, 0.62] },
      foliage: { tint: [0.94, 1.02, 0.84] },
      paint: { tint: [1.1, 1.08, 1.02] },
    },
  },

  // The coastal beginning: white plaster, red tiles on some roofs and blue
  // slate on others, warm dirt timber, fresh grass.
  homestead: {
    label: "Homestead",
    swatch: ["#f2eee4", "#b8402b", "#45468c"],
    grime: 0.5,
    emissive: 1.2,
    /* Whiter plaster and a clearer slate blue, judged in frame against
       docs/shots/farshore.png: the reference town is white houses under
       mid-blue roofs, and the old values came out of the render as grey
       under navy. */
    map: {
      plaster: { tint: [1.66, 1.62, 1.52] },
      concrete: { tint: [1.3, 1.28, 1.2] },
      stone: { tint: [1.28, 1.26, 1.18] },
      wood: { tint: [1.18, 0.98, 0.74] },
      board: { tint: [1.18, 0.98, 0.74] },
      // The slate cottage is authored blue now, so this stops compensating
      // for a maroon it no longer has to fight: h276 violet becomes h209.
      shingle: { tint: [1.0, 1.4, 1.3] },
      rooftile: { tint: [1.7, 0.85, 0.68] },
      brick: { tint: [1.15, 0.9, 0.8] },
      metal: { tint: [1.06, 1.06, 1.02] },
      foliage: { tint: [0.95, 1.14, 0.72] },
      paint: { tint: [1.15, 1.12, 1.05] },
    },
  },

  // Sun-bleached island: pastel plaster, one deep red roof, dark timber and a
  // palm green saturated enough to survive against all that sand.
  seaside: {
    label: "Seaside",
    swatch: ["#f0c6d0", "#a8302a", "#3f8a3c"],
    grime: 0.4,
    emissive: 1.1,
    /* The pink house was rendering MAUVE — the one colour in this world with
       a reference photo of itself, wrong. Judged against
       docs/shots/lonepalm.png: soft bright pink walls, clear red roof. */
    map: {
      plaster: { tint: [1.85, 1.32, 1.44] },
      concrete: { tint: [1.5, 1.46, 1.38] },
      stone: { tint: [1.44, 1.4, 1.3] },
      wood: { tint: [1.0, 0.85, 0.66] },
      board: { tint: [1.0, 0.85, 0.66] },
      shingle: { tint: [1.5, 0.85, 0.75] },
      /* MUTED red, which is what the plate has. 1.9 pinned the red channel
         at 1.0 on the one building in the whole world, so the roof rendered
         maximum-chroma orange AND lost the separation between its lit and
         shaded faces — a clipped channel cannot shade. */
      rooftile: { tint: [1.55, 1.12, 1.15] },
      brick: { tint: [1.2, 0.95, 0.9] },
      metal: { tint: [1.1, 1.1, 1.08] },
      foliage: { tint: [0.9, 1.22, 0.58] },
      // The villa's walls are painted board (tex "none" ⇒ the paint role), and
      // 1.2 put the red over the ceiling: the pink stopped shading.
      paint: { tint: [1.1, 1.0, 1.0] },
    },
  },

  // The playful kingdom: cream stone, terracotta tiles, red cones on the
  // towers. Bright, but the value range is kept narrow so it stays a place
  // rather than a toy.
  parade: {
    label: "Parade",
    swatch: ["#f4e6c8", "#c9552f", "#bc3630"],
    grime: 0.3,
    emissive: 1.2,
    /* Judged against docs/shots/sunhollow.png: the keep was rendering as
       brown brick under cones that read oxblood. The reference is a CREAM
       castle under pink-red cones — near-white masonry, and roofs whose lit
       faces go to salmon. */
    map: {
      plaster: { tint: [1.92, 1.86, 1.62] },
      concrete: { tint: [1.72, 1.66, 1.48] },
      // As storybook's, and for the same reason — but warmer, because this
      // kingdom's stone is cream where the other's is ivory, and that
      // difference only exists below the clip.
      stone: { tint: [1.19, 1.15, 1.05] },
      wood: { tint: [1.2, 1.0, 0.78] },
      board: { tint: [1.2, 1.0, 0.78] },
      shingle: { tint: [1.0, 1.3, 1.3] },
      /* 1.75 pinned the red channel on the cones — the one silhouette this
         whole world is composed under — so they rendered at maximum chroma
         and, worse, with no separation between a lit face and a shaded one.
         Under the ceiling they are salmon again, and they shade. */
      rooftile: { tint: [1.4, 1.1, 1.0] },
      brick: { tint: [1.3, 0.95, 0.82] },
      metal: { tint: [1.16, 1.1, 0.95] },
      foliage: { tint: [0.98, 1.2, 0.7] },
      paint: { tint: [1.22, 1.15, 1.02] },
    },
  },

  // Ancient and spacious rather than grim: everything a shade off, timber
  // gone earth-brown, foliage olive. Deliberately NOT as dark as `horror` —
  // this is late-afternoon light on a kingdom nobody has swept, not a night.
  weathered: {
    label: "Weathered",
    swatch: ["#8c8a80", "#6b5a44", "#6b7a3f"],
    grime: 1.8,
    emissive: 0.85,
    map: {
      plaster: { tint: [0.94, 0.92, 0.84] },
      concrete: { tint: [0.88, 0.87, 0.82] },
      stone: { tint: [0.9, 0.9, 0.86] },
      wood: { tint: [0.78, 0.68, 0.55] },
      board: { tint: [0.78, 0.68, 0.55] },
      shingle: { tint: [0.6, 0.58, 0.58] },
      rooftile: { tint: [0.66, 0.6, 0.56] },
      brick: { tint: [0.84, 0.74, 0.66] },
      metal: { tint: [0.74, 0.74, 0.72] },
      foliage: { tint: [0.84, 0.94, 0.6] },
      paint: { tint: [0.84, 0.82, 0.78] },
    },
  },
};
