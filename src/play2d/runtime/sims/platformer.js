/**
 * Platformer: a side-on course run, jumped and stomped to its goal.
 *
 * The feel is tuned the way a commercial platformer is tuned, and the numbers are the design:
 *
 *   gravity 52 t/s²    jump 18.7 t/s → 3.35 tiles    release while rising cuts vy to 45%
 *   run 7.5 t/s        ground accel 70, decel 85     air accel 48 (turning in the air is
 *   ice accel 16, decel 5 (you slide)                 allowed but softer)
 *   coyote 0.10 s      jump buffer 0.12 s            head-bump corner nudge ≤ 0.3 tile
 *   terminal fall 20   ladder 5 t/s                  water: gravity 12, sink ≤ 3.2, paddle 9
 *   stomp bounce 12 (17 holding jump)                spring height = props.power tiles
 *
 * Collision is swept per axis against the tile grid and solid parts (closed gates, colour
 * switches), sub-stepped so nothing tunnels at terminal speed. A body never ends inside a solid.
 */
import { entityDef, SCORE } from '../../core/catalog.js';
import {
  STEP, createBaseSim, setSource, isSolidCode, recordTrace, collect, hurtPlayer, killPlayer,
  respawnPlayer, win, tickTimer, overlaps, bodyFor,
} from './shared.js';

const G = 52;
const JUMP_V = Math.sqrt(2 * G * 3.35);
const JUMP_CUT = 0.45;
const RUN = 7.5;
const ACCEL = 70, DECEL = 85, AIR_ACCEL = 48, ICE_ACCEL = 16, ICE_DECEL = 5;
const MAX_FALL = 20;
const COYOTE = 0.1, BUFFER = 0.12;
const CLIMB = 5;
const SWIM_G = 12, SWIM_FALL = 3.2, SWIM_PADDLE = 9, SWIM_RUN = 4.5;
const STOMP = 12, STOMP_HELD = 17;
const KNOCK_X = 7, KNOCK_Y = 9;
const EPS = 1e-4;
const STOMPABLE = new Set(['slime', 'bee', 'turret', 'boss']);

export function createPlatformerSim(project, levelIndex = 0, opts = {}) {
  const sim = createBaseSim(project, levelIndex, opts);
  const W = sim.W, H = sim.H;
  const p = sim.player;
  sim.cameraHint = 'follow';
  sim.boss = null;
  sim.crumble = new Map();      // cell -> 0..1 while it shakes
  sim.regrow = new Map();       // cell -> seconds until it grows back
  sim.ghost = new Set();        // switch-block cells that turned solid inside the player
  const pd = p.data;
  pd.coyote = 0; pd.buffer = 0; pd.grounded = false; pd.ground = null; pd.climbing = false; pd.swimming = false;
  pd.hurtLock = 0; pd.doubleUsed = false; pd.drop = 0; pd.stepT = 0; pd.power = null; pd.shield = 0;

  for (const e of sim.entities) {
    const d = e.data;
    if (e.type === 'platform') {
      const w = Math.max(1, Math.min(5, e.props.width | 0 || 3));
      Object.assign(e, { x: e.cell.x, y: e.cell.y, w, h: 0.45 });
      d.ox = e.x; d.oy = e.y; d.travel = 0; d.dirn = 1; d.dx = 0; d.dy = 0;
    } else if (e.type === 'slime' || e.type === 'spiky') {
      e.facing = -1; e.anim = 'walk';
    } else if (e.type === 'bee') {
      d.ox = e.x; d.oy = e.y; d.phase = (e.cell.x * 0.37) % 1;
      e.anim = 'fly';
    } else if (e.type === 'turret') {
      d.timer = (e.props.interval || 2) * (0.4 + ((e.cell.x * 7 + e.cell.y * 3) % 10) / 20);
    } else if (e.type === 'boss') {
      d.state = 'idle'; d.timer = 1.2; d.invuln = 0;
      e.hp = e.maxHp = e.props.hp || 3;
      sim.boss = e;
    } else if (e.type === 'door') {
      e.open = false;
    }
    if (entityDef(e.type)?.enemy) { e.vx = 0; e.vy = 0; }
  }

  const solidParts = () => sim.entities.filter(e => e.alive && ((e.type === 'door' && !e.open) || e.type === 'bswitch'));

  // ------------------------------------------------------------------ collision
  function cellSolid(x, y, forPlayer) {
    if (x < 0 || x >= W) return true;
    if (y < 0 || y >= H) return false;
    const i = y * W + x;
    const c = sim.tiles[i];
    if (!c || !isSolidCode(sim, c)) return false;
    if (forPlayer && sim.ghost.has(i)) return false;
    return true;
  }
  function oneWayTop(x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const c = sim.tiles[y * W + x];
    if (c === 3) return true;
    if (c === 7) return y === 0 || sim.tiles[(y - 1) * W + x] !== 7;
    return false;
  }
  /** Move a body horizontally; returns the solid it hit (true for tiles) or null. */
  function moveX(b, dx, forPlayer, parts) {
    if (!dx) return null;
    b.x += dx;
    let hit = null;
    const y0 = Math.floor(b.y + EPS), y1 = Math.floor(b.y + b.h - EPS);
    if (dx > 0) {
      const cx = Math.floor(b.x + b.w - EPS);
      for (let y = y0; y <= y1; y++) if (cellSolid(cx, y, forPlayer)) { b.x = cx - b.w; hit = true; break; }
    } else {
      const cx = Math.floor(b.x + EPS);
      for (let y = y0; y <= y1; y++) if (cellSolid(cx, y, forPlayer)) { b.x = cx + 1; hit = true; break; }
    }
    for (const s of parts) {
      if (s === b || !overlaps(b, s)) continue;
      b.x = dx > 0 ? s.x - b.w : s.x + s.w;
      hit = s;
    }
    return hit;
  }
  /** Move vertically; returns { hit, ground, part } where ground means it landed. */
  function moveY(b, dy, forPlayer, parts, dropping) {
    const res = { hit: null, ground: false, part: null };
    if (!dy) return res;
    const prevBottom = b.y + b.h;
    b.y += dy;
    const x0 = Math.floor(b.x + EPS), x1 = Math.floor(b.x + b.w - EPS);
    if (dy > 0) {
      const cy = Math.floor(b.y + b.h - EPS);
      for (let x = x0; x <= x1; x++) {
        if (cellSolid(x, cy, forPlayer) || (!dropping && prevBottom <= cy + EPS * 10 && oneWayTop(x, cy))) {
          b.y = cy - b.h; res.hit = true; res.ground = true; break;
        }
      }
      if (!dropping) {
        for (const e of sim.entities) {
          if (e.type !== 'platform' || e === b) continue;
          if (b.x + b.w <= e.x || b.x >= e.x + e.w) continue;
          if (prevBottom <= e.y - (e.data.dy < 0 ? e.data.dy : 0) + 0.02 && b.y + b.h >= e.y) { b.y = e.y - b.h; res.hit = true; res.ground = true; res.part = e; }
        }
      }
    } else {
      const cy = Math.floor(b.y + EPS);
      const blocked = [];
      for (let x = x0; x <= x1; x++) if (cellSolid(x, cy, forPlayer)) blocked.push(x);
      if (blocked.length) {
        // corner correction: a ceiling that only clips the body's edge nudges it aside
        if (forPlayer && blocked.length === 1) {
          const bx = blocked[0];
          const overlapL = bx + 1 - b.x, overlapR = b.x + b.w - bx;
          if (bx === x0 && overlapL < 0.3 && !cellSolid(bx + 1, cy, true)) { b.x = bx + 1; return res; }
          if (bx === x1 && overlapR < 0.3 && !cellSolid(bx - 1, cy, true)) { b.x = bx - b.w; return res; }
        }
        b.y = cy + 1; res.hit = true;
      }
    }
    for (const s of parts) {
      if (s === b || !overlaps(b, s)) continue;
      if (dy > 0) { b.y = s.y - b.h; res.ground = true; } else b.y = s.y + s.h;
      res.hit = true; res.part = s;
    }
    return res;
  }
  function moveBody(b, dx, dy, forPlayer, dropping = false) {
    const parts = solidParts();
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.4));
    let hx = null, ry = { hit: null, ground: false, part: null };
    for (let i = 0; i < n; i++) {
      const h = moveX(b, dx / n, forPlayer, parts);
      if (h) { hx = h; dx = 0; }
      const r = moveY(b, dy / n, forPlayer, parts, dropping);
      if (r.hit) { ry = r; dy = 0; }
      if (!dx && !dy) break;
    }
    return { hx, ry };
  }
  function standingOn(b, forPlayer) {
    const y = Math.floor(b.y + b.h + 0.02);
    const x0 = Math.floor(b.x + EPS), x1 = Math.floor(b.x + b.w - EPS);
    for (let x = x0; x <= x1; x++) if (cellSolid(x, y, forPlayer) || (Math.abs(b.y + b.h - y) < 0.03 && oneWayTop(x, y))) return true;
    return false;
  }
  function cellsUnder(b) {
    const out = [];
    const y = Math.floor(b.y + b.h + 0.02);
    if (y < 0 || y >= H) return out;
    for (let x = Math.floor(b.x + EPS); x <= Math.floor(b.x + b.w - EPS); x++) if (x >= 0 && x < W) out.push(y * W + x);
    return out;
  }
  function tileUnderCenter(b, dy = 0) {
    const x = Math.floor(b.x + b.w / 2), y = Math.floor(b.y + b.h / 2 + dy);
    return x < 0 || y < 0 || x >= W || y >= H ? 0 : sim.tiles[y * W + x];
  }

  // ------------------------------------------------------------------ wires
  function onPower(t) {
    if (t.type === 'door') updateDoor(t);
  }
  function updateDoor(d) {
    if (d.data.unlocked) return;
    const want = d.powered > 0;
    if (want && !d.open) openDoor(d);
    else if (!want && d.open && !d.props.stayOpen && !overlaps(p, d)) { d.open = false; d.animTime = 0; sim.emit('doorClose', d.x + 0.5, d.y + 0.5); }
  }
  function openDoor(d) { d.open = true; d.animTime = 0; sim.emit('door', d.x + 0.5, d.y + 0.5); }
  function flipToggle() {
    sim.toggle = !sim.toggle;
    // blocks that just turned solid inside the player stay passable until the player leaves them
    for (let y = Math.floor(p.y); y <= Math.floor(p.y + p.h - EPS); y++) for (let x = Math.floor(p.x); x <= Math.floor(p.x + p.w - EPS); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (isSolidCode(sim, sim.tiles[i])) sim.ghost.add(i);
    }
    sim.emit('toggle', p.x + p.w / 2, p.y);
  }

  // ------------------------------------------------------------------ the step
  sim.step = input => {
    sim.time += STEP; sim.tick++;
    for (const e of sim.entities) e.animTime += STEP;
    p.animTime += STEP;
    if (sim.status !== 'play') { if (sim.status === 'won') p.anim = 'win'; return; }

    stepPlatforms();
    stepPlayer(input);
    stepEntities(input);
    stepProjectiles();
    stepTiles();
    rules();
    sim.message = null;
    for (const e of sim.entities) if (e.type === 'sign') { e.active = e.alive && overlaps(p, e); if (e.active) sim.message = { title: 'Sign', text: e.props.text || '' }; }
    if (p.y > H + 1.5 && sim.status === 'play') killPlayer(sim);
    recordTrace(sim);
    tickTimer(sim);
  };

  function stepPlatforms() {
    for (const e of sim.entities) {
      if (e.type !== 'platform') continue;
      const d = e.data;
      const run = e.inputs === 0 || e.powered > 0;
      const dist = Math.max(1, e.props.distance || 5), speed = e.props.speed || 2.5;
      const before = d.travel;
      if (run) {
        d.travel += d.dirn * speed * STEP;
        if (d.travel >= dist) { d.travel = dist; d.dirn = -1; }
        if (d.travel <= 0) { d.travel = 0; d.dirn = 1; }
      }
      const delta = d.travel - before;
      const nx = e.props.axis === 'y' ? d.ox : d.ox + d.travel;
      const ny = e.props.axis === 'y' ? d.oy + d.travel : d.oy;
      d.dx = nx - e.x; d.dy = ny - e.y;
      e.x = nx; e.y = ny;
      e.active = run && delta !== 0;
      // carry the rider
      if (pd.ground === e) {
        moveBody(p, d.dx, 0, true);
        if (d.dy > 0) p.y += d.dy; else moveBody(p, 0, d.dy, true);
      }
    }
  }

  function stepPlayer(input) {
    const pr = input.pressed || {};
    if (pr.jump) pd.buffer = BUFFER; else pd.buffer = Math.max(0, pd.buffer - STEP);
    pd.coyote = pd.grounded ? COYOTE : Math.max(0, pd.coyote - STEP);
    p.invuln = Math.max(0, p.invuln - STEP);
    pd.hurtLock = Math.max(0, pd.hurtLock - STEP);
    pd.drop = Math.max(0, pd.drop - STEP);
    if (pd.power) {
      pd.power.left -= STEP;
      if (pd.power.left <= 0) { if (pd.power.kind === 'shield') pd.shield = 0; pd.power = null; sim.emit('powerEnd', p.x, p.y); }
    }
    const lock = pd.hurtLock > 0;
    const dirX = lock ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const center = tileUnderCenter(p);
    const inWater = center === 8;
    const onLadder = tileUnderCenter(p) === 7 || tileUnderCenter(p, p.h / 2 - 0.05) === 7;
    const ladderBelow = (() => { const x = Math.floor(p.x + p.w / 2), y = Math.floor(p.y + p.h + 0.05); return x >= 0 && y >= 0 && x < W && y < H && sim.tiles[y * W + x] === 7; })();
    if (inWater && !pd.swimming) sim.emit('splash', p.x + p.w / 2, p.y + p.h);
    pd.swimming = inWater;

    // ladders: grab with up/down, leave with jump or by walking off
    if (!pd.climbing && !lock && ((onLadder && input.up && !pd.grounded) || (onLadder && input.up && pd.grounded) || (ladderBelow && input.down && pd.grounded))) {
      pd.climbing = true;
      if (ladderBelow && input.down) p.y += 0.12;
    }
    if (pd.climbing && !onLadder && !ladderBelow) pd.climbing = false;

    if (pd.climbing) {
      p.vx = dirX * 3;
      p.vy = (input.down ? 1 : 0) * CLIMB - (input.up ? 1 : 0) * CLIMB;
      const lx = Math.floor(p.x + p.w / 2) + 0.5 - p.w / 2;
      p.x += (lx - p.x) * 0.35;
      if (pd.buffer > 0) { pd.climbing = false; pd.buffer = 0; p.vy = -JUMP_V * 0.85; sim.emit('jump', p.x + p.w / 2, p.y + p.h); sim.stats.jumps++; }
      const r = moveBody(p, p.vx * STEP, p.vy * STEP, true);
      if (r.ry.ground) { pd.climbing = false; pd.grounded = true; }
      if (!onLadder && input.up) { pd.climbing = false; }
      p.anim = 'climb'; if (p.vy !== 0 || p.vx !== 0) p.animTime += STEP * 0.5; else p.animTime -= STEP;
      pickupsAndParts(input);
      return;
    }

    // horizontal
    const onIce = pd.grounded && cellsUnder(p).some(i => sim.tiles[i] === 4);
    const top = inWater ? SWIM_RUN : RUN;
    const target = dirX * top;
    let accel = pd.grounded ? (onIce ? ICE_ACCEL : ACCEL) : AIR_ACCEL;
    if (!dirX) accel = pd.grounded ? (onIce ? ICE_DECEL : DECEL) : AIR_ACCEL * 0.55;
    if (dirX && Math.sign(p.vx) !== dirX && p.vx !== 0 && pd.grounded && !onIce) accel *= 1.4;
    if (lock) accel = 6;
    const dv = target - p.vx;
    p.vx += Math.sign(dv) * Math.min(Math.abs(dv), accel * STEP);
    if (dirX) p.facing = dirX;

    // vertical
    if (inWater) {
      p.vy = Math.min(SWIM_FALL, p.vy + SWIM_G * STEP);
      if (pd.buffer > 0) {
        pd.buffer = 0;
        const surface = tileUnderCenter(p, -0.6) !== 8;
        p.vy = surface ? -JUMP_V * 0.8 : -SWIM_PADDLE;
        sim.emit(surface ? 'jump' : 'splash', p.x + p.w / 2, p.y);
      }
    } else {
      const canJump = pd.grounded || pd.coyote > 0;
      if (pd.buffer > 0 && !lock) {
        if (canJump && input.down && standingOnOneWay()) {
          pd.drop = 0.2; pd.buffer = 0; pd.grounded = false; p.y += 0.05;
        } else if (canJump) {
          p.vy = -JUMP_V; pd.buffer = 0; pd.coyote = 0; pd.grounded = false; pd.ground = null; pd.jumping = true;
          sim.emit('jump', p.x + p.w / 2, p.y + p.h); sim.stats.jumps++;
        } else if (pd.power?.kind === 'wings' && !pd.doubleUsed) {
          p.vy = -JUMP_V * 0.9; pd.doubleUsed = true; pd.buffer = 0; pd.jumping = true;
          sim.emit('doubleJump', p.x + p.w / 2, p.y + p.h);
        }
      }
      // variable height: letting go of jump while rising cuts the rise, once per jump
      if (pd.jumping && !input.jump && p.vy < 0) { p.vy *= JUMP_CUT; pd.jumping = false; }
      if (p.vy >= 0) pd.jumping = false;
      p.vy = Math.min(MAX_FALL, p.vy + G * STEP * (p.vy > 0 ? 1.12 : 1));
    }

    const wasGrounded = pd.grounded;
    const fallSpeed = p.vy;
    const r = moveBody(p, p.vx * STEP, p.vy * STEP, true, pd.drop > 0);
    if (r.hx) p.vx = 0;
    if (r.ry.hit) {
      if (p.vy < 0) {
        // head bump: a colour switch struck from below flips the blocks
        if (r.ry.part?.type === 'bswitch') hitSwitch(r.ry.part);
        sim.emit('bump', p.x + p.w / 2, p.y);
      }
      p.vy = 0;
    }
    pd.grounded = r.ry.ground || (p.vy >= 0 && standingOn(p, true)) || standingOnPlatform();
    if (r.ry.ground) pd.ground = r.ry.part && r.ry.part.type === 'platform' ? r.ry.part : null;
    else if (!pd.grounded) pd.ground = null;
    if (r.ry.part?.type === 'bswitch' && r.ry.ground && fallSpeed > 6) hitSwitch(r.ry.part);
    if (pd.grounded) { pd.doubleUsed = false; if (p.vy > 0) p.vy = 0; }
    if (pd.grounded && !wasGrounded && fallSpeed > 9) sim.emit('land', p.x + p.w / 2, p.y + p.h, { speed: fallSpeed });

    // animation
    if (pd.hurtLock > 0) setAnim(p, 'hurt');
    else if (inWater) setAnim(p, 'swim');
    else if (!pd.grounded) setAnim(p, p.vy < 0 ? 'jump' : 'fall');
    else if (Math.abs(p.vx) > 0.6) {
      setAnim(p, 'run');
      pd.stepT += STEP * Math.abs(p.vx) / RUN;
      if (pd.stepT > 0.27) { pd.stepT = 0; sim.emit('step', p.x + p.w / 2, p.y + p.h); }
    } else setAnim(p, 'idle');

    pickupsAndParts(input);
  }
  function standingOnOneWay() {
    const y = Math.floor(p.y + p.h + 0.02);
    const cells = cellsUnder(p);
    if (pd.ground?.type === 'platform') return true;
    return cells.length > 0 && cells.every(i => { const x = i % W; return oneWayTop(x, y) || !isSolidCode(sim, sim.tiles[i]); }) && cells.some(i => oneWayTop(i % W, y));
  }
  function standingOnPlatform() {
    for (const e of sim.entities) {
      if (e.type !== 'platform') continue;
      if (p.x + p.w > e.x && p.x < e.x + e.w && Math.abs(p.y + p.h - e.y) < 0.04 && p.vy >= 0) { pd.ground = e; return true; }
    }
    return false;
  }
  function hitSwitch(s) {
    if (s.data.cool > 0) return;
    s.data.cool = 0.3;
    s.anim = 'hit'; s.animTime = 0;
    flipToggle();
  }

  function pickupsAndParts(input) {
    const pr = input.pressed || {};
    for (const e of sim.entities) {
      if (!e.alive) continue;
      if (e.data.cool > 0) e.data.cool -= STEP;
      switch (e.type) {
        case 'coin': case 'gem':
          if (overlaps(p, e)) collect(sim, e);
          break;
        case 'heart':
          if (overlaps(p, e)) { e.alive = false; p.hearts = Math.min(p.maxHearts, p.hearts + 1); sim.emit('heart', e.x + e.w / 2, e.y + e.h / 2); }
          break;
        case 'key':
          if (overlaps(p, e)) { e.alive = false; sim.keys[e.props.color || 'amber']++; sim.emit('key', e.x + e.w / 2, e.y + e.h / 2, { color: e.props.color }); }
          break;
        case 'powerup':
          if (overlaps(p, e)) {
            e.alive = false;
            const kind = e.props.kind === 'wings' ? 'wings' : 'shield';
            pd.power = { kind, left: e.props.seconds || 10, total: e.props.seconds || 10 };
            if (kind === 'shield') pd.shield = 1;
            pd.doubleUsed = false;
            sim.emit('powerup', e.x + e.w / 2, e.y + e.h / 2, { kind });
          }
          break;
        case 'checkpoint':
          if (!e.active && overlaps(p, e)) {
            e.active = true;
            const b = bodyFor('side', 'player', e.cell.x, e.cell.y);
            sim.checkpoint = { x: b.x, y: b.y };
            sim.emit('checkpoint', e.x + e.w / 2, e.y);
          }
          break;
        case 'goal':
          if (overlaps(p, e) && sim.level.rules.win === 'goal') { e.active = true; win(sim); }
          break;
        case 'door':
          if (!e.open) {
            const lock = e.props.lock || 'none';
            const near = { x: p.x - 0.08, y: p.y, w: p.w + 0.16, h: p.h };
            if (lock !== 'none' && sim.keys[lock] > 0 && overlaps(near, e)) { sim.keys[lock]--; e.data.unlocked = true; openDoor(e); }
          }
          break;
        case 'switch':
          if (overlaps(p, e) && (pr.action || pr.up)) {
            const mode = e.props.mode || 'once';
            if (mode === 'once' && e.active) break;
            const on = mode === 'toggle' ? !e.active : true;
            e.anim = 'toggle'; e.animTime = 0;
            setSource(sim, e, on, onPower);
            if (mode === 'timed') e.data.timer = e.props.seconds || 8;
            sim.emit('lever', e.x + e.w / 2, e.y + e.h / 2, { on });
          }
          if (e.props.mode === 'timed' && e.active) {
            e.data.timer -= STEP;
            if (e.data.timer <= 0) { setSource(sim, e, false, onPower); sim.emit('lever', e.x + e.w / 2, e.y + e.h / 2, { on: false }); }
          }
          break;
        case 'spring':
          if (p.vy >= 0 && overlaps(p, e) && p.y + p.h <= e.y + e.h + 0.01) {
            const h = e.props.power || 7;
            p.vy = -Math.sqrt(2 * G * (h + 0.35));
            p.y = e.y - p.h;
            pd.grounded = false; pd.ground = null; pd.doubleUsed = false;
            e.anim = 'bounce'; e.animTime = 0;
            sim.emit('spring', e.x + e.w / 2, e.y);
          }
          break;
      }
    }
  }

  function stepEntities() {
    const diff = sim.difficulty;
    for (const e of sim.entities) {
      if (!e.alive) continue;
      const def = entityDef(e.type);
      if (!def?.enemy) continue;
      e.flash = Math.max(0, (e.flash || 0) - STEP * 5);
      if (e.type === 'slime' || e.type === 'spiky') walker(e, (e.props.speed || (e.type === 'spiky' ? 1 : 1.5)) * diff.speed);
      else if (e.type === 'bee') flyer(e, diff.speed);
      else if (e.type === 'turret') turret(e);
      else if (e.type === 'boss') boss(e, diff.speed);
      contact(e);
    }
  }

  function walker(e, speed) {
    if (e.data.stun > 0) { e.data.stun -= STEP; e.vx = 0; }
    else e.vx = e.facing * speed;
    e.vy = Math.min(MAX_FALL, e.vy + G * STEP);
    const r = moveBody(e, e.vx * STEP, e.vy * STEP, false);
    if (r.ry.hit) e.vy = 0;
    const grounded = r.ry.ground || standingOn(e, false);
    if (r.hx) e.facing *= -1;
    else if (grounded) {
      // turn at ledges: no floor under the leading foot
      const fx = e.facing > 0 ? e.x + e.w + 0.05 : e.x - 0.05;
      const fy = Math.floor(e.y + e.h + 0.1);
      const cx = Math.floor(fx);
      const floorAhead = cellSolid(cx, fy, false) || oneWayTop(cx, fy) || sim.entities.some(o => o.type === 'platform' && fx >= o.x && fx <= o.x + o.w && Math.abs(o.y - (e.y + e.h)) < 0.2);
      if (!floorAhead) e.facing *= -1;
    }
    // walkers turn back from thorns rather than walking into them
    const ax = Math.floor(e.facing > 0 ? e.x + e.w + 0.05 : e.x - 0.05), ay = Math.floor(e.y + e.h - 0.1);
    if (ax >= 0 && ay >= 0 && ax < W && ay < H && sim.tiles[ay * W + ax] === 6) e.facing *= -1;
    e.anim = e.data.stun > 0 ? 'hurt' : 'walk';
    if (e.y > H + 2) e.alive = false;
  }

  function flyer(e, speedK) {
    const d = e.data;
    const axis = e.props.axis || 'y', range = e.props.range || 3, speed = (e.props.speed || 2) * speedK;
    const k = speed / Math.max(0.5, range);
    const px = e.x;
    if (axis === 'x') { e.x = d.ox + Math.sin(sim.time * k + d.phase * 6.283) * range; e.y = d.oy + Math.sin(sim.time * 5) * 0.08; }
    else if (axis === 'y') { e.y = d.oy + Math.sin(sim.time * k + d.phase * 6.283) * range; e.x = d.ox + Math.sin(sim.time * 1.7) * 0.1; }
    else { e.x = d.ox + Math.cos(sim.time * 1.3 + d.phase * 6.283) * 0.5; e.y = d.oy + Math.sin(sim.time * 2.6) * 0.35; }
    if (e.x !== px) e.facing = e.x > px ? 1 : -1;
    e.anim = 'fly';
  }

  function turret(e) {
    const d = e.data;
    const armed = e.inputs === 0 || e.powered > 0;
    const dx = p.x + p.w / 2 - (e.x + e.w / 2), dy = p.y + p.h / 2 - (e.y + e.h / 2);
    if (e.props.dir === 'player') d.aim = Math.atan2(dy, dx);
    if (!armed) { e.anim = 'idle'; return; }
    d.timer -= STEP;
    if (d.timer < 0.3 && d.timer > 0) e.anim = 'attack';
    if (d.timer <= 0) {
      d.timer = e.props.interval || 2;
      if (dx * dx + dy * dy > 20 * 20) return;
      const dir = e.props.dir || 'left';
      let vx = 0, vy = 0;
      if (dir === 'player') { const a = d.aim; vx = Math.cos(a) * 7; vy = Math.sin(a) * 7; }
      else if (dir === 'left') vx = -7; else if (dir === 'right') vx = 7; else if (dir === 'up') vy = -7; else vy = 7;
      const cx = e.x + e.w / 2, cy = e.y + 0.35;
      sim.projectiles.push({ x: cx + Math.sign(vx) * 0.45, y: cy + Math.sign(vy) * 0.45, vx, vy, r: 0.14, owner: 'enemy', kind: 'acorn', life: 6 });
      e.anim = 'fire'; e.animTime = 0;
      sim.emit('shoot', cx, cy, { owner: 'enemy' });
    }
  }

  function boss(e, speedK) {
    const d = e.data;
    d.invuln = Math.max(0, d.invuln - STEP);
    e.invuln = d.invuln;
    e.vy = Math.min(MAX_FALL, e.vy + G * 0.8 * STEP);
    const r = moveBody(e, e.vx * STEP, e.vy * STEP, false);
    const grounded = r.ry.ground || standingOn(e, false);
    if (r.hx) e.vx = -e.vx * 0.5;
    if (grounded && e.vy >= 0) {
      if (d.state === 'hop') {
        d.state = 'idle'; d.timer = 0.9 / speedK; e.vx = 0;
        sim.emit('slam', e.x + e.w / 2, e.y + e.h, { shake: 0.5 });
        for (const dir of [-1, 1]) sim.projectiles.push({ x: e.x + e.w / 2 + dir * 0.9, y: e.y + e.h - 0.2, vx: dir * 6.5, vy: 0, r: 0.35, owner: 'enemy', kind: 'ring', life: 1.1, ground: true });
      }
      e.vx *= 0.8;
      d.timer -= STEP;
      e.facing = p.x + p.w / 2 < e.x + e.w / 2 ? -1 : 1;
      if (d.state === 'idle' && d.timer <= 0) { d.state = 'windup'; d.timer = 0.45; e.anim = 'attack'; e.animTime = 0; }
      else if (d.state === 'windup' && d.timer <= 0) {
        d.state = 'hop';
        const dist = Math.min(6, Math.abs(p.x - e.x));
        e.vx = e.facing * Math.max(2.5, dist * 0.9) * speedK;
        e.vy = -15;
        e.anim = 'walk'; e.animTime = 0;
        sim.emit('jump', e.x + e.w / 2, e.y + e.h, { big: true });
      } else if (d.state === 'idle') e.anim = 'idle';
    }
    if (e.y > H + 2) { e.alive = false; }
  }

  function contact(e) {
    if (!e.alive || sim.status !== 'play' || !overlaps(p, e)) return;
    const prevBottom = p.y + p.h - (p.vy > 0 ? p.vy * STEP : 0);
    const fromAbove = p.vy > 0 && prevBottom <= e.y + e.h * 0.55;
    if (fromAbove && STOMPABLE.has(e.type)) {
      if (e.type === 'boss' && e.data.invuln > 0) { p.vy = -STOMP; return; }
      p.vy = -(p.data.lastJumpHeld ? STOMP_HELD : STOMP);
      p.y = e.y - p.h;
      damage(e, 1, 'stomp');
      return;
    }
    if (e.type === 'boss' && e.data.invuln > 0.6) return;
    if (hurtPlayer(sim, 1, e)) knockback(e);
  }
  function knockback(from) {
    const dir = p.x + p.w / 2 < from.x + from.w / 2 ? -1 : 1;
    p.vx = dir * KNOCK_X; p.vy = -KNOCK_Y; pd.hurtLock = 0.3; pd.grounded = false; pd.ground = null; pd.climbing = false;
  }
  function damage(e, n, how) {
    e.hp -= n; e.flash = 1;
    if (e.type === 'boss') {
      e.data.invuln = 1; sim.emit('bossHit', e.x + e.w / 2, e.y, { hp: e.hp });
      if (e.hp > 0) split(e);
    }
    if (how === 'stomp') sim.emit('stomp', e.x + e.w / 2, e.y);
    if (e.hp <= 0) {
      e.alive = false; e.anim = 'dead'; e.animTime = 0;
      sim.kills++;
      sim.score += entityDef(e.type).score || SCORE.enemy;
      sim.emit('kill', e.x + e.w / 2, e.y + e.h / 2, { what: e.type, score: entityDef(e.type).score || SCORE.enemy });
    } else if (e.type !== 'boss') { e.data.stun = 0.3; }
  }
  function split(boss) {
    const id = boss.id + '-s' + sim.tick;
    const s = {
      id, type: 'slime', x: boss.x + boss.w / 2 - 0.4, y: boss.y + boss.h - 0.62, w: 0.8, h: 0.62,
      vx: 0, vy: -9, facing: boss.facing * -1, dir: 'down', anim: 'walk', animTime: 0, alive: true, active: false, open: false,
      hp: 1, maxHp: 1, props: { speed: 2, hp: 1 }, cell: { ...boss.cell }, fp: { w: 1, h: 1 }, inputs: 0, powered: 0, data: { stun: 0.4 },
    };
    sim.entities.push(s); sim.byId.set(id, s);
    sim.enemiesTotal++;
  }

  function stepProjectiles() {
    const list = sim.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i];
      q.life -= STEP;
      q.x += q.vx * STEP; q.y += q.vy * STEP;
      let dead = q.life <= 0;
      if (!dead && q.kind !== 'ring') {
        const cx = Math.floor(q.x), cy = Math.floor(q.y);
        if (cellSolid(cx, cy, false)) { dead = true; sim.emit('hit', q.x, q.y, { owner: q.owner }); }
      }
      if (!dead && q.owner === 'enemy' && sim.status === 'play') {
        const hitbox = q.kind === 'ring' ? { x: q.x - 0.35, y: q.y - 0.3, w: 0.7, h: 0.5 } : { x: q.x - q.r, y: q.y - q.r, w: q.r * 2, h: q.r * 2 };
        if (overlaps(p, hitbox) && !(q.kind === 'ring' && !pd.grounded)) {
          if (hurtPlayer(sim, 1, { x: q.x - 0.1, y: q.y, w: 0.2, h: 0.2 })) knockback({ x: q.x - 0.1, y: q.y, w: 0.2, h: 0.2 });
          if (q.kind !== 'ring') dead = true;
        }
      }
      if (q.kind === 'ring') q.r = 0.35 + (1.1 - q.life) * 0.3;
      if (dead) list.splice(i, 1);
    }
  }

  function stepTiles() {
    // thorns hurt
    if (sim.status === 'play' && p.invuln <= 0) {
      const box = { x: p.x + 0.06, y: p.y + 0.06, w: p.w - 0.12, h: p.h - 0.08 };
      for (let y = Math.floor(box.y); y <= Math.floor(box.y + box.h); y++) for (let x = Math.floor(box.x); x <= Math.floor(box.x + box.w); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || sim.tiles[y * W + x] !== 6) continue;
        const cell = { x: x + 0.12, y: y + 0.25, w: 0.76, h: 0.65 };
        if (overlaps(box, cell) && hurtPlayer(sim, 1, { x: x, y: y + 0.4, w: 1, h: 0.2 })) { knockback({ x: x + 0.5 - (p.x + p.w / 2 < x + 0.5 ? -0.01 : 0.01), y, w: 0, h: 1 }); p.vy = -KNOCK_Y * 1.1; }
      }
    }
    // crumble blocks under the player's feet
    if (pd.grounded) for (const i of cellsUnder(p)) if (sim.tiles[i] === 5 && !sim.crumble.has(i)) { sim.crumble.set(i, 0.001); sim.emit('crumble', i % W + 0.5, Math.floor(i / W), { start: true }); }
    for (const [i, k] of sim.crumble) {
      const n = k + STEP / 0.5;
      if (n >= 1) { sim.crumble.delete(i); sim.tiles[i] = 0; sim.regrow.set(i, 3); sim.emit('crumble', i % W + 0.5, Math.floor(i / W) + 0.5); }
      else sim.crumble.set(i, n);
    }
    for (const [i, s] of sim.regrow) {
      const n = s - STEP;
      const cell = { x: i % W, y: Math.floor(i / W), w: 1, h: 1 };
      if (n <= 0 && !overlaps(p, cell) && !sim.entities.some(e => e.alive && overlaps(e, cell))) { sim.regrow.delete(i); sim.tiles[i] = 5; }
      else sim.regrow.set(i, n);
    }
    // ghost cells release once the player has left them
    for (const i of sim.ghost) { const cell = { x: i % W, y: Math.floor(i / W), w: 1, h: 1 }; if (!overlaps(p, cell)) sim.ghost.delete(i); }
  }

  function rules() {
    const rule = sim.level.rules.win;
    if (rule === 'collect') {
      sim.objective = { label: 'Collect the honey jars', text: `${sim.gems} / ${sim.gemsTotal}`, progress: sim.gemsTotal ? sim.gems / sim.gemsTotal : 0 };
      if (sim.gemsTotal > 0 && sim.gems >= sim.gemsTotal) win(sim);
    } else if (rule === 'defeat') {
      const alive = sim.entities.filter(e => e.alive && entityDef(e.type)?.enemy).length;
      sim.objective = { label: sim.boss ? 'Defeat King Slime and the critters' : 'Defeat the critters', text: `${alive} left`, progress: sim.enemiesTotal ? 1 - alive / sim.enemiesTotal : 1 };
      if (alive === 0) win(sim);
    } else {
      sim.objective = { label: 'Reach the shrine', text: '', progress: 0 };
    }
  }

  function setAnim(e, a) { if (e.anim !== a) { e.anim = a; e.animTime = 0; } }

  sim.respawn = () => {
    respawnPlayer(sim);
    pd.grounded = false; pd.ground = null; pd.climbing = false; pd.hurtLock = 0; pd.buffer = 0; pd.shield = 0; pd.power = null;
    sim.projectiles.length = 0;
    for (const [i] of sim.regrow) sim.tiles[i] = 5;
    sim.regrow.clear(); sim.crumble.clear(); sim.ghost.clear();
    if (sim.boss && sim.boss.alive) { const b = sim.boss; Object.assign(b, bodyFor('side', 'boss', b.cell.x, b.cell.y, { w: 2, h: 2 })); b.vx = b.vy = 0; b.data.state = 'idle'; b.data.timer = 1.5; }
  };

  // Track whether jump is held for stomp height (set per step from input).
  const baseStep = sim.step;
  sim.step = input => { p.data.lastJumpHeld = !!input.jump; baseStep(input); };
  rules();
  return sim;
}
