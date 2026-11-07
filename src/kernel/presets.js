// ONE params object fully defines a world. Every target — editor, VSight,
// Unity — is a different reader of this object.
// (World presets were removed 2026-07-25: structures are themed via
// params.structure — see engine/props/themes.js — not the terrain.)

export const PARAMS_VERSION = 1;

export const DEFAULT_PARAMS = {
  version: PARAMS_VERSION,
  seed: "K7QN-3F2A-9XBD",
  biome: "verdant",
  // Structure theme: procedural dressing of builder blocks (themes.js).
  structure: { theme: "neutral" },
  terrain: {
    size: 4096,          // world edge, metres
    height: 420,         // vertical amplitude, metres
    frequency: 1.7,      // noise cycles across the world
    octaves: 6,
    lacunarity: 2.02,
    gain: 0.5,
    warp: 0.4,           // domain-warp strength
    ridged: 0.55,        // 0 rolling … 1 alpine crests
    plateau: 0.0,        // soft terracing amount
    island: 0.0,         // radial falloff → archipelago
    seaLevel: 0.34,      // 0..1 of the height range
    /* Two simulations, and they answer different questions. The droplets move
       what water CARRIES — valleys, channels, the silt on the shelf. `thermal`
       caps the SLOPE: ground standing steeper than `talus` (rise/run, so 0.8
       is about 39°) is unsupported and slides downhill, which is what puts an
       apron of scree under a crest instead of a knife edge.

       Material moves ONE CELL per iteration, so this knocks the edges off
       crests rather than re-grading a range: a cone 32 cells across needs
       about a thousand passes to reach its cap. Measured on the canonical
       513² grid, a default world starts at grade 2.53 and 16 passes cost
       283 ms to bring it to 2.08, so tens of passes is the useful band and
       hundreds is a different (and much slower) intent. `rate` is clamped —
       see MAX_THERMAL_RATE in terrain/erosion.js, where past about 0.65 the
       relaxation ripples the ground steeper before it settles.

       `iterations: 0` is off, and off is the default deliberately. Every world
       file saved before this existed carries an `erosion` block with no
       `thermal` key in it, so those worlds reload as exactly the ground they
       were saved as; turning it on here would have silently re-cut the two
       worlds on the shelf, and the placements standing on them were composed
       against the old surface. Raise it per world, or in a grammar. */
    erosion: { enabled: true, drops: 35000, inertia: 0.06, capacity: 3.2, deposit: 0.25, erode: 0.28, evaporate: 0.012,
               thermal: { iterations: 0, talus: 0.8, rate: 0.5 } },
    /* The SHAPE, as an ordered list of blended noise layers
       (terrain/noise-stack.js). `null` means the built-in recipe — warped fbm
       against a ridged crest on a continent mask, driven by the ten sliders
       above — and that is what every world saved before stacks existed says by
       saying nothing, so it is the default and it stays bit-identical.

       A stack REPLACES the recipe rather than adding to it; a stack that wants
       the recipe underneath opens with a `legacy` layer. What it never
       replaces is the plate: sea level, the edge falloff into open water, the
       sea floor and the vertical scale run after any shape, so a stack can
       make a world unrecognisable but not unwalkable. */
    stack: null,
    // Hand-sculpted brush strokes, replayed over the noise (terrain/sculpt.js).
    sculpt: [],
    /* INTENT: statements about the ground — a height here, a summit there, the
       interior's mean level — made true by the least improbable change to the
       seed's own lattice (terrain/condition.js). Applied to the shape, before
       the plate and before the sculpt strokes above. Empty is the default and
       an empty list never reaches the solver, so every world without intent is
       bit-identical to the world it was before intent existed. */
    intent: [],
  },
  // `weather` is ambient FX + surface response ("clear" | "rain" | "snow"):
  // rain wets every material and snow settles on upward faces (see
  // engine/render/atmosphere.js). It travels in params so VSight plays the
  // storm the editor authored.
  /* `clock` is the hour RUNNING rather than the hour set. It travels in params
     like everything else, so a world saved at dusk with its clock going opens
     at dusk with its clock going. `rate` is world-minutes per real second — at
     6 a full day takes four minutes, which is long enough that dusk arrives
     and short enough that nobody waits for it. The editor owns what
     follows from the hour; Sky.js still owns the sun. */
  sky: { timeOfDay: 10.5, cloudCover: 0.38, cloudScale: 1.0, volumetric: true, turbidity: 2.2, weather: "clear",
         clock: { running: false, rate: 6 } },
  // `level` is the waterline in metres above the natural coastline (y=0).
  // It floods the terrain as it stands; terrain.seaLevel, by contrast, is a
  // generation input that rebuilds the world into a different shape.
  water: { enabled: true, preset: "ocean", waveHeight: 0.5, waveSpeed: 1.0, level: 0 },
  // Grass is authored, never auto-scattered: patches is the dev's placement
  // list ({x, z, r, n} each), painted in the editor with the Grass tool.
  // The rest mirrors Unity's terrain vegetation standard (resolved with
  // defaults in engine/props/detail-spec.js, shared by renderer + exporter):
  //   detailDistance / detailDensityScale — Terrain Settings → Tree & Detail
  //   Objects; wind {speed, size, bending, tint} — Wind Settings for Grass
  //   (inspector labels; the exporter maps them onto Unity's crossed
  //   wavingGrass* API names); prototypes null — the standard detail set.
  //
  // `wind.direction`/`wind.lean` and `placement` are the two things Unity's
  // terrain has no field for and this ground needs: a compass for the gusts
  // (0 = +X, and 0 reproduces Unity's fixed diagonal exactly), and the rules
  // that decide where a tuft may stand at all. Sparse is fine — everything
  // omitted is filled by engine/props/detail-spec.js, which is the one place
  // the renderer and any exporter both read.
  props: {
    grass: {
      windStrength: 1.0,
      patches: [],
      detailDistance: 250,
      detailDensityScale: 1.0,
      wind: { speed: 0.5, size: 0.5, bending: 0.5, tint: 0xb29980, direction: 0, lean: 0.45 },
      // Altitude band and slope cutoff, measured from the world's waterline.
      // null bounds mean "no limit"; the per-species bands in detail-spec.js
      // narrow this rather than widen it.
      placement: {
        waterClearance: 0.15, minAltitude: null, maxAltitude: null,
        maxSlope: 1.2, slopeFade: 0.62,
      },
      prototypes: null,
    },
    /* Scattered vegetation: {id, x, z, rotationY, scale} each, rendered
       instanced (engine/props/Scatter.js) so the cost is per SPECIES rather
       than per plant. This is where a world's forests live — a placed prop
       is for what you select and drag, and there is no selecting the ten
       thousandth tree. */
    scatter: [],
  },
  /* Spatial climate: null means the world is one biome everywhere, which is
     every world there has ever been. Set `{ biomes: ["verdant", "tundra"],
     scale: 1 }` and the GROUND COLOUR follows two slow temperature/moisture
     fields instead — each point belongs to whichever listed biome's anchor
     (palettes.js `climate`) its local climate lands nearest, blended at the
     borders (terrain/climate.js). The primary `biome` above keeps everything
     else it owns: water, sky, fog, grass tint, the splat materials, the
     minimap's sea. Colour is the one channel already evaluated per vertex,
     which is what makes this affordable; spatial MATERIALS would be a
     different shader and a different change. */
  climate: null,
  fog: { density: 0.35 },
  // World FX that persist: ground fires ({x, z, r} each — y re-seats on the
  // live terrain like props do). Placed via Engine.addFireAt / igniteProp.
  fx: { fires: [] },
};

// Deep-merge a patch into a params object, returning a fresh object.
export function mergeParams(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = typeof base?.[k] === "object" && base[k] !== null && !Array.isArray(base[k])
      ? mergeParams(base[k], patch[k])
      : patch[k];
  }
  return out;
}

export function makeParams({ seed, biome, theme } = {}) {
  // Full deep clone: nothing may share structure with DEFAULT_PARAMS, or
  // painting grass / sliding a knob in one world would leak into the next.
  const params = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
  if (seed) params.seed = seed;
  if (biome) params.biome = biome;
  if (theme) params.structure.theme = theme;
  return params;
}
