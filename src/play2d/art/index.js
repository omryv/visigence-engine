/**
 * The art facade every renderer calls: `createArt()` returns an object that draws tiles,
 * decor, entities, projectiles, maze dots, backdrops, grades, darkness and palette icons.
 *
 * Static tile and decor renders are cached in small offscreen canvases keyed by what their
 * look depends on (code, autotile mask, variant, biome, pixel size), so a frame of 2,000
 * visible cells is 2,000 drawImage calls. Water surfaces and crumbling blocks add a live
 * layer on top. Entities are drawn live (they animate every frame).
 *
 * Nothing touches the DOM until the first draw: canvases are made by `opts.canvasFactory`
 * (tests pass a fake), else OffscreenCanvas, else document.createElement('canvas').
 */
import { drawEntity, drawProjectile } from './entities.js';
import { drawTile, drawTileLive, tileVariantKey, ANIMATED, drawDecor, decorBounds, drawDot } from './tiles.js';
import { drawBackground, drawGrade, drawDarkness } from './backdrop.js';
import { unit } from './draw.js';
import { cellHash } from '../core/grid.js';
import { footprint } from '../core/catalog.js';

const MAX_CACHE = 1800;
const NO_NEIGHBOUR = () => 0;

function defaultFactory(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function createArt(opts = {}) {
  const make = opts.canvasFactory || defaultFactory;
  const makeIcon = opts.iconFactory || ((w, h) => {
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return make(w, h);
  });
  const tiles = new Map();
  const decor = new Map();
  const icons = new Map();
  let scratch = null;
  let hits = 0, misses = 0;

  function remember(map, key, value) {
    if (map.size >= MAX_CACHE) {
      let n = 0;
      for (const k of map.keys()) { map.delete(k); if (++n >= MAX_CACHE / 2) break; }
    }
    map.set(key, value);
  }

  const art = {
    /** One terrain cell. `px`, `py` and `size` should be whole canvas pixels. */
    tile(ctx, code, px, py, size, info) {
      const inf = info;
      if (!inf.at) inf.at = NO_NEIGHBOUR;
      const live = code === 5 && inf.crumble > 0;
      if (!live) {
        const variant = tileVariantKey(code, inf);
        const key = `${code}|${inf.biome}|${size}|${variant}`;
        let entry = tiles.get(key);
        if (!entry) {
          misses++;
          const m = Math.ceil(size * 0.2);
          const c = make(size + m * 2, size + m * 2);
          const g = c.getContext('2d');
          unit(g, m, m, size);
          drawTile(g, code, inf);
          g.restore();
          entry = { c, m };
          remember(tiles, key, entry);
        } else hits++;
        ctx.drawImage(entry.c, px - entry.m, py - entry.m);
      }
      if (live || ANIMATED.has(code)) {
        unit(ctx, px, py, size);
        if (live) drawTile(ctx, code, inf); else drawTileLive(ctx, code, inf);
        ctx.restore();
      }
    },

    /** One decor cell; big decor overflows its cell (see tiles.decorBounds). */
    decor(ctx, code, px, py, size, info) {
      const at = info.at || NO_NEIGHBOUR;
      const v = Math.floor(cellHash(info.x | 0, info.y | 0, code) * 4);
      const join = code === 54 ? (at(-1, 0) === 54 ? 1 : 0) | (at(1, 0) === 54 ? 2 : 0) : 0;
      const glowy = code === 57 || code === 58 ? info.time : '';
      const key = `${code}|${info.biome}|${info.view}|${size}|${v}|${join}|${glowy}`;
      let entry = decor.get(key);
      if (!entry) {
        const [x0, y0, x1, y1] = decorBounds(code);
        const w = Math.ceil((x1 - x0) * size), h = Math.ceil((y1 - y0) * size);
        const c = make(Math.max(1, w), Math.max(1, h));
        const g = c.getContext('2d');
        unit(g, -x0 * size, -y0 * size, size);
        drawDecor(g, code, { ...info, x: v * 7 + 3, y: v * 5 + 1, at: dx => (dx < 0 ? (join & 1 ? 54 : 0) : dx > 0 ? (join & 2 ? 54 : 0) : 0) });
        g.restore();
        entry = { c, ox: x0 * size, oy: y0 * size };
        remember(decor, key, entry);
      }
      ctx.drawImage(entry.c, Math.round(px + entry.ox), Math.round(py + entry.oy));
    },

    entity(ctx, ent, box, size, info) { drawEntity(ctx, ent, box, size, info); },
    projectile(ctx, p, cx, cy, size, info) { drawProjectile(ctx, p, cx, cy, size, info); },
    dot(ctx, cx, cy, size) { drawDot(ctx, cx, cy, size); },
    background(ctx, w, h, info) { drawBackground(ctx, w, h, info); },
    grade(ctx, w, h, info) { drawGrade(ctx, w, h, info); },
    darkness(ctx, w, h, lights) {
      if (!scratch) scratch = make(Math.max(1, w), Math.max(1, h));
      drawDarkness(ctx, w, h, lights, scratch);
    },

    /**
     * A palette icon, `px` canvas pixels square: 'tile' | 'decor' | 'entity'. Cached per
     * (kind, id, px, biome, view, props). Returns a canvas.
     */
    icon(kind, id, px, o = {}) {
      const view = o.view || 'side', biome = o.biome || 'meadow';
      const key = `${kind}|${id}|${px}|${biome}|${view}|${o.props ? JSON.stringify(o.props) : ''}`;
      const hit = icons.get(key);
      if (hit) return hit;
      const c = makeIcon(px, px);
      const g = c.getContext('2d');
      const info = { biome, view, time: 'day', t: 0.35, editor: true, x: 3, y: 5, genre: o.genre, toggle: false };
      if (kind === 'tile') {
        const s = Math.round(px * 0.72), off = Math.round((px - s) / 2);
        if (view === 'top' && ![24, 26, 27, 28, 29].includes(id)) art.tile(g, 0, off, off, s, { ...info, at: NO_NEIGHBOUR });
        art.tile(g, id, off, off, s, { ...info, at: NO_NEIGHBOUR });
      } else if (kind === 'decor') {
        const [x0, y0, x1, y1] = decorBounds(id);
        const span = Math.max(x1 - x0, y1 - y0);
        const s = Math.max(4, Math.floor((px * 0.9) / span));
        const w = (x1 - x0) * s, h = (y1 - y0) * s;
        art.decor(g, id, Math.round((px - w) / 2 - x0 * s), Math.round((px - h) / 2 - y0 * s), s, { ...info, at: NO_NEIGHBOUR });
      } else {
        const ent = { type: id, props: o.props || {}, facing: 1, dir: 'down', anim: 'idle', animTime: 0, alive: true, active: id === 'checkpoint' || id === 'goal', open: false, data: {}, hp: 1, maxHp: 1, cell: { x: 0, y: 0 } };
        const fp = footprint(ent);
        const cells = Math.max(fp.w, fp.h, 1);
        const s = Math.floor((px * (cells > 1 ? 0.9 : 0.8)) / cells);
        const bw = fp.w * s, bh = fp.h * s;
        const box = { x: Math.round((px - bw) / 2), y: Math.round((px - bh) / 2 + (view === 'side' ? s * 0.06 : -s * 0.12)), w: bw, h: bh };
        drawEntity(g, ent, box, s, info);
      }
      icons.set(key, c);
      return c;
    },

    clear() { tiles.clear(); decor.clear(); icons.clear(); },
    stats() { return { tiles: tiles.size, decor: decor.size, icons: icons.size, hits, misses }; },
  };
  return art;
}
