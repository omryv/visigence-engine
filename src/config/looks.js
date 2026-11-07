/**
 * THE STUDIO'S LOOKS: one authored lighting, sky, atmosphere and grade per time of day.
 *
 * Before this existed, game/ShooterSession.js lit every world with the same three
 * numbers - a hemisphere, a directional light and a canvas gradient for a sky - switched
 * on `night` with a couple of ternaries, and the post stack ran one grade whatever the
 * lighting. What separates a game that looks assembled from
 * one that looks directed is that these numbers are chosen TOGETHER, per world: the sun's
 * colour decides the sky's horizon, which decides the fog, which decides where the grade
 * puts its split tone. So they are declared together, here, and read by exactly three
 * consumers: render/Sky.js (sky + atmosphere), the session (lights + exposure) and
 * render/PostFX.js (the grade, through setLook).
 *
 * Every colour is an sRGB hex like the rest of the engine; every intensity is in three's
 * units, so a value here means what it means on a DirectionalLight or a HemisphereLight.
 * Nothing in a look changes gameplay.
 *
 * A look has four blocks:
 *
 *   sky        what render/Sky.js draws behind the world and bakes into the probe.
 *              `elevation` and `azimuth` are the sun's (or the moon's) angles in degrees.
 *              `disc` is the disc's radiance (HDR; the bloom picks it up), `glow` the Mie
 *              halo around it, `zenith`/`horizon`/`ground` the three colours the dome is
 *              built from, `pollution` the city's own glow at the horizon at night,
 *              `stars` and `clouds` in 0..1.
 *   lighting   the two lights every surface sees, the probe's weight, and the exposure.
 *   fog        exponential HEIGHT fog: `density` per metre at ground level, `falloff`
 *              per metre of height (density halves every ln2/falloff metres), `inscatter`
 *              how much the fog picks up the sun's colour when looking toward it. `color`
 *              defaults to the sky's horizon so the far field and the dome agree.
 *   post       the grade, as render/PostFX.js reads it.
 */

export const LOOKS = {
  arcade: {
    // Always bright: `dawn` is the studio's "Sunny day", `night` its "Golden hour". Colours
    // come from the Blender look-dev kit (tools/blender/v2/arcade/kit.py): pastel sky, warm
    // sun, light blue haze, and a soft grade that keeps the palette clean.
    night: {
      sky: {
        elevation: 12, azimuth: 250, sunColor: 0xffc38a, disc: 18, glow: 0.45, discSize: 0.011,
        zenith: 0x6f86d6, horizon: 0xffc7a8, ground: 0x6a8a58, pollution: 0, stars: 0, clouds: 0.6,
      },
      lighting: { sun: 2.4, sunColor: 0xffcf9e, hemiSky: 0xb7b3e6, hemiGround: 0x5e6e4a, hemi: 0.9, env: 0.8, exposure: 1.08, lamps: 0, lampColor: 0xffd873, wet: 0 },
      fog: { density: 0.008, falloff: 0.07, inscatter: 0.6 },
      post: { saturation: 1.06, contrast: 1.04, split: 0.58, shadowTint: [0.95, 0.94, 1.08], highlightTint: [1.06, 1.0, 0.90], vignette: 0.24, grain: 0.12, bloomScale: 0.7 },
      // Toon dials (render/ArcadeToon.js): a warm sunlit tone, a deeper lilac shade, an amber rim.
      toon: { terminator: [0.02, 0.18], sunTint: 0xffe4c8, shadeTint: 0xdccff2, rimColor: 0xffd9a8, outline: 0x4e3129, gain: 0.96, pointGain: 0.35,
        // One wind for the canopy, the tufts and the reeds (metres of sway at the tip, a slow gust across the meadow).
        wind: { dir: [0.8, 0.6], strength: 0.07, speed: 1.4, gust: 0.5 } },
    },
    dawn: {
      sky: {
        elevation: 48, azimuth: 330, sunColor: 0xfff0da, disc: 20, glow: 0.35, discSize: 0.010,
        zenith: 0x5a9fea, horizon: 0xcfe4f7, ground: 0x7fb069, pollution: 0, stars: 0, clouds: 0.7,
      },
      lighting: { sun: 3.0, sunColor: 0xfff0da, hemiSky: 0xbcd8f2, hemiGround: 0x6f9a55, hemi: 1.1, env: 0.9, exposure: 1.05, lamps: 0, lampColor: 0xffd873, wet: 0 },
      fog: { density: 0.006, falloff: 0.06, inscatter: 0.35 },
      post: { saturation: 1.08, contrast: 1.02, split: 0.5, shadowTint: [0.96, 0.95, 1.06], highlightTint: [1.03, 1.0, 0.95], vignette: 0.18, grain: 0.1, bloomScale: 0.6 },
      // Toon dials (render/ArcadeToon.js): the kit's own values - white sun, per-material lilac shade, warm rim.
      toon: { terminator: [0.02, 0.18], sunTint: 0xffffff, shadeTint: 0xffffff, rimColor: 0xfff3df, outline: 0x4e3129, gain: 1, pointGain: 0.35,
        wind: { dir: [0.8, 0.6], strength: 0.06, speed: 1.6, gust: 0.45 } },
    },
  },
};

/**
 * A biome's changes to its theme's looks (the world option's `biome`, world/catalog.js), by theme, biome and lighting. The desert
 * oasis keeps the toon shading, the outlines and the terminator; its sky warms to a sandy horizon, the ground bounces
 * sand-coloured light, the haze thins and warms, and the shade side keeps a little less lilac so plaster reads warm.
 */
export const BIOME_LOOKS = {
  arcade: {
    desert: {
      dawn: {
        sky: { elevation: 52, zenith: 0x4f9be8, horizon: 0xf3dcc0, ground: 0xd9b27c, sunColor: 0xfff0d6, clouds: 0.45 },
        lighting: { sunColor: 0xfff0d6, hemiSky: 0xcfe0f0, hemiGround: 0xd8b07a },
        fog: { density: 0.0045, inscatter: 0.28 },
        toon: { sunTint: 0xfffaf2, shadeTint: 0xf4ecff, wind: { dir: [0.8, 0.6], strength: 0.05, speed: 1.3, gust: 0.35 } },
      },
      night: {
        sky: { horizon: 0xffc49a, ground: 0xc79a64, clouds: 0.4 },
        lighting: { hemiGround: 0xa07850 },
        fog: { density: 0.006 },
      },
    },
    // The snow village: a crisp, deep-blue sky over a pale horizon, a near-white sun, the snow bouncing cool light
    // up into the shade, a thin blue-white haze, and a bluer shade side so the snow reads cold and the timber warm.
    snow: {
      dawn: {
        sky: { elevation: 38, zenith: 0x3f86e0, horizon: 0xe2edf9, ground: 0xdfe8f4, sunColor: 0xfff4e6, clouds: 0.35 },
        // Snow is the brightest thing on screen: a little less sun and exposure keep it from clipping to flat white.
        lighting: { sun: 2.7, sunColor: 0xfff4e6, hemiSky: 0xd6e6fa, hemiGround: 0xdce6f4, exposure: 0.97 },
        fog: { density: 0.005, inscatter: 0.3 },
        post: { highlightTint: [1.0, 1.0, 1.0] },
        toon: { sunTint: 0xffffff, shadeTint: 0xe6ecff, wind: { dir: [0.8, 0.6], strength: 0.04, speed: 1.2, gust: 0.3 } },
      },
      night: {
        sky: { horizon: 0xc9d8f2, ground: 0xb8c8e0, clouds: 0.3 },
        lighting: { hemiGround: 0x8a9ab8, exposure: 1.0 },
        fog: { density: 0.006 },
        toon: { shadeTint: 0xd4d6fa },
      },
    },
  },
};

const mergeLook = (a, b) => {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? mergeLook(a[k], v) : v;
  return out;
};

/**
 * The look for a resolved project, never null: an unknown pair falls back to Arcade's golden hour. `biome` is the
 * built level's (its world option's), which may change the look (BIOME_LOOKS).
 */
export function lookFor(project, biome = null) {
  const theme = LOOKS[project.theme] ?? LOOKS.arcade, lighting = theme[project.lighting] ? project.lighting : 'night';
  return mergeLook(theme[lighting], BIOME_LOOKS[project.theme]?.[biome]?.[lighting]);
}

/**
 * The post/quality profile the studio hands render/PostFX.js, from the project's three
 * graphics words. Built on config/quality.js `standard` so the AO, DOF and film constants
 * the desktop art is authored against are the ones used, then narrowed:
 *
 *   performance  no post at all: the path a phone or an integrated GPU takes.
 *   balanced     the temporal resolve, bloom, the grade and the sharpen/grain output, and
 *                a lighter occlusion pass (8 samples at half resolution).
 *   quality      everything `full` runs that the studio can use: 12-sample occlusion,
 *                depth of field on the sights, lens flare, and screen-space reflections
 *                where the backend has them (WebGPU; see PostFX for why not WebGL2).
 *
 * Temporal AA is on wherever post is: on WebGPU the world pass is drawn without MSAA
 * (a depth-reading post pass cannot copy a multisampled depth there), so before this the
 * `quality` studio had no anti-aliasing at all on the backend most desktops use.
 */
export function studioProfile(quality, base) {
  const p = { ...base, lights: 6, traa: true, film: true, volumetric: false, motionBlur: false, dressing: true };
  if (quality === 'performance') return { ...p, postFX: false, ao: false, traa: false, film: false, dof: false, lensflare: false, ssr: false, lights: 4 };
  if (quality === 'balanced') return { ...p, postFX: true, ao: true, aoSamples: 8, aoScale: 0.5, dof: false, lensflare: false, ssr: false };
  return { ...p, postFX: true, ao: true, aoSamples: 12, aoScale: 0.5, dof: true, lensflare: true, ssr: true, ssrScale: 0.5 };
}

// Pale edges separate the critters from the pastel meadow. These are emissive edge levels,
// not extra ambient fill.
export const ENEMY_SIGNATURES = {
  arcade: { rim: 0xfff3df, eye: 0xff9aa6, night: .4, dawn: .25 },
};
