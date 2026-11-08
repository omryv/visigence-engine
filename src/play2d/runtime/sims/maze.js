/**
 * Arcade maze: eat every pollen dot while the bees give chase; royal jelly turns the tables.
 *
 * Movement is grid-locked along cell centres. A turn you press early is remembered and taken at
 * the next junction where it is open, and within 0.22 tiles of a centre it is taken at once
 * (cornering), which is what makes steering feel crisp. Reversing is always instant. Rows
 * open at both edges are tunnels that wrap left to right.
 *
 * Bees leave the hive one at a time and alternate scatter (each to its own corner) and chase:
 *   hunter    heads for your cell
 *   ambusher  heads four cells ahead of you
 *   fickle    doubles the vector from the hunter to two cells ahead of you (it flanks)
 *   shy       chases until it is within eight cells, then loses its nerve for its corner
 * At a junction a bee never reverses; it takes the open way whose next cell is closest to its
 * target, ties broken up, left, down, right. Royal jelly frightens every bee out of the hive:
 * they turn round, slow down and wander, and eating them in one jelly scores 200, 400, 800, 1600.
 */
import { SCORE } from '../../core/catalog.js';
import { STEP, createBaseSim, recordTrace, win, tickTimer, overlaps, mazeDots, killPlayer } from './shared.js';

const DIRS = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] };
const ORDER = ['up', 'left', 'down', 'right'];
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const PHASES = [[7, 'scatter'], [20, 'chase'], [7, 'scatter'], [20, 'chase'], [5, 'scatter'], [Infinity, 'chase']];

export function createMazeSim(project, levelIndex = 0, opts = {}) {
  const sim = createBaseSim(project, levelIndex, opts);
  const W = sim.W, H = sim.H;
  const p = sim.player;
  sim.cameraHint = 'fit';
  sim.boss = null;
  sim.dots = mazeDots(sim.level);
  sim.dotsLeft = sim.dots.reduce((a, b) => a + b, 0);
  sim.dotsTotal = sim.dotsLeft;
  sim.powerLeft = 0;
  sim.mode = 'scatter';
  const diff = sim.difficulty;
  const P_SPEED = 5.5;
  const pd = p.data;

  const start = { x: Math.floor(p.x + p.w / 2), y: Math.floor(p.y + p.h / 2) };
  pd.cx = start.x + 0.5; pd.cy = start.y + 0.5; pd.dir = null; pd.want = null; pd.warpLock = null;

  const bees = sim.entities.filter(e => e.type === 'bee');
  const tempers = ['hunter', 'ambusher', 'fickle', 'shy'];
  bees.forEach((b, i) => {
    const d = b.data;
    d.home = { x: b.cell.x, y: b.cell.y };
    d.temper = b.props.temper || tempers[i % 4];
    d.corner = [[W - 2, -2], [1, -2], [W - 2, H + 1], [1, H + 1]][i % 4];
    d.speed = 5 * diff.speed * (0.8 + 0.1 * (b.props.speed || 2));
    resetBee(b, i);
  });
  let phase = 0, phaseT = 0, chain = 0;

  function resetBee(b, i) {
    const d = b.data;
    d.cx = d.home.x + 0.5; d.cy = d.home.y + 0.5; d.dir = 'up'; d.state = 'home';
    d.release = 1.2 + i * 2.8; d.fleeLeft = 0;
    b.anim = 'fly'; b.alive = true;
    sync(b, d);
  }
  function sync(e, d) { e.x = d.cx - e.w / 2; e.y = d.cy - e.h / 2; }

  // ------------------------------------------------------------------ the grid
  const wrapX = x => ((x % W) + W) % W;
  function passable(x, y, who) {
    if (y < 0 || y >= H) return false;
    const c = sim.tiles[y * W + wrapX(x)];
    if (c === 20) return false;
    if (c === 28) return who === 'leaving' || who === 'eaten';
    return true;
  }
  // The player's region: open cells reachable from the start without crossing a hive gate.
  const region = new Uint8Array(W * H);
  {
    const stack = [start.y * W + start.x];
    if (passable(start.x, start.y, 'player')) region[stack[0]] = 1; else stack.length = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = wrapX(x + dx), ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (!region[j] && passable(nx, ny, 'player')) { region[j] = 1; stack.push(j); }
      }
    }
  }
  /** Next direction from (x, y) toward the nearest cell satisfying `goal`, by breadth-first search. */
  function bfsDir(x, y, who, goal) {
    const prev = new Int32Array(W * H).fill(-1);
    const s = y * W + x;
    prev[s] = s;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const i = q[h], cx = i % W, cy = (i - cx) / W;
      if (i !== s && goal(cx, cy)) {
        let k = i;
        while (prev[k] !== s) k = prev[k];
        const kx = k % W, ky = (k - kx) / W;
        for (const n of ORDER) { const [dx, dy] = DIRS[n]; if (wrapX(x + dx) === kx && y + dy === ky) return n; }
        return null;
      }
      for (const n of ORDER) {
        const [dx, dy] = DIRS[n];
        const nx = wrapX(cx + dx), ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (prev[j] < 0 && passable(nx, ny, who)) { prev[j] = i; q.push(j); }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ the step
  sim.step = input => {
    sim.time += STEP; sim.tick++;
    p.animTime += STEP;
    for (const e of sim.entities) e.animTime += STEP;
    if (sim.status !== 'play') { if (sim.status === 'won') p.anim = 'win'; return; }
    // scatter / chase clock pauses while bees are frightened
    if (sim.powerLeft <= 0) {
      phaseT += STEP;
      if (phaseT >= PHASES[phase][0]) {
        phaseT = 0; phase = Math.min(PHASES.length - 1, phase + 1);
        sim.mode = PHASES[phase][1];
        for (const b of bees) if (b.data.state === 'active') b.data.dir = OPP[b.data.dir];
      }
    } else {
      sim.powerLeft -= STEP;
      if (sim.powerLeft <= 0) { sim.powerLeft = 0; chain = 0; sim.emit('powerEnd', pd.cx, pd.cy); for (const b of bees) if (b.data.state === 'frightened') b.data.state = 'active'; }
    }
    stepPlayer(input);
    for (let i = 0; i < bees.length; i++) stepBee(bees[i], i);
    collide();
    sim.objective = { label: 'Eat the pollen', text: `${sim.dotsLeft} left`, progress: sim.dotsTotal ? 1 - sim.dotsLeft / sim.dotsTotal : 1 };
    if (sim.dotsLeft === 0) win(sim);
    recordTrace(sim);
    tickTimer(sim);
  };

  function readDir(input) {
    const pr = input.pressed || {};
    for (const n of ['up', 'down', 'left', 'right']) if (pr[n]) return n;
    // held keys count too, favouring the one that is not the current direction
    const held = ['up', 'down', 'left', 'right'].filter(n => input[n]);
    if (held.length) return held.find(n => n !== pd.dir) || held[0];
    return null;
  }

  function stepPlayer(input) {
    const want = readDir(input);
    if (want) pd.want = want;
    const speed = P_SPEED * (sim.powerLeft > 0 ? 1.08 : 1);
    advance(pd, speed * STEP, 'player', () => pd.want);
    p.x = pd.cx - p.w / 2; p.y = pd.cy - p.h / 2;
    if (pd.dir) { p.dir = pd.dir; if (pd.dir === 'left') p.facing = -1; if (pd.dir === 'right') p.facing = 1; }
    const moving = pd.moving;
    const a = moving ? 'walk' : 'idle';
    if (p.anim !== a) { p.anim = a; p.animTime = 0; }
    // pollen
    const cx = Math.floor(pd.cx), cy = Math.floor(pd.cy);
    if (cy >= 0 && cy < H) {
      const i = cy * W + wrapX(cx);
      if (sim.dots[i] && Math.abs(pd.cx - (cx + 0.5)) < 0.4 && Math.abs(pd.cy - (cy + 0.5)) < 0.4) {
        sim.dots[i] = 0; sim.dotsLeft--; sim.score += SCORE.dot;
        sim.emit('dot', cx + 0.5, cy + 0.5);
      }
    }
    for (const e of sim.entities) {
      if (!e.alive || e.type === 'bee') continue;
      if (e.type === 'power' && overlaps(p, e)) {
        e.alive = false;
        sim.powerLeft = e.props.seconds || 7; chain = 0; sim.score += SCORE.power;
        for (const b of bees) { const d = b.data; if (d.state === 'active' || d.state === 'frightened') { d.state = 'frightened'; d.dir = OPP[d.dir]; } }
        sim.emit('power', e.x + e.w / 2, e.y + e.h / 2);
      } else if (e.type === 'gem' && overlaps(p, e)) {
        e.alive = false; sim.gems++; sim.score += SCORE.gem; sim.emit('gem', e.x + e.w / 2, e.y + e.h / 2);
      } else if (e.type === 'teleporter') {
        const inside = Math.abs(pd.cx - (e.cell.x + 0.5)) < 0.3 && Math.abs(pd.cy - (e.cell.y + 0.5)) < 0.3;
        if (pd.warpLock === e.id) { if (!inside) pd.warpLock = null; }
        else if (inside && !pd.warpLock) {
          const mates = sim.entities.filter(o => o.type === 'teleporter' && (o.props.channel || 1) === (e.props.channel || 1));
          if (mates.length > 1) {
            const to = mates[(mates.indexOf(e) + 1) % mates.length];
            pd.cx = to.cell.x + 0.5; pd.cy = to.cell.y + 0.5; pd.warpLock = to.id;
            sim.emit('teleport', pd.cx, pd.cy, { from: { x: e.cell.x + 0.5, y: e.cell.y + 0.5 } });
          }
        }
      }
    }
  }

  /**
   * Move an actor `dist` along its direction, turning at cell centres. `choose()` returns the
   * direction it wants at the next centre (or null to keep going). Handles wrap tunnels.
   */
  function advance(a, dist, who, choose) {
    a.moving = false;
    let guard = 0;
    while (dist > 1e-9 && guard++ < 8) {
      const cx = Math.floor(a.cx), cy = Math.floor(a.cy);
      const ox = a.cx - (cx + 0.5), oy = a.cy - (cy + 0.5);
      const want = choose();
      // instant reversal
      if (want && a.dir && want === OPP[a.dir]) a.dir = want;
      // early turn: within the cornering window of the centre and the wanted way is open
      if (want && want !== a.dir && Math.abs(ox) + Math.abs(oy) < (who === 'player' ? 0.22 : 0.001)) {
        const [dx, dy] = DIRS[want];
        if (passable(cx + dx, cy + dy, who)) { a.cx = cx + 0.5; a.cy = cy + 0.5; a.dir = want; }
      }
      if (!a.dir) {
        if (want) { const [dx, dy] = DIRS[want]; if (passable(cx + dx, cy + dy, who)) a.dir = want; }
        if (!a.dir) return;
      }
      const [dx, dy] = DIRS[a.dir];
      // distance to the next centre along the direction
      const along = dx ? (dx > 0 ? -ox : ox) : (dy > 0 ? -oy : oy);
      const toCenter = along > 1e-9 ? along : along + 1;
      const atCenter = Math.abs(along) < 1e-9;
      if (atCenter) {
        // at a centre: take the wanted turn if open, else continue if open, else stop
        if (want && want !== a.dir) { const [wx, wy] = DIRS[want]; if (passable(cx + wx, cy + wy, who)) { a.dir = want; continue; } }
        if (!passable(cx + dx, cy + dy, who)) { a.cx = cx + 0.5; a.cy = cy + 0.5; return; }
      }
      const step = Math.min(dist, atCenter ? 1 : toCenter);
      a.cx += dx * step; a.cy += dy * step;
      dist -= step;
      a.moving = true;
      if (a.cx < 0) a.cx += W; else if (a.cx >= W) a.cx -= W;
      // snap exactly onto centres we reach
      if (Math.abs(step - toCenter) < 1e-9 && !atCenter) { a.cx = Math.floor(a.cx) + 0.5; a.cy = Math.floor(a.cy) + 0.5; }
    }
  }

  function stepBee(b, i) {
    const d = b.data;
    if (d.state === 'home') {
      d.release -= STEP;
      d.cy = d.home.y + 0.5 + Math.sin(sim.time * 5 + i) * 0.12;
      sync(b, d);
      b.anim = sim.powerLeft > 0 ? 'flee' : 'fly';
      if (d.release <= 0) { d.cy = d.home.y + 0.5; d.state = 'leaving'; }
      return;
    }
    let speed = d.speed;
    if (d.state === 'frightened') speed *= 0.6;
    if (d.state === 'eaten') speed *= 1.7;
    const cx = Math.floor(d.cx), cy = Math.floor(d.cy);
    // tunnels slow bees down
    if (cy >= 0 && cy < H && (cx <= 0 || cx >= W - 1)) speed *= 0.6;
    const who = d.state === 'leaving' || d.state === 'eaten' ? d.state : 'bee';
    advance(d, speed * STEP, who, () => {
      const x = Math.floor(d.cx), y = Math.floor(d.cy);
      if (Math.abs(d.cx - (x + 0.5)) + Math.abs(d.cy - (y + 0.5)) > 1e-6) return null;
      if (d.state === 'leaving') {
        if (region[y * W + wrapX(x)]) { d.state = sim.powerLeft > 0 ? 'active' : 'active'; return pick(b, x, y); }
        return bfsDir(x, y, 'leaving', (gx, gy) => region[gy * W + gx] === 1) || d.dir;
      }
      if (d.state === 'eaten') {
        if (x === d.home.x && y === d.home.y) { d.state = 'leaving'; sim.emit('beeHome', d.cx, d.cy); return null; }
        return bfsDir(x, y, 'eaten', (gx, gy) => gx === d.home.x && gy === d.home.y) || d.dir;
      }
      return pick(b, x, y);
    });
    if (!d.moving && d.state !== 'home') {
      // boxed in (a dead end): turn round
      const x = Math.floor(d.cx), y = Math.floor(d.cy);
      const open = ORDER.filter(n => { const [dx, dy] = DIRS[n]; return passable(x + dx, y + dy, who); });
      if (open.length) d.dir = open[0];
    }
    d.fleeLeft = sim.powerLeft;
    b.anim = d.state === 'eaten' ? 'eaten' : d.state === 'frightened' ? 'flee' : 'fly';
    if (d.dir === 'left') b.facing = -1; else if (d.dir === 'right') b.facing = 1;
    b.dir = d.dir;
    sync(b, d);
  }

  /** The junction choice for an active or frightened bee at cell (x, y). */
  function pick(b, x, y) {
    const d = b.data;
    const options = ORDER.filter(n => n !== OPP[d.dir] && passable(x + DIRS[n][0], y + DIRS[n][1], 'bee'));
    if (!options.length) return OPP[d.dir];
    if (d.state === 'frightened') return options[Math.floor(sim.rng() * options.length)];
    const [tx, ty] = target(b);
    let best = options[0], bd = Infinity;
    for (const n of options) {
      const nx = x + DIRS[n][0], ny = y + DIRS[n][1];
      const dd = (nx - tx) ** 2 + (ny - ty) ** 2;
      if (dd < bd) { bd = dd; best = n; }
    }
    return best;
  }
  function target(b) {
    const d = b.data;
    const px = Math.floor(pd.cx), py = Math.floor(pd.cy);
    if (sim.mode === 'scatter') return d.corner;
    const [fx, fy] = pd.dir ? DIRS[pd.dir] : [0, 0];
    switch (d.temper) {
      case 'ambusher': return [px + fx * 4, py + fy * 4];
      case 'fickle': {
        const hunter = bees.find(o => o.data.temper === 'hunter') || b;
        const ax = px + fx * 2, ay = py + fy * 2;
        return [ax + (ax - Math.floor(hunter.data.cx)), ay + (ay - Math.floor(hunter.data.cy))];
      }
      case 'shy': {
        const dist = Math.hypot(d.cx - pd.cx, d.cy - pd.cy);
        return dist > 8 ? [px, py] : d.corner;
      }
      default: return [px, py];
    }
  }

  function collide() {
    for (const b of bees) {
      const d = b.data;
      if (d.state === 'home' || d.state === 'eaten' || sim.status !== 'play') continue;
      let dx = Math.abs(d.cx - pd.cx);
      dx = Math.min(dx, W - dx);
      if (dx < 0.6 && Math.abs(d.cy - pd.cy) < 0.6) {
        if (d.state === 'frightened') {
          const score = SCORE.beeEaten * 2 ** Math.min(3, chain);
          chain++;
          sim.score += score; sim.kills++;
          d.state = 'eaten';
          sim.emit('beeEaten', d.cx, d.cy, { score });
        } else {
          killPlayer(sim);
          sim.emit('caught', pd.cx, pd.cy);
          return;
        }
      }
    }
  }

  sim.respawn = () => {
    pd.cx = start.x + 0.5; pd.cy = start.y + 0.5; pd.dir = null; pd.want = null;
    p.x = pd.cx - p.w / 2; p.y = pd.cy - p.h / 2;
    p.hearts = p.maxHearts; p.anim = 'idle'; p.animTime = 0; p.invuln = 0;
    bees.forEach(resetBee);
    sim.powerLeft = 0; chain = 0; phase = 0; phaseT = 0; sim.mode = 'scatter';
    sim.status = 'play';
    sim.emit('respawn', pd.cx, pd.cy);
  };
  sim.objective = { label: 'Eat the pollen', text: `${sim.dotsLeft} left`, progress: 0 };
  return sim;
}
