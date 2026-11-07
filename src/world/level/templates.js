/**
 * THE TEMPLATE GAMES (the level editor's start screen, docs/EDITOR.md): one complete game per genre, three levels
 * each, every level made the way a creator makes one in the studio: a seeded village, a mission graph, and hand edits
 * on top (a fenced pen with a locked gate, a lever that wakes an ambush, painted spawn ground, honey to find).
 *
 * `templateGame(id)` returns the game as a creator would save it (project format 4), to open, play and remix. Every
 * level passes the live checks without an error and can be won (tools/test/test-level-templates.mjs). Data and pure
 * helpers only: no three, no DOM, nothing compiled here.
 */
import { worldMission } from '../missionCard.js';
import { GENRES } from '../../genres/registry.js';
import { LEVEL_KEYS } from './game.js';
import { emptyRegions, encodeRegions, regionIndex, REGION_HALF } from './regions.js';

/** A fence piece is this long along its own X axis; four make a pen's side. */
const FENCE = 2.46;

/**
 * A fenced pen four fence lengths square round (x, z), its gate in the south side (the +Z side, facing a player
 * coming from the start) opening by `lock`: a key colour, 'wired' to a lever or zone, or 'hold'.
 * @returns {object[]} the fence pieces and the gate, ids `<id>f0..` and `<id>g`
 */
export function pen(id, x, z, lock) {
  const h = FENCE * 2, out = [], at = [-1.5, -0.5, 0.5, 1.5].map(k => k * FENCE);
  const fence = (i, fx, fz, yaw) => out.push({ id: `${id}f${i}`, type: 'prop', x: round(fx), z: round(fz), yaw, props: { prop: 'fence' } });
  let i = 0;
  for (const a of at) fence(i++, x + a, z - h, 0);
  for (const a of at) fence(i++, x + h, z + a, Math.PI / 2);
  for (const a of at) fence(i++, x - h, z + a, Math.PI / 2);
  fence(i++, x - 1.5 * FENCE, z + h, 0); fence(i++, x + 1.5 * FENCE, z + h, 0);
  out.push({ id: `${id}g`, type: 'door', x: round(x), z: round(z + h), yaw: 0, props: { lock } });
  return out;
}
/** A group of critters: `count` of `kind`, guarding their spot or hunting the player. */
export const critters = (id, x, z, kind, count = 1, behavior = 'guard') => ({ id, type: 'enemy', x, z, yaw: 0, props: { kind, count, behavior } });
export const zone = (id, x, z, w = 6, d = 6) => ({ id, type: 'trigger', x, z, yaw: 0, props: { w, d } });
export const thing = (id, type, x, z, props = {}, yaw = 0) => ({ id, type, x, z, yaw, props });
export const prop = (id, name, x, z, yaw = 0, scale = 1) => ({ id, type: 'prop', x, z, yaw, scale, props: { prop: name } });
/** Painted ground: each rectangle [region code, x0, z0, x1, z1] in metres over the 80 m square, as the region text. */
export function regions(rects) {
  const cells = emptyRegions();
  for (const [code, x0, z0, x1, z1] of rects)
    for (let z = Math.max(-REGION_HALF, z0); z < Math.min(REGION_HALF, z1); z++)
      for (let x = Math.max(-REGION_HALF, x0); x < Math.min(REGION_HALF, x1); x++) cells[regionIndex(x, z)] = code;
  return encodeRegions(cells);
}
const round = v => Math.round(v * 100) / 100;

/**
 * One level: where it is (a world of the pack, a seed, a light), what it asks (steps: [id, objective, count,
 * duration]), who is there (a roster and how many the mission spawns), and what was built by hand.
 */
function level(genre, L) {
  const p = worldMission(L.world, L.seed, genre);
  const graph = p.blueprint;
  graph.nodes = graph.nodes.filter(n => n.kind !== 'objective');
  graph.edges = graph.edges.filter(e => !['start', 'complete'].includes(e.out));
  for (const [i, [id, objective, count, duration]] of L.steps.entries()) {
    graph.nodes.push({ id, kind: 'objective', objective, count, duration, x: 560, y: 30 + i * 150 });
    graph.edges.push({ from: i ? L.steps[i - 1][0] : 'generator', out: i ? 'complete' : 'start', to: id, input: 'start' });
  }
  graph.edges.push({ from: L.steps.at(-1)[0], out: 'complete', to: 'output', input: 'mission' });
  if (L.roster) graph.nodes.find(n => n.kind === 'enemies').items = [...L.roster];
  if (L.weapons) graph.nodes.find(n => n.kind === 'weapons').items = [...L.weapons];
  // A template's things were placed by hand on the village's own hills (its pens, gates and levers), so it keeps the
  // ground it was authored on; a mission card or a new project stands on its seed's world (world/kernelGround.js).
  const out = { ...p, ground: 'village', lighting: L.lighting ?? p.lighting, enemyCount: L.enemyCount ?? p.enemyCount, behavior: L.behavior ?? p.behavior,
    edits: { version: 1, start: L.start ?? null, entities: L.entities ?? [], overrides: L.overrides ?? {}, regions: L.regions ?? '', wires: L.wires ?? [] } };
  return { id: L.id, name: L.name, ...Object.fromEntries(LEVEL_KEYS.filter(k => out[k] !== undefined).map(k => [k, out[k]])), shared: out };
}

/** The five games. Each: its genre, a card (name, a line, the accent the card wears) and three levels. */
const TEMPLATE_SPECS = [
  {
    id: 'hive-patrol', genre: 'shooter', name: 'Shooter template', accent: '#ef9b50',
    tagline: 'Wake the stations, hold the gatehouse, bring down the King.',
    description: 'Three villages and a crossbow. An ambush waits by the second station, a lever wakes the gatehouse guard, and the King holds the snow yard behind an amber gate.',
    levels: [
      { id: 'l1', name: 'Station Run', world: 'arcade', seed: 'HVPA-TR01-MEAD', lighting: 'dawn', enemyCount: 3, behavior: 'guard',
        steps: [['stations', 'activate', 2, 1.5], ['clear', 'eliminate', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [zone('z1', 8, -14, 8, 6), critters('e1', 12, -22, 'bee', 3, 'hunt'), prop('c1', 'hayBarricade', -3.5, 18, 0.3), prop('c2', 'hayBarricade', 4, 12, -0.25), thing('h1', 'pickup', 2, 4, { kind: 'health' }), thing('a1', 'pickup', -2, -6, { kind: 'ammo' })],
        wires: [{ from: 'z1', to: 'e1' }] },
      { id: 'l2', name: 'Gatehouse', world: 'desert', seed: 'HVPA-TR02-DUNE', lighting: 'dawn', enemyCount: 4, behavior: 'hunt', roster: ['pebble', 'hornblob', 'bee'],
        steps: [['gates', 'override', 2, 2], ['hold', 'waves', 2, 1], ['extract', 'extract', 1, 1.5]],
        entities: [thing('v1', 'lever', -4, 6), critters('e1', -6, -10, 'hornblob', 2, 'hunt'), prop('b1', 'barrel', 3, 14), prop('b2', 'barrel', 4.2, 14.6), prop('b3', 'barrel', -3, -2), thing('a1', 'pickup', 1, 8, { kind: 'ammo' }), thing('g1', 'pickup', -1, 8, { kind: 'grenade' }), thing('h1', 'pickup', 0, -12, { kind: 'health' })],
        wires: [{ from: 'v1', to: 'e1' }] },
      { id: 'l3', name: 'The King’s Yard', world: 'snow', seed: 'HVPA-TR03-SNOW', lighting: 'night', enemyCount: 3, behavior: 'guard', roster: ['spirit', 'batpuff', 'king'],
        steps: [['king', 'boss', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [...pen('p', 0, -24, 'amber'), thing('k1', 'key', -12, 2, { color: 'amber' }), critters('e1', -12, -2, 'spirit', 2), thing('h1', 'pickup', 1.5, 13, { kind: 'health' }), thing('h2', 'pickup', 2, -14, { kind: 'health' })],
        overrides: { 'step:extract:0': { x: 0, z: -24 } } },
    ],
  },
  {
    id: 'lantern-survey', genre: 'exploration', name: 'Exploration template', accent: '#68cfdb',
    tagline: 'No weapons. Keys, levers and gates across three villages.',
    description: 'Survey the meadow, find the key that opens the oasis pen, and follow the lanterns through a snow village of nested gates.',
    levels: [
      { id: 'l1', name: 'Meadow Survey', world: 'arcade', seed: 'LNTN-SV01-MEAD', lighting: 'dawn', enemyCount: 2,
        steps: [['activate', 'activate', 1, 2], ['checkpoint', 'reach', 1, 1], ['extract', 'extract', 1, 2]],
        entities: [thing('c1', 'checkpoint', 0, 6), thing('d1', 'collectible', -2, 12), thing('d2', 'collectible', 2, 0), thing('d3', 'collectible', -1, -12)] },
      { id: 'l2', name: 'Oasis Keys', world: 'desert', seed: 'LNTN-SV02-DUNE', lighting: 'dawn', enemyCount: 2, roster: ['pebble', 'sprout'],
        steps: [['activate', 'activate', 1, 2], ['extract', 'extract', 1, 2]],
        entities: [...pen('p', 14, -22, 'ice'), thing('k1', 'key', -14, -6, { color: 'ice' }), thing('c1', 'checkpoint', 0, -6)],
        overrides: { 'step:extract:0': { x: 14, z: -22 } } },
      { id: 'l3', name: 'Night Lanterns', world: 'snow', seed: 'LNTN-SV03-SNOW', lighting: 'night', enemyCount: 2, roster: ['batpuff', 'acorn'],
        steps: [['activate', 'activate', 1, 2], ['extract', 'extract', 1, 2]],
        entities: [...pen('p', -14, -20, 'rose'), thing('k1', 'key', -14, -20, { color: 'ice' }), ...pen('q', 14, -20, 'ice'), thing('k2', 'key', 16, 10, { color: 'rose' }), thing('v1', 'lever', 0, 2), critters('e1', 4, -10, 'batpuff', 2)],
        overrides: { 'step:extract:0': { x: 14, z: -20 } }, wires: [{ from: 'v1', to: 'e1' }] },
    ],
  },
  {
    id: 'trail-warden', genre: 'action', name: 'Action adventure template', accent: '#9fd26b',
    tagline: 'A staff, three lives and a king at the end of the trail.',
    description: 'Wake the shrine and drive the critters out, open the dune pen with the key the hornblobs guard, then face the King in the snow.',
    levels: [
      { id: 'l1', name: 'Shrine Path', world: 'arcade', seed: 'TRLW-DN01-MEAD', lighting: 'dawn', enemyCount: 3,
        steps: [['shrine', 'activate', 1, 1.5], ['clear', 'eliminate', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [critters('e1', -8, 10, 'slime', 2), critters('e2', 10, -10, 'shroom', 2), thing('h1', 'pickup', 0, 0, { kind: 'health' })] },
      { id: 'l2', name: 'Dune Gate', world: 'desert', seed: 'TRLW-DN02-DUNE', lighting: 'dawn', enemyCount: 3, roster: ['pebble', 'hornblob'],
        steps: [['shrine', 'activate', 1, 1.5], ['extract', 'extract', 1, 1.5]],
        entities: [...pen('p', 12, -22, 'amber'), thing('k1', 'key', -14, -10, { color: 'amber' }), critters('e1', -12, -14, 'hornblob', 2), zone('z1', 0, -6, 10, 4), critters('e2', 4, -14, 'pebble', 3, 'hunt'), thing('c1', 'checkpoint', 0, 8), thing('h1', 'pickup', -1.5, 13, { kind: 'health' })],
        overrides: { 'step:shrine:0': { x: 12, z: -22 } }, wires: [{ from: 'z1', to: 'e2' }] },
      { id: 'l3', name: 'Frost Warden', world: 'snow', seed: 'TRLW-DN03-SNOW', lighting: 'night', enemyCount: 3, roster: ['spirit', 'acorn', 'king'],
        steps: [['king', 'boss', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [thing('c1', 'checkpoint', 0, 8), thing('h1', 'pickup', 2, 8, { kind: 'health' }), thing('h2', 'pickup', -2, -10, { kind: 'health' }), critters('e1', -10, 0, 'acorn', 2)] },
    ],
  },
  {
    id: 'honey-siege', genre: 'arena', name: 'Arena shooter template', accent: '#ff6257',
    tagline: 'Twin stick, three squares, the swarm from every lane.',
    description: 'Hold the meadow square against three waves, last a minute in the oasis, and bring down the King under the snow lanterns.',
    levels: [
      { id: 'l1', name: 'Square Siege', world: 'arcade', seed: 'HNSG-SQ01-MEAD', lighting: 'dawn', enemyCount: 6, behavior: 'hunt',
        steps: [['waves', 'waves', 3, 1], ['hold', 'survive', 1, 45], ['extract', 'extract', 1, 1.5]],
        entities: [prop('b1', 'barrel', -4, 10), prop('b2', 'barrel', 4, 10), prop('b3', 'barrel', -4, 2), prop('b4', 'barrel', 4, 2), thing('h1', 'pickup', 0, 6, { kind: 'health' }), thing('a1', 'pickup', 0, 14, { kind: 'ammo' })],
        // The swarm comes up the lanes: spawn ground painted at the four ends of the north and middle lanes.
        regions: regions([[1, -36, -21, -30, -15], [1, 30, -21, 36, -15], [1, -36, -2, -30, 4], [1, 30, -2, 36, 4]]) },
      { id: 'l2', name: 'Dune Hold', world: 'desert', seed: 'HNSG-SQ02-DUNE', lighting: 'dawn', enemyCount: 7, behavior: 'hunt', roster: ['pebble', 'hornblob', 'bee'],
        steps: [['hold', 'survive', 1, 60], ['clear', 'eliminate', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [prop('r1', 'rocks', -6, 6), prop('r2', 'rocks', 6, 6, Math.PI / 2), prop('r3', 'rocks', 0, -4), thing('h1', 'pickup', -3, 12, { kind: 'health' }), thing('h2', 'pickup', 3, -10, { kind: 'health' }), thing('g1', 'pickup', 0, 10, { kind: 'grenade' })],
        regions: regions([[1, -3, -38, 3, -32], [1, -36, -2, -30, 4], [1, 30, -2, 36, 4], [1, -36, 17, -30, 23], [1, 30, 17, 36, 23]]) },
      { id: 'l3', name: 'Night Swarm', world: 'snow', seed: 'HNSG-SQ03-SNOW', lighting: 'night', enemyCount: 6, behavior: 'hunt', roster: ['spirit', 'batpuff', 'king'],
        steps: [['waves', 'waves', 4, 1], ['king', 'boss', 1, 1], ['extract', 'extract', 1, 1.5]],
        entities: [prop('b1', 'hayBarricade', -5, 8, 0.4), prop('b2', 'hayBarricade', 5, 8, -0.4), thing('h1', 'pickup', 0, 12, { kind: 'health' }), thing('h2', 'pickup', 0, -8, { kind: 'health' }), thing('a1', 'pickup', 2, 12, { kind: 'ammo' })],
        regions: regions([[1, -3, -38, 3, -32], [1, -36, -21, -30, -15], [1, 30, -21, 36, -15]]) },
    ],
  },
  {
    id: 'honey-harvest', genre: 'collect', name: 'Collect-a-thon template', accent: '#f5c542',
    tagline: 'Run, jump, bop critters, gather every drop.',
    description: 'Twelve drops in the meadow, a lever-locked honey pen in the oasis, and a rose key between you and the way home in the snow.',
    levels: [
      { id: 'l1', name: 'Meadow Harvest', world: 'arcade', seed: 'HNHV-ST01-MEAD', lighting: 'dawn', enemyCount: 3,
        steps: [['harvest', 'collect', 12, 1], ['lookout', 'reach', 1, 1], ['extract', 'extract', 1, 1.5]] },
      { id: 'l2', name: 'Oasis Honey', world: 'desert', seed: 'HNHV-ST02-DUNE', lighting: 'dawn', enemyCount: 3, roster: ['pebble', 'sprout'],
        steps: [['harvest', 'collect', 16, 1], ['extract', 'extract', 1, 1.5]],
        entities: [...pen('p', -14, -18, 'wired'), thing('v1', 'lever', 10, -4), thing('d1', 'collectible', -16, -20), thing('d2', 'collectible', -12, -20), thing('d3', 'collectible', -16, -16), thing('d4', 'collectible', -12, -16), thing('c1', 'checkpoint', 0, 8)],
        wires: [{ from: 'v1', to: 'pg' }] },
      { id: 'l3', name: 'Frost Hunt', world: 'snow', seed: 'HNHV-ST03-SNOW', lighting: 'night', enemyCount: 4, roster: ['batpuff', 'acorn', 'spirit'],
        steps: [['harvest', 'collect', 20, 1], ['extract', 'extract', 1, 1.5]],
        entities: [...pen('p', 12, -22, 'rose'), thing('k1', 'key', -14, -18, { color: 'rose' }), critters('e1', -12, -14, 'spirit', 2), thing('c1', 'checkpoint', 0, 0)],
        overrides: { 'step:extract:0': { x: 12, z: -22 } } },
    ],
  },
];

/** The start screen's cards: what each template is, without building it. */
export const TEMPLATES = TEMPLATE_SPECS.map(({ levels, ...card }) => ({ ...card, levels: levels.map(l => ({ id: l.id, name: l.name, world: l.world })) }));
export const templateById = id => TEMPLATES.find(t => t.id === id) ?? null;
/**
 * What a copy of a template is called until its maker names it: templates are named by their genre, the same words
 * Play uses, so a copy starts as "My arena shooter game" rather than under a name every other copy shares.
 */
export function copyName(id) {
  const t = templateById(id);
  return `My ${(GENRES[t?.genre]?.label ?? 'arcade').toLowerCase()} game`;
}

/** A template as a game document: the game-wide choices of its first level, and its levels. */
export function templateGame(id) {
  const spec = TEMPLATE_SPECS.find(t => t.id === id);
  if (!spec) throw Error(`Unknown template ${id}`);
  const levels = spec.levels.map(L => level(spec.genre, L));
  const { shared } = levels[0];
  const game = Object.fromEntries(Object.entries(shared).filter(([k]) => !LEVEL_KEYS.includes(k)));
  return { ...game, name: spec.name, levels: levels.map(({ shared: _, ...l }) => l) };
}
