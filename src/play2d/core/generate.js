/**
 * Levels made to order, and proven before anyone sees them.
 *
 *   generateLevels('puzzle', { count: 8, biome: 'snow', from: 0.2, to: 0.9, seed: 'frost-7' })
 *
 * Each genre has a generator driven by a seeded random stream and a difficulty knob. Every
 * candidate it makes goes through the same checks the editor shows (core/analyze.js: the jump
 * arcs of a side-on course, keys for every gate, a bee that can leave its hive, budgets, wiring)
 * and, for block puzzles, the breadth-first solver; a candidate with a single error or warning is
 * thrown away, never repaired by hand. What survives is scored for difficulty from what it
 * contains and how it plays (the widest gap and the critters per screen of a course, the gates
 * between start and shrine, the length of a puzzle's shortest solution), and `count` of them are
 * picked to climb evenly from `from` to `to`.
 *
 * Block puzzles are built backwards: crates start on their pads and the player PULLS them away,
 * so every puzzle is solvable by construction; the forward solver then measures the shortest
 * solution, which becomes its par.
 *
 * Pure and deterministic: no DOM, no clock, no Math.random. The same genre, options and seed give
 * the same levels, byte for byte.
 */
import { analyzeLevel, solvePuzzle } from './analyze.js';
import { genreById, BIOME_IDS, GENRE_IDS, defaultProps } from './catalog.js';
import { defaultRules, normalizeProps, DEFAULT_SETTINGS } from './format.js';

export const GENERATE_MAX = 12;

/**
 * The version of what the generator makes, stamped into every generated level's notes (see
 * generatorStamp). The promise is "the same genre, options and seed give the same levels", and a
 * seed shared today should still mean something tomorrow, so BUMP THIS whenever a change alters
 * the output for any seed: a new maker step, a different random draw, other scoring or picking,
 * a check that now rejects a candidate it used to keep (and so changes which ones survive), even
 * different names or notes. tools/test/test-builder-generate.mjs pins a fingerprint of the output
 * for a fixed seed to this number and fails when one changes without the other. Changes that
 * leave every seed's levels byte for byte the same (speed, comments) do not bump it.
 */
export const GENERATOR_VERSION = 1;

/**
 * Read the stamp generateLevels writes at the start of a level's notes:
 * `Generated (<genre>, seed <seed>, generator v<n>): …`. Returns null for notes without one
 * (a hand-made level, or one generated before the version was recorded). The seed is written
 * as typed, so a seed that itself contains `, generator v<n>):` reads back cut short there, with
 * that number as the version; the dialog's seeds are free text, and this edge case is accepted.
 * @param {string} notes
 * @returns {{genre: string, seed: string, version: number} | null}
 */
export function generatorStamp(notes) {
  const m = /^Generated \((\w+), seed (.*?), generator v(\d+)\):/.exec(String(notes || ''));
  return m ? { genre: m[1], seed: m[2], version: +m[3] } : null;
}

/**
 * Read the value of a `#generate=` link: `<genre>` (a random seed) or `<genre>:<seed>`, the seed
 * being everything after the first colon (so it may hold colons itself), trimmed and cut to the
 * dialog's 40 characters. URLSearchParams has already percent-decoded it. Returns null for a
 * genre the builder does not know.
 * @param {string|null} value
 * @returns {{genre: string, seed: string|null} | null}
 */
export function parseGenerateLink(value) {
  const v = String(value ?? '');
  const at = v.indexOf(':');
  const genre = (at < 0 ? v : v.slice(0, at)).trim();
  if (!GENRE_IDS.includes(genre)) return null;
  const seed = at < 0 ? '' : v.slice(at + 1).trim().slice(0, 40);
  return { genre, seed: seed || null };
}

// terrain and decor codes (core/catalog.js)
const GROUND = 1, PLANK = 3, CRUMBLE = 5, THORNS = 6, LADDER = 7;
const WALL = 20, PATH = 21, POND = 22, BRIDGE = 23, BUSH = 24, PAD = 27, GATE = 28, TALLGRASS = 29;
const FLOWER = 50, TUFT = 51, ROCK = 52, MUSHROOM = 53, FENCE = 54, TREE = 55, SHRUB = 56, LAMP = 57, COTTAGE = 58, CLOUD = 59, BARREL = 60, CRYSTAL = 61;
const TOP_FLOOR = new Set([0, PATH, BRIDGE, TALLGRASS, PAD]);

// ------------------------------------------------------------------ randomness
function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function random(seed) {
  let a = hashString(String(seed)) | 0;
  const next = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const R = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    shuffle: list => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; },
    /** Pick from [[value, weight], ...]; weights of 0 never win. */
    weighted: pairs => { const total = pairs.reduce((n, [, w]) => n + Math.max(0, w), 0); let r = next() * total; for (const [v, w] of pairs) { if (w <= 0) continue; if ((r -= w) < 0) return v; } return pairs.find(([, w]) => w > 0)[0]; },
  };
  return R;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);
const round2 = v => Math.round(v * 4) / 4;

// ------------------------------------------------------------------ a level under construction
function canvas(genre, id, width, height) {
  const T = new Uint16Array(width * height), D = new Uint16Array(width * height);
  const entities = [], links = [];
  let n = 0;
  const L = {
    genre, id, width, height, T, D, entities, links,
    inside: (x, y) => x >= 0 && y >= 0 && x < width && y < height,
    tile: (x, y) => (L.inside(x, y) ? T[y * width + x] : -1),
    set: (x, y, c) => { if (L.inside(x, y)) T[y * width + x] = c; },
    fill: (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) L.set(x, y, c); },
    decor: (x, y, c) => { if (L.inside(x, y) && !L.entityAt(x, y)) D[y * width + x] = c; },
    // props go through the file format's own normaliser (steps, ranges, options), so a generated
    // level is exactly what saving and reopening it gives
    put: (type, x, y, props = {}) => { const e = { id: `${id}-${type}-${n++}`, type, x, y, props: normalizeProps(type, genre, { ...defaultProps(type, genre), ...props }) }; entities.push(e); return e; },
    entityAt: (x, y) => entities.find(e => e.x === x && e.y === y) || null,
    wire: (a, b) => links.push({ from: a.id, to: b.id }),
  };
  return L;
}
function finish(L, extra) {
  return {
    id: L.id, name: extra.name, width: L.width, height: L.height, biome: extra.biome, time: extra.time || 'day',
    rules: { ...defaultRules(L.genre), ...(extra.rules || {}) },
    terrain: L.T, decor: L.D, entities: L.entities, links: L.links, notes: extra.notes || '',
  };
}

// ------------------------------------------------------------------ names
const WORDS = {
  meadow: ['Clover', 'Bluebell', 'Thistle', 'Willow', 'Bramble', 'Acorn', 'Buttercup', 'Hazel', 'Foxglove', 'Primrose', 'Mossy', 'Honeysuckle'],
  desert: ['Dune', 'Saffron', 'Mirage', 'Cactus', 'Amber', 'Oasis', 'Sandstone', 'Palm', 'Scorpion', 'Sirocco', 'Copper', 'Date'],
  snow: ['Frost', 'Pine', 'Snowdrop', 'Icicle', 'Winter', 'Glacier', 'Birch', 'Aurora', 'Sleet', 'Hoarfrost', 'Fir', 'Ptarmigan'],
};
const NOUNS = {
  platformer: ['run', 'hop', 'climb', 'dash', 'leap', 'trail', 'ridge', 'bluff', 'crossing', 'steps'],
  adventure: ['hollow', 'grove', 'glade', 'ruins', 'village', 'hamlet', 'garden', 'green', 'crossroads', 'orchard'],
  arena: ['field', 'ring', 'court', 'pit', 'yard', 'clearing', 'bastion', 'square', 'stand', 'siege'],
  maze: ['hive', 'comb', 'warren', 'hedge', 'labyrinth', 'burrow', 'cells', 'knot', 'tangle', 'rows'],
  puzzle: ['yard', 'shed', 'patch', 'cellar', 'corner', 'store', 'loft', 'barn', 'pantry', 'shelf'],
};

// ------------------------------------------------------------------ platformer
function makePlatformer(R, d, o) {
  const W = o.width || clamp(Math.round(64 + 44 * d + R.int(0, 8)), 40, 180);
  const H = o.height || 20;
  const L = canvas('platformer', o.id, W, H);
  const surf = new Int16Array(W).fill(-1);     // the surface row of each column; -1 is a pit
  const thorn = new Uint8Array(W), crumble = new Uint8Array(W);
  const minS = 7, maxS = H - 3;
  let s = H - 5, x = 0;
  const gapMax = 2 + Math.round(2 * d);
  const upMax = d < 0.35 ? 1 : d < 0.7 ? 2 : 3;
  const enemyRate = 0.12 + 0.55 * d;
  const flats = [];
  const flat = len => { const x0 = x; for (let i = 0; i < len && x < W; i++) surf[x++] = s; if (x - x0 >= 3) flats.push({ x0, x1: x - 1, s }); return x0; };
  const speed = (lo, hi) => round2(lo + (hi - lo) * d);

  flat(8);
  L.put('player', 2, s - 1);
  let lantern = W < 70;
  const end = W - 11;
  while (x < end) {
    const room = end - x;
    const kind = R.weighted([
      ['flat', 3], ['up', 1.4], ['down', 1.1], ['gap', 1.5 + 2 * d],
      ['ledges', d > 0.25 && room > 14 ? 0.7 + d : 0],
      ['thorns', d > 0.3 ? 0.5 + d : 0],
      ['crumble', d > 0.5 && room > 9 ? 0.3 + d : 0],
      ['spring', d > 0.35 && room > 10 && s - 6 >= minS ? 0.5 : 0],
      ['ladder', room > 10 && s - 5 >= minS ? 0.35 : 0],
    ]);
    if (kind === 'flat') {
      const len = R.int(4, 7), x0 = flat(len);
      if (len >= 5 && R.chance(enemyRate)) {
        const spiky = d > 0.6 && R.chance(0.35);
        L.put(spiky ? 'spiky' : 'slime', x0 + (len >> 1), s - 1, spiky ? { speed: speed(0.8, 1.6) } : { speed: speed(1, 2.5) });
      } else if (R.chance(0.55)) {
        for (let i = 1; i < len - 1; i++) L.put('coin', x0 + i, s - 2);
      }
      if (d > 0.4 && len >= 5 && R.chance(0.3)) L.put('bee', x0 + (len >> 1), s - 4, { axis: 'y', range: 1, speed: speed(1.5, 2.5) });
      if (d > 0.75 && len >= 6 && R.chance(0.35)) L.put('turret', x0 + len - 1, s - 1, { dir: 'left', interval: round2(2.6 - d), hp: 3 });
      if (!lantern && x > W * 0.45) { L.put('checkpoint', x0 + 1, s - 1); lantern = true; }
    } else if (kind === 'up' || kind === 'down') {
      const dh = kind === 'up' ? -R.int(1, upMax) : R.int(1, 3);
      s = clamp(s + dh, minS, maxS);
      flat(R.int(3, 5));
    } else if (kind === 'gap') {
      const g = R.int(2, gapMax), from = s, x0 = x;
      for (let i = 0; i < g; i++) surf[x++] = -1;
      for (let i = 0; i < g; i++) L.put('coin', x0 + i, from - 2 - (i > 0 && i < g - 1 ? 1 : 0));
      s = clamp(s + (g <= 3 ? R.int(-1, 1) : R.int(0, 1)), minS, maxS);
      flat(R.int(3, 5));
    } else if (kind === 'ledges') {
      const span = R.int(8, 11), x0 = x;
      for (let i = 0; i < span; i++) surf[x++] = -1;
      let p = x0 + 1, k = 0, top = s;
      while (p + 3 <= x0 + span - 1) {
        const row = s - 2 - (k % 2);
        for (let i = 0; i < 3; i++) L.set(p + i, row, PLANK);
        L.put('coin', p + 1, row - 1);
        top = Math.min(top, row);
        p += R.int(4, 5); k++;
      }
      if (d > 0.5 && R.chance(0.5)) L.put('bee', x0 + (span >> 1), top - 3, { axis: 'y', range: 1, speed: speed(1.5, 2.5) });
      flat(R.int(3, 5));
    } else if (kind === 'thorns') {
      const len = R.int(2, 2 + Math.round(2 * d)), x0 = flat(len + 2);
      for (let i = 1; i <= len; i++) thorn[x0 + i] = 1;
      flat(R.int(2, 4));
    } else if (kind === 'crumble') {
      const g = R.int(3, 4 + Math.round(d)), x0 = x;
      for (let i = 0; i < g; i++) { surf[x] = -1; crumble[x] = s; x++; }
      for (let i = 0; i < g; i++) L.put('coin', x0 + i, s - 2);
      flat(R.int(3, 5));
    } else if (kind === 'spring') {
      const h = R.int(4, d > 0.7 ? 6 : 5), x0 = flat(3);
      L.put('spring', x0 + 1, s - 1, { power: clamp(h + 4, 3, 16) });
      s -= h;
      flat(R.int(4, 6));
    } else if (kind === 'ladder') {
      const h = R.int(4, 5);
      flat(2);
      surf[x] = s;
      for (let y = s - h; y <= s - 1; y++) L.set(x, y, LADDER);
      x++;
      s -= h;
      flat(R.int(4, 6));
    }
  }
  // the finish: a flat run to the shrine
  const x0 = flat(W - x);
  L.put('goal', Math.min(W - 4, x0 + 5), s - 1);
  for (let c = 0; c < W; c++) {
    if (surf[c] >= 0) for (let y = surf[c]; y < H; y++) L.set(c, y, GROUND);
    if (thorn[c] && surf[c] >= 0) L.set(c, surf[c], THORNS);
    if (crumble[c]) L.set(c, crumble[c], CRUMBLE);
  }
  // critters: chance put some in while building; top up to what the difficulty asks for
  const FOES = ['slime', 'spiky', 'bee', 'turret'];
  const foes = () => L.entities.filter(e => FOES.includes(e.type)).length;
  const wantFoes = Math.round((W / 100) * (0.6 + 6 * d));
  for (const f of R.shuffle(flats.filter(f => f.x1 - f.x0 >= 3 && f.x0 > 9 && f.x1 < W - 12))) {
    if (foes() >= wantFoes) break;
    const x0 = R.int(f.x0 + 1, f.x1 - 1), y0 = f.s - 1;
    if (surf[x0] !== f.s || L.entities.some(e => Math.abs(e.x - x0) <= 1 && Math.abs(e.y - y0) <= 1)) continue;
    const spiky = d > 0.55 && R.chance(0.35);
    L.put(spiky ? 'spiky' : 'slime', x0, y0, spiky ? { speed: speed(0.8, 1.6) } : { speed: speed(1, 2.5) });
  }
  // a honey jar on a high ledge above one or two long flats: a detour, not the way
  let jars = 0;
  for (const f of R.shuffle(flats.filter(f => f.x1 - f.x0 >= 5 && f.x0 > 8 && f.x1 < W - 10))) {
    if (jars >= (d > 0.5 ? 2 : 1)) break;
    const px = f.x0 + 1, row = f.s - 3;   // a plank three rows up: a full jump, standing one row below it
    if (row < 2 || L.entities.some(e => e.x >= px - 1 && e.x <= px + 3 && e.y >= row - 1 && e.y <= f.s - 1)) continue;
    for (let i = 0; i < 3; i++) L.set(px + i, row, PLANK);
    L.put('gem', px + 1, row - 1);
    jars++;
  }
  // scenery
  const skyTop = Math.max(1, Math.min(...[...surf].filter(v => v >= 0)) - 6);
  for (let c = R.int(2, 6); c < W - 3; c += R.int(9, 15)) L.decor(c, R.int(1, Math.max(1, Math.min(4, skyTop))), CLOUD);
  if (o.biome !== 'desert') L.decor(4, surf[4] - 1, COTTAGE);
  let lastTree = -10;
  for (let c = 8; c < W - 2; c++) {
    if (surf[c] < 0 || thorn[c] || L.tile(c, surf[c] - 1) !== 0) continue;
    const y = surf[c] - 1;
    if (L.entityAt(c, y) || L.entityAt(c, y - 1)) continue;
    if (c - lastTree > 7 && R.chance(0.08)) { L.decor(c, y, TREE); lastTree = c; continue; }
    if (R.chance(0.2)) L.decor(c, y, R.pick([FLOWER, FLOWER, TUFT, TUFT, ROCK, MUSHROOM, SHRUB]));
  }
  const cp = L.entities.find(e => e.type === 'checkpoint');
  if (cp) L.decor(cp.x + 1, cp.y, LAMP);
  return L;
}
function measurePlatformer(level, analysis) {
  const W = level.width, H = level.height, T = level.terrain;
  // a gap is a run of columns with nothing at all to stand on: ledges and crumble bridges are not jumps
  const STAND = new Set([1, 2, 3, 4, 5, 7, 9, 10]);
  const runs = [];
  let run = 0;
  for (let x = 0; x < W; x++) {
    let open = true;
    for (let y = 0; y < H && open; y++) if (STAND.has(T[y * W + x])) open = false;
    if (open) run++; else if (run) { runs.push(run); run = 0; }
  }
  let thorns = 0, crumbles = 0;
  for (const c of T) { if (c === THORNS) thorns++; else if (c === CRUMBLE) crumbles++; }
  const enemies = level.entities.filter(e => ['slime', 'spiky', 'bee', 'turret'].includes(e.type)).length;
  const widest = runs.length ? Math.max(...runs) : 0;
  const per100 = v => (v * 100) / W;
  const ledges = T.reduce((n, c) => n + (c === PLANK ? 1 : 0), 0) / 3;
  const score = 0.24 * norm(widest, 1, 4) + 0.22 * norm(per100(runs.length + ledges * 0.5), 1, 9) + 0.3 * norm(per100(enemies), 0, 7) + 0.24 * norm(per100(thorns + crumbles * 0.7), 0, 8);
  const facts = [
    `${runs.length} gap${runs.length === 1 ? '' : 's'}${runs.length ? `, widest ${widest}` : ''}`,
    `${enemies} critter${enemies === 1 ? '' : 's'}`,
  ];
  if (thorns) facts.push(`${thorns} thorn${thorns === 1 ? '' : 's'}`);
  if (analysis.stats.route?.seconds) facts.push(`about ${analysis.stats.route.seconds} s`);
  return { score, facts };
}

// ------------------------------------------------------------------ adventure
function makeAdventure(R, d, o) {
  const cols = 3, rows = d > 0.55 ? 3 : 2;
  const rw = o.width ? clamp(Math.floor((o.width - 1) / cols) - 1, 7, 14) : R.int(9, 11);
  const rh = o.height ? clamp(Math.floor((o.height - 1) / rows) - 1, 6, 12) : R.int(7, 8);
  const W = cols * (rw + 1) + 1, H = rows * (rh + 1) + 1;
  const L = canvas('adventure', o.id, W, H);
  L.fill(0, 0, W - 1, H - 1, WALL);
  const rooms = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x0 = 1 + i * (rw + 1), y0 = 1 + j * (rh + 1);
    rooms.push({ n: rooms.length, i, j, x0, y0, x1: x0 + rw - 1, y1: y0 + rh - 1, cx: x0 + (rw >> 1), cy: y0 + (rh >> 1) });
    L.fill(x0, y0, x0 + rw - 1, y0 + rh - 1, 0);
  }
  const at = (i, j) => (i >= 0 && j >= 0 && i < cols && j < rows ? rooms[j * cols + i] : null);
  const key = (a, b) => (a.n < b.n ? `${a.n}-${b.n}` : `${b.n}-${a.n}`);
  // a spanning tree from a corner room
  const start = R.pick([rooms[0], rooms[cols - 1], rooms[(rows - 1) * cols], rooms[rows * cols - 1]]);
  const tree = new Map(), seen = new Set([start.n]), stack = [start];
  while (stack.length) {
    const r = stack[stack.length - 1];
    const next = R.shuffle([at(r.i + 1, r.j), at(r.i - 1, r.j), at(r.i, r.j + 1), at(r.i, r.j - 1)].filter(q => q && !seen.has(q.n)));
    if (!next.length) { stack.pop(); continue; }
    const q = next[0];
    seen.add(q.n); tree.set(key(r, q), [r, q]); stack.push(q);
  }
  const neighbours = r => [...tree.values()].filter(([a, b]) => a === r || b === r).map(([a, b]) => (a === r ? b : a));
  // the shrine goes in the room farthest from the start
  const depth = new Map([[start.n, 0]]), parent = new Map(), queue = [start];
  while (queue.length) { const r = queue.shift(); for (const q of neighbours(r)) if (!depth.has(q.n)) { depth.set(q.n, depth.get(r.n) + 1); parent.set(q.n, r); queue.push(q); } }
  const far = Math.max(...depth.values());
  const goal = R.pick(rooms.filter(r => depth.get(r.n) === far));
  const path = [goal];
  while (path[0] !== start) path.unshift(parent.get(path[0].n));
  const onPath = new Set(path.map(r => r.n));
  // locked gates along the way, in the order you meet them
  const colors = ['amber', 'ice', 'rose'];
  const lockCount = Math.min(path.length - 1, Math.round(d * 3.2));
  const edgeIdx = R.shuffle([...Array(path.length - 1).keys()]).slice(0, lockCount).sort((a, b) => a - b);
  const locks = edgeIdx.map((k, n) => ({ a: path[k], b: path[k + 1], color: colors[n] }));
  const locked = new Set(locks.map(l => key(l.a, l.b)));
  // zones: what is reachable before each lock
  const zoneOf = new Map();
  let zone = 0;
  for (const r of rooms) {
    if (zoneOf.has(r.n)) continue;
    const q = [r]; zoneOf.set(r.n, zone);
    while (q.length) { const c = q.shift(); for (const nb of neighbours(c)) if (!zoneOf.has(nb.n) && !locked.has(key(c, nb))) { zoneOf.set(nb.n, zone); q.push(nb); } }
    zone++;
  }
  // extra openings make loops, but only inside a zone, so no loop walks around a gate
  const edges = [...tree.values()].map(([a, b]) => ({ a, b }));
  for (const r of rooms) for (const q of [at(r.i + 1, r.j), at(r.i, r.j + 1)]) {
    if (q && !tree.has(key(r, q)) && zoneOf.get(r.n) === zoneOf.get(q.n) && R.chance(0.45 - 0.35 * d)) edges.push({ a: r, b: q });
  }
  const reserved = new Set();
  const reserve = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) reserved.add((y + dy) * W + x + dx); };
  const openings = [];
  for (const e of edges) {
    const [a, b] = e.a.n < e.b.n ? [e.a, e.b] : [e.b, e.a];
    let x, y;
    if (a.j === b.j) { x = a.x1 + 1; y = R.int(a.y0 + 1, a.y1 - 1); } else { y = a.y1 + 1; x = R.int(a.x0 + 1, a.x1 - 1); }
    L.set(x, y, 0);
    reserve(x, y);
    const lock = locks.find(l => key(l.a, l.b) === key(a, b));
    if (lock) L.put('door', x, y, { lock: lock.color, stayOpen: true });
    openings.push({ x, y, a, b });
  }
  const occupied = new Set();
  const free = (r, margin = 1) => {
    const cells = [];
    for (let y = r.y0 + margin; y <= r.y1 - margin; y++) for (let x = r.x0 + margin; x <= r.x1 - margin; x++) {
      const i = y * W + x;
      if (!occupied.has(i) && !reserved.has(i) && L.T[i] === 0) cells.push([x, y]);
    }
    return cells.length ? R.pick(cells) : null;
  };
  const place = (type, r, props, margin) => { const c = free(r, margin); if (!c) return null; occupied.add(c[1] * W + c[0]); return L.put(type, c[0], c[1], props); };
  // obstacles first, clear of every opening
  for (const r of rooms) {
    if (r === start) continue;
    const theme = R.pick(['pond', 'bushes', 'grass', 'grass', 'bushes', 'plain']);
    if (theme === 'pond' && rw >= 9 && rh >= 7) {
      const pw = R.int(3, 4), ph = 2, px = r.cx - (pw >> 1), py = r.cy - 1;
      for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) { L.set(x, y, POND); occupied.add(y * W + x); }
      for (let y = py - 1; y <= py + ph; y++) for (let x = px - 1; x <= px + pw; x++) reserved.add(y * W + x);
    } else if (theme === 'bushes') {
      for (let k = R.int(2, 4); k > 0; k--) { const c = free(r, 2); if (c) { L.set(c[0], c[1], BUSH); occupied.add(c[1] * W + c[0]); reserve(c[0], c[1]); } }
    } else if (theme === 'grass') {
      const c = free(r, 1);
      if (c) for (let y = c[1] - 1; y <= c[1] + 1; y++) for (let x = c[0] - 2; x <= c[0] + 2; x++) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1 && L.tile(x, y) === 0) L.set(x, y, TALLGRASS);
    }
  }
  // the people and the prize
  const player = L.put('player', start.cx, start.cy);
  occupied.add(start.cy * W + start.cx); reserve(start.cx, start.cy);
  const shrine = L.put('goal', goal.cx, goal.cy);
  occupied.add(goal.cy * W + goal.cx); reserve(goal.cx, goal.cy);
  const dirWord = (() => {
    const dx = Math.sign(goal.i - start.i), dy = Math.sign(goal.j - start.j);
    return ({ '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north', '1,1': 'south-east', '-1,1': 'south-west', '1,-1': 'north-east', '-1,-1': 'north-west' })[`${dx},${dy}`] || 'beyond';
  })();
  const npcText = locks.length
    ? `The shrine lies to the ${dirWord}, past ${locks.length === 1 ? 'a gate' : `${locks.length} gates`}. Each gate opens with a key of its colour: look for the ${locks[0].color} key first.`
    : `The shrine lies to the ${dirWord}. Mind the critters on the way, and keep an eye out for honey.`;
  const npc = L.put('npc', player.x + (start.cx + 2 <= start.x1 ? 2 : -2), player.y, { name: R.pick(['Mira', 'Tomas', 'Pip', 'Wren', 'Juno', 'Bram']), text: npcText });
  occupied.add(npc.y * W + npc.x);
  // keys, each where it can be reached before its own gate
  locks.forEach((lock, n) => {
    const reachable = rooms.filter(r => { // rooms reachable from the start with this and later gates shut
      const open = new Set(locks.slice(0, n).map(l => key(l.a, l.b)));
      const q = [start], got = new Set([start.n]);
      while (q.length) { const c = q.shift(); for (const e of edges) { const [x1, y1] = [e.a, e.b]; const other = x1 === c ? y1 : y1 === c ? x1 : null; if (!other || got.has(other.n)) continue; const k2 = key(c, other); if (locked.has(k2) && !open.has(k2)) continue; got.add(other.n); q.push(other); } }
      return got.has(r.n);
    });
    const choices = reachable.filter(r => r !== start && !onPath.has(r.n));
    const room = choices.length ? R.pick(choices) : R.pick(reachable);
    if (d > 0.5 && R.chance(0.5)) place('chest', room, { contains: `key-${lock.color}` }, 1);
    else place('key', room, { color: lock.color }, 1);
  });
  // critters, honey and hearts
  let spirits = 0, turrets = 0;
  for (const r of rooms) {
    if (r !== start) {
      const n = (R.chance(0.3 + 0.5 * d) ? 1 : 0) + (d > 0.5 ? R.int(0, 1) : 0) + (d > 0.8 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const kind = R.weighted([['slime', 3], ['spiky', d > 0.45 ? 1.2 : 0], ['spirit', d > 0.65 && spirits < 2 ? 0.8 : 0], ['turret', d > 0.75 && turrets < 2 ? 0.6 : 0]]);
        if (kind === 'spirit') spirits++;
        if (kind === 'turret') turrets++;
        const props = kind === 'slime' ? { speed: round2(1 + d), hp: 1, behavior: R.chance(d) ? 'chase' : 'patrol' }
          : kind === 'spiky' ? { speed: round2(0.8 + 0.8 * d) }
          : kind === 'spirit' ? { speed: round2(1 + d), hp: 2 }
          : { dir: 'player', interval: round2(3 - d), hp: 3 };
        place(kind, r, props, 1);
      }
    }
    const trail = openings.filter(op => op.a === r || op.b === r);
    for (const op of trail) {
      // a short run of honey from the room's middle toward each way in
      const steps = Math.max(Math.abs(op.x - r.cx), Math.abs(op.y - r.cy));
      for (let t = 2; t < steps - 1; t += 2) {
        const x = Math.round(r.cx + ((op.x - r.cx) * t) / steps), y = Math.round(r.cy + ((op.y - r.cy) * t) / steps);
        const i = y * W + x;
        if (L.T[i] === 0 || L.T[i] === TALLGRASS) if (!occupied.has(i)) { occupied.add(i); L.put('coin', x, y); }
      }
    }
    if (r !== start && r !== goal && neighbours(r).length === 1) { const chest = R.chance(0.3); place(chest ? 'chest' : 'gem', r, chest ? { contains: 'gem' } : {}, 1); }
    if (r !== start && R.chance(0.3)) place('heart', r, {}, 1);
  }
  // a worn path from the start to the shrine, through the open doorways
  const prev = new Int32Array(W * H).fill(-1), q2 = [player.y * W + player.x];
  prev[q2[0]] = q2[0];
  while (q2.length) {
    const c = q2.shift(), cx = c % W, cy = (c - cx) / W;
    if (c === shrine.y * W + shrine.x) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy, ni = ny * W + nx;
      if (!L.inside(nx, ny) || prev[ni] >= 0) continue;
      const t = L.T[ni];
      if (t === 0 || t === TALLGRASS || t === PATH) { prev[ni] = c; q2.push(ni); }
    }
  }
  for (let c = shrine.y * W + shrine.x; prev[c] >= 0 && prev[c] !== c; c = prev[c]) if (L.T[c] === 0 || L.T[c] === TALLGRASS) L.T[c] = PATH;
  if (L.T[player.y * W + player.x] === 0) L.T[player.y * W + player.x] = PATH;
  // scenery: trees in corners, flowers, a lamp by the shrine
  for (const r of rooms) {
    // trees only in a room's bottom corners: they are drawn taller than their cell, over the room, not over the hedge
    for (const [x, y] of [[r.x0, r.y1], [r.x1, r.y1]]) if (L.tile(x, y) === 0 && !reserved.has(y * W + x) && R.chance(0.55)) L.decor(x, y, TREE);
    for (let k = R.int(2, 5); k > 0; k--) { const c = free(r, 0); if (c && L.tile(c[0], c[1]) === 0) L.decor(c[0], c[1], R.pick([FLOWER, FLOWER, TUFT, ROCK, MUSHROOM, SHRUB, BARREL])); }
  }
  if (L.tile(shrine.x + 1, shrine.y) !== WALL) L.decor(shrine.x + 1, shrine.y, LAMP);
  return L;
}
function measureAdventure(level, analysis) {
  const ents = level.entities;
  const locks = ents.filter(e => e.type === 'door' && e.props.lock !== 'none').length;
  const foes = ents.filter(e => ['slime', 'spiky', 'spirit', 'turret'].includes(e.type));
  const tough = foes.filter(e => e.type === 'spirit' || e.type === 'turret').length;
  const rooms = Math.round((level.width * level.height) / 90);
  const score = 0.4 * (locks / 3) + 0.35 * norm(foes.length / rooms, 0, 3) + 0.15 * norm(tough, 0, 4) + 0.1 * norm(level.height, 17, 28);
  const facts = [`${locks} locked gate${locks === 1 ? '' : 's'}`, `${foes.length} critter${foes.length === 1 ? '' : 's'}`];
  if (analysis.stats.route?.seconds) facts.push(`about ${analysis.stats.route.seconds} s`);
  return { score, facts };
}

// ------------------------------------------------------------------ arena
function makeArena(R, d, o) {
  const W = o.width || 30 + 2 * R.int(0, 2), H = o.height || 20 + R.int(0, 2);
  const L = canvas('arena', o.id, W, H);
  for (let x = 0; x < W; x++) { L.set(x, 0, WALL); L.set(x, H - 1, WALL); }
  for (let y = 0; y < H; y++) { L.set(0, y, WALL); L.set(W - 1, y, WALL); }
  const mirror = x => W - 1 - x;
  const busy = new Set();
  const px = W >> 1, py = H - 4;
  for (let y = py - 2; y <= py + 1; y++) for (let x = px - 3; x <= px + 3; x++) busy.add(y * W + x);
  const isFree = (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1 && L.tile(x, y) === 0 && !busy.has(y * W + x) && !busy.has(y * W + mirror(x));
  const setBoth = (x, y, c) => { L.set(x, y, c); L.set(mirror(x), y, c); busy.add(y * W + x); busy.add(y * W + mirror(x)); };
  const putBoth = (type, x, y, props) => { const a = L.put(type, x, y, props); busy.add(y * W + x); if (mirror(x) !== x) { L.put(type, mirror(x), y, props); busy.add(y * W + mirror(x)); } return a; };
  L.put('player', px, py);
  // a pond in the middle: shots cross it, feet do not
  if (R.chance(0.5)) {
    const pw = R.int(3, 5), ph = R.int(2, 3), y0 = (H >> 1) - ph + R.int(0, 1);
    for (let y = y0; y < y0 + ph; y++) for (let x = (W >> 1) - pw; x < (W >> 1) + pw; x++) { L.set(x, y, POND); busy.add(y * W + x); }
    for (let y = y0 - 1; y <= y0 + ph; y++) for (let x = (W >> 1) - pw - 1; x <= (W >> 1) + pw; x++) busy.add(y * W + x);
  }
  // cover on the left half, mirrored to the right
  const pieces = R.int(3, 5) + Math.round((1 - d) * 2);
  for (let k = 0, tries = 0; k < pieces && tries < 60; tries++) {
    const x = R.int(3, (W >> 1) - 3), y = R.int(3, H - 5);
    const kind = R.pick(['crates', 'bush', 'bush', 'pillar']);
    const cells = kind === 'pillar' ? [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] : kind === 'bush' ? [[x, y], [x + 1, y]] : [[x, y], [x + 1, y]];
    if (!cells.every(([cx, cy]) => isFree(cx, cy)) || cells.some(([cx, cy]) => [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => busy.has((cy + dy) * W + cx + dx)))) continue;
    if (kind === 'crates') for (const [cx, cy] of cells) putBoth('crate', cx, cy);
    else for (const [cx, cy] of cells) setBoth(cx, cy, kind === 'pillar' ? WALL : BUSH);
    k++;
  }
  // burrows: two, or four when it is hard
  const kinds = d < 0.35 ? ['slime', 'slime'] : d < 0.7 ? ['slime', R.pick(['bee', 'slime'])] : [R.pick(['bee', 'spirit']), 'spirit'];
  const survive = R.chance(0.25);
  const waves = survive ? 6 + Math.round(4 * d) : 2 + Math.round(3 * d);
  const spots = [[3, 2], [2, (H >> 1) - 1]];
  const pairs = d < 0.45 ? 1 : 2;
  for (let n = 0; n < pairs; n++) {
    let [x, y] = spots[n];
    while (!isFree(x, y) && x < (W >> 1) - 2) x++;
    putBoth('spawner', x, y, { enemy: kinds[n], waves, perWave: 3 + Math.round(3 * d), gap: round2(1 - 0.45 * d), rest: round2(3.5 - 1.5 * d), delay: 2 + n * 6 });
  }
  if (d > 0.55) { let x = 2; const y = H - 3; while (!isFree(x, y) && x < 6) x++; putBoth('turret', x, y, { dir: 'player', interval: round2(3.2 - 1.2 * d), hp: 3 }); }
  // pickups
  { let x = 4; const y = (H >> 1) + 2; while (!isFree(x, y) && x < (W >> 1) - 2) x++; putBoth('heart', x, y); }
  if (d > 0.3) { const x = px, y = 3; if (L.tile(x, y) === 0) { L.put('powerup', x, y, { kind: d < 0.6 ? 'rapid' : 'spread', seconds: 15 }); busy.add(y * W + x); } }
  for (let k = R.int(3, 5); k > 0; k--) { const x = R.int(2, (W >> 1) - 2), y = R.int(2, H - 3); if (isFree(x, y)) putBoth('coin', x, y); }
  // scenery
  for (const [x, y] of [[1, 1], [1, H - 2]]) { L.decor(x, y, TREE); L.decor(mirror(x), y, TREE); }
  for (let k = R.int(4, 8); k > 0; k--) { const x = R.int(1, (W >> 1) - 1), y = R.int(1, H - 2); if (L.tile(x, y) === 0 && !L.entityAt(x, y)) { const c = R.pick([FLOWER, TUFT, ROCK, SHRUB]); L.decor(x, y, c); L.decor(mirror(x), y, c); } }
  L.rules = survive ? { win: 'survive', survive: 40 + Math.round(40 * d) } : { win: 'waves' };
  return L;
}
function measureArena(level) {
  const ents = level.entities;
  const burrows = ents.filter(e => e.type === 'spawner');
  const foes = burrows.reduce((n, b) => n + b.props.waves * b.props.perWave, 0) + ents.filter(e => e.type === 'turret').length * 4;
  const hard = burrows.filter(b => b.props.enemy === 'spirit' || b.props.enemy === 'bee').length / Math.max(1, burrows.length);
  const turrets = ents.filter(e => e.type === 'turret').length;
  if (level.rules.win === 'survive') {
    const score = 0.4 * norm(level.rules.survive, 40, 80) + 0.25 * norm(burrows.length, 2, 4) + 0.25 * hard + 0.1 * norm(turrets, 0, 2);
    return { score, facts: [`survive ${level.rules.survive} s`, `${burrows.length} burrows`, turrets ? `${turrets} cannons` : 'no cannons'] };
  }
  const score = 0.5 * norm(foes, 12, 90) + 0.2 * norm(turrets, 0, 2) + 0.2 * hard + 0.1 * norm(burrows.length, 2, 4);
  return { score, facts: [`${burrows[0]?.props.waves || 0} waves`, `${foes} foes`, `${burrows.length} burrows`] };
}

// ------------------------------------------------------------------ arcade maze
function makeMaze(R, d, o) {
  const W = o.width ? (o.width | 1) : 21 + 2 * Math.round(3 * d), H = o.height ? (o.height | 1) : 19 + 2 * Math.round(d);
  const L = canvas('maze', o.id, W, H);
  L.fill(0, 0, W - 1, H - 1, WALL);
  const cx = (W - 1) >> 1, cy = ((H - 1) >> 1) | 1;
  const mirror = x => W - 1 - x;
  const carve = (x, y) => { L.set(x, y, 0); L.set(mirror(x), y, 0); };
  // a depth-first maze over the odd cells of the left half, mirrored
  const nodes = [];
  for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < cx; x += 2) nodes.push([x, y]);
  const seen = new Set();
  const stack = [R.pick(nodes)];
  seen.add(stack[0].join());
  carve(...stack[0]);
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const next = R.shuffle([[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dy]) => [x + dx, y + dy, dx, dy]).filter(([nx, ny]) => nx >= 1 && ny >= 1 && nx < cx && ny < H - 1 && !seen.has(`${nx},${ny}`)));
    if (!next.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = next[0];
    carve(x + dx / 2, y + dy / 2); carve(nx, ny);
    seen.add(`${nx},${ny}`); stack.push([nx, ny]);
  }
  // join the halves across the middle column in a few rows
  const rowsOdd = []; for (let y = 1; y < H - 1; y += 2) rowsOdd.push(y);
  for (const y of R.shuffle(rowsOdd.slice()).slice(0, 3 + R.int(0, 2))) { L.set(cx - 1, y, 0); L.set(cx, y, 0); L.set(cx + 1, y, 0); }
  // no dead ends: a chase needs somewhere to go
  const open = (x, y) => L.inside(x, y) && L.tile(x, y) !== WALL;
  for (let pass = 0; pass < 3; pass++) for (let y = 1; y < H - 1; y += 2) for (let x = 1; x <= cx; x += 2) {
    if (!open(x, y)) continue;
    const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => open(x + dx, y + dy));
    if (exits.length > 1) continue;
    const walls = R.shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !open(x + dx, y + dy) && x + 2 * dx >= 1 && x + 2 * dx <= W - 2 && y + 2 * dy >= 1 && y + 2 * dy <= H - 2));
    if (walls.length) { const [dx, dy] = walls[0]; carve(x + dx, y + dy); carve(x + 2 * dx, y + 2 * dy); }
  }
  // the hive in the middle, a ring corridor round it, a gate only bees pass
  L.fill(cx - 5, cy - 2, cx + 5, cy + 2, 0);
  L.fill(cx - 4, cy - 1, cx + 4, cy + 1, WALL);
  L.fill(cx - 3, cy, cx + 3, cy, PATH);
  L.set(cx, cy - 1, GATE);
  // a wrap-round tunnel on an easier maze
  if (d < 0.75 && R.chance(0.6)) {
    const ty = R.pick(rowsOdd.filter(y => Math.abs(y - cy) > 2 && y > 2 && y < H - 3));
    if (ty) { for (let x = 0; x <= 2; x++) carve(x, ty); }
  }
  // the player below the hive, on a corridor joined both ways
  const pyRow = Math.min(H - 2, cy + 4 + ((cy + 4) % 2 ? 0 : 1));
  L.set(cx - 1, pyRow, 0); L.set(cx, pyRow, 0); L.set(cx + 1, pyRow, 0);
  L.put('player', cx, pyRow);
  // anything the player cannot reach is closed off, so every dot can be eaten
  const reach = new Uint8Array(W * H), q = [pyRow * W + cx];
  reach[q[0]] = 1;
  while (q.length) {
    const c = q.shift(), x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + dx; const ny = y + dy;
      if (nx < 0) nx = W - 1; else if (nx >= W) nx = 0;
      const i = ny * W + nx;
      if (ny < 0 || ny >= H || reach[i]) continue;
      const t = L.T[i];
      if (t === 0 || t === PATH) { reach[i] = 1; q.push(i); }
    }
  }
  for (let i = 0; i < W * H; i++) if (L.T[i] === 0 && !reach[i]) L.T[i] = WALL;
  // the bees, by temperament
  const bees = 2 + Math.round(2 * d);
  const tempers = ['hunter', 'ambusher', 'fickle', 'shy'];
  const beeX = [cx - 2, cx + 2, cx - 3, cx + 3];
  for (let k = 0; k < bees; k++) L.put('bee', beeX[k], cy, { temper: tempers[k], speed: round2(1.6 + 0.9 * d) });
  // royal jelly near the corners: four when it is easy, two when it is hard
  const jelly = d < 0.5 ? 4 : d < 0.8 ? 3 : 2;
  const corners = [[1, 3], [W - 2, 3], [1, H - 4], [W - 2, H - 4]];
  let placed = 0;
  for (const [x0, y0] of corners) {
    if (placed >= jelly) break;
    let best = null;
    for (let r = 0; r < 4 && !best; r++) for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r && !best; dx++) { const x = x0 + dx, y = y0 + dy; if (L.tile(x, y) === 0 && !L.entityAt(x, y) && reach[y * W + x]) best = [x, y]; }
    if (best) { L.put('power', best[0], best[1], { seconds: Math.round(8 - 3 * d) }); placed++; }
  }
  if (L.tile(cx, cy + 2) === 0) L.put('gem', cx, cy + 2);
  return L;
}
function measureMaze(level) {
  const bees = level.entities.filter(e => e.type === 'bee');
  const jelly = level.entities.filter(e => e.type === 'power').length;
  const dots = level.terrain.reduce((n, c) => n + (c === 0 ? 1 : 0), 0);
  const speed = bees.length ? bees[0].props.speed : 2;
  const score = 0.35 * norm(bees.length, 1, 4) + 0.25 * norm(speed, 1.6, 2.5) + 0.25 * (1 - norm(jelly, 2, 4)) + 0.15 * norm(dots, 150, 320);
  return { score, facts: [`${dots} dots`, `${bees.length} bees`, `${jelly} royal jelly`] };
}

// ------------------------------------------------------------------ block puzzle
function makePuzzle(R, d, o) {
  const iw = o.width ? clamp(o.width - 2, 4, 20) : clamp(5 + Math.round(3 * d) + R.int(0, 1), 4, 20);
  const ih = o.height ? clamp(o.height - 2, 4, 14) : clamp(4 + Math.round(2 * d) + R.int(0, 1), 4, 14);
  const W = iw + 2, H = ih + 2;
  const L = canvas('puzzle', o.id, W, H);
  L.fill(0, 0, W - 1, H - 1, WALL);
  L.fill(1, 1, iw, ih, 0);
  const floorCells = () => { const out = []; for (let y = 1; y <= ih; y++) for (let x = 1; x <= iw; x++) if (L.tile(x, y) === 0) out.push(y * W + x); return out; };
  const connected = () => {
    const cells = floorCells(); if (!cells.length) return false;
    const seen = new Set([cells[0]]), q = [cells[0]];
    while (q.length) { const c = q.shift(); for (const k of [1, -1, W, -W]) if (L.T[c + k] === 0 && !seen.has(c + k)) { seen.add(c + k); q.push(c + k); } }
    return seen.size === cells.length;
  };
  // walls inside the room: they are what makes a puzzle
  const blocks = Math.round(iw * ih * (0.1 + 0.08 * R.next()));
  for (let k = 0, tries = 0; k < blocks && tries < 200; tries++) {
    const x = R.int(1, iw), y = R.int(1, ih);
    if (L.tile(x, y) !== 0) continue;
    L.set(x, y, WALL);
    const free = floorCells().filter(c => [1, -1, W, -W].filter(k2 => L.T[c + k2] !== WALL).length <= 1).length;
    if (!connected() || free > 1) { L.set(x, y, 0); continue; }
    k++;
  }
  const crates = d < 0.3 ? 1 : d < 0.65 ? 2 : iw * ih >= 40 && d > 0.85 ? 4 : 3;
  const cells = floorCells();
  // start solved: crates on pads, then pull them apart
  const pads = R.shuffle(cells.slice()).slice(0, crates);
  const posOf = c => [c % W, Math.floor(c / W)];
  const pull = (state, steps) => {
    const crateSet = new Set(state.crates);
    let player = state.player;
    for (let s = 0; s < steps; s++) {
      // where the player can walk
      const reach = new Set([player]), q = [player];
      while (q.length) { const c = q.shift(); for (const k of [1, -1, W, -W]) { const n = c + k; if (L.T[n] === WALL || crateSet.has(n) || reach.has(n)) continue; reach.add(n); q.push(n); } }
      const moves = [];
      for (const c of crateSet) for (const k of [1, -1, W, -W]) {
        const stand = c + k, back = c + 2 * k;
        if (reach.has(stand) && L.T[back] !== WALL && !crateSet.has(back) && L.T[stand] !== WALL) moves.push([c, k]);
      }
      if (!moves.length) break;
      const [c, k] = R.pick(moves);
      crateSet.delete(c); crateSet.add(c + k); player = c + 2 * k;
    }
    return { crates: [...crateSet], player };
  };
  const player0 = R.pick(cells.filter(c => !pads.includes(c)));
  let best = null;
  const tries = 3 + Math.round(3 * d);
  for (let t = 0; t < tries; t++) {
    const st = pull({ crates: pads.slice(), player: player0 }, 8 + Math.round(40 * d) + R.int(0, 10));
    if (st.crates.some(c => pads.includes(c)) && crates === 1) continue;
    if (st.crates.filter(c => pads.includes(c)).length > Math.floor(crates / 2)) continue;
    const trial = { width: W, height: H, terrain: Uint16Array.from(L.T), entities: [...st.crates.map((c, i) => ({ id: `c${i}`, type: 'crate', x: posOf(c)[0], y: posOf(c)[1], props: {} })), { id: 'p', type: 'player', x: posOf(st.player)[0], y: posOf(st.player)[1], props: {} }], links: [], rules: {} };
    for (const p of pads) trial.terrain[p] = PAD;
    const sol = solvePuzzle(trial, { maxNodes: 60000 });
    if (sol.solvable !== true) continue;
    if (!best || sol.moves > best.sol.moves) best = { st, sol };
  }
  if (!best) return null;
  for (const p of pads) L.T[p] = PAD;
  for (const c of best.st.crates) L.put('crate', ...posOf(c));
  L.put('player', ...posOf(best.st.player));
  L.solution = best.sol;
  return L;
}
function measurePuzzle(level, analysis, L) {
  const sol = L.solution;
  const crates = level.entities.filter(e => e.type === 'crate').length;
  const score = 0.5 * norm(sol.moves, 6, 42) + 0.3 * norm(Math.log(Math.max(1, sol.explored)), Math.log(40), Math.log(30000)) + 0.2 * norm(crates, 1, 3);
  return { score, facts: [`solvable in ${sol.moves} moves`, `${crates} crate${crates === 1 ? '' : 's'}`, `${sol.explored.toLocaleString('en')} positions searched`] };
}

const MAKERS = { platformer: makePlatformer, adventure: makeAdventure, arena: makeArena, maze: makeMaze, puzzle: makePuzzle };
const MEASURES = { platformer: measurePlatformer, adventure: measureAdventure, arena: measureArena, maze: measureMaze, puzzle: measurePuzzle };

/** The difficulty words the editor shows for a score. */
export function difficultyLabel(score) { return score < 0.34 ? 'Easy' : score < 0.67 ? 'Medium' : 'Hard'; }

/**
 * Make `count` verified levels for a genre.
 *
 * @param {string} genre
 * @param {object} [opts]
 * @param {number} [opts.count=5]      1 to GENERATE_MAX
 * @param {string} [opts.biome]        'meadow' | 'desert' | 'snow' | 'mixed' (a third of the run each)
 * @param {number} [opts.from=0.15]    easiest difficulty, 0 to 1
 * @param {number} [opts.to=0.85]      hardest difficulty, 0 to 1
 * @param {string|number} [opts.seed]  the same seed gives the same levels
 * @param {number} [opts.width]        grid size; each genre has its own default
 * @param {number} [opts.height]
 * @param {string} [opts.idPrefix]     level ids are `${idPrefix}-${n}`
 * @param {(p: {done: number, total: number, kept: number, rejected: number}) => void} [opts.onProgress]
 * @returns {{ levels: {level: object, score: number, label: string, facts: string[]}[], attempts: number, rejected: number, reasons: Object<string, number> }}
 */
export function generateLevels(genre, opts = {}) {
  if (!MAKERS[genre]) throw new Error(`No generator for genre "${genre}"`);
  const count = clamp(Math.round(opts.count ?? 5), 1, GENERATE_MAX);
  let from = clamp(opts.from ?? 0.15, 0, 1), to = clamp(opts.to ?? 0.85, 0, 1);
  if (to < from) [from, to] = [to, from];
  const seed = String(opts.seed ?? 'visigame');
  const biome = opts.biome === 'mixed' || BIOME_IDS.includes(opts.biome) ? opts.biome : 'meadow';
  const prefix = opts.idPrefix || `gen-${hashString(`${genre}|${seed}`).toString(36)}`;
  const g = genreById(genre);
  const size = o => ({
    width: opts.width ? clamp(opts.width, g.minSize.width, g.maxSize.width) : undefined,
    height: opts.height ? clamp(opts.height, g.minSize.height, g.maxSize.height) : undefined,
    ...o,
  });
  const wanted = Math.max(count * 3, 6), maxAttempts = count * 10 + 10;
  const kept = [], reasons = {};
  let attempts = 0, rejected = 0;
  while (kept.length < wanted && attempts < maxAttempts) {
    const k = attempts++;
    // a low-discrepancy walk over the difficulty range, so candidates cover it evenly
    const knob = from + (to - from) * ((k * 0.6180339887 + 0.31) % 1);
    const R = random(`${genre}|${seed}|${k}`);
    const id = `${prefix}-c${k}`;
    const L = MAKERS[genre](R, knob, size({ id, biome: biome === 'mixed' ? 'meadow' : biome }));
    if (!L) { rejected++; reasons['no solvable arrangement'] = (reasons['no solvable arrangement'] || 0) + 1; report(); continue; }
    const level = finish(L, { name: '', biome: biome === 'mixed' ? 'meadow' : biome, rules: { ...(L.rules || {}), ...(L.solution ? { par: L.solution.moves } : {}) } });
    const project = { genre, settings: { ...DEFAULT_SETTINGS }, levels: [level] };
    const analysis = analyzeLevel(project, 0, { solve: genre !== 'puzzle', maxNodes: 60000 });
    const bad = analysis.issues.filter(x => x.severity !== 'tip');
    if (bad.length) {
      rejected++;
      for (const b of bad) { const r = b.id.replace(/:.*$/, ''); reasons[r] = (reasons[r] || 0) + 1; }
      report();
      continue;
    }
    const m = MEASURES[genre](level, analysis, L);
    kept.push({ level, score: Math.round(m.score * 1000) / 1000, facts: m.facts, knob, k });
    report();
  }
  function report() { opts.onProgress?.({ done: Math.min(kept.length, wanted), total: wanted, kept: kept.length, rejected, attempts }); }

  // pick `count` to climb evenly across the range, then order them by difficulty
  const targets = count === 1 ? [(from + to) / 2] : Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
  const used = new Set(), chosen = [];
  for (const t of targets) {
    let best = -1;
    for (let i = 0; i < kept.length; i++) if (!used.has(i) && (best < 0 || Math.abs(kept[i].score - t) < Math.abs(kept[best].score - t))) best = i;
    if (best < 0) break;
    used.add(best); chosen.push(kept[best]);
  }
  chosen.sort((a, b) => a.score - b.score || a.k - b.k);
  // names and biomes in order of play
  const nameR = random(`${genre}|${seed}|names`);
  const words = { meadow: nameR.shuffle(WORDS.meadow.slice()), desert: nameR.shuffle(WORDS.desert.slice()), snow: nameR.shuffle(WORDS.snow.slice()) };
  const nouns = nameR.shuffle(NOUNS[genre].slice());
  const levels = chosen.map((c, n) => {
    const b = biome === 'mixed' ? BIOME_IDS[Math.min(2, Math.floor((n * 3) / chosen.length))] : biome;
    const level = c.level;
    level.id = `${prefix}-${n + 1}`;
    level.entities.forEach((e, i) => { const old = e.id; e.id = `${level.id}-${e.type}-${i}`; for (const k2 of level.links) { if (k2.from === old) k2.from = e.id; if (k2.to === old) k2.to = e.id; } });
    level.biome = b;
    level.time = n === chosen.length - 1 && chosen.length > 2 ? 'golden' : 'day';
    const word = words[b][n % words[b].length];
    level.name = `${word} ${nouns[n % nouns.length]}`.slice(0, 40);
    level.notes = `Generated (${genre}, seed ${seed}, generator v${GENERATOR_VERSION}): ${difficultyLabel(c.score).toLowerCase()}, difficulty ${Math.round(c.score * 100)}. ${c.facts.join(' · ')}.`;
    return { level, score: c.score, label: difficultyLabel(c.score), facts: c.facts };
  });
  return { levels, attempts, rejected, reasons };
}
