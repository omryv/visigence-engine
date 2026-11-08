/**
 * Levels authored as ASCII maps, so a template reads like the level it is. One character per
 * cell for the terrain and its entities, an optional second map for decor, and a legend that
 * can be extended per level for numbered parts that carry props, tags and wires.
 *
 *   fromAscii('platformer', {
 *     id: 'hh-1', name: 'Meadow run', biome: 'meadow', rules: { win: 'goal' },
 *     map: ['....', 'P..G', '####'],
 *     decor: ['....', '.f..', '....'],
 *     legend: { 1: { entity: 'switch', tag: 'lever' }, 2: { entity: 'door', props: { lock: 'none' }, tag: 'gate' } },
 *     links: [['lever', 'gate']],
 *   })
 *
 * Entity ids are derived from the level id and the order of appearance, so building a template
 * twice produces the same document byte for byte.
 */
import { tileById, decorById, entityDef, viewOf } from '../core/catalog.js';

/** Characters every side-view (platformer) map understands. */
export const SIDE_LEGEND = {
  '.': null, ' ': null,
  '#': 'ground', 'B': 'brick', '=': 'plank', 'I': 'iceblock', 'C': 'crumble', '^': 'thorns', 'H': 'ladder', '~': 'water', 'a': 'blockA', 'b': 'blockB',
  'P': { entity: 'player' }, 'G': { entity: 'goal' }, 'o': { entity: 'coin' }, 'J': { entity: 'gem' }, 'h': { entity: 'heart' },
  'k': { entity: 'key', props: { color: 'amber' } }, 'D': { entity: 'door', props: { lock: 'amber' } },
  'X': { entity: 'bswitch' }, 'S': { entity: 'spring' }, 's': { entity: 'slime' }, 'z': { entity: 'bee' }, 'x': { entity: 'spiky' },
  'T': { entity: 'turret' }, 'K': { entity: 'boss' }, 'c': { entity: 'checkpoint' }, 'w': { entity: 'powerup', props: { kind: 'wings', seconds: 12 } },
};
/** Characters every top-view map understands. */
export const TOP_LEGEND = {
  '.': null, ' ': null,
  '#': 'wall', '-': 'path', '~': 'pond', '=': 'bridge', 'b': 'bush', 'i': 'icefloor', 'O': 'pit', '_': 'pad', 'g': 'gate', ',': 'tallgrass',
  'P': { entity: 'player' }, 'G': { entity: 'goal' }, 'o': { entity: 'coin' }, 'J': { entity: 'gem' }, 'h': { entity: 'heart' },
  'k': { entity: 'key', props: { color: 'amber' } }, 'D': { entity: 'door', props: { lock: 'amber' } },
  'C': { entity: 'crate' }, 'Q': { entity: 'chest' }, 'N': { entity: 'npc' }, 'W': { entity: 'teleporter' }, 'Z': { entity: 'spawner' },
  'p': { entity: 'plate' }, 's': { entity: 'slime' }, 'z': { entity: 'bee' }, 'x': { entity: 'spiky' }, 'T': { entity: 'turret' },
  'A': { entity: 'spirit' }, 'K': { entity: 'boss' }, 'c': { entity: 'checkpoint' }, 'j': { entity: 'power' }, 'L': { entity: 'switch' },
  '*': { entity: 'crate', tile: 'pad' },
};
/** Decor characters, the same in both views. */
export const DECOR_LEGEND = {
  '.': null, ' ': null,
  'f': 'flower', 'g': 'tuft', 'r': 'rock', 'm': 'mushroom', 'n': 'fence', 't': 'tree', 'u': 'shrub', 'l': 'lamp', 'h': 'cottage', 'q': 'cloud', 'e': 'barrel', 'y': 'crystal',
};

export function fromAscii(genre, spec) {
  const view = viewOf(genre);
  const rows = spec.map;
  const height = rows.length;
  const width = Math.max(...rows.map(r => r.length));
  const legend = { ...(view === 'side' ? SIDE_LEGEND : TOP_LEGEND), ...(spec.legend || {}) };
  const terrain = new Array(width * height).fill(0);
  const decor = new Array(width * height).fill(0);
  const entities = [];
  const tags = new Map();
  const id = spec.id || 'lvl';
  let n = 0;
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? '.';
      if (!(ch in legend)) throw new Error(`${id}: no legend entry for "${ch}" at ${x},${y}`);
      const entry = legend[ch];
      if (!entry) continue;
      const put = tileId => {
        const t = tileById(tileId);
        if (!t) throw new Error(`${id}: unknown tile "${tileId}"`);
        terrain[y * width + x] = t.code;
      };
      if (typeof entry === 'string') { put(entry); continue; }
      if (entry.tile) put(entry.tile);
      if (entry.entity) {
        if (!entityDef(entry.entity)) throw new Error(`${id}: unknown entity "${entry.entity}"`);
        const e = { id: `${id}-${entry.entity}-${n++}`, type: entry.entity, x, y, props: { ...(entry.props || {}) } };
        entities.push(e);
        if (entry.tag) {
          if (tags.has(entry.tag)) throw new Error(`${id}: tag "${entry.tag}" used twice`);
          tags.set(entry.tag, e);
        }
      }
    }
  }
  if (spec.decor) {
    spec.decor.forEach((row, y) => [...row].forEach((ch, x) => {
      if (!(ch in DECOR_LEGEND)) throw new Error(`${id}: no decor legend entry for "${ch}" at ${x},${y}`);
      const d = DECOR_LEGEND[ch];
      if (d && y < height && x < width) decor[y * width + x] = decorById(d).code;
    }));
  }
  const links = (spec.links || []).map(([a, b]) => {
    const from = tags.get(a), to = tags.get(b);
    if (!from || !to) throw new Error(`${id}: wire ${a} -> ${b} names a missing tag`);
    return { from: from.id, to: to.id };
  });
  return {
    id, name: spec.name, width, height,
    biome: spec.biome || 'meadow', time: spec.time || 'day',
    rules: { ...(spec.rules || {}) },
    terrain, decor, entities, links, notes: spec.notes || '',
  };
}
