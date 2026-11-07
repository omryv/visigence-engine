/**
 * THE THINGS A CREATOR PLACES BY HAND in a 3D level (docs/EDITOR.md).
 *
 * The generator lays out the village, the mission pads, the gates and the cover from the seed and the graph;
 * everything in this table is what the level editor adds on top: a player start, enemies where you want them,
 * supplies, keys and the doors they open, levers, trigger zones, checkpoints, collectibles and props. DATA ONLY:
 * no three, no DOM. The edit layer normalizes against it, the compiler turns records into placements, the checks
 * read its rules, the runtime's level script plays it, and the studio draws its palette and inspector from it.
 *
 * `clear` is the radius, in metres, of village clutter (trees, rocks, flowers, fences) a placed thing clears from
 * its spot once the village is laid out. A placed thing never feeds the village generator itself: the generator
 * picks its landmarks' hills by a global search, so one levelled pad can re-plan the whole map (docs/EDITOR.md).
 * Houses and landmarks are never cleared; the checks flag a placed thing that stands in one.
 *
 * `wireOut` types drive what they are wired to; `wireIn` types can be driven (WIRES).
 */

/** Key, lock and door colours. */
export const KEY_COLORS = ['amber', 'ice', 'rose'];

/** Outliner layers, in the order the panel lists them. */
export const ENTITY_GROUPS = {
  player: { label: 'Player' },
  enemies: { label: 'Enemies' },
  items: { label: 'Items' },
  logic: { label: 'Logic' },
  props: { label: 'Props' },
};

/** The props a creator may place, by catalogue prop id. Houses and trees are grown from a plan the id seeds. */
export const PLACEABLE_PROPS = ['barrel', 'rocks', 'fence', 'hayBarricade', 'house', 'tree', 'nature'];

/**
 * Each prop field: `enum` (values), `int`/`num` (min, max, step), `enemy` (a catalogue enemy id), `prop` (one of
 * PLACEABLE_PROPS) or `variant` (a house family, a tree species or a nature part, checked against the level's pack).
 */
export const ENTITY_TYPES = {
  enemy: {
    label: 'Enemy', group: 'enemies', icon: 'enemy', clear: 0, radius: 0.5, limit: 48, wireIn: true,
    hint: 'A critter from the roster. Wired to a lever or a trigger zone, it waits unseen until that fires.',
    props: {
      kind: { type: 'enemy', default: 'slime', label: 'Critter' },
      count: { type: 'int', min: 1, max: 6, default: 1, label: 'How many' },
      behavior: { type: 'enum', values: ['guard', 'hunt'], default: 'guard', label: 'Behaviour' },
    },
  },
  pickup: {
    label: 'Supply', group: 'items', icon: 'heart', clear: 0.8, radius: 0.6, limit: 24,
    hint: 'Restores health, pebbles or fizz-bombs once per run.',
    props: { kind: { type: 'enum', values: ['health', 'ammo', 'grenade'], default: 'health', label: 'Supply' } },
  },
  key: {
    label: 'Key', group: 'items', icon: 'key', clear: 0.8, radius: 0.6, limit: 9, model: 'keyAmber',
    hint: 'Opens every door locked with its colour.',
    props: { color: { type: 'enum', values: KEY_COLORS, default: 'amber', label: 'Colour' } },
  },
  collectible: {
    label: 'Honey drop', group: 'items', icon: 'drop', clear: 0.6, radius: 0.5, limit: 60, model: 'honeyDrop',
    hint: 'A collect step counts these.',
    props: {},
  },
  door: {
    label: 'Door', group: 'logic', icon: 'door', clear: 2.6, radius: 2.4, limit: 12, wireIn: true, model: 'woodGate',
    hint: 'Hold to open, open with a key of its colour, or open when a wired lever or zone fires.',
    props: { lock: { type: 'enum', values: ['hold', ...KEY_COLORS, 'wired'], default: 'hold', label: 'Opens by' } },
  },
  lever: {
    label: 'Lever', group: 'logic', icon: 'lever', clear: 1.2, radius: 1, limit: 12, wireOut: true, model: 'lever',
    hint: 'Hold to pull. Opens wired doors and wakes wired enemies.',
    props: {},
  },
  trigger: {
    label: 'Trigger zone', group: 'logic', icon: 'zone', clear: 0, radius: 0, limit: 16, wireOut: true,
    hint: 'Fires once when the player walks in. Invisible in play.',
    props: {
      w: { type: 'num', min: 1, max: 24, step: 0.5, default: 6, label: 'Width' },
      d: { type: 'num', min: 1, max: 24, step: 0.5, default: 6, label: 'Depth' },
    },
  },
  checkpoint: {
    label: 'Checkpoint', group: 'logic', icon: 'flag', clear: 1.8, radius: 1.6, limit: 8,
    hint: 'Walk through it to respawn here after a fall.',
    props: {},
  },
  prop: {
    label: 'Prop', group: 'props', icon: 'cube', clear: null, radius: 1, limit: 160, scalable: true,
    hint: 'Scenery and cover. Solid props block shots and paths.',
    props: {
      prop: { type: 'prop', default: 'barrel', label: 'Prop' },
      variant: { type: 'variant', default: '', label: 'Variant' },
    },
  },
};
export const ENTITY_TYPE_IDS = Object.keys(ENTITY_TYPES);

/** What drives what. A wire always runs from a `wireOut` type to a `wireIn` type. */
export const WIRES = { lever: ['door', 'enemy'], trigger: ['door', 'enemy'] };
export function canWire(fromType, toType) { return !!WIRES[fromType]?.includes(toType); }

/** Uniform scale bounds for scalable types (props). Collision footprints scale with it. */
export const SCALE_RANGE = [0.5, 2];

/** Everything a hand-built level may hold, per level: sized for phones (see checks.js for the draw budget). */
export const EDIT_LIMITS = { entities: 200, wires: 120, overrides: 400 };

/** The playable square: the meadow is 80 m across and the nav grid keeps a three-cell rim. */
export const WORLD_HALF = 38;

export function defaultProps(type) {
  const def = ENTITY_TYPES[type];
  return Object.fromEntries(Object.entries(def?.props ?? {}).map(([k, f]) => [k, f.default]));
}
