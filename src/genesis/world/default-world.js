/* default-world.js — the world the editor opens on.
 *
 * THE LANDING IS A FILE, not a dice roll. Every session used to begin on a
 * freshly minted seed: screening kept the worst of them off the screen, but
 * "workable land fraction and some relief" is a floor, not a composition, and
 * no two visitors ever saw the same first frame. A default nobody chose is a
 * default nobody can point at — it cannot be photographed for the site, it
 * cannot be described in a sentence that stays true, and a bug reported
 * against it ("the water reads grey at dusk") arrives without the world it
 * happened in.
 *
 * So the first world is authored and it is checked in, as the one thing this
 * tool already knows how to write down: a `.world.json`, exactly the document
 * `js/worldfile.js` saves and opens. Nothing here is a private format and
 * nothing here is a special case — the editor boots this file the same way it
 * boots one a person drags in, which is the whole reason the file format was
 * worth having.
 *
 * It is a SHORELAND at 17:15: a large landmass with a coast on it, deep relief
 * (800 m of amplitude, ridged and lightly terraced), the sea sitting low at
 * 0.14 so the country reads as country rather than as an archipelago, and thin
 * fog under a late-afternoon sun where the shadows are long enough to prove
 * the terrain is geometry. It carries no placements: the landing is ground the
 * visitor is invited to build on, not a town they arrived after.
 *
 * TO CHANGE IT: open the editor, make the world, press Save, and paste the
 * downloaded file in below. That is the entire authoring loop, and it is why
 * this is stored as the saved document rather than as a params patch — a
 * params patch is a thing somebody has to hand-write and hand-verify, and this
 * is a thing the tool emits. `tests/default-world.test.js` holds the pasted
 * document to the same validation an opened file gets, so a bad paste fails
 * the suite instead of the page.
 *
 * The derived fields (`palette`, `settlements`, `spawn`, `field`) travel with
 * the file because a saved world carries them; the editor re-derives all four
 * from the params on boot, which is the README's claim that params ARE the
 * world, kept honest. Nothing in here is read back as state.
 */

/** The editor's first world, as a saved `.world.json` document. */
export const DEFAULT_WORLD = {
  kind: "worldgence.world",
  fileVersion: 1,
  // No world grammar produced this one — its ground was authored rather than
  // composed — so there is no id to name and the save dialog falls back to
  // the biome.
  origin: null,
  omitted: [],
  procs: [],
  world: {
    version: 4,
    kind: "vsight-world",
    seed: "H22U-WCBP-M4BS",
    seedHash: 2493560658,
    bakedAt: 0,
    params: {
      version: 1,
      seed: "H22U-WCBP-M4BS",
      biome: "shoreland",
      structure: { theme: "neutral" },
      terrain: {
        size: 4096,
        height: 800,
        frequency: 3.5,
        octaves: 6,
        lacunarity: 2.02,
        gain: 0.5,
        warp: 0.4,
        ridged: 0.62,
        plateau: 0.23,
        island: 0.3,
        seaLevel: 0.14,
        erosion: { enabled: true, drops: 80000, inertia: 0.06, capacity: 3.2, deposit: 0.25, erode: 0.28, evaporate: 0.012 },
        sculpt: [],
      },
      sky: {
        timeOfDay: 17.15, cloudCover: 0.38, cloudScale: 1, volumetric: true,
        turbidity: 2.2, weather: "clear", clock: { running: false, rate: 6 },
      },
      water: { enabled: true, preset: "ocean", waveHeight: 0.5, waveSpeed: 1, level: 0 },
      props: {
        grass: {
          windStrength: 1,
          patches: [],
          detailDistance: 250,
          detailDensityScale: 1,
          wind: { speed: 0.5, size: 0.5, bending: 1, tint: 11704704 },
          prototypes: null,
        },
        scatter: [],
      },
      fog: { density: 0.1 },
      fx: { fires: [] },
    },
    palette: {
      biome: "shoreland",
      stops: [
        [0, 866634], [0.19, 1728896], [0.288, 13812121], [0.313, 14996648],
        [0.328, 6989388], [0.372, 5543481], [0.42, 4423473], [0.48, 3500076],
        [0.58, 6057796], [1, 11579548],
      ],
      water: { shallow: 5554392, deep: 870242 },
      sky: { horizon: 13822192, zenith: 4161488 },
      fog: 12901864,
      grass: 5940038,
      rock: 9076584,
      sand: 14865062,
    },
    props: [],
    settlements: [
      { x: 1592.9, z: 1267.8, score: 0.25, r: 81.9 },
      { x: 617.7, z: -617.7, score: 0.235, r: 81.9 },
      { x: -97.5, z: 1267.8, score: 0.21, r: 81.9 },
      { x: 97.5, z: -1267.8, score: 0.198, r: 81.9 },
      { x: -1527.9, z: 1657.9, score: 0.195, r: 81.9 },
    ],
    spawn: { x: 1592.9, z: 1267.8, yaw: 1.65511808370596, rings: [{ r: 24.6 }, { r: 45.1 }] },
    tactics: null,
    field: { res: 513, size: 4096 },
  },
};
