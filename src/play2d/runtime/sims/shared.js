/**
 * What every genre's simulation shares: the fixed step, the input shape, a seeded random
 * stream, the live copy of the level, wires between parts, the event queue the game shell
 * turns into sound and sparks, and the trace the editor draws after a playtest.
 *
 * A simulation is plain data plus `step(input)`. It never touches the DOM, a canvas or the
 * clock, so the same level plays bit-identically in the editor, in an exported game and in
 * `node tools/test/test-builder-runtime.mjs`.
 *
 * Units: tiles and seconds. Positions are the top-left of a body's box, y grows downward.
 */
import { entityDef, footprint, viewOf, tileByCode, SCORE } from '../../core/catalog.js';

export const STEP = 1 / 60;

/** Difficulty scales how hard critters hit and how fast they move. */
export const DIFFICULTY = {
  easy:   { damage: 0.5, speed: 0.8, invuln: 1.6 },
  normal: { damage: 1,   speed: 1,   invuln: 1.2 },
  hard:   { damage: 1,   speed: 1.2, invuln: 0.9 },
};

/** Seeded PRNG (mulberry32). Returns a function yielding [0, 1). */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/**
 * The input for one step. Held states are booleans; `pressed` holds edges that happened since
 * the previous step (the shell delivers each press to exactly one step). `aim` is a direction
 * (any length, or null) for the arena's twin stick.
 */
export function emptyInput() {
  return {
    left: false, right: false, up: false, down: false,
    jump: false, action: false, fire: false,
    aim: null,
    pressed: { left: false, right: false, up: false, down: false, jump: false, action: false, fire: false, undo: false, restart: false },
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const centerOf = e => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
export const dist2 = (a, b) => { const ax = a.x + a.w / 2 - (b.x + b.w / 2), ay = a.y + a.h / 2 - (b.y + b.h / 2); return ax * ax + ay * ay; };

/**
 * Body sizes in tiles, per view. A body sits bottom-centred in its anchor cell (side view) or
 * centred in it (top view); art anchors its sprite the same way, so an entity drawn from its
 * editor cell and the same entity drawn from its live body land on the same pixels.
 */
export const BODY = {
  side: {
    player: [0.62, 0.9], slime: [0.8, 0.62], bee: [0.7, 0.62], spiky: [0.8, 0.66], turret: [0.9, 0.9], boss: [1.8, 1.6],
    coin: [0.5, 0.6], gem: [0.7, 0.8], heart: [0.6, 0.6], key: [0.7, 0.5], powerup: [0.6, 0.7],
    goal: [1, 1], checkpoint: [0.6, 1], sign: [0.8, 0.8], switch: [0.7, 0.7], bswitch: [0.9, 0.5],
    spring: [0.9, 0.5], door: [1, 1],
  },
  top: {
    player: [0.66, 0.66], slime: [0.7, 0.6], bee: [0.62, 0.62], spiky: [0.7, 0.6], turret: [0.8, 0.8], boss: [1.7, 1.6], spirit: [0.66, 0.66],
    coin: [0.5, 0.5], gem: [0.6, 0.6], heart: [0.5, 0.5], key: [0.6, 0.5], powerup: [0.55, 0.55], power: [0.5, 0.5],
    goal: [0.9, 0.9], checkpoint: [0.6, 0.6], sign: [0.8, 0.6], switch: [0.7, 0.7], plate: [0.8, 0.8], door: [1, 1],
    crate: [1, 1], chest: [0.9, 0.8], teleporter: [0.8, 0.8], npc: [0.66, 0.66], spawner: [1, 1],
  },
};

/** A body for an entity placed at its anchor cell. */
export function bodyFor(view, type, cellX, cellY, fp = { w: 1, h: 1 }) {
  const size = BODY[view][type];
  if (!size) return { x: cellX, y: cellY, w: fp.w, h: fp.h };
  const [w, h] = size;
  if (view === 'side') return { x: cellX + (fp.w - w) / 2, y: cellY + fp.h - h, w, h };
  return { x: cellX + (fp.w - w) / 2, y: cellY + (fp.h - h) / 2, w, h };
}

/**
 * Pollen for the arcade maze: every open, non-path floor cell that the player can reach,
 * except under power jelly and warp flowers. Pure, so the editor can draw the same dots.
 */
export function mazeDots(level) {
  const { width: w, height: h, terrain } = level;
  const dots = new Uint8Array(w * h);
  const player = level.entities.find(e => e.type === 'player');
  const blocked = new Set(level.entities.filter(e => e.type === 'power' || e.type === 'teleporter' || e.type === 'gem' || e.type === 'player').map(e => e.y * w + e.x));
  const open = i => terrain[i] === 0 || terrain[i] === 21;
  let reach = null;
  if (player) {
    reach = new Uint8Array(w * h);
    const stack = [player.y * w + player.x];
    if (open(stack[0])) reach[stack[0]] = 1; else stack.length = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const wx = (nx + w) % w; // tunnels wrap left-right
        if (ny < 0 || ny >= h) continue;
        const j = ny * w + wx;
        if (!reach[j] && open(j)) { reach[j] = 1; stack.push(j); }
      }
    }
  }
  for (let i = 0; i < w * h; i++) if (terrain[i] === 0 && !blocked.has(i) && (!reach || reach[i])) dots[i] = 1;
  return dots;
}

/**
 * The part of a simulation every genre shares. A genre module calls this, then adds its own
 * fields and `step`. Entities become live objects:
 *   { id, type, x, y, w, h, vx, vy, facing, dir, anim, animTime, alive, active, open,
 *     hp, maxHp, props, cell: {x, y}, inputs, powered, data }
 * `facing` is 1 or -1 (side view); `dir` is 'up' | 'down' | 'left' | 'right' (top view).
 */
export function createBaseSim(project, levelIndex = 0, opts = {}) {
  const level = project.levels[levelIndex];
  if (!level) throw new Error(`No level ${levelIndex}`);
  const genre = project.genre, view = viewOf(genre);
  const W = level.width, H = level.height;
  const diff = DIFFICULTY[project.settings?.difficulty] || DIFFICULTY.normal;
  const sim = {
    genre, view, project, level, levelIndex,
    W, H,
    tiles: new Uint16Array(level.terrain),
    decor: level.decor,
    time: 0, tick: 0,
    status: 'play',               // 'play' | 'won' | 'dead' | 'timeout'
    rng: makeRng(opts.seed ?? hashString(level.id + ':' + (opts.attempt || 0))),
    difficulty: diff,
    player: null,
    entities: [],
    projectiles: [],              // { x, y, vx, vy, r, owner: 'player' | 'enemy', kind, life }
    events: [],
    toggle: false,                // switch blocks: false = amber solid, true = ice-blue solid
    score: 0, coins: 0, coinsTotal: 0, gems: 0, gemsTotal: 0, kills: 0, enemiesTotal: 0,
    keys: { amber: 0, ice: 0, rose: 0 },
    message: null,                // { title, text } while standing at a sign or talking
    objective: { label: '', text: '', progress: 0 },
    checkpoint: null,             // { x, y } body position to respawn at
    trace: [],                    // [x, y, t] of the player every 6 steps
    deaths: [],                   // [{ x, y, t }]
    links: new Map(),             // source id -> [target ids]
    byId: new Map(),
    stats: { jumps: 0, hurt: 0, steps: 0 },
    emit(type, x = 0, y = 0, data = null) { sim.events.push({ ...(data || {}), type, x, y, t: sim.time }); },
    drainEvents() { const e = sim.events; sim.events = []; return e; },
  };
  const spawnCell = opts.spawn || null;
  for (const src of level.entities) {
    const def = entityDef(src.type);
    if (!def) continue;
    const fp = footprint(src);
    const body = bodyFor(view, src.type, src.x, src.y, fp);
    const ent = {
      id: src.id, type: src.type, ...body,
      vx: 0, vy: 0, facing: -1, dir: 'down', anim: 'idle', animTime: 0,
      alive: true, active: false, open: false,
      hp: src.props?.hp || 1, maxHp: src.props?.hp || 1,
      props: { ...src.props }, cell: { x: src.x, y: src.y }, fp,
      inputs: 0, powered: 0, data: {},
    };
    if (src.type === 'player') {
      if (spawnCell) Object.assign(ent, bodyFor(view, 'player', spawnCell.x, spawnCell.y));
      ent.facing = 1;
      ent.hearts = ent.maxHearts = project.settings?.hearts || 3;
      ent.invuln = 0;
      sim.player = ent;
      sim.byId.set(ent.id, ent);
      continue;
    }
    if (def.enemy) sim.enemiesTotal++;
    if (src.type === 'coin') sim.coinsTotal++;
    if (src.type === 'gem') sim.gemsTotal++;
    sim.entities.push(ent);
    sim.byId.set(ent.id, ent);
  }
  if (!sim.player) {
    const p = { id: 'player', type: 'player', ...bodyFor(view, 'player', 1, 1), vx: 0, vy: 0, facing: 1, dir: 'down', anim: 'idle', animTime: 0, alive: true, props: {}, cell: { x: 1, y: 1 }, data: {}, hearts: 3, maxHearts: 3, invuln: 0 };
    sim.player = p;
  }
  sim.checkpoint = { x: sim.player.x, y: sim.player.y };
  for (const k of level.links) {
    if (!sim.byId.has(k.from) || !sim.byId.has(k.to)) continue;
    if (!sim.links.has(k.from)) sim.links.set(k.from, []);
    sim.links.get(k.from).push(k.to);
    sim.byId.get(k.to).inputs++;
  }
  return sim;
}

/**
 * Turn a wire source on or off. Targets count their powered inputs; `onPower(target, on)` is
 * the genre's hook, called when a target's powered state flips between 0 and more.
 */
export function setSource(sim, source, on, onPower) {
  if (!!source.active === !!on) return;
  source.active = !!on;
  for (const id of sim.links.get(source.id) || []) {
    const t = sim.byId.get(id);
    if (!t) continue;
    const before = t.powered > 0;
    t.powered = Math.max(0, t.powered + (on ? 1 : -1));
    const after = t.powered > 0;
    if (before !== after && onPower) onPower(t, after);
  }
}

/** Tile code at a cell; `outside` is returned beyond the grid. */
export function tileAt(sim, x, y, outside = 0) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= sim.W || y >= sim.H) return outside;
  return sim.tiles[y * sim.W + x];
}
/** Whether a tile code is solid right now (switch blocks follow `sim.toggle`). */
export function isSolidCode(sim, code) {
  if (!code) return false;
  const t = tileByCode(code);
  if (!t) return false;
  if (t.toggle === 'A') return !sim.toggle;
  if (t.toggle === 'B') return sim.toggle;
  return !!t.solid;
}

/** Record the player's path for the editor's playtest trace. */
export function recordTrace(sim) {
  if (sim.tick % 6 === 0 && sim.player) sim.trace.push([+(sim.player.x + sim.player.w / 2).toFixed(2), +(sim.player.y + sim.player.h / 2).toFixed(2), +sim.time.toFixed(2)]);
  if (sim.trace.length > 20000) sim.trace.splice(0, 2000);
}

/** Collect a pickup: scores it, counts it, emits the event. */
export function collect(sim, ent) {
  if (!ent.alive) return;
  ent.alive = false;
  const cx = ent.x + ent.w / 2, cy = ent.y + ent.h / 2;
  if (ent.type === 'coin') { sim.coins++; sim.score += SCORE.coin; }
  else if (ent.type === 'gem') { sim.gems++; sim.score += SCORE.gem; }
  sim.emit(ent.type, cx, cy);
}

/** Damage the player (respecting invulnerability and shields). Returns true if it landed. */
export function hurtPlayer(sim, amount = 1, from = null) {
  const p = sim.player;
  if (sim.status !== 'play' || p.invuln > 0) return false;
  if (p.data.shield > 0) { p.data.shield = 0; p.invuln = 0.6; sim.emit('shieldBreak', p.x + p.w / 2, p.y + p.h / 2); return false; }
  const dmg = Math.max(1, Math.round(amount * sim.difficulty.damage));
  p.hearts = Math.max(0, p.hearts - dmg);
  p.invuln = sim.difficulty.invuln;
  sim.stats.hurt++;
  if (from) { const dx = p.x + p.w / 2 - (from.x + from.w / 2); p.data.knock = dx >= 0 ? 1 : -1; }
  sim.emit('hurt', p.x + p.w / 2, p.y + p.h / 2);
  if (p.hearts <= 0) killPlayer(sim);
  return true;
}
export function killPlayer(sim) {
  if (sim.status !== 'play') return;
  const p = sim.player;
  p.hearts = 0; p.anim = 'dead'; p.animTime = 0;
  sim.status = 'dead';
  sim.deaths.push({ x: +(p.x + p.w / 2).toFixed(2), y: +(p.y + p.h / 2).toFixed(2), t: +sim.time.toFixed(2) });
  sim.emit('die', p.x + p.w / 2, p.y + p.h / 2);
}
/** Back to the last lantern with full hearts; the level keeps what was collected. */
export function respawnPlayer(sim) {
  const p = sim.player;
  p.x = sim.checkpoint.x; p.y = sim.checkpoint.y;
  p.vx = p.vy = 0; p.hearts = p.maxHearts; p.invuln = 1.5; p.anim = 'idle'; p.animTime = 0; p.alive = true;
  sim.status = 'play';
  sim.emit('respawn', p.x + p.w / 2, p.y + p.h / 2);
}
export function win(sim) {
  if (sim.status !== 'play') return;
  sim.status = 'won';
  sim.player.anim = 'win'; sim.player.animTime = 0;
  sim.emit('win', sim.player.x + sim.player.w / 2, sim.player.y + sim.player.h / 2);
}

/** Time limit shared by every genre: 0 means none. */
export function tickTimer(sim) {
  const limit = sim.level.rules.timeLimit;
  if (limit > 0 && sim.status === 'play' && sim.time >= limit) {
    sim.status = 'timeout';
    sim.emit('timeout', sim.player.x, sim.player.y);
  }
}

/**
 * Stars for a finished level: one for finishing, one for every drop of honey (free when the
 * level has none), one for beating par (seconds, or moves in a puzzle) or, with no par set,
 * for finishing without taking a hit.
 */
export function starsFor(sim, par = 0) {
  if (sim.status !== 'won') return 0;
  let stars = 1;
  if (sim.coins >= sim.coinsTotal && sim.gems >= sim.gemsTotal) stars++;
  const measure = sim.genre === 'puzzle' ? sim.moves : sim.time;
  if (par > 0 ? measure <= par : sim.stats.hurt === 0) stars++;
  return stars;
}
