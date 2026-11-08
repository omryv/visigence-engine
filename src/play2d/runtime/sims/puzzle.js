/**
 * Block puzzle: push every crate onto a pad. Sokoban rules, plus a few garden twists: ice
 * (you and crates slide until something stops you), pits (a crate pushed in fills it; you
 * cannot step in), keys and gates, plates wired to gates (held down by a crate or by you), and
 * warp flowers that carry you (never a crate).
 *
 * Moves are discrete. A pressed direction moves one cell; holding repeats every 0.16 s after a
 * 0.25 s delay. The move animates for 0.1 s (0.06 s per cell of a slide) while the logical cell
 * is already decided, so input never waits on animation. Every move pushes a full snapshot on
 * the undo stack: undo is exact, and restart is undo to the bottom.
 */
import { STEP, createBaseSim, setSource, recordTrace, win, tickTimer } from './shared.js';

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const FLOOR = new Set([0, 21, 25, 27]);          // cells a body may stand on (pits are not)
const CRATE_OK = new Set([0, 21, 25, 27, 26]);   // cells a crate may enter (26: fills the pit)

export function createPuzzleSim(project, levelIndex = 0, opts = {}) {
  const sim = createBaseSim(project, levelIndex, opts);
  const W = sim.W, H = sim.H;
  const p = sim.player;
  sim.cameraHint = 'fit';
  sim.boss = null;
  sim.moves = 0; sim.pushes = 0;
  const pd = p.data;
  pd.cell = { x: Math.floor(p.x + p.w / 2), y: Math.floor(p.y + p.h / 2) };
  pd.anim = null;   // { fx, fy, tx, ty, t, dur }
  pd.hold = null; pd.holdT = 0; pd.queued = null; pd.warpLock = false;
  p.dir = 'down';

  const crates = sim.entities.filter(e => e.type === 'crate');
  const pads = [];
  for (let i = 0; i < W * H; i++) if (sim.tiles[i] === 27) pads.push(i);
  sim.padsTotal = pads.length;
  sim.padsCovered = 0;
  const history = [];
  sim.canUndo = false;

  for (const c of crates) { c.data.anim = null; }
  for (const e of sim.entities) if (e.type === 'door') e.open = false;

  // ------------------------------------------------------------------ state
  const tile = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 20 : sim.tiles[y * W + x]);
  const crateAt = (x, y) => crates.find(c => c.alive && c.cell.x === x && c.cell.y === y) || null;
  const doorAt = (x, y) => sim.entities.find(e => e.type === 'door' && e.cell.x === x && e.cell.y === y) || null;
  const pickupAt = (x, y) => sim.entities.find(e => e.alive && e.type === 'key' && e.cell.x === x && e.cell.y === y) || null;

  function snapshot() {
    return {
      cell: { ...pd.cell }, dir: p.dir,
      crates: crates.map(c => ({ x: c.cell.x, y: c.cell.y, alive: c.alive })),
      tiles: new Uint16Array(sim.tiles),
      keys: { ...sim.keys },
      doors: sim.entities.filter(e => e.type === 'door').map(e => ({ id: e.id, open: e.open, unlocked: !!e.data.unlocked })),
      pickups: sim.entities.filter(e => e.type === 'key').map(e => ({ id: e.id, alive: e.alive })),
      moves: sim.moves, pushes: sim.pushes, warpLock: pd.warpLock,
    };
  }
  function restore(s) {
    pd.cell = { ...s.cell }; p.dir = s.dir;
    crates.forEach((c, i) => { c.cell = { x: s.crates[i].x, y: s.crates[i].y }; c.alive = s.crates[i].alive; c.anim = 'idle'; c.animTime = 1; c.data.anim = null; placeAt(c, c.cell.x, c.cell.y); });
    sim.tiles.set(s.tiles);
    Object.assign(sim.keys, s.keys);
    for (const d of s.doors) { const e = sim.byId.get(d.id); e.open = d.open; e.data.unlocked = d.unlocked; e.animTime = 1; }
    for (const k of s.pickups) sim.byId.get(k.id).alive = k.alive;
    sim.moves = s.moves; sim.pushes = s.pushes; pd.warpLock = s.warpLock;
    pd.anim = null;
    placeAt(p, pd.cell.x, pd.cell.y);
    plates();
    count();
  }
  function placeAt(e, x, y) { e.x = x + 0.5 - e.w / 2; e.y = y + 0.5 - e.h / 2; }

  // ------------------------------------------------------------------ rules of motion
  function doorBlocks(x, y) {
    const d = doorAt(x, y);
    return d && !d.open;
  }
  function crateCanEnter(x, y) {
    return CRATE_OK.has(tile(x, y)) && !crateAt(x, y) && !doorBlocks(x, y) && !pickupAt(x, y);
  }
  /** Try to move one step. Returns true if anything moved. */
  function tryMove(dirName) {
    const [dx, dy] = DIRS[dirName];
    p.dir = dirName;
    if (dx) p.facing = dx;
    const tx = pd.cell.x + dx, ty = pd.cell.y + dy;
    const t = tile(tx, ty);
    if (!FLOOR.has(t)) { sim.emit('bump', tx + 0.5, ty + 0.5); return false; }
    const door = doorAt(tx, ty);
    let unlock = null;
    if (door && !door.open) {
      const lock = door.props.lock || 'none';
      if (lock !== 'none' && sim.keys[lock] > 0) unlock = door;
      else { sim.emit('bump', tx + 0.5, ty + 0.5); return false; }
    }
    const crate = crateAt(tx, ty);
    const before = snapshot();
    let pushedPath = null;
    if (crate) {
      if (!crateCanEnter(tx + dx, ty + dy)) { sim.emit('bump', tx + 0.5, ty + 0.5); return false; }
      // the crate goes one cell, then keeps sliding while it is on ice and the way is clear
      let cx = tx + dx, cy = ty + dy;
      pushedPath = [[tx, ty], [cx, cy]];
      while (tile(cx, cy) === 25 && crateCanEnter(cx + dx, cy + dy) && tile(cx + dx, cy + dy) !== 26) { cx += dx; cy += dy; pushedPath.push([cx, cy]); }
      if (tile(cx, cy) === 25 && tile(cx + dx, cy + dy) === 26 && crateCanEnter(cx + dx, cy + dy)) { cx += dx; cy += dy; pushedPath.push([cx, cy]); }
      crate.cell = { x: cx, y: cy };
      crate.data.anim = { fx: tx, fy: ty, tx: cx, ty: cy, t: 0, dur: 0.1 + (pushedPath.length - 2) * 0.06 };
      crate.anim = 'idle';
      sim.pushes++;
      sim.emit('push', cx + 0.5, cy + 0.5);
      if (pushedPath.length > 2) sim.emit('slide', cx + 0.5, cy + 0.5);
      if (tile(cx, cy) === 26) {
        sim.tiles[cy * W + cx] = 0;
        crate.alive = false; crate.anim = 'dead'; crate.animTime = 0;
        sim.emit('fill', cx + 0.5, cy + 0.5);
      }
    }
    if (unlock) { sim.keys[unlock.props.lock]--; unlock.open = true; unlock.data.unlocked = true; unlock.animTime = 0; sim.emit('door', tx + 0.5, ty + 0.5); }
    // the player steps, and slides on ice while the way is clear
    let px = tx, py = ty, cells = 1;
    while (tile(px, py) === 25 && FLOOR.has(tile(px + dx, py + dy)) && !crateAt(px + dx, py + dy) && !doorBlocks(px + dx, py + dy)) { px += dx; py += dy; cells++; }
    pd.anim = { fx: pd.cell.x, fy: pd.cell.y, tx: px, ty: py, t: 0, dur: 0.1 + (cells - 1) * 0.06 };
    pd.cell = { x: px, y: py };
    if (cells > 1) sim.emit('slide', px + 0.5, py + 0.5);
    history.push(before);
    if (history.length > 2000) history.shift();
    sim.canUndo = true;
    sim.moves++;
    sim.emit('step', px + 0.5, py + 0.5);
    // pick up keys
    const key = pickupAt(px, py);
    if (key) { key.alive = false; sim.keys[key.props.color || 'amber']++; sim.emit('key', px + 0.5, py + 0.5, { color: key.props.color }); }
    // warp flowers carry the player to the next flower on the channel
    const warp = sim.entities.find(e => e.type === 'teleporter' && e.cell.x === px && e.cell.y === py);
    if (warp && !pd.warpLock) {
      const mates = sim.entities.filter(e => e.type === 'teleporter' && (e.props.channel || 1) === (warp.props.channel || 1));
      const to = mates[(mates.indexOf(warp) + 1) % mates.length];
      if (to && to !== warp && !crateAt(to.cell.x, to.cell.y)) {
        pd.cell = { x: to.cell.x, y: to.cell.y };
        pd.anim = null;
        pd.warpLock = true;
        sim.emit('teleport', to.cell.x + 0.5, to.cell.y + 0.5, { from: { x: px + 0.5, y: py + 0.5 } });
      }
    } else if (!warp) pd.warpLock = false;
    plates();
    count();
    if (sim.padsTotal > 0 && sim.padsCovered === sim.padsTotal) win(sim);
    return true;
  }

  function onPower(t, on) {
    if (t.type !== 'door' || t.data.unlocked) return;
    if (on && !t.open) { t.open = true; t.animTime = 0; sim.emit('door', t.x + 0.5, t.y + 0.5); }
    else if (!on && t.open && !t.props.stayOpen && !(pd.cell.x === t.cell.x && pd.cell.y === t.cell.y) && !crateAt(t.cell.x, t.cell.y)) { t.open = false; t.animTime = 0; sim.emit('doorClose', t.x + 0.5, t.y + 0.5); }
  }
  function plates() {
    for (const e of sim.entities) {
      if (e.type !== 'plate') continue;
      const on = (pd.cell.x === e.cell.x && pd.cell.y === e.cell.y) || !!crateAt(e.cell.x, e.cell.y);
      if (on !== !!e.active) { setSource(sim, e, on, onPower); sim.emit('plate', e.cell.x + 0.5, e.cell.y + 0.5, { on }); }
    }
  }
  function count() {
    let n = 0;
    for (const i of pads) if (crateAt(i % W, Math.floor(i / W))) n++;
    sim.padsCovered = n;
    for (const c of crates) c.active = c.alive && sim.tiles[c.cell.y * W + c.cell.x] === 27;
    sim.objective = { label: 'Push crates onto pads', text: `${n} / ${sim.padsTotal} · ${sim.moves} moves`, progress: sim.padsTotal ? n / sim.padsTotal : 0 };
  }

  sim.undo = () => {
    const s = history.pop();
    if (!s) return false;
    restore(s);
    sim.canUndo = history.length > 0;
    if (sim.status === 'won') sim.status = 'play';
    sim.emit('undo', pd.cell.x + 0.5, pd.cell.y + 0.5);
    return true;
  };
  sim.restart = () => {
    if (!history.length) return false;
    const first = history[0];
    history.length = 0;
    restore(first);
    sim.canUndo = false;
    sim.status = 'play';
    sim.emit('restart', pd.cell.x + 0.5, pd.cell.y + 0.5);
    return true;
  };
  sim.respawn = () => { sim.restart(); sim.status = 'play'; };

  // ------------------------------------------------------------------ the step
  sim.step = input => {
    sim.time += STEP; sim.tick++;
    p.animTime += STEP;
    for (const e of sim.entities) e.animTime += STEP;
    const pr = input.pressed || {};
    if (pr.undo) sim.undo();
    if (pr.restart) sim.restart();
    if (sim.status === 'play') {
      let want = null;
      for (const n of ['up', 'down', 'left', 'right']) if (pr[n]) { want = n; pd.hold = n; pd.holdT = 0; }
      if (!want && pd.hold && input[pd.hold]) {
        pd.holdT += STEP;
        if (pd.holdT >= 0.25) { want = pd.hold; pd.holdT -= 0.16; }
      } else if (pd.hold && !input[pd.hold]) pd.hold = null;
      if (want) {
        if (pd.anim && pd.anim.t < pd.anim.dur * 0.6) pd.queued = want;
        else tryMove(want);
      } else if (pd.queued && (!pd.anim || pd.anim.t >= pd.anim.dur * 0.6)) { const q = pd.queued; pd.queued = null; tryMove(q); }
    }
    // animate bodies toward their logical cells
    animate(p, pd);
    for (const c of crates) if (c.alive || c.data.anim) animate(c, c.data);
    const moving = !!pd.anim;
    const a = sim.status === 'won' ? 'win' : moving ? (history.length && history[history.length - 1].pushes !== sim.pushes ? 'push' : 'walk') : 'idle';
    if (p.anim !== a) { p.anim = a; p.animTime = 0; }
    recordTrace(sim);
    tickTimer(sim);
  };
  function animate(e, d) {
    const cell = e === p ? pd.cell : e.cell;
    if (!d.anim) { placeAt(e, cell.x, cell.y); return; }
    d.anim.t += STEP;
    const k = Math.min(1, d.anim.t / d.anim.dur);
    const s = k * k * (3 - 2 * k);
    const x = d.anim.fx + (d.anim.tx - d.anim.fx) * s, y = d.anim.fy + (d.anim.ty - d.anim.fy) * s;
    placeAt(e, x, y);
    if (k >= 1) { d.anim = null; placeAt(e, cell.x, cell.y); }
  }

  placeAt(p, pd.cell.x, pd.cell.y);
  for (const c of crates) placeAt(c, c.cell.x, c.cell.y);
  plates();
  count();
  return sim;
}
