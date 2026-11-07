/**
 * Camera and first-person viewmodel configuration.
 *
 * Reconstructed from the runtime consumers after the original config file
 * was missing from the repository.
 */

export const CAMERA = {
  worldFovDesktop: 75,
  worldFovMobile: 70,
  worldNear: 0.05,
  worldFar: 200,

  viewmodelFov: 60,
  viewmodelNear: 0.01,
  viewmodelFar: 10,
};

/**
 * Animation clip names are discovered rather than assumed.
 * Each semantic name contains patterns tried in order.
 *
 * The Blender sets name their clips `SMG_Reload_Empty`, `Shotgun_AimIn` and so on, with an
 * underscore between the weapon prefix and the verb. `\b` does not see an underscore as a
 * boundary, so every pattern below also accepts `(^|_)verb(_|$)`. The more specific names
 * are listed FIRST (`reloadEmpty` before `reload`): resolveClips binds each clip to at most one
 * semantic, in this order, so a pattern that would also match the more specific clip never
 * gets the chance to steal it.
 */
export const CLIP_PATTERNS = {
  reloadEmpty: [
    /(^|_)reload_empty(_|$)/i,
    /(^|_)reloadempty$/i,
    /\breload.?empty\b/i,
  ],

  reload: [
    /^reload$/i,
    /(^|_)reload(_tactical|_cell)?$/i,
    /\breload\b/i,
    /\bmagazine\b/i,
  ],

  fire: [
    /^fire$/i,
    /(^|_)fire$/i,
    /(^|_)shoot$/i,
    /\bfire\b/i,
    /\bshoot\b/i,
    /\bshot\b/i,
  ],

  equip: [
    /^equip$/i,
    /(^|_)equip$/i,
    /\bequip\b/i,
    /\bdraw\b/i,
    /\bdeploy\b/i,
  ],

  holster: [
    /^holster$/i,
    /(^|_)holster$/i,
    /\bholster\b/i,
    /(^|_)unequip$/i,
    /\bunequip\b/i,
  ],

  sprint: [
    /^sprint$/i,
    /(^|_)sprint$/i,
    /(^|_)run$/i,
    /\bsprint\b/i,
    /\brun\b/i,
  ],

  ads: [
    /^ads$/i,
    /(^|_)aim(in)?$/i,
    /\bads\b/i,
    /\baim\b/i,
  ],

  interact: [
    /^interact$/i,
    /(^|_)interact$/i,
    /\binteract\b/i,
    /\buse\b/i,
  ],

  inspect: [
    /^inspect$/i,
    /(^|_)inspect$/i,
    /\binspect\b/i,
    /\bcheck\b/i,
  ],

  /** Moving at a walk: a loop weighted by the player's speed (v2 first-person rigs). */
  walk: [
    /^walk$/i,
    /(^|_)walk$/i,
  ],

  idle: [
    /^idle$/i,
    /(^|_)idle$/i,
    /\bidle\b/i,
    /\brest\b/i,
  ],

  /** The support hand letting go of the fore-end and taking it again. Not a reload. */
  regrip: [
    /(^|_)supportregrip$/i,
    /\bregrip\b/i,
  ],

  /** A standalone priming stroke. The shotgun's fire clip already contains one. */
  cycle: [
    /(^|_)cycle$/i,
    /\bcycle\b/i,
  ],
};

/**
 * How the AUTHORED clips are run against the weapon state machine. See
 * viewmodel/AuthoredAnimator.js: the state machine keeps every duration and every ammo
 * marker, and a clip is stretched or squeezed to the state it plays under, so the seated
 * magazine and the ammo commit cannot disagree whatever the two files say.
 */
export const AUTHORED_ANIM = {
  /** Crossfade into and out of a one-shot, seconds. Short: the clips start on the idle pose. */
  fade: 0.08,
  /** The idle loop's crossfade, when it takes over from a finished one-shot. */
  idleFade: 0.14,
  /**
   * How much of the idle breathe survives at full aim, as a weight. The procedural idle keeps
   * 40%; the authored root sway is ±2.5 mm, which a sight picture notices, so the same.
   */
  idleAtAds: 0.4,
  /**
   * The AimIn clip's root track is DROPPED before it is bound: it moves the assembly to the
   * animator's guess at a sight picture, and the game already solves that exactly
   * (WEAPONS[*].ads, tools/measure/solve-ads.mjs) on the ADSRoot above. Only the hands tighten.
   */
  adsHandsOnly: true,
  /**
   * The clip is fitted to the state when the two durations differ by more than this ratio;
   * inside it the clip runs at its authored speed and the state's end simply cuts it, which
   * for a difference this small is invisible and keeps the authored timing exact.
   */
  fitTolerance: 0.02,
};

