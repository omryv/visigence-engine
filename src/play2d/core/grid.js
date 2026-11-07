/**
 * Grid arithmetic shared by the editor, the analyser, the runtime and the art: cell indexing,
 * run-length encoding for files, flood fills, neighbour masks for autotiling, region copies.
 * Pure functions over typed arrays; nothing here knows what a tile means.
 */

export const idx = (w, x, y) => y * w + x;
export const inBounds = (w, h, x, y) => x >= 0 && y >= 0 && x < w && y < h;

/** Neighbour bits for autotiling. Cardinals first so `mask & 15` is the 4-way mask. */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;
export const NE = 16;
export const SE = 32;
export const SW = 64;
export const NW = 128;
const DIRS8 = [[0, -1, N], [1, 0, E], [0, 1, S], [-1, 0, W], [1, -1, NE], [1, 1, SE], [-1, 1, SW], [-1, -1, NW]];

/**
 * 8-bit mask of the neighbours of (x, y) for which `same(code)` holds. Cells outside the grid
 * count as `outside` (true by default, so ground and walls run cleanly off the edge).
 */
export function neighborMask(cells, w, h, x, y, same, outside = true) {
  let m = 0;
  for (const [dx, dy, bit] of DIRS8) {
    const nx = x + dx, ny = y + dy;
    const hit = inBounds(w, h, nx, ny) ? same(cells[ny * w + nx]) : outside;
    if (hit) m |= bit;
  }
  return m;
}

/**
 * Run-length encode a cell array as "code*count,code*count". Plain text on purpose: a level
 * file stays readable in a diff, and 64×24 of mostly air is a few hundred bytes.
 */
export function rleEncode(cells) {
  const out = [];
  let run = 0, prev = cells.length ? cells[0] : 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === prev) { run++; continue; }
    out.push(run === 1 ? String(prev) : prev + '*' + run);
    prev = cells[i]; run = 1;
  }
  if (cells.length) out.push(run === 1 ? String(prev) : prev + '*' + run);
  return out.join(',');
}

/** Decode into a fresh Uint16Array of exactly `length` cells; throws on a malformed run. */
export function rleDecode(text, length) {
  const cells = new Uint16Array(length);
  if (!text) return cells;
  let i = 0;
  for (const part of String(text).split(',')) {
    if (!part) continue;
    const m = /^(\d{1,5})(?:\*(\d{1,7}))?$/.exec(part);
    if (!m) throw new Error(`Bad tile run "${part.slice(0, 16)}"`);
    const code = +m[1], count = m[2] ? +m[2] : 1;
    if (i + count > length) throw new Error('Tile data is longer than the level');
    cells.fill(code, i, i + count);
    i += count;
  }
  if (i !== length) throw new Error(`Tile data covers ${i} of ${length} cells`);
  return cells;
}

/**
 * 4-connected flood fill from (x, y) over cells where `pass(code, index)` holds. Returns a
 * Uint8Array mask (1 = reached). Iterative, so a 200×64 level never touches the call stack.
 */
export function flood(cells, w, h, x, y, pass) {
  const seen = new Uint8Array(w * h);
  if (!inBounds(w, h, x, y)) return seen;
  const start = y * w + x;
  if (!pass(cells[start], start)) return seen;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    const cx = i % w, cy = (i - cx) / w;
    if (cx > 0 && !seen[i - 1] && pass(cells[i - 1], i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
    if (cx < w - 1 && !seen[i + 1] && pass(cells[i + 1], i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
    if (cy > 0 && !seen[i - w] && pass(cells[i - w], i - w)) { seen[i - w] = 1; stack.push(i - w); }
    if (cy < h - 1 && !seen[i + w] && pass(cells[i + w], i + w)) { seen[i + w] = 1; stack.push(i + w); }
  }
  return seen;
}

/** The paint-bucket: indices of the contiguous region of `cells[x,y]`'s code. */
export function fillRegion(cells, w, h, x, y) {
  if (!inBounds(w, h, x, y)) return [];
  const target = cells[y * w + x];
  const mask = flood(cells, w, h, x, y, c => c === target);
  const out = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i);
  return out;
}

/** Cells on a straight line between two cells (Bresenham), both ends included. */
export function lineCells(x0, y0, x1, y1) {
  const out = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

/** Normalise a drag rectangle to {x, y, w, h} clamped to the grid. */
export function rectFrom(ax, ay, bx, by, gw, gh) {
  const x0 = Math.max(0, Math.min(ax, bx)), y0 = Math.max(0, Math.min(ay, by));
  const x1 = Math.min(gw - 1, Math.max(ax, bx)), y1 = Math.min(gh - 1, Math.max(ay, by));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
}

/** Copy a rectangle of cells out of a grid. */
export function copyRegion(cells, w, rect) {
  const out = new Uint16Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) out[y * rect.w + x] = cells[(rect.y + y) * w + rect.x + x];
  return out;
}

/**
 * Resize a grid, keeping content anchored: `ax`/`ay` are 0 (left/top), 0.5 (centre) or 1
 * (right/bottom). Returns the new cells and the offset old content moved by.
 */
export function resizeCells(cells, w, h, nw, nh, ax = 0, ay = 1, fill = 0) {
  const out = new Uint16Array(nw * nh);
  if (fill) out.fill(fill);
  const ox = Math.round((nw - w) * ax), oy = Math.round((nh - h) * ay);
  for (let y = 0; y < h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= nh) continue;
    for (let x = 0; x < w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= nw) continue;
      out[ty * nw + tx] = cells[y * w + x];
    }
  }
  return { cells: out, dx: ox, dy: oy };
}

/** A stable per-cell hash in [0, 1), for picking art variants without storing them. */
export function cellHash(x, y, salt = 0) {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
