/**
 * The level analyser: every constraint the editor shows as an issue, and the facts it shows as
 * stats. It answers "can this level be played, and finished?" before anyone presses Play.
 *
 *   analyzeLevel(project, levelIndex) -> { issues, stats, reach, solver }
 *   analyzeProject(project)           -> { levels, errors, warnings, tips, issues }
 *   solvePuzzle(level, { maxNodes })  -> { solvable, moves, path, explored, capped }
 *   reachability(project, levelIndex) -> Uint8Array (1 = the player can get here)
 *
 * Severity is a promise about the level: an ERROR means it certainly cannot be finished (or
 * cannot run) and blocks export; a WARNING is very likely a mistake; a TIP is advice. The
 * platformer's reachability is an approximation of jumps and falls, so what it cannot prove
 * reachable is reported as a warning, never an error: it is generous by design (it assumes a
 * skilled player), because a false "unreachable" on a fine level would teach people to ignore it.
 *
 * Issue ids are stable for an unchanged problem (`goal-unreachable`, `buried:<entity id>`) so the
 * panel can keep focus and animate only what changed.
 */
import { entityDef, footprint, LIMITS, viewOf, WIN_RULES } from './catalog.js';
import { flood } from './grid.js';

const TOP_WALK = new Set([0, 21, 23, 25, 27, 29]);
const SIDE_SOLID = new Set([1, 2, 4, 5]);

export function analyzeLevel(project, levelIndex = 0, opts = {}) {
  const level = project.levels[levelIndex];
  const genre = project.genre, view = viewOf(genre);
  const W = level.width, H = level.height, T = level.terrain;
  const issues = [];
  const add = (id, severity, message, at = null, entityId = null) => issues.push({ id, severity, message, at, entityId });
  const ents = level.entities;
  const of = type => ents.filter(e => e.type === type);
  const name = e => entityDef(e.type)?.name.toLowerCase() || e.type;
  const players = of('player');
  const player = players[0] || null;
  const rule = level.rules.win;

  // ---------------------------------------------------------------- basics
  if (!player) add('no-player', 'error', 'Place a player start: nothing can begin without one.');
  const enemies = ents.filter(e => entityDef(e.type)?.enemy);
  const spawners = of('spawner');
  if (ents.length > LIMITS.entities) add('budget-entities', 'error', `This level holds ${ents.length} parts; the most is ${LIMITS.entities}.`);
  if (enemies.length > LIMITS.enemies) add('budget-enemies', 'error', `This level holds ${enemies.length} critters; the most is ${LIMITS.enemies}.`);
  if (level.links.length > LIMITS.links) add('budget-links', 'error', `This level holds ${level.links.length} wires; the most is ${LIMITS.links}.`);

  const solidAt = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return view === 'top';
    const c = T[y * W + x];
    if (view === 'side') return SIDE_SOLID.has(c) || c === 9;
    return c === 20 || c === 24 || c === 28;
  };
  for (const e of ents) {
    const def = entityDef(e.type);
    if (!def) continue;
    const fp = footprint(e);
    let buried = false;
    for (let y = e.y; y < e.y + fp.h && !buried; y++) for (let x = e.x; x < e.x + fp.w; x++) if (solidAt(x, y)) { buried = true; break; }
    if (e.type === 'platform') continue;
    if (buried) {
      if (e.type === 'player') add('player-buried', 'error', 'The player start is inside a solid tile.', { x: e.x, y: e.y }, e.id);
      else if (view === 'top' && genre === 'maze' && e.type === 'bee' && T[e.y * W + e.x] === 28) { /* a bee on its own gate is fine */ }
      else add(`buried:${e.id}`, 'warning', `This ${name(e)} is inside a solid tile.`, { x: e.x, y: e.y }, e.id);
    }
    if ((e.type === 'sign' || e.type === 'npc') && !String(e.props.text || '').trim()) add(`silent:${e.id}`, 'warning', `This ${name(e)} has nothing to say. Give it a line.`, { x: e.x, y: e.y }, e.id);
  }

  // ---------------------------------------------------------------- wires and locks
  const byId = new Map(ents.map(e => [e.id, e]));
  const inputs = new Map();
  for (const k of level.links) { if (!inputs.has(k.to)) inputs.set(k.to, []); inputs.get(k.to).push(byId.get(k.from)); }
  for (const e of of('switch')) if (!level.links.some(k => k.from === e.id)) add(`lever-unwired:${e.id}`, 'warning', 'This lever is not wired to anything. Use the wire tool to connect it.', { x: e.x, y: e.y }, e.id);
  for (const e of of('plate')) if (!level.links.some(k => k.from === e.id)) add(`plate-unwired:${e.id}`, 'tip', 'This pressure plate is not wired to anything.', { x: e.x, y: e.y }, e.id);
  for (const d of of('door')) if ((d.props.lock || 'none') === 'none' && !inputs.has(d.id)) add(`door-never:${d.id}`, 'warning', 'This gate has no lock and no wire, so it never opens.', { x: d.x, y: d.y }, d.id);
  const keyCount = { amber: 0, ice: 0, rose: 0 };
  for (const k of of('key')) keyCount[k.props.color || 'amber']++;
  for (const c of of('chest')) { const m = /^key-(\w+)$/.exec(c.props.contains || ''); if (m) keyCount[m[1]]++; }
  const doorCount = { amber: 0, ice: 0, rose: 0 };
  for (const d of of('door')) { const l = d.props.lock || 'none'; if (l !== 'none' && !inputs.has(d.id)) doorCount[l]++; }
  for (const c of Object.keys(doorCount)) {
    if (doorCount[c] > keyCount[c]) {
      const d = of('door').find(o => o.props.lock === c && !inputs.has(o.id));
      add(`keys-short:${c}`, 'warning', keyCount[c] ? `${doorCount[c]} ${c} gates but only ${keyCount[c]} ${c} key${keyCount[c] === 1 ? '' : 's'}.` : `This gate needs ${c === 'amber' ? 'an' : 'a'} ${c} key; none is placed.`, d ? { x: d.x, y: d.y } : null, d?.id);
    }
  }
  for (const e of of('teleporter')) {
    const mates = of('teleporter').filter(o => (o.props.channel || 1) === (e.props.channel || 1));
    if (mates.length < 2) add(`warp-alone:${e.id}`, 'warning', `This warp flower has no partner on channel ${e.props.channel || 1}.`, { x: e.x, y: e.y }, e.id);
  }
  if (genre === 'platformer') for (const p of of('platform')) {
    const w = p.props.width || 3, d = p.props.distance || 5;
    let blocked = false;
    if (p.props.axis === 'y') { for (let y = p.y; y <= p.y + d && !blocked; y++) for (let x = p.x; x < p.x + w; x++) if (solidAt(x, y)) { blocked = true; break; } }
    else { for (let x = p.x; x < p.x + w + d && !blocked; x++) if (solidAt(x, p.y)) blocked = true; }
    if (blocked) add(`track-blocked:${p.id}`, 'warning', 'This platform\'s track runs through solid tiles; it will pass through them.', { x: p.x, y: p.y }, p.id);
  }

  // ---------------------------------------------------------------- win-rule prerequisites
  const gems = of('gem'), coins = of('coin'), goals = of('goal');
  if (rule === 'goal' && !goals.length) add('no-goal', 'error', `The win rule is "${WIN_RULES.goal.label}" but there is no goal shrine.`);
  if (rule === 'collect' && !gems.length) add('no-gems', 'error', 'The win rule is "Collect every jar" but there are no honey jars.');
  if (rule === 'defeat' && !enemies.length && !spawners.length) add('no-enemies', 'error', 'The win rule is "Defeat every critter" but there are none to defeat.');
  if (rule === 'waves' && !spawners.length) add('no-spawners', enemies.length ? 'warning' : 'error', enemies.length ? 'No burrows to release waves: the level is won by defeating the critters placed.' : 'The win rule is "Clear every wave" but there are no burrows and no critters.');
  if (rule === 'survive' && !enemies.length && !spawners.length) add('survive-empty', 'warning', 'Nothing threatens the player: surviving is guaranteed.');

  // ---------------------------------------------------------------- reachability
  let reach = null, route = null, solver = null, par = null;
  if (player) {
    if (genre === 'platformer') {
      const r = platformerReach(level);
      reach = r.touched;
      route = r.route;
      const touched = (e, pad = 0) => { const fp = footprint(e); for (let y = e.y - pad; y < e.y + fp.h + pad; y++) for (let x = e.x - pad; x < e.x + fp.w + pad; x++) if (x >= 0 && y >= 0 && x < W && y < H && reach[y * W + x]) return true; return false; };
      reachChecks(touched);
    } else if (genre === 'maze') {
      const r = mazeReach(level);
      reach = r.reach;
      const dots = r.dots;
      if (!dots) add('no-dots', 'error', 'There is no pollen to eat: open floor cells hold it.');
      for (const b of of('bee')) if (!r.beeFree(b)) add(`bee-stuck:${b.id}`, 'warning', 'This bee can never leave its hive. Open a gate or a path.', { x: b.x, y: b.y }, b.id);
      if (!of('bee').length) add('no-bees', 'tip', 'No bees: add a few so there is something to evade.');
      if (!of('power').length && of('bee').length) add('no-jelly', 'tip', 'Royal jelly in the corners lets players turn on the bees.');
      route = { length: dots, seconds: Math.round(dots / 4.5) };
    } else if (genre === 'puzzle') {
      const pads = T.reduce((n, c) => n + (c === 27 ? 1 : 0), 0);
      const crates = of('crate').length;
      if (!pads) add('no-pads', 'error', 'Place at least one crate pad; covering them all wins.');
      else if (crates < pads) add('crates-short', 'error', `${pads} pads but only ${crates} crate${crates === 1 ? '' : 's'}.`);
      else if (crates > pads) add('crates-extra', 'tip', `${crates - pads} spare crate${crates - pads === 1 ? '' : 's'}: fine, but spares make it easier.`);
      if (pads && crates >= pads && opts.solve !== false) {
        solver = solvePuzzle(level, { maxNodes: opts.maxNodes || 250000 });
        if (solver.solvable === true) {
          par = solver.moves;
          const set = level.rules.par || 0;
          if (!set) add('solved', 'tip', `Solvable in ${solver.moves} moves. Set par to ${solver.moves} for a tough third star.`);
          else if (set < solver.moves) add('par-impossible', 'warning', `Par is ${set} moves but the best solution takes ${solver.moves}: nobody can earn the third star.`, null);
          else if (set > solver.moves * 2) add('par-loose', 'tip', `Par is ${set} moves; the best solution takes ${solver.moves}. A tighter par makes the third star count.`);
        }
        else if (solver.solvable === false) add('unsolvable', 'error', 'No sequence of moves covers every pad. Move a crate or a wall.');
        else add('solver-capped', 'warning', `Too many positions to prove it solvable (checked ${solver.explored.toLocaleString('en')}). Playtest it.`);
      }
      reach = topReach(level, genre).reach;
    } else {
      const r = topReach(level, genre);
      reach = r.reach;
      route = r.route;
      const touched = (e, pad = 1) => { const fp = footprint(e); for (let y = e.y - pad; y < e.y + fp.h + pad; y++) for (let x = e.x - pad; x < e.x + fp.w + pad; x++) if (x >= 0 && y >= 0 && x < W && y < H && reach[y * W + x]) return true; return false; };
      reachChecks(touched);
    }
  }

  function reachChecks(touched) {
    const sev = genre === 'platformer' ? 'warning' : 'error';
    if (rule === 'goal' && goals.length && !goals.some(g => touched(g, genre === 'platformer' ? 1 : 1))) {
      add('goal-unreachable', sev, genre === 'platformer' ? 'The shrine looks out of reach from the start. Check the jumps on the way.' : 'The shrine is out of reach from the start.', { x: goals[0].x, y: goals[0].y }, goals[0].id);
    }
    const lostGems = gems.filter(g => !touched(g, genre === 'platformer' ? 1 : 0));
    if (lostGems.length) add('gems-unreachable', rule === 'collect' ? sev : 'warning', `${lostGems.length} honey jar${lostGems.length === 1 ? ' looks' : 's look'} out of reach.`, { x: lostGems[0].x, y: lostGems[0].y }, lostGems[0].id);
    const lostCoins = coins.filter(c => !touched(c, genre === 'platformer' ? 1 : 0));
    if (lostCoins.length) add('coins-unreachable', 'warning', `${lostCoins.length} honey drop${lostCoins.length === 1 ? ' looks' : 's look'} out of reach: the second star needs them all.`, { x: lostCoins[0].x, y: lostCoins[0].y }, lostCoins[0].id);
    for (const k of of('key')) if (!touched(k, genre === 'platformer' ? 1 : 0)) add(`key-unreachable:${k.id}`, 'warning', 'This key looks out of reach.', { x: k.x, y: k.y }, k.id);
    for (const s of of('switch')) if (!touched(s, genre === 'platformer' ? 1 : 1)) add(`lever-unreachable:${s.id}`, 'warning', 'This lever looks out of reach.', { x: s.x, y: s.y }, s.id);
    if (rule === 'defeat') for (const e of enemies) if (!touched(e, 2) && e.type !== 'spirit' && e.type !== 'bee') add(`enemy-unreachable:${e.id}`, 'warning', `This ${name(e)} looks out of reach, and the win rule needs it defeated.`, { x: e.x, y: e.y }, e.id);
  }

  // ---------------------------------------------------------------- advice
  if (genre === 'platformer' && W >= 70 && !of('checkpoint').length) add('no-lanterns', 'tip', 'A long level with no lanterns: add one midway so a fall does not send players back to the start.');
  if (['platformer', 'adventure', 'arena'].includes(genre) && !coins.length && !gems.length) add('no-honey', 'tip', 'Add honey drops to guide the eye and give players a star to chase.');
  if (level.rules.timeLimit > 0 && route && route.seconds && level.rules.timeLimit < route.seconds * 1.2) add('time-tight', 'warning', `The time limit (${level.rules.timeLimit} s) is tight for a route of about ${route.seconds} s.`);
  if (genre === 'adventure' && level.time === 'night' && level.rules.dark && !of('checkpoint').length) add('dark-no-lanterns', 'tip', 'A dark level: lanterns and lamp posts give players light to navigate by.');

  if (par === null && route) par = genre === 'puzzle' ? null : Math.max(10, Math.round(route.seconds * 1.6 / 5) * 5);
  const stats = {
    width: W, height: H,
    entities: ents.length, enemies: enemies.length, coins: coins.length, gems: gems.length, links: level.links.length,
    reachableCells: reach ? reach.reduce((a, b) => a + b, 0) : 0,
    budget: { entities: [ents.length, LIMITS.entities], enemies: [enemies.length, LIMITS.enemies], links: [level.links.length, LIMITS.links] },
    route, par, parUnit: genre === 'puzzle' ? 'moves' : 's',
  };
  const order = { error: 0, warning: 1, tip: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, stats, reach, solver };
}

export function analyzeProject(project, opts = {}) {
  const levels = project.levels.map((_, i) => analyzeLevel(project, i, opts));
  const issues = [];
  if (!String(project.title || '').trim()) issues.push({ id: 'no-title', severity: 'warning', message: 'Give the game a title; it goes on the title screen.' });
  let errors = 0, warnings = 0, tips = 0;
  for (const r of [...levels.map(l => l.issues).flat(), ...issues]) { if (r.severity === 'error') errors++; else if (r.severity === 'warning') warnings++; else tips++; }
  return { levels, errors, warnings, tips, issues };
}

export function reachability(project, levelIndex = 0) {
  const genre = project.genre, level = project.levels[levelIndex];
  if (genre === 'platformer') return platformerReach(level).touched;
  if (genre === 'maze') return mazeReach(level).reach;
  return topReach(level, genre).reach;
}

// =============================================================================================
// Platformer: a graph of standing spots joined by walks, falls, jumps, ladders, swims, springs
// and platform rides. Doors open when a key of their colour or a wired lever has been reached.

const JUMP_UP = 3, JUMP_UP_WINGS = 6;

export function platformerReach(level) {
  const W = level.width, H = level.height, T = level.terrain;
  const ents = level.entities;
  const player = ents.find(e => e.type === 'player');
  const touched = new Uint8Array(W * H);
  if (!player) return { touched, route: null };
  const hasSwitch = ents.some(e => e.type === 'bswitch');
  const doors = ents.filter(e => e.type === 'door');
  const openDoors = new Set();
  const links = level.links;

  let wings = false;
  let dist = null;
  for (let pass = 0; pass < 8; pass++) {
    const doorAt = new Map(doors.filter(d => !openDoors.has(d.id)).map(d => [d.y * W + d.x, d]));
    const solid = (x, y) => {
      if (x < 0 || x >= W) return true;
      if (y < 0 || y >= H) return false;
      const i = y * W + x, c = T[i];
      if (doorAt.has(i)) return true;
      if (c === 10) return false;
      if (c === 9) return !hasSwitch;
      return SIDE_SOLID.has(c);
    };
    const supportTop = (x, y) => {
      if (y >= H) return false;
      if (x < 0 || x >= W) return false;
      const c = T[y * W + x];
      if (SIDE_SOLID.has(c) || c === 3 || c === 9 || c === 10 || doorAt.has(y * W + x)) return true;
      if (c === 7) return y === 0 || T[(y - 1) * W + x] !== 7;
      return false;
    };
    const ladder = (x, y) => x >= 0 && y >= 0 && x < W && y < H && T[y * W + x] === 7;
    const water = (x, y) => x >= 0 && y >= 0 && x < W && y < H && T[y * W + x] === 8;
    const thorn = (x, y) => x >= 0 && y >= 0 && x < W && y < H && T[y * W + x] === 6;
    // standing spots: open cells over support, plus the tops of moving platform tracks and springs
    const stand = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!solid(x, y) && !thorn(x, y) && supportTop(x, y + 1)) stand[y * W + x] = 1;
    const rides = [];
    for (const p of ents.filter(e => e.type === 'platform')) {
      const w = p.props.width || 3, d = p.props.distance || 5, cells = [];
      if (p.props.axis === 'y') { for (let k = 0; k <= d; k++) for (let x = p.x; x < p.x + w; x++) cells.push([x, p.y - 1 + k]); }
      else { for (let k = 0; k <= d; k++) for (let x = p.x + k; x < p.x + k + w; x++) cells.push([x, p.y - 1]); }
      const idxs = cells.filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H).map(([x, y]) => y * W + x);
      for (const i of idxs) stand[i] = 1;
      rides.push(idxs);
    }
    const springs = new Map(ents.filter(e => e.type === 'spring').map(s => [s.y * W + s.x, s.props.power || 7]));
    for (const i of springs.keys()) stand[i] = 1;

    const start = player.y * W + player.x;
    dist = new Float32Array(W * H).fill(Infinity);
    const queue = [];
    const visit = (i, d) => { if (d < dist[i]) { dist[i] = d; queue.push(i); } };
    // the player may start in the air: fall to the first support
    let sx = player.x, sy = player.y;
    while (sy < H - 1 && !stand[sy * W + sx] && !ladder(sx, sy) && !water(sx, sy) && !solid(sx, sy + 1)) { touched[sy * W + sx] = 1; sy++; }
    visit(sy * W + sx, 0);
    touched[start] = 1;

    const up = wings ? JUMP_UP_WINGS : JUMP_UP;
    const arcClear = (x0, y0, x1, y1, peak) => {
      // sample a parabola from (x0, y0) to (x1, y1) peaking `peak` above the higher end
      const top = Math.min(y0, y1) - peak;
      const steps = Math.max(4, Math.abs(x1 - x0) * 3 + Math.abs(y1 - y0) * 2);
      const cells = [];
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = x0 + (x1 - x0) * t;
        // quadratic through (0, y0), (tm, top), (1, y1) with the apex where it rises then falls
        const a = y0 + (y1 - y0) * t;
        const bulge = 4 * t * (1 - t) * (Math.min(y0, y1) - top);
        const y = a - bulge;
        const cx = Math.round(x), cy = Math.round(y);
        if (solid(cx, cy)) return null;
        cells.push(cy * W + cx);
      }
      return cells;
    };
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % W, y = (i - x) / W, d = dist[i];
      touched[i] = 1;
      if (y > 0) touched[i - W] = 1;
      // walk
      for (const dx of [-1, 1]) {
        const nx = x + dx;
        if (solid(nx, y) || nx < 0 || nx >= W) continue;
        if (stand[y * W + nx] || ladder(nx, y) || water(nx, y)) visit(y * W + nx, d + 1);
        else {
          // walk off a ledge: fall straight down (with the arcs below covering drift)
          let fy = y;
          while (fy < H - 1 && !stand[fy * W + nx] && !ladder(nx, fy) && !water(nx, fy) && !solid(nx, fy + 1)) { touched[fy * W + nx] = 1; fy++; }
          if (fy < H && !solid(nx, fy) && (stand[fy * W + nx] || ladder(nx, fy) || water(nx, fy))) visit(fy * W + nx, d + 1 + (fy - y) * 0.3);
        }
      }
      // ladders: climb up and down
      if (ladder(x, y) || ladder(x, y + 1)) {
        for (const dy of [-1, 1]) { const ny = y + dy; if (ny >= 0 && ny < H && !solid(x, ny) && (ladder(x, ny) || stand[ny * W + x] || ladder(x, ny + 1))) visit(ny * W + x, d + 1); }
      }
      // water: swim in every direction
      if (water(x, y)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (!solid(nx, ny) && ny >= 0 && ny < H && nx >= 0 && nx < W) visit(ny * W + nx, d + 1.5); }
      // riding a platform: every cell of its track is one ride away
      for (const r of rides) if (r.includes(i)) for (const j of r) visit(j, d + 1);
      // jumps and drops
      const canJump = stand[i] || ladder(x, y) || water(x, y);
      if (!canJump) continue;
      const spring = springs.get(i);
      const hUp = spring ? spring + 0.5 : water(x, y) ? 2.5 : up;
      const reachX = spring ? 4 : wings ? 7 : 5;
      for (let dy = -Math.floor(hUp); dy <= 12; dy++) {
        const maxDx = dy < 0 ? Math.max(1, Math.round(reachX - 0.5 + (dy + hUp) * 0.5)) : Math.min(9, Math.round(reachX + dy * 0.6));
        for (let dx = -maxDx; dx <= maxDx; dx++) {
          if (!dx && dy >= 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          if (!(stand[j] || ladder(nx, ny) || water(nx, ny))) continue;
          if (dist[j] <= d + 1) continue;
          // headroom straight up for the rise, then the arc
          let ok = true;
          const rise = Math.max(0, -dy) + 1;
          for (let k = 1; k <= Math.min(rise, Math.ceil(hUp)); k++) if (solid(x, y - k)) { ok = false; break; }
          if (!ok && dy < 0) continue;
          // a low arc proves the jump possible under a ceiling; a full-height arc shows what the
          // player's body sweeps on the way (honey above a gap is collected by jumping for it)
          const low = arcClear(x, y, nx, ny, dy < 0 ? 0.8 : 1);
          const high = arcClear(x, y, nx, ny, Math.max(1, hUp - Math.max(0, -dy)));
          if (!low && !high) continue;
          for (const arc of [low, high]) if (arc) for (const c of arc) { touched[c] = 1; if (c >= W) touched[c - W] = 1; }
          visit(j, d + Math.abs(dx) + Math.abs(dy) * 0.5 + 1);
        }
      }
      // the air above a standing spot is touchable up to the jump height
      for (let k = 1; k <= Math.ceil(hUp); k++) { if (y - k < 0 || solid(x, y - k)) break; touched[(y - k) * W + x] = 1; }
    }
    // unlock what the reached part of the level can open
    let changed = false;
    const reachedEnt = e => { const fp = footprint(e); for (let yy = e.y - 1; yy <= e.y + fp.h; yy++) for (let xx = e.x - 1; xx <= e.x + fp.w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H && touched[yy * W + xx]) return true; return false; };
    const keys = { amber: 0, ice: 0, rose: 0 };
    for (const k of ents.filter(e => e.type === 'key')) if (reachedEnt(k)) keys[k.props.color || 'amber']++;
    for (const dr of doors) {
      if (openDoors.has(dr.id)) continue;
      const lock = dr.props.lock || 'none';
      const wired = links.filter(k => k.to === dr.id).some(k => { const s = ents.find(e => e.id === k.from); return s && reachedEnt(s); });
      if (wired || (lock !== 'none' && keys[lock] > 0)) { openDoors.add(dr.id); if (lock !== 'none' && !wired) keys[lock]--; changed = true; }
    }
    if (!wings && ents.some(e => e.type === 'powerup' && e.props.kind === 'wings' && reachedEnt(e))) { wings = true; changed = true; }
    if (!changed) break;
  }
  const goal = ents.find(e => e.type === 'goal');
  let route = null;
  if (goal) {
    let best = Infinity;
    for (let yy = goal.y - 1; yy <= goal.y + 1; yy++) for (let xx = goal.x - 1; xx <= goal.x + 1; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) best = Math.min(best, dist[yy * W + xx]);
    if (best < Infinity) route = { length: Math.round(best), seconds: Math.max(3, Math.round(best / 5.5)) };
  }
  return { touched, route };
}

// =============================================================================================
// Top view: a flood fill that opens gates as their keys, levers and plates come within reach.

export function topReach(level, genre) {
  const W = level.width, H = level.height, T = level.terrain;
  const ents = level.entities;
  const player = ents.find(e => e.type === 'player');
  const reach = new Uint8Array(W * H);
  if (!player) return { reach, route: null };
  const blocking = new Map();
  for (const e of ents) if (['chest', 'npc', 'turret', 'spawner'].includes(e.type)) blocking.set(e.y * W + e.x, e);
  const doors = ents.filter(e => e.type === 'door');
  const open = new Set();
  let mask = null;
  // crates can fill pits: with crates about, count pits as crossable (a generous approximation)
  const pitsCross = genre !== 'puzzle' && ents.some(e => e.type === 'crate');
  const walk = c => TOP_WALK.has(c) || (pitsCross && c === 26);
  for (let pass = 0; pass < 10; pass++) {
    const closed = new Set(doors.filter(d => !open.has(d.id)).map(d => d.y * W + d.x));
    mask = flood(T, W, H, player.x, player.y, (c, i) => walk(c) && !closed.has(i) && !blocking.has(i));
    // warp flowers join their channel
    const flowers = ents.filter(e => e.type === 'teleporter');
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of flowers) {
        if (!mask[f.y * W + f.x]) continue;
        for (const g of flowers) {
          if ((g.props.channel || 1) !== (f.props.channel || 1) || mask[g.y * W + g.x]) continue;
          const more = flood(T, W, H, g.x, g.y, (c, i) => walk(c) && !closed.has(i) && !blocking.has(i));
          for (let i = 0; i < more.length; i++) if (more[i]) mask[i] = 1;
          grew = true;
        }
      }
    }
    const near = e => { for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = e.x + dx, y = e.y + dy; if (x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x]) return true; } return false; };
    const keys = { amber: 0, ice: 0, rose: 0 };
    for (const k of ents) {
      if (k.type === 'key' && mask[k.y * W + k.x]) keys[k.props.color || 'amber']++;
      if (k.type === 'chest' && near(k)) { const m = /^key-(\w+)$/.exec(k.props.contains || ''); if (m) keys[m[1]]++; }
    }
    for (const d of doors) if (open.has(d.id) && (d.props.lock || 'none') !== 'none') keys[d.props.lock]--;
    let changed = false;
    for (const d of doors) {
      if (open.has(d.id)) continue;
      const lock = d.props.lock || 'none';
      const sources = level.links.filter(k => k.to === d.id).map(k => ents.find(e => e.id === k.from)).filter(Boolean);
      const wired = sources.some(s => (s.type === 'spawner' ? true : s.type === 'plate' ? mask[s.y * W + s.x] || near(s) : near(s)));
      if (!near(d) && !wired) continue;
      if (wired || (lock !== 'none' && keys[lock] > 0)) { open.add(d.id); if (!wired && lock !== 'none') keys[lock]--; changed = true; }
    }
    if (!changed) break;
  }
  for (let i = 0; i < mask.length; i++) reach[i] = mask[i];
  const goal = ents.find(e => e.type === 'goal');
  let route = null;
  if (goal) {
    // breadth-first distance to the goal over the final mask (and the goal's own cell)
    const dist = new Int32Array(W * H).fill(-1);
    const s = player.y * W + player.x;
    dist[s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % W, y = (i - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (dist[j] >= 0 || !(mask[j] || j === goal.y * W + goal.x)) continue;
        dist[j] = dist[i] + 1; q.push(j);
      }
    }
    const d = dist[goal.y * W + goal.x];
    if (d >= 0) route = { length: d, seconds: Math.max(3, Math.round(d / 4.5)) };
  }
  return { reach, route };
}

// =============================================================================================
// Maze: open cells from the player, with tunnels wrapping left to right; hives reach out
// through their gates.

export function mazeReach(level) {
  const W = level.width, H = level.height, T = level.terrain;
  const player = level.entities.find(e => e.type === 'player');
  const reach = new Uint8Array(W * H);
  const walk = (sx, sy, pass) => {
    const m = new Uint8Array(W * H);
    if (!pass(T[sy * W + sx])) return m;
    const st = [sy * W + sx]; m[st[0]] = 1;
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + W) % W, ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (!m[j] && pass(T[j])) { m[j] = 1; st.push(j); }
      }
    }
    return m;
  };
  if (player) { const m = walk(player.x, player.y, c => c !== 20 && c !== 28); for (let i = 0; i < m.length; i++) reach[i] = m[i]; }
  let dots = 0;
  const blocked = new Set(level.entities.filter(e => ['power', 'teleporter', 'gem', 'player'].includes(e.type)).map(e => e.y * W + e.x));
  for (let i = 0; i < W * H; i++) if (reach[i] && T[i] === 0 && !blocked.has(i)) dots++;
  const beeFree = b => { const m = walk(b.x, b.y, c => c !== 20); for (let i = 0; i < m.length; i++) if (m[i] && reach[i]) return true; return false; };
  return { reach, dots, beeFree };
}

// =============================================================================================
// Puzzle solver: breadth-first search over whole positions (player cell, crates, filled pits,
// keys held, gates unlocked), so the first solution found is the fewest moves. The rules mirror
// runtime/sims/puzzle.js exactly: pushes, ice slides for crates and the player, pits filled by
// crates, keys and locked gates, gates wired to plates (open while a crate holds the plate; a
// plate held only by the player is treated as up, which never makes a solvable level look
// unsolvable in practice), and warp flowers. Positions with a crate stuck in a corner that is not
// a pad are pruned.

export function solvePuzzle(level, opts = {}) {
  const maxNodes = opts.maxNodes || 250000;
  const W = level.width, H = level.height;
  const T0 = level.terrain;
  const ents = level.entities;
  const player = ents.find(e => e.type === 'player');
  const crates0 = ents.filter(e => e.type === 'crate').map(e => e.y * W + e.x);
  const pads = [];
  for (let i = 0; i < W * H; i++) if (T0[i] === 27) pads.push(i);
  if (!player || !pads.length) return { solvable: false, moves: 0, path: '', explored: 0, capped: false };
  const pits = []; for (let i = 0; i < W * H; i++) if (T0[i] === 26) pits.push(i);
  const pitBit = new Map(pits.map((p, k) => [p, k]));
  const keysE = ents.filter(e => e.type === 'key');
  const keyAt = new Map(keysE.map((k, n) => [k.y * W + k.x, n]));
  const doorsE = ents.filter(e => e.type === 'door');
  const doorAt = new Map(doorsE.map((d, n) => [d.y * W + d.x, n]));
  const doorPlates = doorsE.map(d => level.links.filter(k => k.to === d.id).map(k => ents.find(e => e.id === k.from)).filter(e => e && e.type === 'plate').map(e => e.y * W + e.x));
  const warps = ents.filter(e => e.type === 'teleporter');
  const warpTo = new Map();
  for (const w of warps) {
    const mates = warps.filter(o => (o.props.channel || 1) === (w.props.channel || 1));
    if (mates.length > 1) warpTo.set(w.y * W + w.x, mates[(mates.indexOf(w) + 1) % mates.length]);
  }
  const hasPits = pits.length > 0;
  const wall = i => T0[i] === 20;
  // Dead cells: a crate pushed into a wall corner can never leave it, so unless that corner is
  // somewhere a crate is meant to rest (a pad, a pit it fills, a plate that opens a gate) the
  // position is lost and not worth exploring.
  const dead = new Uint8Array(W * H);
  const restOk = new Set(ents.filter(e => e.type === 'plate').map(e => e.y * W + e.x));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (T0[i] === 27 || T0[i] === 26 || wall(i) || restOk.has(i)) continue;
    const w = (xx, yy) => xx < 0 || yy < 0 || xx >= W || yy >= H || wall(yy * W + xx);
    if ((w(x, y - 1) || w(x, y + 1)) && (w(x - 1, y) || w(x + 1, y))) dead[i] = 1;
  }
  const DIRS = [[0, -1, 'U'], [0, 1, 'D'], [-1, 0, 'L'], [1, 0, 'R']];
  // Filled pits, taken keys and unlocked gates are bit sets held as arrays of 32-bit words, so
  // any count is exact: a single integer would alias bit 32 onto bit 0 (shift counts are mod 32)
  // and merge states that differ. A state copies a set only when it changes it.
  const bits = n => new Array(Math.max(1, Math.ceil(n / 32))).fill(0);
  const has = (set, n) => (set[n >> 5] >>> (n & 31)) & 1;
  const withBit = (set, n) => { const out = set.slice(); out[n >> 5] |= 1 << (n & 31); return out; };
  const start = { p: player.y * W + player.x, crates: crates0.slice().sort((a, b) => a - b), filled: bits(pits.length), keys: [0, 0, 0], taken: bits(keysE.length), unlocked: bits(doorsE.length), warp: false };
  const COLORS = { amber: 0, ice: 1, rose: 2 };
  const encode = s => `${s.p}|${s.crates.join(',')}|${s.filled.join(',')}|${s.keys.join('')}|${s.taken.join(',')}|${s.unlocked.join(',')}|${s.warp ? 1 : 0}`;
  const tileOf = (s, i) => { const c = T0[i]; if (c === 26 && hasPits && has(s.filled, pitBit.get(i))) return 0; return c; };
  const doorOpen = (s, n) => has(s.unlocked, n) === 1 || doorPlates[n].some(pl => s.crates.includes(pl));
  const blockedDoor = (s, i) => { const n = doorAt.get(i); return n !== undefined && !doorOpen(s, n); };
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const FLOOR = c => c === 0 || c === 21 || c === 25 || c === 27;
  const CRATE_OK = c => FLOOR(c) || c === 26;

  function step(s, dx, dy) {
    const px = s.p % W, py = (s.p - px) / W;
    const tx = px + dx, ty = py + dy;
    if (!inb(tx, ty)) return null;
    const ti = ty * W + tx;
    if (!FLOOR(tileOf(s, ti))) return null;
    const n = { p: s.p, crates: s.crates, filled: s.filled, keys: s.keys, taken: s.taken, unlocked: s.unlocked, warp: s.warp };
    const dn = doorAt.get(ti);
    let unlockDoor = -1;
    if (dn !== undefined && !doorOpen(s, dn)) {
      const lock = COLORS[doorsE[dn].props.lock];
      if (lock === undefined || s.keys[lock] <= 0) return null;
      unlockDoor = dn;
    }
    const ci = s.crates.indexOf(ti);
    if (ci >= 0) {
      let cx = tx + dx, cy = ty + dy;
      const ok = i => { const c = tileOf(n, i); return CRATE_OK(c) && !s.crates.includes(i) && !blockedDoor(s, i) && !keyAt.has(i) || false; };
      if (!inb(cx, cy) || !ok(cy * W + cx) || (keyAt.has(cy * W + cx) && !has(s.taken, keyAt.get(cy * W + cx)))) return null;
      while (tileOf(s, cy * W + cx) === 25 && inb(cx + dx, cy + dy) && ok((cy + dy) * W + cx + dx) && tileOf(s, (cy + dy) * W + cx + dx) !== 26) { cx += dx; cy += dy; }
      if (tileOf(s, cy * W + cx) === 25 && inb(cx + dx, cy + dy) && tileOf(s, (cy + dy) * W + cx + dx) === 26 && ok((cy + dy) * W + cx + dx)) { cx += dx; cy += dy; }
      const dest = cy * W + cx;
      const crates = s.crates.slice();
      if (tileOf(s, dest) === 26) { crates.splice(ci, 1); n.filled = withBit(s.filled, pitBit.get(dest)); }
      else { crates[ci] = dest; crates.sort((a, b) => a - b); if (dead[dest] && T0[dest] !== 27) return null; }
      n.crates = crates;
    }
    if (unlockDoor >= 0) { const lock = COLORS[doorsE[unlockDoor].props.lock]; n.keys = s.keys.slice(); n.keys[lock]--; n.unlocked = withBit(s.unlocked, unlockDoor); }
    let x = tx, y = ty;
    while (tileOf(n, y * W + x) === 25 && inb(x + dx, y + dy) && FLOOR(tileOf(n, (y + dy) * W + x + dx)) && !n.crates.includes((y + dy) * W + x + dx) && !blockedDoor(n, (y + dy) * W + x + dx)) { x += dx; y += dy; }
    n.p = y * W + x;
    const kn = keyAt.get(n.p);
    if (kn !== undefined && !has(n.taken, kn)) { n.taken = withBit(n.taken, kn); n.keys = n.keys.slice(); n.keys[COLORS[keysE[kn].props.color || 'amber']]++; }
    const w = warpTo.get(n.p);
    if (w && !s.warp) { const to = w.y * W + w.x; if (!n.crates.includes(to)) { n.p = to; n.warp = true; } }
    else if (!w) n.warp = false;
    return n;
  }
  const solved = s => pads.every(p => s.crates.includes(p));

  const seen = new Map();
  const startKey = encode(start);
  seen.set(startKey, null);
  let frontier = [[start, startKey]];
  let explored = 0;
  if (solved(start)) return { solvable: true, moves: 0, path: '', explored: 1, capped: false };
  while (frontier.length) {
    const next = [];
    for (const [s, key] of frontier) {
      for (const [dx, dy, ch] of DIRS) {
        const n = step(s, dx, dy);
        if (!n) continue;
        const k = encode(n);
        if (seen.has(k)) continue;
        seen.set(k, [key, ch]);
        explored++;
        if (solved(n)) {
          let path = '';
          let cur = k;
          while (seen.get(cur)) { const [prev, c] = seen.get(cur); path = c + path; cur = prev; }
          return { solvable: true, moves: path.length, path, explored, capped: false };
        }
        if (explored >= maxNodes) return { solvable: null, moves: 0, path: '', explored, capped: true };
        next.push([n, k]);
      }
    }
    frontier = next;
  }
  return { solvable: false, moves: 0, path: '', explored, capped: false };
}

export { TOP_WALK };
