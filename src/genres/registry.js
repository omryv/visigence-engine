/**
 * THE GENRES: what a project may be, beyond a shooter.
 *
 * A genre is a vocabulary and a set of rules over the same engine: which blueprint pools
 * a mission needs, which objectives its steps may use, which perspectives it plays from,
 * and whether the weapon stack is built at all. This file is DATA ONLY and imports no
 * three, so the world layer (blueprint compiler, project resolver, launcher presets) can
 * read it under bare node; the runtime rules that build systems, drive input and place
 * the camera live in genres/rules.js and its per-genre modules, which the session loads.
 *
 * Adding a genre: an entry here, a rules module registered in genres/rules.js, a preset
 * in world/missionCard.js, and a row in docs/GENRES.md. The studio, the launcher, the
 * project contract and the compiler read this table; nothing else needs to know.
 *
 * Perspectives: `first` (the eye, the hands and the weapon), `follow` (the hero seen from over
 * the shoulder, the camera orbiting them) and `overhead` (the hero seen from above and behind,
 * north up, aimed at the pointer). The hero's model and clips are the pack's player character.
 */

/** The first-person shooter's objective kinds (world/blueprint.js OBJECTIVE_KINDS). */
const ALL_OBJECTIVES = ['activate', 'override', 'waves', 'eliminate', 'boss', 'barricade', 'reach', 'extract'];
/** The steps a player can complete with hands only: no shooting, no breaking. */
const HANDS_ONLY_OBJECTIVES = ['activate', 'override', 'reach', 'extract'];

/**
 * @typedef {object} Genre
 * @property {string} id
 * @property {string} label
 * @property {string} description       one line, shown in the studio and the launcher
 * @property {string} platformLine      the launcher's platform caption
 * @property {boolean} weapons          build the weapon stack (viewmodel, hitscan, ammo, grenades, rockets)
 * @property {string[]} cameras         allowed `project.camera` values; the first is the default
 * @property {string[]} objectives      objective kinds a mission step may use
 * @property {string[]} requiredPools   blueprint pools the generator must be fed
 * @property {boolean} pointerLock      whether a mouse click captures the pointer
 * @property {boolean} [melee]          the hero strikes with the trail staff (third person)
 * @property {boolean} [stomp]          landing on a critter defeats it (collect-a-thon)
 * @property {string[]} [gear]          pack props the genre itself needs loaded (the hero's staff)
 * @property {{enemyCount: number, behavior: string, lives: number}} preset  the launcher's quick-mission defaults
 * @property {Controls} controls         how it is played, for the control guide and the touch layout
 */

/**
 * @typedef {object} Controls
 * @property {string[]} keys      the guide's lines on a keyboard and mouse
 * @property {string[]} touch     the guide's lines on a touch screen
 * @property {string} pad         the guide's line when a gamepad is connected
 * @property {string[]} buttons   the touch buttons shown, of weapon, grenade, reload, use, aim, jump, fire and aimPad
 *                                (a right-hand pad that aims and fires while held)
 * @property {string} [fire]      the fire button's label, when it is not FIRE
 */
const FOLLOW_KEYS = 'WASD run · Mouse turns the camera · Space jump';

/** @type {Record<string, Genre>} */
export const GENRES = {
  shooter: {
    id: 'shooter', label: 'Shooter', description: 'Hitscan weapons, grenades and rockets over the mission graph.',
    platformLine: 'FIRST-PERSON SHOOTER',
    weapons: true,
    cameras: ['first'], objectives: ALL_OBJECTIVES, requiredPools: ['world', 'weapons'],
    pointerLock: true, preset: { enemyCount: 3, behavior: 'guard', lives: 1 },
    controls: {
      keys: ['WASD move · Mouse aim · Click fire · Space jump', 'E hold to interact · R reload · G fizz-bomb · Esc pause'],
      touch: ['Left pad to move · Drag the world to look', 'Hold FIRE to shoot · Hold AIM for sights · USE to interact'],
      pad: 'Left stick move · Right stick look · RT fire · LT sights · A jump · B interact',
      buttons: ['weapon', 'grenade', 'reload', 'use', 'aim', 'fire'],
    },
  },
  exploration: {
    id: 'exploration', label: 'Exploration', description: 'No weapons. The village, and what moves in it. Reach, activate, get out.',
    platformLine: 'FIRST-PERSON EXPLORATION',
    weapons: false,
    cameras: ['first'], objectives: HANDS_ONLY_OBJECTIVES, requiredPools: ['world'],
    pointerLock: true, preset: { enemyCount: 2, behavior: 'guard', lives: 1 },
    controls: {
      keys: ['WASD move · Mouse look · Shift sprint · Space jump', 'E hold to interact · J journal · Esc pause'],
      touch: ['Left pad to move · Drag the world to look', 'JUMP to jump · Hold USE to interact'],
      pad: 'Left stick move · Right stick look · A jump · B interact · L3 sprint',
      buttons: ['use', 'jump'],
    },
  },
  action: {
    id: 'action', label: 'Action adventure', description: 'Third person with the trail staff: strike, jump, find the keys, open the way.',
    platformLine: 'THIRD-PERSON ACTION',
    weapons: false, melee: true, gear: ['staff'],
    cameras: ['follow'], objectives: ['activate', 'override', 'waves', 'eliminate', 'boss', 'barricade', 'reach', 'collect', 'extract'], requiredPools: ['world'],
    pointerLock: true, preset: { enemyCount: 4, behavior: 'guard', lives: 3 },
    controls: {
      keys: [FOLLOW_KEYS, 'Click to strike · E hold to interact · Esc pause'],
      touch: ['Left pad to run · Drag the world to turn the camera', 'STRIKE to swing the staff · JUMP · Hold USE to interact'],
      pad: 'Left stick run · Right stick camera · RT strike · A jump · B interact',
      buttons: ['use', 'jump', 'fire'], fire: 'STRIKE',
    },
  },
  arena: {
    id: 'arena', label: 'Arena shooter', description: 'From above: move with one hand, aim with the other, survive the waves.',
    platformLine: 'TOP-DOWN ARENA',
    weapons: true,
    cameras: ['overhead'], objectives: ['waves', 'survive', 'eliminate', 'boss', 'activate', 'reach', 'extract'], requiredPools: ['world', 'weapons'],
    pointerLock: false, preset: { enemyCount: 6, behavior: 'hunt', lives: 3 },
    controls: {
      keys: ['WASD move · The mouse aims · Hold click to fire', 'G fizz-bomb · R reload · E hold to interact · Esc pause'],
      touch: ['Left pad to move · Right pad to aim, and fire while held', 'RELOAD · GRENADE · Hold USE to interact'],
      pad: 'Left stick move · Right stick aim · RT fire · LB fizz-bomb · RB reload',
      buttons: ['weapon', 'grenade', 'reload', 'use', 'aimPad'],
    },
  },
  collect: {
    id: 'collect', label: 'Collect-a-thon', description: 'Third person: run and jump for every honey drop; land on a critter to bop it.',
    platformLine: '3D COLLECT-A-THON',
    weapons: false, stomp: true,
    cameras: ['follow'], objectives: ['collect', 'reach', 'activate', 'override', 'extract'], requiredPools: ['world'],
    pointerLock: true, preset: { enemyCount: 3, behavior: 'guard', lives: 3 },
    controls: {
      keys: [FOLLOW_KEYS, 'Land on a critter to bop it · E hold to interact · Esc pause'],
      touch: ['Left pad to run · Drag the world to turn the camera', 'JUMP, and land on critters · Hold USE to interact'],
      pad: 'Left stick run · Right stick camera · A jump · B interact',
      buttons: ['use', 'jump'],
    },
  },
};

export const GENRE_IDS = Object.keys(GENRES);
export const DEFAULT_GENRE = 'shooter';
/** Every perspective any genre plays from; `resolveProject` narrows it per genre. */
export const CAMERAS = ['first', 'follow', 'overhead'];

/** The genre of a project, defaulting to the shooter for documents that predate the field. */
export function genreOf(project) {
  return GENRES[project?.genre ?? DEFAULT_GENRE] ?? GENRES[DEFAULT_GENRE];
}

