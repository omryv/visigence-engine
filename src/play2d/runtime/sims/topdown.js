/**
 * The top-down engine behind Adventure and Arena. One body model, one collision, one set of
 * critters; the genre decides the verbs:
 *
 *   adventure  explore, talk, open chests, push crates, pull levers, unlock gates, warp, and
 *              (optionally) a slingshot. Win: goal, collect or defeat.
 *   arena      twin-stick: move with one hand, aim and hold fire with the other; waves from
 *              burrows; bushes and crates break under fire. Win: waves, survive or defeat.
 *
 * Movement is 8-way at 5.5 (adventure) or 6 (arena) tiles/s with quick acceleration. Walls
 * slide you along them, and corners nudge you into 1-tile corridors when you are within a third
 * of a tile of lining up, so tight spaces never snag. Chasing critters follow a flow field (a
 * breadth-first distance map from the player, refreshed four times a second), so they find
 * their way around walls instead of pressing into them.
 */
import { entityDef, SCORE } from '../../core/catalog.js';
import {
  STEP, createBaseSim, setSource, recordTrace, collect, hurtPlayer, killPlayer,
  respawnPlayer, win, tickTimer, overlaps, bodyFor,
} from './shared.js';

const EPS = 1e-4;
const WALKABLE = new Set([0, 21, 23, 25, 27, 29]);   // floors a body may stand on
const SHOT_BLOCK = new Set([20, 24]);                 // walls and bushes stop shots; ponds do not
const CRATE_FLOOR = new Set([0, 21, 23, 25, 27, 29, 26]);

export function createTopdownSim(project, levelIndex, opts, mode) {
  const sim = createBaseSim(project, levelIndex, opts);
  const W = sim.W, H = sim.H;
  const p = sim.player;
  const arena = mode === 'arena';
  const rules = sim.level.rules;
  const SPEED = arena ? 6 : 5.5;
  sim.cameraHint = arena ? 'fit' : 'follow';
  sim.boss = null;
  sim.lights = null;
  sim.waves = { current: 0, total: 0 };
  sim.bushHits = new Map();
  const pd = p.data;
  Object.assign(pd, { kx: 0, ky: 0, safe: { x: p.x, y: p.y }, cool: 0, pushT: 0, pushDir: null, power: null, shield: 0, slide: null, warpLock: null, talk: null, fall: 0 });
  p.dir = 'down';

  let flow = null, flowT = 0;
  const shotsFired = { n: 0 };

  for (const e of sim.entities) {
    const d = e.data;
    if (e.type === 'boss') { e.hp = e.maxHp = e.props.hp || (arena ? 30 : 3); d.timer = 1.5; d.state = 'idle'; d.splits = 0; sim.boss = e; }
    if (e.type === 'turret') d.timer = (e.props.interval || 2) * (0.3 + ((e.cell.x * 7 + e.cell.y * 3) % 10) / 14);
    if (e.type === 'slime' || e.type === 'spiky') { d.wander = 0; d.home = { x: e.x, y: e.y }; }
    if (e.type === 'spiky') { e.dir = 'left'; e.facing = -1; }
    if (e.type === 'bee') { d.home = { x: e.x, y: e.y }; }
    if (e.type === 'spirit') d.home = { x: e.x, y: e.y };
    if (e.type === 'crate') { e.hp = e.maxHp = 2; }
    if (e.type === 'spawner') {
      d.state = e.inputs > 0 ? 'wired' : 'waiting';
      d.timer = e.props.delay ?? 1;
      d.wave = 0; d.spawned = 0; d.children = [];
      sim.waves.total = Math.max(sim.waves.total, e.props.waves || 3);
    }
    if (e.type === 'npc') e.dir = 'down';
  }

  // ------------------------------------------------------------------ the grid
  function tile(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? 20 : sim.tiles[y * W + x]; }
  /** Whether a cell stops a body. Pits stop critters (they will not walk in) but not the player. */
  function cellBlocks(x, y, who) {
    const c = tile(x, y);
    if (c === 20 || c === 24 || c === 28) return who !== 'spirit' || x < 0 || y < 0 || x >= W || y >= H;
    if (c === 22) return who !== 'bee' && who !== 'spirit';
    if (c === 26) return who !== 'player' && who !== 'bee' && who !== 'spirit';
    return false;
  }
  const SOLID_TYPES = new Set(['door', 'crate', 'chest', 'npc', 'turret', 'spawner', 'sign']);
  function partSolid(e, who) {
    if (!e.alive || !SOLID_TYPES.has(e.type)) return false;
    if (e.type === 'door') return !e.open;
    if (who === 'spirit') return false;
    if (e.type === 'sign') return false;
    return true;
  }
  function partsFor(b, who) {
    const out = [];
    for (const e of sim.entities) if (e !== b && partSolid(e, who)) out.push(e);
    return out;
  }
  function blockedBox(b, who, parts) {
    const x0 = Math.floor(b.x + EPS), x1 = Math.floor(b.x + b.w - EPS), y0 = Math.floor(b.y + EPS), y1 = Math.floor(b.y + b.h - EPS);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (cellBlocks(x, y, who)) return true;
    for (const s of parts) if (overlaps(b, s)) return s;
    return false;
  }
  /** Move one axis, snapping flush to whatever stops it. Returns the blocker (true for tiles). */
  function moveAxis(b, d, axis, who, parts) {
    if (!d) return null;
    let hit = null;
    if (axis === 'x') {
      b.x += d;
      const y0 = Math.floor(b.y + EPS), y1 = Math.floor(b.y + b.h - EPS);
      const cx = d > 0 ? Math.floor(b.x + b.w - EPS) : Math.floor(b.x + EPS);
      for (let y = y0; y <= y1; y++) if (cellBlocks(cx, y, who)) { b.x = d > 0 ? cx - b.w : cx + 1; hit = true; break; }
      for (const s of parts) if (overlaps(b, s)) { b.x = d > 0 ? s.x - b.w : s.x + s.w; hit = s; }
    } else {
      b.y += d;
      const x0 = Math.floor(b.x + EPS), x1 = Math.floor(b.x + b.w - EPS);
      const cy = d > 0 ? Math.floor(b.y + b.h - EPS) : Math.floor(b.y + EPS);
      for (let x = x0; x <= x1; x++) if (cellBlocks(x, cy, who)) { b.y = d > 0 ? cy - b.h : cy + 1; hit = true; break; }
      for (const s of parts) if (overlaps(b, s)) { b.y = d > 0 ? s.y - b.h : s.y + s.h; hit = s; }
    }
    return hit;
  }
  /** Axis-separated move with sliding. Returns { hitX, hitY } (true for tiles, the part otherwise). */
  function move(b, dx, dy, who, nudge = false) {
    const parts = partsFor(b, who);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.3));
    let hitX = null, hitY = null;
    for (let i = 0; i < n; i++) {
      const hx = moveAxis(b, dx / n, 'x', who, parts);
      if (hx) { hitX = hx; if (nudge && !dy && hx === true) nudgeAxis(b, 'y', Math.sign(dx), who, parts); dx = 0; }
      const hy = moveAxis(b, dy / n, 'y', who, parts);
      if (hy) { hitY = hy; if (nudge && !dx && hy === true) nudgeAxis(b, 'x', Math.sign(dy), who, parts); dy = 0; }
      if (!dx && !dy) break;
    }
    return { hitX, hitY };
  }
  /** Corner forgiveness: slide sideways toward an opening you are nearly lined up with. */
  function nudgeAxis(b, axis, forward, who, parts) {
    const size = axis === 'y' ? b.h : b.w;
    const pos = axis === 'y' ? b.y : b.x;
    const center = pos + size / 2;
    const cell = Math.floor(center);
    const target = cell + 0.5 - size / 2;
    const off = target - pos;
    if (Math.abs(off) > 0.36 || Math.abs(off) < 0.001) {
      // try the neighbouring lane on the side we overlap most
      return;
    }
    const probe = { x: b.x, y: b.y, w: b.w, h: b.h };
    if (axis === 'y') { probe.y = target; probe.x += forward * 0.2; } else { probe.x = target; probe.y += forward * 0.2; }
    if (blockedBox(probe, who, parts)) return;
    const step = Math.sign(off) * Math.min(Math.abs(off), SPEED * STEP);
    if (axis === 'y') { b.y += step; if (blockedBox(b, who, parts)) b.y -= step; } else { b.x += step; if (blockedBox(b, who, parts)) b.x -= step; }
  }
  const centerCell = b => ({ x: Math.floor(b.x + b.w / 2), y: Math.floor(b.y + b.h / 2) });
  const cellOf = b => centerCell(b);

  // ------------------------------------------------------------------ flow field toward the player
  function buildFlow() {
    const dist = new Int16Array(W * H).fill(-1);
    const c = cellOf(p);
    if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) return dist;
    const q = new Int32Array(W * H);
    let head = 0, tail = 0;
    const start = c.y * W + c.x;
    dist[start] = 0; q[tail++] = start;
    const closedDoor = new Set(sim.entities.filter(e => e.type === 'door' && !e.open && e.alive).map(e => e.cell.y * W + e.cell.x));
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i - x) / W, d = dist[i] + 1;
      const nb = [i - 1, i + 1, i - W, i + W];
      for (let k = 0; k < 4; k++) {
        const j = nb[k];
        if (k === 0 && x === 0) continue;
        if (k === 1 && x === W - 1) continue;
        if (j < 0 || j >= W * H || dist[j] >= 0) continue;
        const code = sim.tiles[j];
        if (!WALKABLE.has(code) || closedDoor.has(j)) continue;
        dist[j] = d; q[tail++] = j;
      }
    }
    return dist;
  }
  /** Direction toward the player along the flow field, or straight at them when adjacent. */
  function flowDir(e) {
    if (!flow) return null;
    const c = cellOf(e);
    const here = c.y * W + c.x;
    if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) return null;
    const dh = flow[here];
    if (dh < 0) return null;
    if (dh <= 1) return norm(p.x + p.w / 2 - (e.x + e.w / 2), p.y + p.h / 2 - (e.y + e.h / 2));
    let best = null, bd = dh;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const v = flow[ny * W + nx];
      if (v >= 0 && v < bd) { bd = v; best = [nx, ny]; }
    }
    if (!best) return null;
    return norm(best[0] + 0.5 - (e.x + e.w / 2), best[1] + 0.5 - (e.y + e.h / 2));
  }
  function norm(x, y) { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; }
  function dirName(x, y) { return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up'); }
  function dist(a, b) { return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2)); }

  // ------------------------------------------------------------------ wires
  function onPower(t, on) {
    if (t.type === 'door') {
      if (t.data.unlocked) return;
      if (on && !t.open) { t.open = true; t.animTime = 0; sim.emit('door', t.x + 0.5, t.y + 0.5); }
      else if (!on && t.open && !t.props.stayOpen && !sim.entities.some(o => o !== t && o.alive && !SOLID_TYPES.has(o.type) && overlaps(o, t)) && !overlaps(p, t)) { t.open = false; t.animTime = 0; sim.emit('doorClose', t.x + 0.5, t.y + 0.5); }
    } else if (t.type === 'spawner' && on && t.data.state === 'wired') {
      t.data.state = 'waiting'; t.data.timer = t.props.delay ?? 0;
    }
  }

  // ------------------------------------------------------------------ the step
  sim.step = input => {
    sim.time += STEP; sim.tick++;
    p.animTime += STEP;
    for (const e of sim.entities) e.animTime += STEP;
    if (sim.status !== 'play') { if (sim.status === 'won') p.anim = 'win'; return; }
    flowT -= STEP;
    if (flowT <= 0) { flow = buildFlow(); flowT = 0.25; }
    stepPlayer(input);
    stepParts(input);
    stepCritters();
    stepShots();
    separate();
    checkRules();
    if (sim.level.time === 'night' && rules.dark) lights();
    recordTrace(sim);
    tickTimer(sim);
  };

  function stepPlayer(input) {
    const pr = input.pressed || {};
    p.invuln = Math.max(0, p.invuln - STEP);
    pd.cool = Math.max(0, pd.cool - STEP);
    if (pd.power) { pd.power.left -= STEP; if (pd.power.left <= 0) { if (pd.power.kind === 'shield') pd.shield = 0; pd.power = null; sim.emit('powerEnd', p.x, p.y); } }
    let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0), iy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (pd.fall > 0) { pd.fall -= STEP; ix = iy = 0; if (pd.fall <= 0) { p.x = pd.safe.x; p.y = pd.safe.y; p.invuln = Math.max(p.invuln, 1); } p.anim = 'hurt'; return; }
    const c = cellOf(p);
    const onIce = tile(c.x, c.y) === 25;
    let vx, vy;
    if (pd.slide) {
      vx = pd.slide.x * 7; vy = pd.slide.y * 7;
    } else {
      const n = Math.hypot(ix, iy) || 1;
      const tx = (ix / n) * SPEED, ty = (iy / n) * SPEED;
      const k = 1 - Math.exp(-22 * STEP);
      p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;
      if (!ix && Math.abs(p.vx) < 0.05) p.vx = 0;
      if (!iy && Math.abs(p.vy) < 0.05) p.vy = 0;
      vx = p.vx; vy = p.vy;
      if (onIce && !arena && (ix || iy || Math.hypot(p.vx, p.vy) > 1)) {
        // on ice you keep going: slide in the pressed (or current) cardinal direction until stopped
        const sx = ix || iy ? ix : p.vx, sy = ix || iy ? iy : p.vy;
        const d = Math.abs(sx) >= Math.abs(sy) ? { x: Math.sign(sx), y: 0 } : { x: 0, y: Math.sign(sy) };
        pd.slide = d; sim.emit('slide', p.x + p.w / 2, p.y + p.h / 2);
      }
    }
    // knockback
    vx += pd.kx; vy += pd.ky;
    pd.kx *= Math.exp(-10 * STEP); pd.ky *= Math.exp(-10 * STEP);
    if (Math.abs(pd.kx) < 0.05) pd.kx = 0;
    if (Math.abs(pd.ky) < 0.05) pd.ky = 0;
    const r = move(p, vx * STEP, vy * STEP, 'player', !pd.slide);
    if (pd.slide) {
      const cc = cellOf(p);
      if (r.hitX || r.hitY || tile(cc.x, cc.y) !== 25) {
        if (tile(cc.x, cc.y) !== 25 || r.hitX || r.hitY) { pd.slide = null; p.vx = p.vy = 0; }
      }
    }
    if (r.hitX) p.vx = 0;
    if (r.hitY) p.vy = 0;
    if (ix || iy) p.dir = dirName(ix || 0.001 * (p.dir === 'right' ? 1 : -1), iy);
    if (ix) p.facing = ix;
    // pushing crates
    const pushing = (r.hitX && r.hitX.type === 'crate' && ix) ? { part: r.hitX, dx: Math.sign(ix), dy: 0 } : (r.hitY && r.hitY.type === 'crate' && iy) ? { part: r.hitY, dx: 0, dy: Math.sign(iy) } : null;
    if (pushing && !arena) {
      const key = pushing.part.id + pushing.dx + ',' + pushing.dy;
      if (pd.pushDir === key) pd.pushT += STEP; else { pd.pushDir = key; pd.pushT = 0; }
      if (pd.pushT > 0.12) { pd.pushT = 0; pushCrate(pushing.part, pushing.dx, pushing.dy); }
      setAnim(p, 'push');
    } else {
      pd.pushDir = null;
      setAnim(p, Math.hypot(vx, vy) > 0.4 ? 'walk' : 'idle');
    }
    // pits: fall in, lose a heart, come back to the last safe floor
    const cc = cellOf(p);
    const centerTile = tile(cc.x, cc.y);
    if (centerTile === 26) {
      const cx = p.x + p.w / 2 - (cc.x + 0.5), cy = p.y + p.h / 2 - (cc.y + 0.5);
      if (Math.abs(cx) < 0.32 && Math.abs(cy) < 0.32) {
        sim.emit('fall', p.x + p.w / 2, p.y + p.h / 2);
        p.invuln = 0;
        if (hurtPlayer(sim, 1) && sim.status === 'play') { pd.fall = 0.45; p.vx = p.vy = 0; pd.slide = null; }
        else if (sim.status === 'play') { pd.fall = 0.45; }
      }
    } else if (WALKABLE.has(centerTile) && centerTile !== 25) {
      pd.safe = { x: p.x, y: p.y };
    }
    // shooting
    const canShoot = arena || rules.slingshot;
    if (canShoot && input.fire && pd.cool <= 0) {
      let aim = input.aim && (input.aim.x || input.aim.y) ? norm(input.aim.x, input.aim.y) : null;
      if (!aim) { const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[p.dir]; aim = { x: d[0], y: d[1] }; }
      if (arena && input.aim) p.dir = dirName(aim.x, aim.y);
      fire(aim);
    }
  }

  function fire(aim) {
    const kind = pd.power?.kind;
    const rate = arena ? (kind === 'rapid' ? 1 / 14 : 1 / 7) : 0.35;
    pd.cool = rate;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const angles = kind === 'spread' ? [-0.22, 0, 0.22] : [0];
    for (const a of angles) {
      const c = Math.cos(a), s = Math.sin(a);
      const vx = (aim.x * c - aim.y * s) * 16, vy = (aim.x * s + aim.y * c) * 16;
      sim.projectiles.push({ x: cx + aim.x * 0.35, y: cy + aim.y * 0.35, vx, vy, r: 0.12, owner: 'player', kind: 'pebble', life: arena ? 1 : 0.7, power: !!kind });
    }
    shotsFired.n++;
    sim.emit('shoot', cx, cy, { owner: 'player', n: shotsFired.n });
  }

  function pushCrate(crate, dx, dy) {
    const tx = crate.cell.x + dx, ty = crate.cell.y + dy;
    const code = tile(tx, ty);
    if (!CRATE_FLOOR.has(code)) { sim.emit('bump', crate.x + 0.5, crate.y + 0.5); return; }
    const target = { x: tx + 0.02, y: ty + 0.02, w: 0.96, h: 0.96 };
    if (sim.entities.some(o => o !== crate && o.alive && (SOLID_TYPES.has(o.type) ? partSolid(o, 'player') : entityDef(o.type)?.enemy) && overlaps(o, target))) { sim.emit('bump', crate.x + 0.5, crate.y + 0.5); return; }
    crate.cell = { x: tx, y: ty };
    crate.x = tx; crate.y = ty;
    sim.emit('push', tx + 0.5, ty + 0.5);
    if (code === 26) {
      sim.tiles[ty * W + tx] = 0;
      crate.alive = false;
      sim.emit('fill', tx + 0.5, ty + 0.5);
    }
  }

  function near(e, r = 0.35) { return overlaps({ x: p.x - r, y: p.y - r, w: p.w + r * 2, h: p.h + r * 2 }, e); }

  function stepParts(input) {
    const pr = input.pressed || {};
    let acted = false;
    let msg = null;
    for (const e of sim.entities) {
      if (!e.alive) continue;
      switch (e.type) {
        case 'coin': case 'gem': if (overlaps(p, e)) collect(sim, e); break;
        case 'heart': if (overlaps(p, e)) { e.alive = false; p.hearts = Math.min(p.maxHearts, p.hearts + 1); sim.emit('heart', e.x + e.w / 2, e.y + e.h / 2); } break;
        case 'key': if (overlaps(p, e)) { e.alive = false; sim.keys[e.props.color || 'amber']++; sim.emit('key', e.x + e.w / 2, e.y + e.h / 2, { color: e.props.color }); } break;
        case 'powerup':
          if (overlaps(p, e)) {
            e.alive = false;
            let kind = e.props.kind || 'shield';
            if (!arena && kind === 'spread') kind = 'rapid';
            if (!arena && kind === 'wings') kind = 'shield';
            pd.power = { kind, left: e.props.seconds || 10, total: e.props.seconds || 10 };
            if (kind === 'shield') pd.shield = 1;
            sim.emit('powerup', e.x + e.w / 2, e.y + e.h / 2, { kind });
          }
          break;
        case 'checkpoint':
          if (!e.active && near(e, 0.1)) { e.active = true; const b = bodyFor('top', 'player', e.cell.x, e.cell.y + (tile(e.cell.x, e.cell.y + 1) === 0 ? 1 : 0)); sim.checkpoint = { x: b.x, y: b.y }; sim.emit('checkpoint', e.x + e.w / 2, e.y); }
          break;
        case 'goal': if (overlaps(p, e) && rules.win === 'goal') { e.active = true; win(sim); } break;
        case 'door':
          if (!e.open) { const lock = e.props.lock || 'none'; if (lock !== 'none' && sim.keys[lock] > 0 && near(e, 0.12)) { sim.keys[lock]--; e.data.unlocked = true; e.open = true; e.animTime = 0; sim.emit('door', e.x + 0.5, e.y + 0.5); } }
          break;
        case 'switch':
          if (!acted && pr.action && near(e, 0.4)) {
            acted = true;
            const mode = e.props.mode || 'once';
            if (mode === 'once' && e.active) break;
            const on = mode === 'toggle' ? !e.active : true;
            e.anim = 'toggle'; e.animTime = 0;
            setSource(sim, e, on, onPower);
            if (mode === 'timed') e.data.timer = e.props.seconds || 8;
            sim.emit('lever', e.x + e.w / 2, e.y + e.h / 2, { on });
          }
          if (e.props.mode === 'timed' && e.active) { e.data.timer -= STEP; if (e.data.timer <= 0) { setSource(sim, e, false, onPower); sim.emit('lever', e.x + e.w / 2, e.y + e.h / 2, { on: false }); } }
          break;
        case 'plate': {
          const box = { x: e.x + 0.15, y: e.y + 0.15, w: e.w - 0.3, h: e.h - 0.3 };
          const on = overlaps(p, box) || sim.entities.some(o => o.alive && o !== e && (o.type === 'crate' || entityDef(o.type)?.enemy) && o.type !== 'bee' && o.type !== 'spirit' && overlaps(o, box));
          if (on !== !!e.active) { setSource(sim, e, on, onPower); sim.emit('plate', e.x + e.w / 2, e.y + e.h / 2, { on }); }
          break;
        }
        case 'chest':
          if (!e.open && !acted && pr.action && near(e, 0.45)) { acted = true; openChest(e); }
          break;
        case 'npc':
          if (!acted && pr.action && near(e, 0.5)) {
            acted = true;
            pd.talk = e.id;
            e.dir = dirName(p.x - e.x, p.y - e.y);
            sim.emit('talk', e.x + e.w / 2, e.y);
          }
          if (pd.talk === e.id) {
            if (dist(p, e) > 2.2) pd.talk = null;
            else { msg = { title: e.props.name || 'Villager', text: e.props.text || '' }; e.anim = 'talk'; }
          } else if (e.anim === 'talk') e.anim = 'idle';
          break;
        case 'sign':
          e.active = near(e, 0.25);
          if (e.active && !msg) msg = { title: 'Sign', text: e.props.text || '' };
          break;
        case 'teleporter': {
          const inside = overlaps({ x: p.x + p.w * 0.25, y: p.y + p.h * 0.25, w: p.w * 0.5, h: p.h * 0.5 }, e);
          if (pd.warpLock === e.id) { if (!overlaps(p, e)) pd.warpLock = null; break; }
          if (inside && !pd.warpLock) {
            const mates = sim.entities.filter(o => o.type === 'teleporter' && o.alive && (o.props.channel || 1) === (e.props.channel || 1));
            if (mates.length > 1) {
              const to = mates[(mates.indexOf(e) + 1) % mates.length];
              p.x = to.x + to.w / 2 - p.w / 2; p.y = to.y + to.h / 2 - p.h / 2;
              pd.warpLock = to.id; pd.slide = null;
              sim.emit('teleport', to.x + to.w / 2, to.y + to.h / 2, { from: { x: e.x + e.w / 2, y: e.y + e.h / 2 } });
            }
          }
          break;
        }
        case 'crate':
          if (e.flash) e.flash = Math.max(0, e.flash - STEP * 5);
          break;
      }
    }
    sim.message = msg;
  }

  function openChest(c) {
    c.open = true; c.animTime = 0;
    sim.emit('chest', c.x + c.w / 2, c.y + c.h / 2);
    const what = c.props.contains || 'gem';
    const drop = (type, props = {}, dx = 0, dy = 1) => {
      const cx = Math.max(0, Math.min(W - 1, c.cell.x + dx)), cy = Math.max(0, Math.min(H - 1, c.cell.y + dy));
      const e = { id: `${c.id}-${type}-${sim.tick}-${dx}`, type, ...bodyFor('top', type, cx, cy), vx: 0, vy: 0, facing: 1, dir: 'down', anim: 'idle', animTime: 0, alive: true, active: false, open: false, hp: 1, maxHp: 1, props, cell: { x: cx, y: cy }, fp: { w: 1, h: 1 }, inputs: 0, powered: 0, data: {} };
      sim.entities.push(e); sim.byId.set(e.id, e);
      if (type === 'coin') sim.coinsTotal++;
      if (type === 'gem') sim.gemsTotal++;
    };
    if (what === 'coins') { for (let i = -2; i <= 2; i++) drop('coin', {}, i, 1); }
    else if (what === 'gem') drop('gem');
    else if (what === 'heart') drop('heart');
    else if (what === 'powerup') drop('powerup', { kind: 'shield', seconds: 12 });
    else if (what.startsWith('key-')) { const color = what.slice(4); sim.keys[color] = (sim.keys[color] || 0) + 1; sim.emit('key', c.x + c.w / 2, c.y, { color }); }
  }

  // ------------------------------------------------------------------ critters
  function stepCritters() {
    const diff = sim.difficulty;
    for (const e of [...sim.entities]) {
      if (!e.alive) continue;
      const def = entityDef(e.type);
      if (e.type === 'spawner') { spawner(e); continue; }
      if (!def?.enemy) continue;
      e.flash = Math.max(0, (e.flash || 0) - STEP * 5);
      const d = e.data;
      if (d.stun > 0) { d.stun -= STEP; e.anim = 'hurt'; move(e, d.kx * STEP, d.ky * STEP, e.type === 'bee' ? 'bee' : e.type === 'spirit' ? 'spirit' : 'enemy'); d.kx *= 0.85; d.ky *= 0.85; continue; }
      const speedK = diff.speed;
      if (e.type === 'slime') slime(e, speedK);
      else if (e.type === 'bee') bee(e, speedK);
      else if (e.type === 'spiky') spiky(e, speedK);
      else if (e.type === 'turret') turret(e);
      else if (e.type === 'spirit') spirit(e, speedK);
      else if (e.type === 'boss') boss(e, speedK);
      if (e.alive && sim.status === 'play' && overlaps(shrink(e, 0.08), p) && pd.fall <= 0) {
        if (hurtPlayer(sim, 1, e)) knock(e);
      }
    }
  }
  const shrink = (b, k) => ({ x: b.x + k, y: b.y + k, w: b.w - k * 2, h: b.h - k * 2 });
  function knock(from) {
    const d = norm(p.x + p.w / 2 - (from.x + from.w / 2), p.y + p.h / 2 - (from.y + from.h / 2));
    pd.kx = d.x * 9; pd.ky = d.y * 9; pd.slide = null;
  }
  function chaseStep(e, speed, who = 'enemy') {
    const dir = who === 'bee' ? norm(p.x - e.x, p.y - e.y) : flowDir(e);
    if (!dir) return false;
    const r = move(e, dir.x * speed * STEP, dir.y * speed * STEP, who);
    e.dir = dirName(dir.x, dir.y); e.facing = dir.x >= 0 ? 1 : -1;
    return !(r.hitX && r.hitY);
  }
  function wanderStep(e, speed, who = 'enemy') {
    const d = e.data;
    d.wander -= STEP;
    if (d.wander <= 0 || !d.wdir) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]];
      d.wdir = dirs[Math.floor(sim.rng() * dirs.length)];
      d.wander = 0.8 + sim.rng() * 1.6;
    }
    const [dx, dy] = d.wdir;
    const r = move(e, dx * speed * STEP, dy * speed * STEP, who);
    if (r.hitX || r.hitY) d.wander = 0;
    if (dx || dy) { e.dir = dirName(dx, dy); if (dx) e.facing = dx; }
    return !!(dx || dy);
  }
  function slime(e, k) {
    const speed = (e.props.speed || 1.5) * k * (arena ? 1.15 : 1);
    const chase = arena || e.props.behavior === 'chase';
    const close = dist(e, p) < 6.5;
    let moving;
    if (chase && (arena || close)) moving = chaseStep(e, speed); else moving = wanderStep(e, speed * 0.7);
    e.anim = moving ? 'walk' : 'idle';
  }
  function bee(e, k) {
    const d = e.data;
    const speed = (e.props.speed || 2) * k * 1.25;
    const radius = e.props.radius || 6;
    const dd = dist(e, p);
    if (arena || dd < radius) {
      // hover in, pause, then dart: a telegraphed charge
      d.cycle = (d.cycle || 0) + STEP;
      const phase = d.cycle % 2.2;
      if (phase < 1.5) { chaseStep(e, speed * 0.75, 'bee'); e.anim = 'fly'; }
      else if (phase < 1.8) { e.anim = 'attack'; d.dash = norm(p.x - e.x, p.y - e.y); }
      else { move(e, d.dash.x * speed * 3 * STEP, d.dash.y * speed * 3 * STEP, 'bee'); e.anim = 'fly'; }
    } else {
      const h = d.home, dx = h.x - e.x, dy = h.y - e.y;
      const l = Math.hypot(dx, dy);
      if (l > 0.2) move(e, dx / l * speed * 0.6 * STEP, dy / l * speed * 0.6 * STEP, 'bee');
      e.anim = 'fly';
    }
  }
  function spiky(e, k) {
    const speed = (e.props.speed || 1) * k;
    const dx = e.facing || -1;
    const r = move(e, dx * speed * STEP, 0, 'enemy');
    if (r.hitX) e.facing = -dx;
    // do not walk into pits
    const ahead = Math.floor(e.facing > 0 ? e.x + e.w + 0.05 : e.x - 0.05), row = Math.floor(e.y + e.h / 2);
    if (tile(ahead, row) === 26) e.facing = -e.facing;
    e.dir = e.facing > 0 ? 'right' : 'left';
    e.anim = 'walk';
  }
  function turret(e) {
    const d = e.data;
    const armed = e.inputs === 0 || e.powered > 0;
    const dx = p.x + p.w / 2 - (e.x + e.w / 2), dy = p.y + p.h / 2 - (e.y + e.h / 2);
    const aimAt = e.props.dir === 'player' || arena;
    if (aimAt) d.aim = Math.atan2(dy, dx);
    if (!armed) { e.anim = 'idle'; return; }
    d.timer -= STEP;
    if (d.timer < 0.35 && d.timer > 0) e.anim = 'attack';
    if (d.timer <= 0) {
      d.timer = e.props.interval || 2;
      if (Math.hypot(dx, dy) > 14) return;
      let vx = 0, vy = 0;
      const dir = aimAt ? 'player' : (e.props.dir || 'left');
      if (dir === 'player') { vx = Math.cos(d.aim) * 7; vy = Math.sin(d.aim) * 7; }
      else if (dir === 'left') vx = -7; else if (dir === 'right') vx = 7; else if (dir === 'up') vy = -7; else vy = 7;
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      sim.projectiles.push({ x: cx + Math.sign(vx) * 0.5, y: cy + Math.sign(vy) * 0.5, vx, vy, r: 0.14, owner: 'enemy', kind: 'acorn', life: 4 });
      e.anim = 'fire'; e.animTime = 0;
      sim.emit('shoot', cx, cy, { owner: 'enemy' });
    }
  }
  function spirit(e, k) {
    const speed = (e.props.speed || 1.5) * k;
    const dd = dist(e, p);
    if (dd < 8 || arena) {
      const dir = norm(p.x - e.x, p.y - e.y);
      move(e, dir.x * speed * STEP, dir.y * speed * STEP, 'spirit');
      e.dir = dirName(dir.x, dir.y); e.facing = dir.x >= 0 ? 1 : -1;
    }
    e.anim = 'idle';
  }
  function boss(e, k) {
    const d = e.data;
    d.invuln = Math.max(0, (d.invuln || 0) - STEP);
    d.timer -= STEP;
    if (d.state === 'idle') { e.anim = 'idle'; if (d.timer <= 0) { d.state = 'windup'; d.timer = 0.5; e.anim = 'attack'; e.animTime = 0; } }
    else if (d.state === 'windup') { if (d.timer <= 0) { d.state = 'hop'; d.timer = 0.6; d.dir = norm(p.x - e.x, p.y - e.y); e.anim = 'walk'; e.animTime = 0; sim.emit('jump', e.x + e.w / 2, e.y + e.h, { big: true }); } }
    else if (d.state === 'hop') {
      move(e, d.dir.x * 5.5 * k * STEP, d.dir.y * 5.5 * k * STEP, 'enemy');
      if (d.timer <= 0) {
        d.state = 'idle'; d.timer = 1.1 / k;
        sim.emit('slam', e.x + e.w / 2, e.y + e.h / 2, { shake: 0.5 });
        sim.projectiles.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, vx: 0, vy: 0, r: 0.8, owner: 'enemy', kind: 'ring', life: 0.8, grow: 5 });
      }
    }
    e.facing = p.x > e.x ? 1 : -1;
    const frac = e.hp / e.maxHp;
    if ((d.splits === 0 && frac <= 0.66) || (d.splits === 1 && frac <= 0.33)) {
      d.splits++;
      for (let i = 0; i < 3; i++) spawnCritter('slime', e.x + e.w / 2 + (i - 1) * 0.9, e.y + e.h + 0.2, null);
    }
  }

  function spawnCritter(type, cx, cy, parent) {
    // find a free cell near (cx, cy) that is not on the player
    const cands = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
    for (const [dx, dy] of cands) {
      const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy;
      if (cellBlocks(x, y, type === 'bee' ? 'bee' : 'enemy')) continue;
      const body = bodyFor('top', type, x, y);
      if (overlaps(body, { x: p.x - 0.8, y: p.y - 0.8, w: p.w + 1.6, h: p.h + 1.6 })) continue;
      if (sim.entities.some(o => o.alive && partSolid(o, 'enemy') && overlaps(o, body))) continue;
      const id = `${parent ? parent.id : 'boss'}-${type}-${sim.tick}-${dx}${dy}`;
      const e = { id, type, ...body, vx: 0, vy: 0, facing: -1, dir: 'down', anim: 'walk', animTime: 0, alive: true, active: false, open: false, hp: 1, maxHp: 1, props: { speed: type === 'slime' ? 1.6 : type === 'bee' ? 2.2 : 1.5, hp: 1, behavior: 'chase', radius: 30 }, cell: { x, y }, fp: { w: 1, h: 1 }, inputs: 0, powered: 0, data: { wander: 0, home: { x: body.x, y: body.y } } };
      if (type === 'spiky') e.props.speed = 1.2;
      sim.entities.push(e); sim.byId.set(id, e);
      sim.enemiesTotal++;
      sim.emit('spawn', body.x + body.w / 2, body.y + body.h / 2, { what: type });
      return e;
    }
    return null;
  }

  function spawner(e) {
    const d = e.data;
    d.children = d.children.filter(id => sim.byId.get(id)?.alive);
    e.active = d.state === 'active';
    if (d.state === 'wired' || d.state === 'done') return;
    d.timer -= STEP;
    if (d.state === 'waiting' && d.timer <= 0) {
      d.state = 'active'; d.spawned = 0; d.timer = 0;
      d.wave++;
      sim.waves.current = Math.max(sim.waves.current, d.wave);
      sim.emit('wave', e.x + 0.5, e.y + 0.5, { wave: d.wave, total: e.props.waves || 3 });
    }
    if (d.state === 'active' && d.timer <= 0) {
      const kind = e.props.enemy || 'slime';
      const c = spawnCritter(kind, e.x + 0.5, e.y + 1.5, e);
      if (c) { d.children.push(c.id); d.spawned++; e.anim = 'spawn'; e.animTime = 0; }
      d.timer = e.props.gap ?? 0.75;
      if (d.spawned >= (e.props.perWave || 4)) d.state = 'clearing';
    }
    if (d.state === 'clearing' && d.children.length === 0) {
      if (d.wave >= (e.props.waves || 3)) {
        d.state = 'done'; d.exhausted = true; e.active = false;
        setSource(sim, e, true, onPower);
        sim.emit('cleared', e.x + 0.5, e.y + 0.5);
      } else { d.state = 'waiting'; d.timer = e.props.rest ?? 3; }
    }
  }

  function separate() {
    const list = sim.entities.filter(e => e.alive && entityDef(e.type)?.enemy && e.type !== 'turret' && e.type !== 'boss');
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y + b.h / 2 - (a.y + a.h / 2);
      const min = (a.w + b.w) * 0.42;
      const d2 = dx * dx + dy * dy;
      if (d2 > min * min || d2 === 0) continue;
      const d = Math.sqrt(d2), push = (min - d) * 0.25;
      const ux = dx / d, uy = dy / d;
      move(a, -ux * push, -uy * push, a.type === 'bee' ? 'bee' : a.type === 'spirit' ? 'spirit' : 'enemy');
      move(b, ux * push, uy * push, b.type === 'bee' ? 'bee' : b.type === 'spirit' ? 'spirit' : 'enemy');
    }
  }

  // ------------------------------------------------------------------ shots
  function stepShots() {
    const list = sim.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i];
      q.life -= STEP;
      let dead = q.life <= 0;
      if (q.kind === 'ring') {
        q.r += (q.grow || 4) * STEP;
        const dd = Math.hypot(p.x + p.w / 2 - q.x, p.y + p.h / 2 - q.y);
        if (!q.hitPlayer && Math.abs(dd - q.r) < 0.35 && sim.status === 'play') { q.hitPlayer = true; if (hurtPlayer(sim, 1, { x: q.x, y: q.y, w: 0, h: 0 })) knock({ x: q.x, y: q.y, w: 0, h: 0 }); }
        if (dead) list.splice(i, 1);
        continue;
      }
      q.x += q.vx * STEP; q.y += q.vy * STEP;
      const cx = Math.floor(q.x), cy = Math.floor(q.y);
      const code = tile(cx, cy);
      if (!dead && SHOT_BLOCK.has(code)) {
        dead = true;
        if (q.owner === 'player' && code === 24 && arena) {
          const k = cy * W + cx;
          const hits = (sim.bushHits.get(k) || 0) + 1;
          sim.bushHits.set(k, hits);
          if (hits >= 3) { sim.tiles[k] = 0; sim.bushHits.delete(k); sim.emit('break', cx + 0.5, cy + 0.5, { what: 'bush' }); }
          else sim.emit('hit', q.x, q.y, { owner: 'player', what: 'bush' });
        } else sim.emit('hit', q.x, q.y, { owner: q.owner });
      }
      const box = { x: q.x - q.r, y: q.y - q.r, w: q.r * 2, h: q.r * 2 };
      if (!dead) for (const e of sim.entities) {
        if (!e.alive) continue;
        if (q.owner === 'player') {
          if (entityDef(e.type)?.enemy && overlaps(box, e)) { dead = true; damage(e, 1, q); break; }
          if ((e.type === 'crate' || e.type === 'door' && !e.open || e.type === 'chest' || e.type === 'spawner' || e.type === 'npc') && overlaps(box, e)) {
            dead = true;
            if (e.type === 'crate' && arena) { e.hp--; e.flash = 1; if (e.hp <= 0) { e.alive = false; e.anim = 'dead'; e.animTime = 0; sim.emit('break', e.x + 0.5, e.y + 0.5, { what: 'crate' }); if (sim.rng() < 0.5) dropLoot(e, 'coin'); } else sim.emit('hit', q.x, q.y, { owner: 'player', what: 'crate' }); }
            else sim.emit('hit', q.x, q.y, { owner: 'player' });
            break;
          }
        } else if ((e.type === 'crate' || e.type === 'door' && !e.open) && overlaps(box, e)) { dead = true; sim.emit('hit', q.x, q.y, { owner: 'enemy' }); break; }
      }
      if (!dead && q.owner === 'enemy' && sim.status === 'play' && overlaps(box, p)) {
        dead = true;
        if (hurtPlayer(sim, 1, box)) knock(box);
      }
      if (dead) list.splice(i, 1);
    }
  }
  function damage(e, n, from) {
    const d = e.data;
    if (e.type === 'boss' && d.invuln > 0) return;
    e.hp -= n; e.flash = 1;
    if (e.type === 'boss') { d.invuln = 0.08; sim.emit('bossHit', e.x + e.w / 2, e.y, { hp: e.hp }); }
    else { const k = norm(from.vx, from.vy); d.kx = k.x * 5; d.ky = k.y * 5; d.stun = 0.15; }
    sim.emit('hit', e.x + e.w / 2, e.y + e.h / 2, { owner: 'player', what: e.type });
    if (e.hp <= 0) {
      e.alive = false; e.anim = 'dead'; e.animTime = 0;
      sim.kills++;
      const score = entityDef(e.type).score || SCORE.enemy;
      sim.score += score;
      sim.emit('kill', e.x + e.w / 2, e.y + e.h / 2, { what: e.type, score });
      if (arena && e.type !== 'boss') { const r = sim.rng(); if (r < 0.06) dropLoot(e, 'heart'); else if (r < 0.2) dropLoot(e, 'coin'); }
    }
  }
  function dropLoot(e, type) {
    const cx = Math.floor(e.x + e.w / 2), cy = Math.floor(e.y + e.h / 2);
    const body = bodyFor('top', type, cx, cy);
    const drop = { id: `${e.id}-drop-${sim.tick}`, type, ...body, vx: 0, vy: 0, facing: 1, dir: 'down', anim: 'idle', animTime: 0, alive: true, active: false, open: false, hp: 1, maxHp: 1, props: {}, cell: { x: cx, y: cy }, fp: { w: 1, h: 1 }, inputs: 0, powered: 0, data: { life: 8 } };
    sim.entities.push(drop); sim.byId.set(drop.id, drop);
    if (type === 'coin') sim.coinsTotal++;
  }

  // ------------------------------------------------------------------ rules and light
  function aliveEnemies() { let n = 0; for (const e of sim.entities) if (e.alive && entityDef(e.type)?.enemy) n++; return n; }
  function checkRules() {
    const rule = rules.win;
    const spawners = sim.entities.filter(e => e.type === 'spawner');
    const exhausted = spawners.every(s => s.data.exhausted);
    if (rule === 'collect') {
      sim.objective = { label: 'Collect the honey jars', text: `${sim.gems} / ${sim.gemsTotal}`, progress: sim.gemsTotal ? sim.gems / sim.gemsTotal : 0 };
      if (sim.gemsTotal > 0 && sim.gems >= sim.gemsTotal) win(sim);
    } else if (rule === 'defeat' || (rule === 'waves' && !spawners.length)) {
      const alive = aliveEnemies();
      sim.objective = { label: sim.boss ? 'Defeat King Slime' : 'Defeat the critters', text: `${alive} left`, progress: sim.enemiesTotal ? 1 - alive / sim.enemiesTotal : 1 };
      if (alive === 0 && exhausted) win(sim);
    } else if (rule === 'waves') {
      const alive = aliveEnemies();
      const cur = Math.max(1, sim.waves.current), total = Math.max(1, sim.waves.total);
      sim.objective = { label: 'Clear the waves', text: exhausted ? `${alive} left` : `Wave ${Math.min(cur, total)} / ${total}`, progress: Math.min(1, (cur - (exhausted ? 0 : 1)) / total) };
      if (exhausted && alive === 0) win(sim);
    } else if (rule === 'survive') {
      const left = Math.max(0, (rules.survive || 60) - sim.time);
      sim.objective = { label: 'Survive', text: `${Math.floor(left / 60)}:${String(Math.ceil(left % 60) === 60 ? 0 : Math.ceil(left % 60)).padStart(2, '0')}`, progress: 1 - left / (rules.survive || 60) };
      if (left <= 0) win(sim);
    } else {
      sim.objective = { label: 'Reach the shrine', text: '', progress: 0 };
    }
    // drops fade after a while in the arena
    if (arena) for (const e of sim.entities) if (e.data.life !== undefined && e.alive) { e.data.life -= STEP; if (e.data.life <= 0) e.alive = false; }
  }
  function lights() {
    const L = [{ x: p.x + p.w / 2, y: p.y + p.h / 2, r: 4.5 }];
    for (const e of sim.entities) {
      if (!e.alive) continue;
      if (e.type === 'checkpoint' && e.active) L.push({ x: e.x + e.w / 2, y: e.y, r: 3.5 });
      else if (e.type === 'goal') L.push({ x: e.x + e.w / 2, y: e.y, r: 2.8 });
      else if (e.type === 'teleporter') L.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, r: 1.6 });
      else if (e.type === 'power' || e.type === 'powerup') L.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, r: 1.2 });
    }
    const dec = sim.decor;
    for (let i = 0; i < dec.length; i++) {
      if (dec[i] === 57) L.push({ x: i % W + 0.5, y: Math.floor(i / W) - 0.6, r: 3.2 });
      else if (dec[i] === 61) L.push({ x: i % W + 0.5, y: Math.floor(i / W) + 0.5, r: 2 });
      else if (dec[i] === 58) L.push({ x: i % W + 2, y: Math.floor(i / W) - 0.3, r: 2.6 });
    }
    sim.lights = L;
  }

  function setAnim(e, a) { if (e.anim !== a) { e.anim = a; e.animTime = 0; } }

  sim.respawn = () => {
    respawnPlayer(sim);
    Object.assign(pd, { kx: 0, ky: 0, slide: null, fall: 0, talk: null, warpLock: null, power: null, shield: 0 });
    sim.projectiles.length = 0;
    // critters that were on top of the lantern back off a little
    for (const e of sim.entities) if (e.alive && entityDef(e.type)?.enemy && dist(e, p) < 2.5 && e.data.home) { e.x = e.data.home.x; e.y = e.data.home.y; }
  };
  sim.kill = () => killPlayer(sim);
  checkRules();
  if (sim.level.time === 'night' && rules.dark) lights();
  return sim;
}
