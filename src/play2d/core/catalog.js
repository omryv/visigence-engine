/**
 * The level builder's vocabulary: genres, biomes, the terrain and decor tiles you paint, and
 * the entities you place. Data only: no DOM, no canvas, no three. The editor reads it for its
 * palette and inspector, the analyser for its constraints, the runtime for its rules and the
 * art for what to draw, so every one of them agrees on what a thing is.
 *
 * Tile CODES are saved in level files. Never renumber one; retire it instead.
 */

/** A genre is one set of rules over the shared grid. `view` decides how the grid is drawn. */
export const GENRES = [
  {
    id: 'platformer', name: 'Platformer', view: 'side',
    blurb: 'Run, jump and stomp through a side-on course to the shrine.',
    verbs: 'Run · Jump · Stomp · Climb',
    size: { width: 64, height: 24 }, minSize: { width: 16, height: 12 }, maxSize: { width: 200, height: 64 },
    wins: ['goal', 'collect', 'defeat'],
  },
  {
    id: 'adventure', name: 'Adventure', view: 'top',
    blurb: 'Explore a top-down world: keys, gates, chests and villagers with something to say.',
    verbs: 'Explore · Talk · Unlock · Push',
    size: { width: 40, height: 30 }, minSize: { width: 12, height: 10 }, maxSize: { width: 128, height: 96 },
    wins: ['goal', 'collect', 'defeat'],
  },
  {
    id: 'arena', name: 'Arena shooter', view: 'top',
    blurb: 'Twin-stick waves in a walled arena. Move with one hand, aim with the other.',
    verbs: 'Move · Aim · Shoot · Survive',
    size: { width: 32, height: 22 }, minSize: { width: 12, height: 10 }, maxSize: { width: 96, height: 72 },
    wins: ['waves', 'survive', 'defeat'],
  },
  {
    id: 'maze', name: 'Arcade maze', view: 'top',
    blurb: 'Eat every pollen dot while the bees give chase. Royal jelly turns the tables.',
    verbs: 'Steer · Eat · Evade · Chase',
    size: { width: 27, height: 21 }, minSize: { width: 9, height: 9 }, maxSize: { width: 63, height: 45 },
    wins: ['dots'],
  },
  {
    id: 'puzzle', name: 'Block puzzle', view: 'top',
    blurb: 'Push every crate onto a pad. Every level is checked by a solver before you ship it.',
    verbs: 'Push · Think · Undo · Solve',
    size: { width: 12, height: 10 }, minSize: { width: 5, height: 5 }, maxSize: { width: 32, height: 24 },
    wins: ['crates'],
  },
];

export const GENRE_IDS = GENRES.map(g => g.id);
export const genreById = id => GENRES.find(g => g.id === id) || null;
export const viewOf = genre => (genreById(genre)?.view || 'top');

/** Win rules, named for the objective line in the HUD. */
export const WIN_RULES = {
  goal:    { label: 'Reach the goal',        hud: 'Reach the shrine' },
  collect: { label: 'Collect every jar',     hud: 'Collect the honey jars' },
  defeat:  { label: 'Defeat every critter',  hud: 'Defeat the critters' },
  waves:   { label: 'Clear every wave',      hud: 'Clear the waves' },
  survive: { label: 'Survive the timer',     hud: 'Survive' },
  dots:    { label: 'Eat every pollen dot',  hud: 'Eat the pollen' },
  crates:  { label: 'Cover every pad',       hud: 'Push crates onto pads' },
};

/** The three Arcade biomes, the same ones the first-person villages are built in. */
export const BIOMES = [
  { id: 'meadow', name: 'Meadow', blurb: 'Grass, oaks, hedges and honey.' },
  { id: 'desert', name: 'Desert oasis', blurb: 'Sandstone, palms and cactus.' },
  { id: 'snow', name: 'Snow village', blurb: 'Snowdrifts, pines and ice.' },
];
export const BIOME_IDS = BIOMES.map(b => b.id);

/** Time of day tints the backdrop and, at night, lets an adventure level go dark. */
export const TIMES = [
  { id: 'day', name: 'Day' },
  { id: 'golden', name: 'Golden hour' },
  { id: 'night', name: 'Night' },
];
export const TIME_IDS = TIMES.map(t => t.id);

/** Key, lock and door colours. Named for the Visigame palette's warm, cold and rose lights. */
export const KEY_COLORS = [
  { id: 'amber', name: 'Amber' },
  { id: 'ice', name: 'Ice' },
  { id: 'rose', name: 'Rose' },
];
export const KEY_COLOR_IDS = KEY_COLORS.map(k => k.id);

/**
 * Terrain tiles. `solid` blocks bodies; `oneway` only from above (side view); `hazard` hurts;
 * `liquid` is swum through (side) or blocks walking but not shots (top: `blocksWalk`);
 * `floor` marks a walkable top-down floor variant. `autotile` means the art reads neighbours.
 */
export const TILES = [
  // ---- side view (platformer) ----
  { code: 1,  id: 'ground',   name: 'Ground',        view: 'side', genres: ['platformer'], category: 'Ground', solid: true, autotile: true, key: '1', hint: 'Solid earth. Grass grows on any open top.' },
  { code: 2,  id: 'brick',    name: 'Stone block',   view: 'side', genres: ['platformer'], category: 'Ground', solid: true, autotile: true, hint: 'A solid dressed-stone block.' },
  { code: 3,  id: 'plank',    name: 'Plank ledge',   view: 'side', genres: ['platformer'], category: 'Platforms', oneway: true, autotile: true, key: '2', hint: 'Stand on it from above; jump up through it. Hold down and jump to drop.' },
  { code: 4,  id: 'iceblock', name: 'Ice block',     view: 'side', genres: ['platformer'], category: 'Ground', solid: true, slippery: true, autotile: true, hint: 'Solid and slippery underfoot.' },
  { code: 5,  id: 'crumble',  name: 'Crumble block', view: 'side', genres: ['platformer'], category: 'Platforms', solid: true, crumble: true, hint: 'Gives way half a second after you land on it, and grows back.' },
  { code: 6,  id: 'thorns',   name: 'Thorns',        view: 'side', genres: ['platformer'], category: 'Hazards', hazard: true, autotile: true, key: '3', hint: 'Hurts on touch. Grows from whatever solid it sits against.' },
  { code: 7,  id: 'ladder',   name: 'Vine ladder',   view: 'side', genres: ['platformer'], category: 'Platforms', climb: true, autotile: true, hint: 'Hold up or down to climb.' },
  { code: 8,  id: 'water',    name: 'Water',         view: 'side', genres: ['platformer'], category: 'Hazards', liquid: true, autotile: true, hint: 'Swim: slow fall, press jump to paddle up.' },
  { code: 9,  id: 'blockA',   name: 'Amber block',   view: 'side', genres: ['platformer'], category: 'Switch blocks', solid: true, toggle: 'A', hint: 'Solid until a colour switch is hit; then it turns to outline.' },
  { code: 10, id: 'blockB',   name: 'Ice-blue block', view: 'side', genres: ['platformer'], category: 'Switch blocks', solid: true, toggle: 'B', hint: 'Outline until a colour switch is hit; then it turns solid.' },
  // ---- top view (adventure, arena, maze, puzzle) ----
  { code: 20, id: 'wall',     name: 'Wall',          view: 'top', genres: ['adventure', 'arena', 'maze', 'puzzle'], category: 'Walls', solid: true, autotile: true, key: '1', hint: 'Hedge, sandstone or packed snow, by biome.' },
  { code: 21, id: 'path',     name: 'Path',          view: 'top', genres: ['adventure', 'arena', 'maze', 'puzzle'], category: 'Floors', floor: true, autotile: true, key: '2', hint: 'A walkable path. In a maze, a floor with no pollen.' },
  { code: 22, id: 'pond',     name: 'Pond',          view: 'top', genres: ['adventure', 'arena'], category: 'Water', liquid: true, blocksWalk: true, autotile: true, hint: 'Blocks walking. Shots fly over it.' },
  { code: 23, id: 'bridge',   name: 'Bridge',        view: 'top', genres: ['adventure', 'arena'], category: 'Water', floor: true, autotile: true, hint: 'Walkable planks over a pond.' },
  { code: 24, id: 'bush',     name: 'Bush',          view: 'top', genres: ['adventure', 'arena'], category: 'Walls', solid: true, breakable: true, hint: 'Solid. Shots break it in the arena.' },
  { code: 25, id: 'icefloor', name: 'Ice floor',     view: 'top', genres: ['adventure', 'puzzle'], category: 'Floors', floor: true, slippery: true, autotile: true, hint: 'Slide until something stops you.' },
  { code: 26, id: 'pit',      name: 'Pit',           view: 'top', genres: ['adventure', 'puzzle'], category: 'Hazards', pit: true, autotile: true, hint: 'Falling in costs a heart. A pushed crate fills it.' },
  { code: 27, id: 'pad',      name: 'Crate pad',     view: 'top', genres: ['puzzle'], category: 'Floors', floor: true, pad: true, key: '3', hint: 'Cover every pad with a crate to win.' },
  { code: 28, id: 'gate',     name: 'Hive gate',     view: 'top', genres: ['maze'], category: 'Walls', beeOnly: true, hint: 'Bees pass through; you cannot.' },
  { code: 29, id: 'tallgrass', name: 'Tall grass',   view: 'top', genres: ['adventure', 'arena'], category: 'Floors', floor: true, hint: 'Walkable. Rustles as you pass.' },
];

/** Decor never collides. It is painted on its own layer, behind entities. */
export const DECOR = [
  { code: 50, id: 'flower',   name: 'Flowers',     views: ['side', 'top'], category: 'Plants', hint: 'By biome: flowers, desert blooms or snowdrops.' },
  { code: 51, id: 'tuft',     name: 'Grass tuft',  views: ['side', 'top'], category: 'Plants' },
  { code: 52, id: 'rock',     name: 'Rock',        views: ['side', 'top'], category: 'Scenery' },
  { code: 53, id: 'mushroom', name: 'Mushrooms',   views: ['side', 'top'], category: 'Plants' },
  { code: 54, id: 'fence',    name: 'Fence',       views: ['side', 'top'], category: 'Scenery', autotile: true },
  { code: 55, id: 'tree',     name: 'Tree',        views: ['side', 'top'], category: 'Plants', big: true, hint: 'Oak, palm or pine by biome. Drawn larger than its cell.' },
  { code: 56, id: 'shrub',    name: 'Shrub',       views: ['side', 'top'], category: 'Plants' },
  { code: 57, id: 'lamp',     name: 'Lamp post',   views: ['side', 'top'], category: 'Scenery', big: true },
  { code: 58, id: 'cottage',  name: 'Cottage',     views: ['side', 'top'], category: 'Scenery', big: true, hint: 'A village house, anchored at its bottom-left cell.' },
  { code: 59, id: 'cloud',    name: 'Cloud',       views: ['side'], category: 'Sky', big: true },
  { code: 60, id: 'barrel',   name: 'Barrel',      views: ['side', 'top'], category: 'Scenery' },
  { code: 61, id: 'crystal',  name: 'Crystal',     views: ['side', 'top'], category: 'Scenery' },
];

const ALL_GENRES = GENRE_IDS;
const P = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

/**
 * Entities. `w`/`h` is the footprint in cells from the anchor (top-left). `max` caps how many a
 * level may hold, `required` means a level is not playable without one. `linkSource` things
 * drive `linkTarget` things through wires; `props` are what the inspector edits, each with a
 * default. An enum option may carry `genres` to show only where it means something.
 */
export const ENTITIES = [
  // ---- core ----
  { type: 'player', name: 'Player start', category: 'Core', genres: ALL_GENRES, max: 1, required: true, key: 'P',
    hint: 'Where the hero begins. Exactly one per level.', props: [] },
  { type: 'goal', name: 'Goal shrine', category: 'Core', genres: ['platformer', 'adventure'], max: 4,
    hint: 'Touch it to finish the level when the win rule is "Reach the goal".', props: [] },
  { type: 'checkpoint', name: 'Lantern', category: 'Core', genres: ['platformer', 'adventure'], max: 16,
    hint: 'Touch to light it. You respawn at the last lantern you lit.', props: [] },
  { type: 'sign', name: 'Sign', category: 'Core', genres: ['platformer', 'adventure', 'puzzle'], max: 32,
    hint: 'Shows its message while you stand at it.',
    props: [P('text', 'Message', 'text', { max: 140, default: 'Hold jump to leap further.' })] },
  // ---- collectibles ----
  { type: 'coin', name: 'Honey drop', category: 'Pickups', genres: ['platformer', 'adventure', 'arena'], max: 400, score: 10,
    hint: 'Worth 10. Collect them all for a star.', props: [] },
  { type: 'gem', name: 'Honey jar', category: 'Pickups', genres: ['platformer', 'adventure', 'arena', 'maze'], max: 40, score: 100,
    hint: 'Worth 100. The "Collect every jar" rule counts these.', props: [] },
  { type: 'heart', name: 'Heart', category: 'Pickups', genres: ['platformer', 'adventure', 'arena'], max: 40,
    hint: 'Restores one heart.', props: [] },
  { type: 'key', name: 'Key', category: 'Pickups', genres: ['platformer', 'adventure', 'puzzle'], max: 24,
    hint: 'Opens one door of its colour.',
    props: [P('color', 'Colour', 'enum', { options: KEY_COLOR_IDS, default: 'amber' })] },
  { type: 'powerup', name: 'Fizz power', category: 'Pickups', genres: ['platformer', 'adventure', 'arena'], max: 16,
    hint: 'A timed power: wings, rapid fire, spread shot or a shield.',
    props: [
      P('kind', 'Power', 'enum', { options: ['wings', 'rapid', 'spread', 'shield'], default: 'shield',
        optionGenres: { wings: ['platformer'], rapid: ['arena', 'adventure'], spread: ['arena'], shield: ['platformer', 'adventure', 'arena'] } }),
      P('seconds', 'Lasts (s)', 'int', { min: 3, max: 60, step: 1, default: 10 }),
    ] },
  { type: 'power', name: 'Royal jelly', category: 'Pickups', genres: ['maze'], max: 8,
    hint: 'Bees flee and can be eaten for a few seconds.',
    props: [P('seconds', 'Lasts (s)', 'int', { min: 2, max: 20, step: 1, default: 7 })] },
  // ---- mechanisms ----
  { type: 'door', name: 'Gate', category: 'Mechanisms', genres: ['platformer', 'adventure', 'arena', 'puzzle'], max: 40, linkTarget: true,
    hint: 'Opens with a key of its colour, or when a wired lever, plate or burrow fires.',
    props: [
      P('lock', 'Lock', 'enum', { options: ['none', ...KEY_COLOR_IDS], default: 'amber' }),
      P('stayOpen', 'Stays open', 'bool', { default: true, help: 'Off: closes again when its wire turns off.' }),
    ] },
  { type: 'switch', name: 'Lever', category: 'Mechanisms', genres: ['platformer', 'adventure', 'arena'], max: 32, linkSource: true,
    hint: 'Press the action button at it. Wire it to gates, platforms, cannons or burrows.',
    props: [
      P('mode', 'Mode', 'enum', { options: ['toggle', 'once', 'timed'], default: 'once' }),
      P('seconds', 'Timer (s)', 'int', { min: 1, max: 60, step: 1, default: 8, showIf: { mode: 'timed' } }),
    ] },
  { type: 'plate', name: 'Pressure plate', category: 'Mechanisms', genres: ['adventure', 'puzzle'], max: 32, linkSource: true,
    hint: 'On while anything stands on it: you, a crate or a critter.', props: [] },
  { type: 'bswitch', name: 'Colour switch', category: 'Mechanisms', genres: ['platformer'], max: 16,
    hint: 'Hit from below or stomp it: amber and ice-blue blocks swap.', props: [] },
  { type: 'spring', name: 'Spring', category: 'Mechanisms', genres: ['platformer'], max: 40,
    hint: 'Launches you upward.',
    props: [P('power', 'Height (tiles)', 'int', { min: 3, max: 16, step: 1, default: 7 })] },
  { type: 'platform', name: 'Moving platform', category: 'Mechanisms', genres: ['platformer'], max: 32, linkTarget: true,
    hint: 'Carries you along a track. Wire it to a lever to run only while that lever is on.',
    props: [
      P('width', 'Width (tiles)', 'int', { min: 1, max: 5, step: 1, default: 3 }),
      P('axis', 'Track', 'enum', { options: ['x', 'y'], default: 'x', labels: { x: 'Horizontal', y: 'Vertical' } }),
      P('distance', 'Distance (tiles)', 'int', { min: 1, max: 16, step: 1, default: 5 }),
      P('speed', 'Speed (tiles/s)', 'float', { min: 0.5, max: 8, step: 0.5, default: 2.5 }),
    ] },
  { type: 'crate', name: 'Crate', category: 'Mechanisms', genres: ['adventure', 'arena', 'puzzle'], max: 64,
    hint: 'Push it by walking into it. In the arena it is cover that shots can break.', props: [] },
  { type: 'chest', name: 'Chest', category: 'Mechanisms', genres: ['adventure'], max: 24,
    hint: 'Open it with the action button.',
    props: [P('contains', 'Contains', 'enum', { options: ['coins', 'gem', 'heart', 'key-amber', 'key-ice', 'key-rose', 'powerup'], default: 'gem',
      labels: { coins: '5 honey drops', gem: 'Honey jar', heart: 'Heart', 'key-amber': 'Amber key', 'key-ice': 'Ice key', 'key-rose': 'Rose key', powerup: 'Shield power' } })] },
  { type: 'teleporter', name: 'Warp flower', category: 'Mechanisms', genres: ['adventure', 'maze', 'puzzle'], max: 16,
    hint: 'Step in to come out of the other flower on the same channel.',
    props: [P('channel', 'Channel', 'int', { min: 1, max: 4, step: 1, default: 1 })] },
  { type: 'npc', name: 'Villager', category: 'Core', genres: ['adventure'], max: 24,
    hint: 'Says something when you press the action button next to them.',
    props: [
      P('name', 'Name', 'text', { max: 24, default: 'Beekeeper' }),
      P('text', 'Says', 'text', { max: 140, default: 'The hives are restless. Mind the burrows.' }),
    ] },
  // ---- critters ----
  { type: 'slime', name: 'Slime', category: 'Critters', genres: ['platformer', 'adventure', 'arena'], max: 120, enemy: true, score: 50,
    hint: 'Patrols and turns at edges. Stomp it in a platformer.',
    props: [
      P('speed', 'Speed (tiles/s)', 'float', { min: 0.5, max: 6, step: 0.5, default: 1.5 }),
      P('hp', 'Hit points', 'int', { min: 1, max: 6, step: 1, default: 1 }),
      P('behavior', 'Behaviour', 'enum', { options: ['patrol', 'chase'], default: 'patrol', optionGenres: { chase: ['adventure', 'arena'] } }),
    ] },
  { type: 'bee', name: 'Bee', category: 'Critters', genres: ['platformer', 'adventure', 'arena', 'maze'], max: 60, enemy: true, score: 100,
    hint: 'Flies. Hovers along a track, chases when close, or hunts the maze by temperament.',
    props: [
      P('axis', 'Track', 'enum', { options: ['x', 'y', 'hover'], default: 'y', labels: { x: 'Horizontal', y: 'Vertical', hover: 'Hover' }, genres: ['platformer'] }),
      P('range', 'Range (tiles)', 'int', { min: 1, max: 12, step: 1, default: 3, genres: ['platformer'] }),
      P('radius', 'Sight (tiles)', 'int', { min: 2, max: 20, step: 1, default: 6, genres: ['adventure', 'arena'] }),
      P('temper', 'Temperament', 'enum', { options: ['hunter', 'ambusher', 'fickle', 'shy'], default: 'hunter', genres: ['maze'],
        labels: { hunter: 'Hunter: heads straight for you', ambusher: 'Ambusher: cuts you off', fickle: 'Fickle: flanks with the hunter', shy: 'Shy: chases, then loses nerve' } }),
      P('speed', 'Speed (tiles/s)', 'float', { min: 0.5, max: 8, step: 0.5, default: 2 }),
    ] },
  { type: 'spiky', name: 'Burr hedgehog', category: 'Critters', genres: ['platformer', 'adventure'], max: 60, enemy: true, score: 75,
    hint: 'Patrols like a slime, but its spines hurt stompers.',
    props: [P('speed', 'Speed (tiles/s)', 'float', { min: 0.5, max: 5, step: 0.5, default: 1 })] },
  { type: 'turret', name: 'Acorn cannon', category: 'Critters', genres: ['platformer', 'adventure', 'arena'], max: 32, enemy: true, linkTarget: true, score: 100,
    hint: 'Fires acorns in one direction on a beat. Wired to a lever, it fires only while the lever is on.',
    props: [
      P('dir', 'Aims', 'enum', { options: ['left', 'right', 'up', 'down', 'player'], default: 'left', labels: { player: 'At the player' } }),
      P('interval', 'Every (s)', 'float', { min: 0.5, max: 6, step: 0.25, default: 2 }),
      P('hp', 'Hit points', 'int', { min: 1, max: 12, step: 1, default: 3 }),
    ] },
  { type: 'spirit', name: 'Spirit', category: 'Critters', genres: ['adventure', 'arena'], max: 24, enemy: true, score: 150,
    hint: 'Drifts through walls toward you when it can see you.',
    props: [
      P('speed', 'Speed (tiles/s)', 'float', { min: 0.5, max: 5, step: 0.5, default: 1.5 }),
      P('hp', 'Hit points', 'int', { min: 1, max: 8, step: 1, default: 2 }),
    ] },
  { type: 'boss', name: 'King Slime', category: 'Critters', genres: ['platformer', 'arena'], max: 2, enemy: true, w: 2, h: 2, score: 1000,
    hint: 'Hops, slams and splits. Stomp it (platformer) or wear it down (arena).',
    props: [P('hp', 'Hit points', 'int', { min: 1, max: 60, step: 1, default: 3 })] },
  { type: 'spawner', name: 'Slime burrow', category: 'Critters', genres: ['arena', 'adventure'], max: 12, linkSource: true, linkTarget: true,
    hint: 'Releases waves of critters. Fires its wires once every wave is cleared.',
    props: [
      P('enemy', 'Releases', 'enum', { options: ['slime', 'bee', 'spiky', 'spirit'], default: 'slime', optionGenres: { spiky: ['adventure'] } }),
      P('waves', 'Waves', 'int', { min: 1, max: 12, step: 1, default: 3 }),
      P('perWave', 'Per wave', 'int', { min: 1, max: 16, step: 1, default: 4 }),
      P('gap', 'Spawn gap (s)', 'float', { min: 0.25, max: 5, step: 0.25, default: 0.75 }),
      P('rest', 'Rest between waves (s)', 'float', { min: 0, max: 20, step: 0.5, default: 3 }),
      P('delay', 'Starts after (s)', 'float', { min: 0, max: 60, step: 0.5, default: 1 }),
    ] },
];

export const ENTITY_TYPES = ENTITIES.map(e => e.type);
export const entityDef = type => ENTITIES.find(e => e.type === type) || null;
export const tileByCode = code => TILES.find(t => t.code === code) || null;
export const tileById = id => TILES.find(t => t.id === id) || null;
export const decorByCode = code => DECOR.find(d => d.code === code) || null;
export const decorById = id => DECOR.find(d => d.id === id) || null;

/** The palette a genre offers, in display order. */
export function tilesFor(genre) { return TILES.filter(t => t.genres.includes(genre)); }
export function decorFor(genre) { const v = viewOf(genre); return DECOR.filter(d => d.views.includes(v)); }
export function entitiesFor(genre) { return ENTITIES.filter(e => e.genres.includes(genre)); }

/** A prop applies to a genre unless it names others. */
export function propsFor(type, genre) {
  const def = entityDef(type);
  if (!def) return [];
  return def.props.filter(p => !p.genres || p.genres.includes(genre));
}
/** Enum options an entity prop offers in a genre. */
export function optionsFor(prop, genre) {
  if (!prop.options) return [];
  return prop.options.filter(o => !prop.optionGenres?.[o] || prop.optionGenres[o].includes(genre));
}
/** Default props for a new entity in a genre (only the props that apply there). */
export function defaultProps(type, genre) {
  const out = {};
  for (const p of propsFor(type, genre)) {
    let v = p.default;
    if (p.type === 'enum') { const opts = optionsFor(p, genre); if (!opts.includes(v)) v = opts[0]; }
    out[p.key] = v;
  }
  return out;
}
/** Footprint of an entity; the moving platform's width is a prop. */
export function footprint(entity) {
  const def = entityDef(entity.type);
  const w = entity.type === 'platform' ? Math.max(1, Math.min(5, entity.props?.width | 0 || 3)) : def?.w || 1;
  return { w, h: def?.h || 1 };
}

/** Link rules: which sources may drive which targets, per genre. */
export function canLink(fromEntity, toEntity) {
  const a = entityDef(fromEntity?.type), b = entityDef(toEntity?.type);
  if (!a?.linkSource || !b?.linkTarget || fromEntity.id === toEntity.id) return false;
  if (a.type === 'spawner' && b.type === 'spawner') return true; // a cleared burrow can wake the next
  return true;
}

/** Budgets the analyser enforces and the editor shows as meters. */
export const LIMITS = {
  entities: 600,
  enemies: 160,
  links: 120,
  levels: 24,
  textLength: 140,
  titleLength: 48,
};

/** Scoring shared by every genre, so a score means the same thing everywhere. */
export const SCORE = { coin: 10, gem: 100, enemy: 50, dot: 10, power: 50, beeEaten: 200, timeBonusPerSecond: 5, crate: 25 };
