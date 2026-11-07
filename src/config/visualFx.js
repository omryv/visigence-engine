/**
 * THE VISUAL-EFFECT SWITCHBOARD.
 *
 * Every effect added in the visual-upgrade passes - set dressing, ambient occlusion,
 * the wet floor, volumetric fog, the post stack - is decided by exactly two things:
 *
 *   1. the session's fixed graphics profile (config/quality.js), which says whether the
 *      device gets the effect at all, and
 *   2. the `?fx=` address-bar override, which lets anyone A/B one effect on its own.
 *
 * `?fx=` is a comma list. A bare name forces the effect ON, a `-name` forces it OFF, and
 * `off` disables every effect listed here at once, so `?fx=off` renders the level exactly
 * as the profile did before any of these existed and `?fx=-ao` renders everything except
 * the occlusion. This is the same convention as `?ibl=off` in render/Environment.js and
 * `?maze=glb` in game/Level.js, extended to more than one switch.
 *
 * Everything here is FIXED FOR THE SESSION, like the rest of the profile: an effect is
 * built or not built at boot, never toggled while the game runs, because most of them are
 * a node in the post graph or a material on the level and switching either is a rebuild.
 *
 * The names are the vocabulary the README, the debug readout and the final report use.
 */

/** Every switch, with the profile field that decides its default. */
export const FX = {
  /** Option 2: macro tint variation, height grime, conduit runs, world decals, rubble. */
  dressing: 'dressing',
  /** Option 2: blood marks left on walls and the floor by enemy hits and deaths. */
  blood: 'bloodDecals',
  /** Option 1: screen-space ambient occlusion (GTAO) on the world pass. */
  ao: 'ao',
  /** Option 1: overhead key light with a soft (VSM) shadow, replacing the raking sun. */
  skylight: 'skylight',
  /** Option 1: the nearest zone fixture casts a real shadow. */
  fixtureShadow: 'fixtureShadow',
  /** Option 4: puddles, wear track and the semi-gloss floor response. */
  wet: 'wet',
  /** Option 4: screen-space reflections. */
  ssr: 'ssr',
  /** Option 3: raymarched light scattering in place of the additive cones. */
  volumetric: 'volumetric',
  /** Option 3: the gantry silhouette over the void above the walls. */
  ceiling: 'ceiling',
  /** Option 5: temporal anti-aliasing. */
  traa: 'traa',
  /** Option 5: per-object motion blur. */
  motionBlur: 'motionBlur',
  /** Option 5: depth of field while aiming down the sights. */
  dof: 'dof',
  /** Option 5: lens flare and dirt response to bright sources. */
  lensflare: 'lensflare',
  /** Option 5: film grain in place of the hash dither, plus the sharpen pass. */
  film: 'film',
  /** Option 5: enemy bodies burn away instead of sinking through the floor. */
  dissolve: 'dissolve',
  /**
   * The renderer's 4x multisampling (core/Renderer.js `antialias`). The only anti-aliasing
   * a profile without a temporal resolve has; `?fx=-msaa` is the on-device A/B for it.
   * Read by core/SessionQuality.js through parseFxOverrides, so only the explicit `-msaa`
   * token turns it off: `?fx=off` leaves it alone, because the sampling predates the effects.
   */
  msaa: 'antialias',
};

/** Parse `?fx=` once. Exported for the node tests, which pass a string instead. */
export function parseFxOverrides(search) {
  const out = { all: null, on: new Set(), off: new Set() };
  if (!search) return out;
  const raw = new URLSearchParams(search).get('fx');
  if (!raw) return out;
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    if (token === 'off' || token === 'none') { out.all = false; continue; }
    if (token === 'on' || token === 'all') { out.all = true; continue; }
    if (token.startsWith('-') || token.startsWith('!')) out.off.add(token.slice(1));
    else out.on.add(token);
  }
  return out;
}

let _overrides = null;
function overrides() {
  if (_overrides) return _overrides;
  _overrides = parseFxOverrides(typeof location !== 'undefined' ? location.search : '');
  return _overrides;
}

/**
 * Whether one effect is on for this session.
 *
 * @param {keyof FX} name one of the FX keys
 * @param {object} profile the session's fixed profile (config/quality.js)
 * @returns {boolean}
 */
export function fxEnabled(name, profile) {
  const o = overrides();
  if (o.off.has(name)) return false;
  if (o.on.has(name)) return true;
  if (o.all === false) return false;
  if (o.all === true) return true;
  const field = FX[name];
  const v = profile?.[field];
  return typeof v === 'number' ? v > 0 : !!v;
}

