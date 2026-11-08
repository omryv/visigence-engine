/**
 * Draws a level, live or static, through the art facade. One renderer serves the editor's
 * grid, the gallery previews and the game, so what you paint is exactly what you play.
 *
 *   drawScene(ctx, scene, cam, art, opts)   scene = a sim, or sceneFromLevel() for a static level
 *   cam = { x, y, size }                    world tile at the canvas top-left; canvas px per tile
 *
 * Tile positions are whole pixels (the camera origin is rounded once and every cell steps by an
 * integer size), which is what keeps adjacent cached tiles seamless at every zoom.
 */
import { entityDef, viewOf, footprint } from '../core/catalog.js';
import { bodyFor, mazeDots } from './sims/shared.js';

// Out of bounds, these read as more of themselves so ground, walls and water run off the edge.
const EDGE_SAME = new Set([1, 2, 4, 8, 20, 22]);
const BEHIND = new Set(['door', 'platform', 'spring', 'bswitch', 'switch', 'sign', 'checkpoint', 'goal', 'teleporter', 'plate', 'spawner', 'chest', 'crate']);
const PICKUP = new Set(['coin', 'gem', 'heart', 'key', 'powerup', 'power']);

function layerOf(e) {
  if (BEHIND.has(e.type)) return 0;
  if (PICKUP.has(e.type)) return 1;
  if (e.type === 'player') return 3;
  return 2;
}

export function drawScene(ctx, scene, cam, art, opts = {}) {
  const width = opts.width, height = opts.height;
  const size = Math.max(1, Math.round(cam.size));
  const level = scene.level;
  const view = scene.view;
  const t = opts.t ?? scene.time ?? 0;
  const W = scene.W, H = scene.H;
  const ox = Math.round(-cam.x * size), oy = Math.round(-cam.y * size);
  const info = { biome: level.biome, time: level.time, view, t, toggle: !!scene.toggle, genre: scene.genre, editor: !!opts.editor, x: 0, y: 0, at: null, crumble: 0 };

  if (opts.background !== false) art.background(ctx, width, height, { ...info, camX: cam.x, camY: cam.y, size, levelW: W, levelH: H });

  const x0 = Math.max(0, Math.floor(cam.x) - 1), y0 = Math.max(0, Math.floor(cam.y) - 1);
  const x1 = Math.min(W - 1, Math.ceil(cam.x + width / size) + 1), y1 = Math.min(H - 1, Math.ceil(cam.y + height / size) + 1);
  const tiles = scene.tiles, decor = scene.decor;
  let cx = 0, cy = 0, cself = 0;
  const atTile = (dx, dy) => {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
      if (view === 'side' && ny < 0) return 0;
      return EDGE_SAME.has(cself) ? cself : 0;
    }
    return tiles[ny * W + nx];
  };
  const atDecor = (dx, dy) => {
    const nx = cx + dx, ny = cy + dy;
    return nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : decor[ny * W + nx];
  };
  const drawDecorCell = (x, y) => {
    const d = decor[y * W + x];
    if (!d) return;
    cx = x; cy = y; info.x = x; info.y = y; info.at = atDecor;
    art.decor(ctx, d, ox + x * size, oy + y * size, size, info);
  };

  // Side view: decor stands behind the ground (big decor may start off-screen, so widen the scan).
  if (view === 'side' && decor && opts.decor !== false) {
    const dx0 = Math.max(0, x0 - 4), dy1 = Math.min(H - 1, y1 + 3);
    for (let y = y0; y <= dy1; y++) for (let x = dx0; x <= x1; x++) drawDecorCell(x, y);
  }

  // Terrain.
  if (opts.terrain !== false) {
    const crumble = scene.crumble;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const code = tiles[i];
        if (!code && view === 'side') continue;
        cx = x; cy = y; cself = code;
        info.x = x; info.y = y; info.at = atTile;
        info.crumble = crumble ? crumble.get(i) || 0 : 0;
        art.tile(ctx, code, ox + x * size, oy + y * size, size, info);
      }
    }
  }

  // Pollen.
  if (scene.dots) {
    const d = scene.dots;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[y * W + x]) art.dot(ctx, ox + x * size + size / 2, oy + y * size + size / 2, size, info);
  }

  // Entities (and, in top view, decor interleaved by row so trees overlap what stands behind them).
  const list = [];
  if (opts.entities !== false) {
    for (const e of scene.entities) {
      if (e.alive === false && !(e.anim === 'dead' && e.animTime < 0.6)) continue;
      if (e.x + e.w < cam.x - 2 || e.y + e.h < cam.y - 3 || e.x > cam.x + width / size + 2 || e.y > cam.y + height / size + 2) continue;
      list.push(e);
    }
    if (scene.player && (scene.player.alive !== false || scene.player.anim === 'dead')) list.push(scene.player);
  }
  const boxOf = e => ({ x: ox + e.x * size, y: oy + e.y * size, w: e.w * size, h: e.h * size });
  if (view === 'side') {
    list.sort((a, b) => layerOf(a) - layerOf(b));
    for (const e of list) art.entity(ctx, e, boxOf(e), size, info);
  } else {
    // flat mechanisms first, then everything that stands, row by row with the decor
    const standing = [];
    for (const e of list) { if (FLATLIKE.has(e.type)) art.entity(ctx, e, boxOf(e), size, info); else standing.push(e); }
    standing.sort((a, b) => (a.y + a.h) - (b.y + b.h));
    let j = 0;
    const dy0 = y0, dy1 = Math.min(H - 1, y1 + 3);
    for (let y = dy0; y <= dy1; y++) {
      if (decor && opts.decor !== false) for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) drawDecorCell(x, y);
      while (j < standing.length && standing[j].y + standing[j].h <= y + 1) { art.entity(ctx, standing[j], boxOf(standing[j]), size, info); j++; }
    }
    for (; j < standing.length; j++) art.entity(ctx, standing[j], boxOf(standing[j]), size, info);
  }

  // Projectiles.
  if (scene.projectiles) for (const p of scene.projectiles) art.projectile(ctx, p, ox + p.x * size, oy + p.y * size, size, info);

  if (opts.fx) opts.fx(ctx, cam, size, ox, oy);

  if (opts.darkness && scene.lights) {
    const lights = scene.lights.map(l => ({ x: ox + l.x * size, y: oy + l.y * size, r: l.r * size }));
    art.darkness(ctx, width, height, lights);
  }
  if (opts.grade !== false) art.grade(ctx, width, height, info);
}

/** Flat top-view parts drawn under everything that stands. */
const FLATLIKE = new Set(['plate', 'teleporter', 'spawner', 'platform']);

/**
 * A static scene of a level as authored: entities at their cells, idle, maze pollen shown.
 * The editor and the gallery draw this; the game draws its live sim instead.
 */
export function sceneFromLevel(project, levelIndex = 0, t = 0) {
  const level = project.levels[levelIndex];
  const genre = project.genre, view = viewOf(genre);
  const entities = [];
  let player = null;
  for (const src of level.entities) {
    const def = entityDef(src.type);
    if (!def) continue;
    const fp = footprint(src);
    const body = bodyFor(view, src.type, src.x, src.y, fp);
    const e = {
      id: src.id, type: src.type, ...body, props: src.props, cell: { x: src.x, y: src.y },
      facing: src.type === 'player' ? 1 : -1, dir: 'down', anim: 'idle', animTime: 0,
      alive: true, active: src.type === 'checkpoint' ? false : false, open: false,
      hp: src.props?.hp || 1, maxHp: src.props?.hp || 1, data: {}, inputs: level.links.some(k => k.to === src.id) ? 1 : 0, powered: 0,
    };
    if (src.type === 'player') player = e; else entities.push(e);
  }
  return {
    genre, view, level, W: level.width, H: level.height,
    tiles: level.terrain, decor: level.decor,
    entities, player, projectiles: [], toggle: false, time: t,
    dots: genre === 'maze' ? mazeDots(level) : null,
    crumble: null, lights: null,
  };
}

/** A camera that fits the whole level in the canvas, centred, with `margin` tiles around it. */
export function fitCamera(scene, width, height, opts = {}) {
  const margin = opts.margin ?? 0.5;
  const size = Math.max(opts.min ?? 4, Math.min(opts.max ?? 96, Math.floor(Math.min(width / (scene.W + margin * 2), height / (scene.H + margin * 2)))));
  return { x: scene.W / 2 - width / size / 2, y: scene.H / 2 - height / size / 2, size };
}

/**
 * Smoothly follow a target (default the player) with look-ahead, clamped to the level. Side
 * view keeps a vertical dead zone so small hops do not bob the camera.
 */
export function followCamera(cam, scene, width, height, dt, opts = {}) {
  const p = opts.target || scene.player;
  const size = cam.size;
  const vw = width / size, vh = height / size;
  let tx = p.x + p.w / 2 - vw / 2 + (opts.lookX || 0);
  let ty = p.y + p.h / 2 - vh / 2 + (opts.lookY || 0);
  if (scene.view === 'side') {
    const cy = cam.y + vh / 2, py = p.y + p.h / 2;
    const dead = vh * 0.12;
    ty = Math.abs(py - (cy + vh * 0.08)) > dead ? py - vh / 2 - vh * 0.08 - Math.sign(py - cy - vh * 0.08) * dead : cam.y;
  }
  const clampX = v => (vw >= scene.W ? scene.W / 2 - vw / 2 : Math.max(0, Math.min(scene.W - vw, v)));
  const clampY = v => (vh >= scene.H ? scene.H / 2 - vh / 2 : Math.max(0, Math.min(scene.H - vh, v)));
  tx = clampX(tx); ty = clampY(ty);
  if (opts.snap) { cam.x = tx; cam.y = ty; return cam; }
  const k = 1 - Math.exp(-(opts.rate ?? 7) * dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * (scene.view === 'side' ? Math.min(1, k * 0.9) : k);
  cam.x = clampX(cam.x); cam.y = clampY(cam.y);
  return cam;
}
