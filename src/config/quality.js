/**
 * WHAT THE MACHINE GETS, AND WHAT MAY CHANGE WHILE IT RUNS.
 *
 * This replaces the old five-preset ladder (mobile/performance/balanced/high/ultra) that
 * the player picked from a menu and that an adaptive controller stepped up and down. That
 * design had two problems, and they were the two things actually wrong with the game.
 *
 * 1. THE PRESETS COULD NOT BE MET. Every preset above `performance` was unplayable, and
 *    the reason was never the resolution - it was that the scene carried 36 point lights
 *    and the presets only thinned a handful of them. Fixing that (see render/LightRig.js)
 *    is what makes a higher setting possible at all; without it, no preset table helps.
 *
 * 2. CHANGING PRESET AT RUNTIME FROZE THE GAME. Half of what a preset controls - whether
 *    shadows exist, how many lights there are, whether the post chain runs - is baked into
 *    every shader in the scene. Changing any of it invalidates every pipeline, and the
 *    player sees a hang. An "adaptive" system whose adaptations cost half a second is
 *    worse than no adaptive system.
 *
 * So the settings are split by what they cost to change, and that split is the whole idea:
 *
 *   FIXED    decided once at boot from what the device actually is, then never touched.
 *            Everything that participates in a shader: light count, shadows, post
 *            processing, texture sizes. Nothing here can hitch, because nothing here moves.
 *
 *   ADAPTIVE  free to change on any frame. Render scale, and how many particles and decals
 *            are in play. None of these recompile anything - a render scale change resizes
 *            targets, and the effect budgets only change how many pooled objects are live.
 *
 * The profile is chosen by core/DeviceProfile.js from real signals - and, since the
 * graphics settings came back, from the player's saved PRESET when they have chosen one.
 * The preset is a request the device mapping honours within the platform's ladder; it is
 * applied at boot, because that is the only moment the fixed half can be decided.
 *
 * THE HANDHELD TIER. The ladder used to jump from `lean` (no shadows, no post, no set
 * dressing, no ceiling, 256 px surface maps) straight to `standard`, and every phone was
 * capped at `lean` for thermal reasons. That cap threw away the whole visual pass on the
 * platform the game ships on: Level 1 lost its gantry, its luminaires, its conduit and
 * signage, its wet floor and its shadows, while the sectors with authored interiors
 * (school, museum, cinema) kept theirs because they never consulted the profile. The result
 * was a game whose first level looked like a different, cheaper product than its fourth.
 * `mobile` is the tier that spends a phone's budget where the eye is: shadows, the set
 * dressing, the ceiling and its fixtures, bloom and the grade, at a render scale the
 * adaptive controller can protect - and none of the raymarch, reflection or temporal
 * passes whose cost per pixel a phone cannot sustain.
 */

/**
 * The five fixed budgets, weakest first.
 *
 * They are deliberately close together at the top. "Ultra" in the old table bought a 2x
 * pixel ratio and 16x anisotropy over "high" - real cost, almost no visible difference in
 * a fogged corridor - which is the overkill this replaces. The meaningful spread is at the
 * bottom, where it decides whether a phone runs at all.
 *
 * @typedef {object} Profile
 * @property {string} label            shown in the readout
 * @property {number} lights           LightRig slots. FIXED for the session: this is the
 *                                     single biggest cost in the scene and the single most
 *                                     expensive thing to change.
 * @property {boolean} shadows
 * @property {number} shadowMapSize
 * @property {number} shadowDistance   directional shadow camera half-extent, metres
 * @property {boolean} propShadows     whether props cast, or only the maze
 * @property {boolean} softShadows     VSM (a real blurred penumbra, two blur passes over the
 *                                     map every frame) rather than PCF. The skylight's
 *                                     direction does not depend on it; only the filter does.
 * @property {boolean} postFX          bloom + grade
 * @property {number} bloomStrength
 * @property {number} maxPixelRatio    cap on devicePixelRatio
 * @property {number} renderScale      starting multiplier on the drawing buffer; the
 *                                     adaptive controller moves this and only this
 * @property {number} minRenderScale   how far down it may be pushed
 * @property {number} maxTextureSize   prop textures are downscaled to this
 * @property {number} surfaceTextureSize  edge of the generated maze/floor maps
 * @property {number} anisotropy
 * @property {number} particleScale
 * @property {number} maxDecals
 * @property {boolean} tracers
 * @property {boolean} shellCasings
 * @property {number} fogDensityScale
 * @property {number} liveEffectLights how many effect flashes may decay at once (feel, not cost)
 *
 * The visual-upgrade switches (see config/visualFx.js for the `?fx=` override that
 * pairs with each). Every one is FIXED for the session like the rest of this block:
 * @property {boolean} dressing        conduit, signage, stains, rubble and the macro tint
 * @property {number} bloodDecals      pooled blood marks; 0 disables them
 * @property {boolean} ao              screen-space ambient occlusion (GTAO) on the world pass
 * @property {number} aoScale          resolution of the AO pass relative to the frame
 * @property {number} aoSamples        GTAO samples per pixel; compiled into the pass
 * @property {boolean} skylight        the key light comes from overhead instead of the
 *                                     raking sun it replaced
 * @property {boolean} fixtureShadow   the nearest zone fixture casts a real shadow
 * @property {number} fixtureShadowMapSize
 * @property {boolean} wet             the floor's wear track, puddles and semi-gloss response
 * @property {boolean} ssr             screen-space reflections over the world pass
 * @property {number} ssrScale         resolution of the reflection pass relative to the frame
 * @property {boolean} volumetric      raymarched light scatter in place of the additive cones
 * @property {number} volumetricSteps  samples per ray; compiled into the pass
 * @property {number} volumetricLights lights per sample; compiled into the pass
 * @property {number} volumetricScale  resolution of the scatter pass relative to the frame
 * @property {boolean} ceiling         the shadow-casting gantry over the void
 * @property {boolean} traa            temporal anti-aliasing over the world pass
 * @property {boolean} motionBlur      per-object motion blur from the velocity target
 * @property {number} motionBlurSamples
 * @property {boolean} dof             depth of field while aiming down the sights
 * @property {boolean} lensflare       ghosts from the bloom's bright sources
 * @property {boolean} film            film grain in place of the hash dither, plus a sharpen pass
 * @property {boolean} dissolve        enemy bodies burn away instead of sinking through the floor
 *
 * Nothing in a profile changes gameplay: fire rate, damage, spread, enemy behaviour and
 * timing are identical on every one of them. Only what is drawn changes.
 */

/** @type {Record<string, Profile>} */
export const PROFILES = {
  /** Software rasterisers and the weakest phones. The target is "runs", not "looks good". */
  minimal: {
    label: 'MINIMAL',
    lights: 3,
    shadows: false,
    shadowMapSize: 512,
    shadowDistance: 10,
    propShadows: false,
    softShadows: false,
    postFX: false,
    bloomStrength: 0,
    maxPixelRatio: 1.0,
    renderScale: 0.72,
    minRenderScale: 0.5,
    maxTextureSize: 512,
    surfaceTextureSize: 256,
    anisotropy: 1,
    particleScale: 0.3,
    maxDecals: 6,
    tracers: false,
    shellCasings: false,
    fogDensityScale: 1.2,
    liveEffectLights: 2,
    dressing: false,
    bloodDecals: 0,
    ao: false,
    aoScale: 0.5,
    aoSamples: 8,
    skylight: false,
    fixtureShadow: false,
    fixtureShadowMapSize: 512,
    wet: false,
    ssr: false,
    ssrScale: 0.5,
    volumetric: false,
    volumetricSteps: 8,
    volumetricLights: 2,
    volumetricScale: 0.5,
    ceiling: false,
    traa: false,
    motionBlur: false,
    motionBlurSamples: 8,
    dof: false,
    lensflare: false,
    film: false,
    dissolve: false,
  },

  /**
   * Low-memory phones and low-power laptops. Shadows and the post chain stay off - one
   * shadow map is the biggest single win - but the ceiling, its fixtures and the wet floor
   * now come with it: they are static geometry and one texture read, and their absence is
   * what made the first level read as a blockout under a black void. The surface maps are
   * 512 px like every tier above: 256 px over a 2 m tile is 128 px per metre, which blurs
   * into paint at the range a wall is actually read from, and the memory it saved was one
   * 768 KB set.
   */
  lean: {
    label: 'LEAN',
    lights: 4,
    shadows: false,
    shadowMapSize: 512,
    shadowDistance: 12,
    propShadows: false,
    softShadows: false,
    postFX: false,
    bloomStrength: 0,
    maxPixelRatio: 1.5,
    renderScale: 0.85,
    minRenderScale: 0.6,
    maxTextureSize: 1024,
    surfaceTextureSize: 512,
    anisotropy: 2,
    particleScale: 0.5,
    maxDecals: 16,
    tracers: true,
    shellCasings: false,
    fogDensityScale: 1.1,
    liveEffectLights: 3,
    dressing: false,
    bloodDecals: 0,
    ao: false,
    aoScale: 0.5,
    aoSamples: 8,
    skylight: true,
    fixtureShadow: false,
    fixtureShadowMapSize: 512,
    wet: true,
    ssr: false,
    ssrScale: 0.5,
    volumetric: false,
    volumetricSteps: 8,
    volumetricLights: 2,
    volumetricScale: 0.5,
    ceiling: true,
    traa: false,
    motionBlur: false,
    motionBlurSamples: 8,
    dof: false,
    lensflare: false,
    film: false,
    dissolve: false,
  },

  /**
   * THE HANDHELD TIER: a current phone or tablet. This is what the iOS build ships on.
   *
   * What it keeps from `standard`, because the eye reads it in the first second: the
   * shadow map (PCF, one map, 1024), the set dressing and the door landmarks, the gantry
   * and its luminaires, the wet floor, bloom and the grade, the sharpen-and-grain output
   * (which also hides the reduced render scale), enemy dissolve, and a light budget one
   * slot short of standard.
   *
   * What it drops, because its cost is per pixel every frame and its return is a nuance:
   * the volumetric raymarch (the additive cones stand in), the second shadow map for the
   * nearest fixture, VSM's two blur passes (PCF's penumbra is fixed but a phone screen is
   * small), temporal AA and its velocity target (MSAA is already on), motion blur, depth of
   * field, lens flare, and screen-space reflections. GTAO stays at half resolution with
   * fewer samples: the contact term is mostly baked into the walls and the wear map, so
   * the pass only has to find the small contacts.
   *
   * 1.75 x 0.92 is about 1.6 device pixels per CSS pixel on an iPhone - sharp enough that
   * the UI and the world no longer disagree about resolution - and the adaptive controller
   * has 0.6 to fall back to when the device warms up, which is the honest answer to
   * thermal throttling: hold the features, trade the pixels.
   */
  mobile: {
    label: 'MOBILE',
    lights: 5,
    shadows: true,
    shadowMapSize: 1024,
    shadowDistance: 16,
    propShadows: true,
    softShadows: false,
    postFX: true,
    bloomStrength: 0.30,
    maxPixelRatio: 1.75,
    renderScale: 0.92,
    minRenderScale: 0.6,
    maxTextureSize: 1024,
    surfaceTextureSize: 512,
    anisotropy: 4,
    particleScale: 0.7,
    maxDecals: 24,
    tracers: true,
    shellCasings: true,
    fogDensityScale: 1.0,
    liveEffectLights: 4,
    dressing: true,
    bloodDecals: 16,
    ao: true,
    aoScale: 0.5,
    aoSamples: 8,
    skylight: true,
    fixtureShadow: false,
    fixtureShadowMapSize: 512,
    wet: true,
    ssr: false,
    ssrScale: 0.5,
    volumetric: false,
    volumetricSteps: 8,
    volumetricLights: 2,
    volumetricScale: 0.5,
    ceiling: true,
    traa: false,
    motionBlur: false,
    motionBlurSamples: 8,
    dof: false,
    lensflare: false,
    film: true,
    dissolve: true,
  },

  /** The default for ordinary hardware, and what the art direction is authored against. */
  standard: {
    label: 'STANDARD',
    lights: 6,
    shadows: true,
    shadowMapSize: 1024,
    shadowDistance: 18,
    propShadows: true,
    softShadows: true,
    postFX: true,
    bloomStrength: 0.34,
    maxPixelRatio: 1.75,
    renderScale: 1.0,
    minRenderScale: 0.7,
    maxTextureSize: 1024,
    surfaceTextureSize: 512,
    anisotropy: 8,
    particleScale: 0.85,
    maxDecals: 32,
    tracers: true,
    shellCasings: true,
    fogDensityScale: 1.0,
    liveEffectLights: 5,
    dressing: true,
    bloodDecals: 24,
    ao: true,
    aoScale: 0.5,
    aoSamples: 12,
    skylight: true,
    fixtureShadow: true,
    fixtureShadowMapSize: 768,
    wet: true,
    ssr: false,
    ssrScale: 0.5,
    volumetric: true,
    volumetricSteps: 12,
    volumetricLights: 3,
    volumetricScale: 0.5,
    ceiling: true,
    traa: true,
    motionBlur: false,
    motionBlurSamples: 8,
    dof: true,
    lensflare: false,
    film: true,
    dissolve: true,
  },

  /**
   * Desktops with a real GPU. Note what it does NOT buy over `standard`: the same texture
   * budget, the same render scale, a modest anisotropy bump. It buys two more lights, a
   * sharper shadow map and full particle counts, because those are the three things a
   * player can actually see the difference in.
   */
  full: {
    label: 'FULL',
    lights: 8,
    shadows: true,
    shadowMapSize: 1536,
    shadowDistance: 22,
    propShadows: true,
    softShadows: true,
    postFX: true,
    bloomStrength: 0.38,
    maxPixelRatio: 2.0,
    renderScale: 1.0,
    minRenderScale: 0.75,
    maxTextureSize: 2048,
    surfaceTextureSize: 512,
    anisotropy: 8,
    particleScale: 1.0,
    maxDecals: 48,
    tracers: true,
    shellCasings: true,
    fogDensityScale: 1.0,
    liveEffectLights: 6,
    dressing: true,
    bloodDecals: 40,
    ao: true,
    aoScale: 0.6,
    aoSamples: 12,
    skylight: true,
    fixtureShadow: true,
    fixtureShadowMapSize: 1024,
    wet: true,
    ssr: true,
    ssrScale: 0.5,
    volumetric: true,
    volumetricSteps: 20,
    volumetricLights: 4,
    volumetricScale: 0.5,
    ceiling: true,
    traa: true,
    motionBlur: true,
    motionBlurSamples: 12,
    dof: true,
    lensflare: true,
    film: true,
    dissolve: true,
  },
};

/** Weakest to strongest, so a score can be mapped onto it. */
export const PROFILE_ORDER = ['minimal', 'lean', 'mobile', 'standard', 'full'];

export const PRESET_PROFILES = {
  handheld: { performance: 'lean', balanced: 'mobile', quality: 'standard' },
  desktop: { performance: 'lean', balanced: 'standard', quality: 'full' },
};

