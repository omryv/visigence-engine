// The terrain-detail standard, as data. One module owns the default prototype
// set, the Wind Settings for Grass, and the healthy/dry colour resolution.
//
// It was written because there were TWO readers — the browser renderer
// (engine/props/grass.js) and a Unity exporter — and splitting them was how
// the old grass shipped hardcoded exporter numbers the renderer never drew.
// The exporter is deleted; this file is not, because the reason it is a file
// survives the second reader: the values are defined in exactly one place, and
// being pure data + hex math with no three.js is what lets the suite reach
// them at all.
//
// Naming follows the Unity Terrain inspector, not the (scrambled) API:
//   wind.speed   → the "Speed" slider   → TerrainData.wavingGrassStrength
//   wind.size    → the "Size" slider    → TerrainData.wavingGrassSpeed
//   wind.bending → the "Bending" slider → TerrainData.wavingGrassAmount
//   wind.tint    → the "Grass Tint" field → TerrainData.wavingGrassTint
// The exporter does that crossing once, at the manifest boundary.
//
// ── WHAT UNITY DOES NOT HAVE, AND THIS GROUND NEEDS ──
// Unity paints detail density onto a map, cell by cell, and a human decides
// where grass stops. There is no map here — patches are circles a dev brushed
// — so the rules that would have been painted have to be STATED instead, and
// they live in this file with everything else the two readers share:
//
//   wind.direction  the compass the gusts blow along. Unity's waving grass
//                   has no direction at all: its four waves run on fixed
//                   world-XZ frequencies, so every field on every world
//                   ripples along the same diagonal forever.
//   placement       the altitude band, the clearance above the waterline and
//                   the slope cutoff a tuft has to satisfy to be planted.
//                   The renderer used to hold two literals for this — y<0.15
//                   and slope>1.2 — which meant grass grew to the water's
//                   edge on a world whose sea had been raised 40 m, and
//                   stopped dead at a hard line on a hillside.
//   per-species     the same three rules again, per prototype, plus a
//                   moisture preference. That is what makes reeds a species
//                   rather than a differently-shaped grass: it stands where
//                   grass cannot and grass stands where it cannot.

// Unity DetailPrototype defaults (TerrainData bindings): healthy #43F92A,
// dry #CDBC1A, min/max width 1/2, min/max height 1/2, noiseSpread 0.1,
// density 1, renderMode Grass(Billboard). Our sizes are metres in a 1:1
// world, so the width/height ranges are grass-sized rather than Unity's
// bare defaults; everything else keeps the Unity meaning and range.
export const DETAIL_RENDER_MODES = ["grassBillboard", "grass", "vertexLit"];

// Unity dry-grass yellow — the fixed pole every biome's dry colour leans to.
const UNITY_DRY = 0xcdbc1a;
// A vivid healthy green in the direction of Unity's #43F92A, tamed so the
// biome palette still owns the overall hue.
const HEALTHY_LEAN = 0x7ddc4f;

/* Wind Settings for Grass — Unity slider defaults (0.5 across the board) and
   Unity's default grass tint (0.7, 0.6, 0.5) — plus the one Unity has no
   field for.

   `direction` is the compass bearing the wind blows TOWARD, in degrees, with
   0 = +X and 90 = +Z (the engine's own handedness, the same one the sun and
   the minimap use). It is the axis the four waves run along and the axis the
   blades lean down, and 0 reproduces Unity's fixed diagonal EXACTLY — the
   wave frequencies were authored against world XZ, so a wind-aligned frame
   whose first axis is +X is the identity. That is deliberate: turning the
   wind on is a change an author makes, not one a commit makes for them.

   `lean` is how far the field bows downwind on top of the ripple, as a
   fraction of the bending slider. Unity's waving grass is symmetric — the
   sin⁴ waves push and pull about the blade's own axis — so a Unity field in a
   gale is agitated but never actually blown over. */
export const WIND_DEFAULTS = { speed: 0.5, size: 0.5, bending: 0.5, tint: 0xb29980, direction: 0, lean: 0.45 };

/* ── where a tuft may stand ──
   The two figures the renderer used to hold as literals, plus the two the
   waterline made necessary.

   waterClearance is measured from the WORLD'S waterline rather than from
   y = 0. Those were the same number on a world whose sea sits where the
   heightfield put it, and different by the whole flood depth on every world
   that has ever raised one — which is why grass grew out of the sea on a
   flooded plate and why this is a clearance rather than an altitude.

   maxSlope is a grade (rise over run), so 1.0 is 45°. slopeFade is where
   thinning STARTS: between the two, a tuft is kept with a probability that
   falls to zero, so a hillside loses its grass the way a hillside does
   instead of along a contour line drawn with a ruler. */
export const PLACEMENT_DEFAULTS = {
  waterClearance: 0.15,   // metres of dry ground needed above the waterline
  minAltitude: null,      // world metres; null = no floor beyond the clearance
  maxAltitude: null,      // world metres; null = grass anywhere it can hold on
  altitudeFade: 12,       // metres of soft band inside each altitude limit
  maxSlope: 1.2,          // grade at which nothing is planted at all
  slopeFade: 0.62,        // grade at which thinning begins
  sizeJitter: 0.35,       // share of the size range decided per tuft, not per clump
  tiltJitter: 0.16,       // radians of random lean off vertical
  bendJitter: 0.28,       // ± share of the bending slider, per tuft
  /* 0..1 of a full wind cycle, offset per tuft. SMALL on purpose: the four
     waves are a travelling gust, and a full random phase per blade is not a
     livelier field, it is no field at all — the wave dissolves into
     per-blade noise. This is enough that neighbours stop cresting on the
     same frame and no more. */
  phaseJitter: 0.15,
  groundTint: 0.26,       // how far a blade's colour is pulled to the ground under it
  /* Metres above the waterline over which "damp" runs out. 45 rather than a
     tighter figure because it has to be a fraction of the RELIEF a world
     actually has, not of the shoreline: these terrains reach about a third of
     their stated amplitude, so the default 420 m world has roughly 140 m of
     dry land in it and a 20 m gradient would leave the preference inert
     everywhere above the beach — including for heather, whose whole character
     is that it wants the dry end of exactly this range. */
  moistureRange: 45,
};

// Terrain Settings → Tree & Detail Objects. Unity defaults detailDistance to
// 80 (slider 0–1000); this world is authored from a diorama camera, so the
// default sits higher — still inside Unity's range, exported verbatim.
export const DETAIL_DISTANCE_DEFAULT = 250;
export const DETAIL_DENSITY_SCALE_DEFAULT = 1.0;

/* The standard prototype set. `share` is the pick weight when the brush
   scatters a tuft — a meadow is mostly grass, some wilder tufts, a few
   flowers and weeds. `atlasCell` indexes the procedural detail atlas
   (engine/props/grass-textures.js). healthyColor/dryColor null = derive from
   the biome palette (resolveDetail), so tundra grass and oasis grass keep
   their character without per-biome tables.

   ── EIGHT SPECIES, AND WHY THE COUNT IS NOT THE POINT ──
   Four more prototypes would be four more sprites and nothing else if they
   all grew in the same places. What makes these species rather than shapes is
   the four fields after `density`:

     minAltitude/maxAltitude  the band, in metres above the WATERLINE, this
                              plant lives in. Reeds die a few metres up;
                              heather will not grow at the shore.
     maxSlope                 its own grade limit. Tufts hold a bank that
                              clover slides off.
     moisture                 +1 wants the water's edge, −1 wants it dry, 0
                              does not care. Weighted against the same
                              height-above-water the band uses, so a patch
                              painted across a shoreline sorts itself into
                              reeds at the bottom and heather at the top
                              without anybody painting a second map.

   Anything left null falls back to the world-level PLACEMENT_DEFAULTS, so the
   original four keep behaving exactly as they always did. */
export const DETAIL_PROTOTYPES = [
  { key: "grass", label: "Grass", renderMode: "grassBillboard", atlasCell: 0, share: 0.42,
    minWidth: 0.9, maxWidth: 1.7, minHeight: 0.55, maxHeight: 1.05,
    noiseSeed: 71, noiseSpread: 0.1, density: 1, holeEdgePadding: 0,
    minAltitude: null, maxAltitude: null, maxSlope: null, moisture: 0,
    healthyColor: null, dryColor: null },
  { key: "tuft", label: "Wild tuft", renderMode: "grass", atlasCell: 1, share: 0.18,
    minWidth: 0.8, maxWidth: 1.45, minHeight: 0.45, maxHeight: 0.95,
    noiseSeed: 137, noiseSpread: 0.15, density: 1, holeEdgePadding: 0,
    // The one that holds a bank: a steeper cutoff than anything else here.
    minAltitude: null, maxAltitude: null, maxSlope: 1.45, moisture: -0.15,
    healthyColor: null, dryColor: null },
  { key: "flowers", label: "Flowers", renderMode: "grass", atlasCell: 2, share: 0.07,
    minWidth: 0.65, maxWidth: 1.05, minHeight: 0.45, maxHeight: 0.8,
    noiseSeed: 211, noiseSpread: 0.22, density: 1, holeEdgePadding: 0,
    minAltitude: null, maxAltitude: null, maxSlope: 0.85, moisture: 0.1,
    healthyColor: 0xe9e2c9, dryColor: 0xc9b878 },
  { key: "weed", label: "Broadleaf", renderMode: "grass", atlasCell: 3, share: 0.06,
    minWidth: 0.6, maxWidth: 1.0, minHeight: 0.35, maxHeight: 0.65,
    noiseSeed: 349, noiseSpread: 0.18, density: 1, holeEdgePadding: 0,
    minAltitude: null, maxAltitude: null, maxSlope: null, moisture: 0.2,
    healthyColor: null, dryColor: null },

  // Damp shade under a bank: broad fronds, low, and gone before the ridge.
  { key: "fern", label: "Fern", renderMode: "grass", atlasCell: 4, share: 0.09,
    minWidth: 0.9, maxWidth: 1.6, minHeight: 0.5, maxHeight: 0.95,
    noiseSeed: 419, noiseSpread: 0.13, density: 1, holeEdgePadding: 0,
    minAltitude: 0.6, maxAltitude: 46, maxSlope: 1.05, moisture: 0.55,
    healthyColor: null, dryColor: null },
  // The water's edge, and only the water's edge. Tall, thin, barely bends.
  { key: "reed", label: "Reeds", renderMode: "grass", atlasCell: 5, share: 0.07,
    minWidth: 0.7, maxWidth: 1.15, minHeight: 1.0, maxHeight: 1.9,
    noiseSeed: 523, noiseSpread: 0.09, density: 1, holeEdgePadding: 0,
    minAltitude: 0, maxAltitude: 4.5, maxSlope: 0.5, moisture: 1,
    healthyColor: null, dryColor: null },
  // Ground cover: the mat that fills between everything else, on flat ground.
  { key: "clover", label: "Clover", renderMode: "grass", atlasCell: 6, share: 0.07,
    minWidth: 0.7, maxWidth: 1.2, minHeight: 0.18, maxHeight: 0.36,
    noiseSeed: 631, noiseSpread: 0.26, density: 1, holeEdgePadding: 0,
    minAltitude: null, maxAltitude: null, maxSlope: 0.7, moisture: 0.25,
    healthyColor: null, dryColor: null },
  // High and dry, woody, and stubborn about slope — what is left up where
  // grass has given up.
  { key: "heather", label: "Heather", renderMode: "grass", atlasCell: 7, share: 0.04,
    minWidth: 0.6, maxWidth: 1.05, minHeight: 0.28, maxHeight: 0.55,
    noiseSeed: 743, noiseSpread: 0.2, density: 1, holeEdgePadding: 0,
    minAltitude: 26, maxAltitude: null, maxSlope: 1.35, moisture: -0.8,
    healthyColor: 0xa07fa8, dryColor: 0x8d7a5e },
];

export function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// Per-instance tint poles for a biome: healthy grass leans bright green,
// dry grass leans Unity's straw yellow, both anchored on palette.grass.
export function healthyColorFor(paletteGrass) { return mixHex(paletteGrass, HEALTHY_LEAN, 0.4); }
export function dryColorFor(paletteGrass) { return mixHex(paletteGrass, UNITY_DRY, 0.55); }

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* Hermite ramp, the same shape GLSL's smoothstep has, so the JS that decides
   WHERE a tuft goes and the shader that decides how it looks agree on what a
   soft edge is. */
export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/* The wind as a unit vector on the ground plane. Degrees in, XZ out, with
   0 = +X — one place converts, so the renderer, the exporter and any future
   reader cannot disagree about which way the field is bowing. */
export function windVector(directionDeg) {
  const a = ((directionDeg || 0) * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

/* ── how well one spot suits one species, 0..1 ──
   `y` is the ground height in world metres and `waterY` is the world's
   waterline, so `y - waterY` is the height above water that both the altitude
   band and the moisture preference are stated in. `grade` is rise over run.

   Returns 0 for "not here", and a fraction otherwise, so the caller can use it
   as a probability rather than as a yes/no — which is what keeps a species'
   edge a thinning rather than a line. Pure, and the whole reason the placement
   rules are testable at all. */
export function placementFit(proto, place, { y, waterY = 0, grade = 0 }) {
  const above = y - waterY;
  if (above < place.waterClearance) return 0;

  const fade = Math.max(place.altitudeFade, 1e-3);
  let fit = 1;

  const lo = proto?.minAltitude ?? place.minAltitude;
  if (lo != null) fit *= smoothstep(lo - fade, lo, above);
  const hi = proto?.maxAltitude ?? place.maxAltitude;
  if (hi != null) fit *= 1 - smoothstep(hi, hi + fade, above);
  if (fit <= 0) return 0;

  // Slope: full density up to slopeFade, then thinning to nothing at maxSlope.
  const maxSlope = proto?.maxSlope ?? place.maxSlope;
  const fadeFrom = Math.min(place.slopeFade, maxSlope * 0.92);
  fit *= 1 - smoothstep(fadeFrom, maxSlope, grade);
  if (fit <= 0) return 0;

  /* Moisture. One proxy — how far above the waterline the ground is — because
     it is the only one available on the JS side without dragging the flow
     bake into the grass, and because it is the one that actually separates
     these species: reeds at the line, heather well above it. */
  const m = Math.max(-1, Math.min(1, proto?.moisture || 0));
  if (m !== 0) {
    // 1 at the waterline, 0 once the ground is moistureRange metres above it.
    const damp = 1 - smoothstep(0, Math.max(place.moistureRange, 1e-3), above);
    // mix(1, damp, m) for a wet-lover; mix(1, 1 − damp, −m) for a dry one.
    fit *= m > 0 ? 1 - m + m * damp : 1 + m * damp;
  }
  return clamp01(fit);
}

/* Resolve params.props.grass into the full detail settings both renderers
   agree on. Sparse params stay sparse (the world contract stays small);
   every reader goes through here for the filled-in truth. */
export function resolveDetail(params, palette) {
  const g = params?.props?.grass || {};
  const grassHex = palette?.grass ?? 0x4d8a3f;
  const wind = { ...WIND_DEFAULTS, ...(g.wind || {}) };
  wind.speed = clamp01(wind.speed); wind.size = clamp01(wind.size); wind.bending = clamp01(wind.bending);
  wind.lean = clamp01(wind.lean);
  // Any bearing is legal; it is a compass, so it wraps rather than clamps.
  wind.direction = Number.isFinite(wind.direction) ? ((wind.direction % 360) + 360) % 360 : 0;
  const placement = { ...PLACEMENT_DEFAULTS, ...(g.placement || {}) };
  placement.sizeJitter = clamp01(placement.sizeJitter);
  placement.phaseJitter = clamp01(placement.phaseJitter);
  placement.bendJitter = clamp01(placement.bendJitter);
  placement.groundTint = clamp01(placement.groundTint);
  placement.maxSlope = Math.max(placement.maxSlope, 1e-3);
  const source = Array.isArray(g.prototypes) && g.prototypes.length ? g.prototypes : DETAIL_PROTOTYPES;
  const prototypes = source.map((p) => {
    const base = DETAIL_PROTOTYPES.find((d) => d.key === p.key) || DETAIL_PROTOTYPES[0];
    const filled = { ...base, ...p };
    if (filled.healthyColor == null) filled.healthyColor = healthyColorFor(grassHex);
    if (filled.dryColor == null) filled.dryColor = dryColorFor(grassHex);
    if (!DETAIL_RENDER_MODES.includes(filled.renderMode)) filled.renderMode = "grass";
    return filled;
  });
  return {
    patches: g.patches || [],
    windStrength: g.windStrength ?? 1,
    detailDistance: g.detailDistance ?? DETAIL_DISTANCE_DEFAULT,
    detailDensityScale: clamp01(g.detailDensityScale ?? DETAIL_DENSITY_SCALE_DEFAULT),
    wind,
    placement,
    prototypes,
  };
}
