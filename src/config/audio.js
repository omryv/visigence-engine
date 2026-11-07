/**
 * THE AUDIO ASSET REGISTRY.
 *
 * One entry per shipped MP3, and nothing in the game names a file directly: every caller
 * asks for a logical id here, so a replaced or renamed file is a one-line change and a
 * missing one fails loudly in exactly one place.
 *
 * ---------------------------------------------------------------------------
 * WHERE THESE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * `node tools/measure/measure-audio.mjs` decodes every file in a real AudioContext and reports its
 * duration, peak, RMS, where the sound actually stops, and its transient onsets. The table
 * below is set from that output - it is not tuned by ear against a guess. What it measured:
 *
 *   file                      dur    peak   peak dB  RMS dB  ends at  onsets
 *   steps.mp3                 2.00   0.32    -9.9    -40.7    1.85    0.12 0.63 1.15 1.65
 *   jump.mp3                  2.00   0.58    -4.8    -31.0    1.58    1.15 1.53
 *   weapon1.mp3               2.00   1.09    +0.8    -10.8    1.57    (dense from 0.00)
 *   weapon-1-reload.mp3       1.60   1.06    +0.5    -20.1    1.11    0.03 0.25 0.67 0.77
 *   E-loading-computer.mp3    2.00   0.97    -0.2    -19.8    2.00    every ~0.13 s
 *   E-computer-activated.mp3  2.00   0.59    -4.5    -23.9    1.10
 *   E-door-opened.mp3         2.00   1.07    +0.6    -13.7    2.00
 *   door-unavailable.mp3      2.00   0.44    -7.1    -25.8    2.00    0.05 0.27
 *   grenade-exploaded.mp3     2.00   1.05    +0.4    -11.0    2.00    0.03 0.61 0.76 0.90
 *   enemy-1.mp3              1.00   0.73    -2.8    -18.4    1.00    0.25
 *   enemy-2.mp3              1.60   0.97    -0.3    -16.0    1.60    0.33
 *   enemy-3.mp3              1.60   0.79    -2.1    -17.5    1.60    0.26 0.41
 *   ui-button-click.mp3       1.00   0.40    -8.0    -25.5    0.32
 *   ui-esc-button.mp3         1.00   0.38    -8.4    -25.1    1.00
 *
 * Four of them peak ABOVE full scale (`weapon1`, `weapon-1-reload`, `grenade-exploaded`,
 * `E-door-opened`) while `steps.mp3` sits 30 dB
 * below them. Playing that set at a flat gain is either an inaudible footstep or a
 * distorted gunshot, so every `gain` here is the multiplier that lands the file's MEASURED
 * RMS on a chosen mix level: gain = 10^((target - measuredRms) / 20). The targets are the
 * mix decision (a grenade is meant to be louder than a footstep); the arithmetic is not.
 *
 * `duration` trims a file to its meaningful part where the container carries a long silent
 * tail. It is a playback window, never a gameplay timer - see the note on `meaningful`.
 */

/** Output buses. UI is never spatialised; the world bus is. */
export const BUS = { UI: 'ui', PLAYER: 'player', WORLD: 'world' };

/**
 * Per-bus trim, applied under the master volume. The player bus sits slightly back so a
 * weapon fired at the ear does not bury a enemy two metres away.
 */
export const BUS_GAIN = {
  [BUS.UI]: 0.9,
  [BUS.PLAYER]: 0.85,
  [BUS.WORLD]: 1.0,
};

/**
 * The master limiter. Everything - synthesised sounds included - passes through it, so a
 * grenade landing under a burst of automatic fire cannot clip the output.
 */
export const LIMITER = {
  threshold: -6,
  knee: 6,
  ratio: 12,
  attack: 0.003,
  release: 0.18,
  /** Make-up gain after the compressor, chosen so the limiter is transparent when idle. */
  makeup: 1.15,
};

/** Distance model for spatial voices - the same shape the synthesised pool already uses. */
export const SPATIAL = {
  refDistance: 4.5,
  rolloffFactor: 1.15,
  maxDistance: 45,
  distanceModel: 'inverse',
};

/**
 * @typedef {object} AudioAsset
 * @property {string} file        exact filename, including its existing typo
 * @property {string} bus
 * @property {number} gain        level-matching multiplier, see the header
 * @property {boolean} [spatial]
 * @property {boolean} [loop]
 * @property {number} [loopStart] seconds
 * @property {number} [loopEnd]   seconds
 * @property {number} [offset]    start this far into the file
 * @property {number} [duration]  stop after this long (trims a silent tail)
 * @property {number} [minAudible] shortest audible burst when stopped early, seconds
 */

/** @type {Record<string, AudioAsset>} */
export const AUDIO_ASSETS = {
  // --- UI, never spatial -------------------------------------------------
  uiEsc: { file: 'ui-esc-button.mp3', bus: BUS.UI, gain: 0.72, duration: 0.60 },
  uiClick: { file: 'ui-button-click.mp3', bus: BUS.UI, gain: 0.75, duration: 0.35 },

  // --- player-local, never spatial (they happen at the ear) ---------------
  /**
   * Four evenly spaced steps at 0.12 / 0.63 / 1.15 / 1.65 make the whole 2.00 s file one
   * walk cycle, so the loop is the file: no per-footfall triggering, one voice.
   */
  steps: { file: 'steps.mp3', bus: BUS.PLAYER, gain: 2.16, loop: true, loopStart: 0, loopEnd: 2.0 },
  /**
   * The takeoff is NOT at zero: the first transient is at 1.15 s. Started from zero on a
   * jump press the sound arrives after the player has already landed, so playback starts
   * just before that transient instead.
   */
  jump: { file: 'jump.mp3', bus: BUS.PLAYER, gain: 1.12, offset: 1.10, duration: 0.80 },
  /**
   * Automatic fire. The useful texture is the first half second; the rest is the tail of a
   * burst and then silence, which would turn into a rhythmic pumping if it were looped
   * whole. The loop window is inside the dense part, past the initial transient so the
   * seam has no attack in it.
   */
  weapon1Fire: {
    file: 'weapon1.mp3', bus: BUS.PLAYER, gain: 0.275,
    loop: true, loopStart: 0.06, loopEnd: 0.50, minAudible: 0.12,
  },
  // ffmpeg decode: launch 2.00 s / -4.2 dB RMS; impact 2.88 s / -11.6 dB RMS.
  // One source per accepted launch/impact, mixed below the existing master limiter.
  rpgFire: { file: 'rpg.mp3', bus: BUS.PLAYER, gain: 0.15 },
  rpgImpact: { file: 'rpg-impact.mp3', bus: BUS.WORLD, gain: 0.56, spatial: true },
  // The reload sounds are action voices that play OUT when the reload completes and stop only
  // when it is cancelled (WeaponController._endReload): their files run past the reload
  // timelines (rpg 3.20 s for 2.2, pistol 2.00 for 1.75, shotgun 4.40 for 3.2, sniper 4.56 for
  // 2.7). weapon 1 is the exception, trimmed to its mechanism on purpose - see `duration`.
  weapon1Reload: { file: 'weapon-1-reload.mp3', bus: BUS.PLAYER, gain: 0.403, duration: 1.11 },
  rpgReload: { file: 'rpg-reload.mp3', bus: BUS.PLAYER, gain: 0.4 },
  weaponSwitch: { file: 'weapon-switch.mp3', bus: BUS.PLAYER, gain: 0.4 },
  pistolFire: { file: 'pistol.mp3', bus: BUS.PLAYER, gain: 0.35 },
  pistolReload: { file: 'pistol-reload.mp3', bus: BUS.PLAYER, gain: 0.4 },
  shotgunFire: { file: 'shotgun.mp3', bus: BUS.PLAYER, gain: 0.3 },
  shotgunReload: { file: 'shotgun-reload.mp3', bus: BUS.PLAYER, gain: 0.4 },
  sniperFire: { file: 'sniper.mp3', bus: BUS.PLAYER, gain: 0.3 },
  sniperReload: { file: 'sniper-reload.mp3', bus: BUS.PLAYER, gain: 0.4 },

  // --- world, spatial ----------------------------------------------------
  /** Continuous through its full 2.00 s, which is what makes it loopable under a hold. */
  computerLoading: {
    file: 'E-loading-computer.mp3', bus: BUS.WORLD, gain: 0.49, spatial: true,
    loop: true, loopStart: 0.02, loopEnd: 1.98,
  },
  computerActivated: { file: 'E-computer-activated.mp3', bus: BUS.WORLD, gain: 0.90, spatial: true, duration: 1.15 },
  doorOpened: { file: 'E-door-opened.mp3', bus: BUS.WORLD, gain: 0.48, spatial: true, duration: 1.20 },
  doorUnavailable: { file: 'door-unavailable.mp3', bus: BUS.WORLD, gain: 0.98, spatial: true, duration: 1.00 },
  grenadeExploded: { file: 'grenade-exploaded.mp3', bus: BUS.WORLD, gain: 0.56, spatial: true },
};

/**
 * ACTION IDS.
 *
 * One id per cancellable action, built here so the code that starts a voice and the code
 * that cancels it cannot disagree about the string. Anything with an entity in its name
 * takes that entity's id, which is also the OWNER used to drop all of its audio at once.
 */
export const ACTION = {
  steps: 'player:steps',
  jump: 'player:jump',
  weapon1Fire: 'player:weapon1-fire',
  weapon1Reload: 'player:weapon1-reload',
  rpgReload: 'player:rpg-reload',
  computer: (id) => `interaction:computer:${id}`,
  door: (id) => `interaction:door:${id}`,
};

/** Fade lengths, milliseconds. Short enough to be a cancel, long enough not to click. */
export const FADE = {
  /** Cancelling a continuous action: a hold released, a reload interrupted. */
  cancel: 60,
  /** Releasing the trigger. The brief's 30-60 ms. */
  fire: 45,
  /** Movement stopping. */
  steps: 80,
  /** Everything being torn down. */
  teardown: 40,
};

