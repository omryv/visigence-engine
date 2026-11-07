/**
 * HOUSE GRAMMAR: a seeded shape grammar that turns a key into an Arcade house. No AI, no network: the
 * rules in the pack (`packs/<theme>/pack.json`, `houses`) and a few PRNG streams.
 *
 * It runs in the same order a builder thinks, and every stage reads the STYLE DNA (size, tall, whimsy,
 * ornament, tone) drawn first, so proportions, roofs, openings and trims stay correlated:
 *
 *   1. style      weighted, tagged choices (grammarCore): ridge, walls, roof, covering, door, windows,
 *                 annex, chimney, dormers, trims. `favor` bends weights toward a gene; `needs`/`clash`
 *                 gate options on tags already chosen (no dormers on a front-gabled roof).
 *   2. footprint  a main block, then at most one annex attached to one of its faces: a wing (an L or a
 *                 cross gable whose roof runs into the main roof), a lean-to (a shed roof against a gable
 *                 end) or a corner turret. Every block must fit the lot and stay under the main roof.
 *   3. facades    each wall is cut into the stretches no other block covers, then storeys, then bays;
 *                 bays become the door (exactly one, on the front), windows mirrored about the facade
 *                 centre, or blank panels; gables get attic windows and round towers windows on a ring.
 *   4. details    chimney, dormers, a roof topper, a yard prop.
 *
 * `generateHouse` returns that PLAN (plain data). `buildHouse` expands a plan into geometry: bevelled
 * convex prisms and lathes (walls, plinth stones, timber frame, roof slabs, tiles or thatch, chimney)
 * plus placements of socketed parts from the house parts library (doors, windows, shutters, lanterns,
 * ridge caps...). render/HouseAssembler.js meshes that list; the Blender preview
 * (tools/blender/v2/arcade/house_grammar.py, house_preview.py) is a line-for-line port and
 * tools/test/test-house-grammar.mjs holds both the plans and the expansions to identical output.
 *
 * PARITY RULES: no trigonometry (directions come from DIRS64, built with square roots and sums);
 * numbers leave through r4/snap (floor(x + 0.5)); the draw order of every stream is fixed, whatever
 * branch is taken. Coordinates are Blender's: metres, Z up, the front of the lot faces -Y.
 */
import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';
import { clamp01, choose, weightOf, allows, toned, DIRS64 } from './grammarCore.js';

export const HOUSE_GRAMMAR_VERSION = 1;
/** Style slots with built-in meaning; every other slot names parts from the library. */
export const HOUSE_CHOICES = {
  shape: ['rect', 'round'], ridge: ['front', 'side'], walls: ['timber', 'stone', 'plank', 'mixed', 'plaster', 'adobe', 'log', 'belfry'],
  roof: ['gable', 'hip', 'cone', 'pyramid'], covering: ['tiles', 'thatch', 'snow'], annex: ['wing', 'leanto', 'tower', 'terrace', 'court'], chimney: ['ridge', 'gable', 'stack'],
  // flat-roofed families only: the parapet's profile and what stands on the main roof
  parapet: ['plain', 'stepped', 'crenel'], crown: ['loft', 'dome', 'lookout'],
};
/** Slot -> the socket its part hangs on (null: placed by the grammar itself). */
export const HOUSE_PART_SLOTS = {
  door: null, window: null, attic: null, dormer: null, upper: null, topper: null, yard: null,
  shutters: 'shutter', flowers: 'sill', canopy: 'canopy', lantern: 'lamp', sign: 'sign',
};

const FACES = ['-y', '+x', '+y', '-x'];
const NORMALS = { '-y': [0, -1], '+x': [1, 0], '+y': [0, 1], '-x': [-1, 0] };
const Z = [0, 0, 1];
const r4 = v => Math.floor(v * 10000 + 0.5) / 10000;
const snap = v => Math.floor(v * 20 + 0.5) / 20;
const mix = (range, t) => range[0] + (range[1] - range[0]) * t;
const sc = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const mad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

// The 64 unit directions live in the grammar core (every generator turns by them); re-exported for the Arcade modules.
export { DIRS64 };
const RING = [48, 0, 16, 32, 56, 40];   // round-tower window directions: front, +x, back, -x, front-right, front-left

/** One PRNG stream per stage, so changing the facade rules never reshuffles the footprints. */
export function houseRng(family, key, stage) { return mulberry32(hashSeed(`${family}|${key}|${stage}`)); }

// ---------------------------------------------------------------- blocks

function ridgeZ(b, K) {
  const R = b.roof;
  if (R.type === 'shed') { R.zr = r4(R.zt); return; }
  const half = b.shape === 'round' || R.axis === 'x' ? (b.y1 - b.y0) / 2 : (b.x1 - b.x0) / 2;
  R.zr = r4(b.zTop + K.plate + half * R.pitch);
}

function block(id, shape, x0, x1, y0, y1, storeys, walls, zTop, roof, K) {
  const b = { id, shape, x0: r4(x0), x1: r4(x1), y0: r4(y0), y1: r4(y1), storeys, zTop: r4(zTop), walls, roof: { ...roof } };
  ridgeZ(b, K);
  return b;
}

function extent(blocks, K) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of blocks) {
    const pad = b.shape === 'round' ? 0.5 : K.eave + 0.05;
    x0 = Math.min(x0, b.x0 - pad); x1 = Math.max(x1, b.x1 + pad); y0 = Math.min(y0, b.y0 - pad); y1 = Math.max(y1, b.y1 + pad);
  }
  return [x0, x1, y0, y1];
}

function fits(blocks, lot, K) {
  const [x0, x1, y0, y1] = extent(blocks, K);
  return x1 - x0 <= lot.w + 1e-6 && y1 - y0 <= lot.d + 1e-6;
}

/** Is (x, y) strictly inside a block other than `skip`? */
function inside(x, y, blocks, skip) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i !== skip && x > b.x0 + 0.01 && x < b.x1 - 0.01 && y > b.y0 + 0.01 && y < b.y1 - 0.01) return true;
  }
  return false;
}

function facePoint(b, face, u) {
  return face === '-y' ? [u, b.y0] : face === '+y' ? [u, b.y1] : face === '-x' ? [b.x0, u] : [b.x1, u];
}

/** The stretches of a face no other block covers: [[a, z, cornerA, cornerZ]] along the face's world axis. */
function exposedSpans(bi, face, blocks) {
  const b = blocks[bi], alongX = face === '-y' || face === '+y';
  const line = face === '-y' ? b.y0 : face === '+y' ? b.y1 : face === '-x' ? b.x0 : b.x1;
  const lo = alongX ? b.x0 : b.y0, hi = alongX ? b.x1 : b.y1;
  let spans = [[lo, hi]];
  for (let i = 0; i < blocks.length; i++) {
    if (i === bi) continue;
    const o = blocks[i], p0 = alongX ? o.y0 : o.x0, p1 = alongX ? o.y1 : o.x1;
    if (!(line > p0 + 0.01 && line < p1 - 0.01)) continue;
    const c0 = alongX ? o.x0 : o.y0, c1 = alongX ? o.x1 : o.y1, next = [];
    for (const [a, z] of spans) {
      if (c1 <= a || c0 >= z) { next.push([a, z]); continue; }
      if (c0 > a) next.push([a, c0]);
      if (c1 < z) next.push([c1, z]);
    }
    spans = next;
  }
  const out = [];
  for (const [a, z] of spans) {
    if (z - a < 0.3) continue;
    const pa = facePoint(b, face, a), pz = facePoint(b, face, z);
    out.push([r4(a), r4(z), a === lo && !inside(pa[0], pa[1], blocks, bi), z === hi && !inside(pz[0], pz[1], blocks, bi)]);
  }
  return out;
}

function exposedAt(bi, face, u, blocks, margin) {
  for (const [a, z] of exposedSpans(bi, face, blocks)) if (u >= a + margin && u <= z - margin) return true;
  return false;
}

// ---------------------------------------------------------------- 2. footprint

function wingOn(K, main, face, a, H) {
  const onX = face !== '-y', faceLen = onX ? main.y1 - main.y0 : main.x1 - main.x0;
  // on a gable end the wing extends the house; anywhere else (eaves, a hip's end) its roof runs into the main one
  const proj = snap(2.0 + 1.4 * a[1]), axis = onX ? 'x' : 'y', extension = axis === main.roof.axis && main.roof.type === 'gable';
  // narrower than the main span, so its ridge sits below the main one
  const hsM = main.roof.axis === 'x' ? (main.y1 - main.y0) / 2 : (main.x1 - main.x0) / 2;
  let ws = snap(Math.max(2.4, Math.min(faceLen - 0.4, 2 * hsM - 0.9, Math.max(2.6, faceLen * (0.55 + 0.25 * a[2])))));
  let storeys = main.storeys > 1 && a[3] < 0.5 ? main.storeys - 1 : main.storeys;
  for (let tries = 0; tries < 8; tries++) {
    // an extension sits centred on the gable wall (its roof must stay inside the main gable); a cross wing may go flush
    const lo = onX ? main.y0 : main.x0, hi = onX ? main.y1 : main.x1;
    const mid = extension || (a[3] >= 0.4 && a[3] <= 0.75) ? (lo + hi) / 2 : a[3] < 0.4 ? lo + ws / 2 : hi - ws / 2;
    let x0, x1, y0, y1;
    if (face === '+x') { x0 = main.x1 - 0.3; x1 = main.x1 + proj; y0 = mid - ws / 2; y1 = mid + ws / 2; }
    else if (face === '-x') { x0 = main.x0 - proj; x1 = main.x0 + 0.3; y0 = mid - ws / 2; y1 = mid + ws / 2; }
    else { x0 = mid - ws / 2; x1 = mid + ws / 2; y0 = main.y0 - proj; y1 = main.y0 + 0.3; }
    const w = block('wing', 'rect', x0, x1, y0, y1, storeys, main.walls, K.plinth + storeys * H,
      { type: 'gable', axis, pitch: main.roof.pitch, covering: main.roof.covering, ends: [K.over, K.over] }, K);
    // Where they meet, the wing's roof must stay under the main one.
    const off = axis === 'x' ? (w.y0 + w.y1) / 2 - (main.y0 + main.y1) / 2 : (w.x0 + w.x1) / 2 - (main.x0 + main.x1) / 2;
    const limit = extension ? main.roof.zr - Math.abs(off) * main.roof.pitch - 0.3 : main.roof.zr - 0.35;
    if (w.roof.zr <= limit) {
      // An extension stops at the main gable wall; a cross wing runs into the main roof until its ridge meets it.
      const inner = face === '+x' ? 0 : 1;
      if (extension) w.roof.ends[inner] = -0.32;
      else {
        const t = (main.roof.zr - w.roof.zr) / main.roof.pitch;
        w.roof.ends[inner] = r4(t >= hsM ? -0.32 : hsM - t - 0.35);
      }
      return w;
    }
    if (storeys > 1) storeys -= 1;
    else if (ws > 2.45) ws = snap(ws - 0.3);
    else return null;
  }
  return null;
}

function leantoOn(K, main, face, a, H, onGable) {
  const onX = face === '+x' || face === '-x', faceLen = onX ? main.y1 - main.y0 : main.x1 - main.x0;
  const round = main.shape === 'round', open = a[5] < 0.5, low = !round && main.storeys === 1 && !onGable;
  // Its top meets a gable wall above the plate, climbs a taller house to its first floor, or tucks under a low eave
  // (shallower then, and narrower).
  const depth = snap((low ? 1.5 : 1.7) + (low ? 0.4 : 0.6) * a[2]), len = Math.min(faceLen, snap(Math.max(2.2, faceLen * (0.5 + 0.35 * a[1]))));
  const pitch = r4((low ? 0.28 : 0.42) + 0.1 * a[4]);
  const zt = r4(round || main.storeys > 1 ? K.plinth + H + 0.45 : onGable ? main.zTop + 0.3 : main.zTop - 0.55);
  const zLow = zt - depth * pitch;
  if (zLow < K.plinth + (open ? 0.95 : 1.25)) return null;
  const inset = round ? 0.75 : 0.3, lo = onX ? main.y0 : main.x0, hi = onX ? main.y1 : main.x1;
  const mid = a[3] >= 0.5 ? hi - len / 2 : (lo + hi) / 2;
  let x0, x1, y0, y1, wall, dir;
  if (face === '+x') { x0 = main.x1 - inset; x1 = main.x1 + depth; y0 = mid - len / 2; y1 = mid + len / 2; wall = main.x1; dir = 1; }
  else if (face === '-x') { x0 = main.x0 - depth; x1 = main.x0 + inset; y0 = mid - len / 2; y1 = mid + len / 2; wall = main.x0; dir = -1; }
  else { x0 = mid - len / 2; x1 = mid + len / 2; y0 = main.y1 - inset; y1 = main.y1 + depth; wall = main.y1; dir = 1; }
  return block('leanto', 'rect', x0, x1, y0, y1, 1, open ? 'open' : 'plank', zLow,
    { type: 'shed', axis: onX ? 'y' : 'x', pitch, covering: main.roof.covering, ends: [0.3, 0.3], zt, wall: r4(wall), dir }, K);
}

/** The faces an annex may take, in preference order (the first one tried is picked by a roll), and whether each is a gable end. */
function annexFaces(kind, main) {
  if (main.shape === 'round') return kind === 'leanto' ? [['+x', true], ['-x', true], ['+y', true]] : [];
  const x = main.roof.axis === 'x', gable = main.roof.type === 'gable';
  if (kind === 'wing') return (x ? ['+x', '-x', '-y'] : ['+x', '-x']).map(f => [f, false]);
  if (kind === 'tower') return [['-x', false], ['+x', false]];
  const gables = !gable ? [] : x ? ['+x', '-x'] : ['+y'];
  const eaves = gable ? (x ? ['+y'] : ['+x', '-x']) : x ? ['+x', '-x', '+y'] : ['+y', '+x', '-x'];
  return [...gables.map(f => [f, true]), ...eaves.map(f => [f, false])];
}

/** Room the annex needs beyond the main block on its first-choice face: [along x, along y]. */
function annexReserve(kind, face, a) {
  if (kind === 'tower') { const half = snap(2.3 + 0.7 * a[2]) / 2 - 0.1; return [half, half]; }
  const out = kind === 'wing' ? snap(2.0 + 1.4 * a[1]) : snap(1.7 + 0.6 * a[2]);
  return face === '+x' || face === '-x' ? [out, 0] : [0, out];
}

/** Does some front wall still take a door? (A round main block always does: its door is on the ring.) */
function doorFits(blocks, dw) {
  if (blocks[0].shape === 'round') return true;
  for (let bi = 0; bi < blocks.length; bi++) {
    if (blocks[bi].shape !== 'rect' || blocks[bi].walls === 'open') continue;
    for (const [a, z, ca, cz] of exposedSpans(bi, '-y', blocks)) if (z - a - (ca ? 0.5 : 0.35) - (cz ? 0.5 : 0.35) >= dw + 0.3) return true;
  }
  return false;
}

function annexOf(kind, K, main, a, blocks, lot, H, dna, dw) {
  const faces = annexFaces(kind, main), first = Math.floor(a[0] * faces.length);
  for (let i = 0; i < faces.length; i++) {
    const [face, onGable] = faces[(first + i) % faces.length];
    let b = null;
    if (kind === 'wing') b = wingOn(K, main, face, a, H);
    else if (kind === 'leanto') b = leantoOn(K, main, face, a, H, onGable);
    else {
      // a corner turret on a front corner, one storey above the house
      const round = a[4] < 0.55, ts = snap(2.3 + 0.7 * a[2]), cx = face === '-x' ? main.x0 : main.x1, cy = main.y0;
      const walls = main.walls === 'stone' ? 'stone' : round ? 'plaster' : 'timber';
      b = block('tower', round ? 'round' : 'rect', cx - ts / 2, cx + ts / 2, cy - ts / 2, cy + ts / 2, main.storeys + 1, walls,
        K.plinth + (main.storeys + 1) * H, { type: round ? 'cone' : 'pyramid', axis: round ? null : 'x', pitch: r4(1.9 + 0.6 * dna.whimsy),
          covering: main.roof.covering, ends: [K.over, K.over] }, K);
    }
    if (b && fits([...blocks, b], lot, K) && doorFits([...blocks, b], dw)) return b;
  }
  return null;
}

function massing(rules, F, style, dna, m, lot) {
  const K = rules.kit, M = F.mass, dw = rules.parts[style.door].w;
  const gene = g => clamp01(0.75 * g + 0.25 * m());
  const H = snap(K.storey * (0.96 + 0.08 * m()));
  const pitch = r4(mix(M.pitch, gene(dna.whimsy)));
  const span = snap(mix(M.span, gene(dna.size)));
  let length = snap(mix(M.length, gene(dna.size)));
  const a = [m(), m(), m(), m(), m(), m()];
  const shape = style.shape === 'round' ? 'round' : 'rect';
  if (M.square || shape === 'round') length = span;
  const n = M.storeys[0] + Math.min(M.storeys[1] - M.storeys[0], Math.floor(dna.tall * (M.storeys[1] - M.storeys[0] + 1)));
  const pad = K.eave + 0.05, type = style.roof ?? (shape === 'round' ? 'cone' : 'gable');
  let axis = style.ridge === 'side' ? 'x' : 'y';
  const body = (W, D) => {
    const ax = type === 'hip' || type === 'pyramid' ? (W >= D ? 'x' : 'y') : axis;
    return block('main', shape, -W / 2, W / 2, -D / 2, D / 2, n, style.walls ?? 'timber', K.plinth + n * H,
      { type, axis: shape === 'round' ? null : ax, pitch, covering: style.covering ?? 'tiles', ends: [K.over, K.over] }, K);
  };
  let W = Math.min(axis === 'x' ? length : span, snap(lot.w - 2 * pad));
  let D = shape === 'round' ? W : Math.min(axis === 'x' ? span : length, snap(lot.d - 2 * pad));
  let main = body(W, D);
  // An annex takes room on the lot: the main block gives up what its first-choice face needs.
  const faces = style.annex ? annexFaces(style.annex, main) : [];
  if (faces.length) {
    const [rx, ry] = annexReserve(style.annex, faces[Math.floor(a[0] * faces.length)][0], a);
    W = Math.max(M.span[0] * 0.8, Math.min(W, snap(lot.w - 2 * pad - rx)));
    D = shape === 'round' ? W : Math.max(M.span[0] * 0.8, Math.min(D, snap(lot.d - 2 * pad - ry)));
    main = body(W, D);
  }
  const blocks = [main];
  const annex = faces.length ? annexOf(style.annex, K, main, a, blocks, lot, H, dna, dw) : null;
  if (annex) blocks.push(annex);
  // centre the whole house (roofs included) on the lot
  const [x0, x1, y0, y1] = extent(blocks, K), dx = snap(-(x0 + x1) / 2), dy = snap(-(y0 + y1) / 2);
  for (const b of blocks) {
    b.x0 = r4(b.x0 + dx); b.x1 = r4(b.x1 + dx); b.y0 = r4(b.y0 + dy); b.y1 = r4(b.y1 + dy);
    if (b.roof.type === 'shed') b.roof.wall = r4(b.roof.wall + (b.roof.axis === 'y' ? dx : dy));
  }
  return { blocks, H };
}

// ---------------------------------------------------------------- 3. facades

function bays(a, z, ca, cz, bay, K) {
  const m0 = ca ? 0.5 : 0.35, m1 = cz ? 0.5 : 0.35, usable = z - a - m0 - m1;
  if (usable < K.bay) return [];
  const n = Math.max(1, Math.min(Math.floor(usable / K.bay), Math.floor(usable / bay + 0.5))), out = [];
  for (let i = 0; i < n; i++) out.push(r4(a + m0 + (i + 0.5) * usable / n));
  return out;
}

const cell = (u, kind, part = null, shutter = null, sill = null) => ({ u, kind, part, shutter, sill });

function facades(rules, F, style, dna, f, blocks) {
  const K = rules.kit, FC = rules.facade, bay = F.mass.bay * (1.15 - 0.3 * dna.ornament), main = blocks[0];
  const walls = [], rings = [], attics = [];
  // The door: the widest front stretch that takes one, on the main block if it can.
  let door = null;
  const dw = rules.parts[style.door].w;
  if (main.shape === 'rect') {
    for (let bi = 0; bi < blocks.length && !door; bi++) {
      const b = blocks[bi];
      if (b.shape !== 'rect' || b.walls === 'open') continue;
      let best = -1, width = 0;
      exposedSpans(bi, '-y', blocks).forEach(([a, z, ca, cz], si) => {
        const usable = z - a - (ca ? 0.5 : 0.35) - (cz ? 0.5 : 0.35);
        if (usable >= dw + 0.3 && z - a > width) { best = si; width = z - a; }
      });
      if (best >= 0) door = { bi, si: best };
    }
    if (!door) throw new Error('House: no front wall takes a door');
  }
  const doorRoll = f();
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.shape === 'round') {
      const R = (b.x1 - b.x0) / 2, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cells = [];
      const win = rules.parts[style.window].w <= 0.95 ? style.window : 'win.slim';
      for (let s = 0; s < b.storeys; s++) for (const k of RING) {
        const roll = f(), d = DIRS64[k];
        if (inside(cx + d[0] * (R + 0.4), cy + d[1] * (R + 0.4), blocks, bi)) continue;
        if (bi === 0 && s === 0 && k === 48) { cells.push({ s, k, kind: 'door', part: style.door, shutter: null, sill: null }); continue; }
        const kind = k === 48 || k === 56 || k === 40 ? 'front' : k === 16 ? 'back' : 'side';
        if (roll >= FC[kind] * (k === 56 || k === 40 ? 0.45 : 1)) continue;
        const sill = style.upper === 'balcony' && bi === 0 && s === 1 && k === 48 ? 'balcony' : style.flowers && s === 0 ? style.flowers : null;
        cells.push({ s, k, kind: 'window', part: win, shutter: null, sill });
      }
      rings.push({ b: bi, cells });
      continue;
    }
    if (b.walls === 'open') continue;
    for (const face of FACES) {
      const kind = face === '-y' ? 'front' : face === '+y' ? 'back' : 'side';
      exposedSpans(bi, face, blocks).forEach(([a, z, ca, cz], si) => {
        const us = bays(a, z, ca, cz, bay, K), n = us.length;
        for (let s = 0; s < b.storeys; s++) {
          // a belfry's top storey is open: posts and a railing, no wall to cut
          if (b.walls === 'belfry' && s === b.storeys - 1) continue;
          const rolls = us.map(() => f());
          const isDoor = door && door.bi === bi && door.si === si && face === '-y' && s === 0;
          const doorAt = isDoor ? (n % 2 ? (n - 1) / 2 : n / 2 - (doorRoll < 0.5 ? 1 : 0)) : -1;
          const middle = n % 2 && bi === 0 && face === '-y' ? (n - 1) / 2 : -1;
          const cells = us.map((u, i) => {
            if (i === doorAt) return cell(u, 'door', style.door);
            if (i === middle && s >= 1 && s === b.storeys - 1 && style.upper === 'win.oriel') return cell(u, 'oriel', 'win.oriel');
            // a banner hangs on the front of the top walled storey
            if (i === middle && s >= 1 && s === topWalled(b) && /^banner\./.test(style.upper ?? '')) return cell(u, 'banner', style.upper);
            const balcony = i === middle && s === 1 && style.upper === 'balcony';
            if (!balcony && rolls[Math.min(i, n - 1 - i)] >= FC[kind]) return cell(u, 'blank');
            const sill = balcony ? 'balcony' : style.flowers && s === 0 && kind !== 'back' ? style.flowers : null;
            return cell(u, 'window', style.window, style.shutters ?? null, sill);
          });
          // a wide door or bay window crowds its neighbour on tight bays: the window gives way
          for (let i = 1; i < n; i++) {
            const p = cells[i - 1], q = cells[i];
            if (p.kind === 'blank' || q.kind === 'blank' || q.u - p.u >= (rules.parts[p.part].w + rules.parts[q.part].w) / 2 + 0.08) continue;
            if (q.kind === 'window') cells[i] = cell(q.u, 'blank'); else if (p.kind === 'window') cells[i - 1] = cell(p.u, 'blank');
          }
          walls.push({ b: bi, face, a, z, ca, cz, s, cells });
        }
      });
    }
    if (b.roof.type === 'gable') {
      const ends = b.roof.axis === 'x' ? ['-x', '+x'] : ['-y', '+y'];
      const half = b.roof.axis === 'x' ? (b.y1 - b.y0) / 2 : (b.x1 - b.x0) / 2, u = b.roof.axis === 'x' ? (b.y0 + b.y1) / 2 : (b.x0 + b.x1) / 2;
      for (const face of ends) {
        const roll = f(), kind = face === '-y' ? 'front' : face === '+y' ? 'back' : 'side';
        if (half * b.roof.pitch < 1.5 || roll >= FC.attic * FC[kind] || !exposedAt(bi, face, u, blocks, 0.6)) continue;
        attics.push({ b: bi, face, u: r4(u), part: style.attic ?? 'win.round' });
      }
    }
  }
  return { walls, rings, attics };
}

// ---------------------------------------------------------------- 4. details

function details(rules, style, dna, x, blocks, walls) {
  const K = rules.kit, main = blocks[0], R = main.roof, r = [x(), x(), x(), x(), x(), x(), x(), x()];
  let chimney = null, topper = null, yard = null;
  const dormers = [];
  const ax = R.axis, hs = ax === 'x' ? (main.y1 - main.y0) / 2 : (main.x1 - main.x0) / 2;
  const [a0, a1] = ax === 'x' ? [main.x0, main.x1] : [main.y0, main.y1], cc = ax === 'x' ? (main.y0 + main.y1) / 2 : (main.x0 + main.x1) / 2;
  if (style.chimney && main.shape === 'rect') {
    const top = r4(R.zr + (style.chimney === 'ridge' ? 0.5 : 0.3) + 0.6 * dna.whimsy), lean = r4((r[2] - 0.5) * 0.24 * dna.whimsy);
    if (style.chimney === 'ridge') {
      const lo = R.type === 'hip' ? Math.min((a0 + a1) / 2, a0 + hs) : a0 + 0.6, hi = R.type === 'hip' ? Math.max((a0 + a1) / 2, a1 - hs) : a1 - 0.6;
      const al = lo + (hi - lo) * (0.2 + 0.6 * r[0]), ac = cc + (r[1] - 0.5) * 0.8;
      chimney = { kind: 'ridge', x: r4(ax === 'x' ? al : ac), y: r4(ax === 'x' ? ac : al), top, lean, pot: r[6] < dna.ornament };
    } else {
      const ends = ax === 'x' ? (r[3] < 0.5 ? ['-x', '+x'] : ['+x', '-x']) : ['+y', '-y'];
      for (const face of ends) {
        const u = cc + (r[1] - 0.5) * hs * 0.6;
        if (face === '-y' || !exposedAt(0, face, u, blocks, 0.8)) continue;
        chimney = { kind: 'gable', face, u: r4(u), top, lean, pot: r[6] < dna.ornament };
        break;
      }
    }
  }
  if (style.dormer && main.shape === 'rect' && ax === 'x' && (R.type === 'gable' || R.type === 'hip') && hs >= 1.9 && R.pitch >= 0.85) {
    const W = main.x1 - main.x0, cx = (main.x0 + main.x1) / 2;
    const xs = W >= 5.4 && dna.ornament > 0.45 ? [main.x0 + W * 0.28, main.x1 - W * 0.28] : [cx + (r[4] - 0.5) * 0.8];
    const room = R.type === 'hip' ? W / 2 - hs + 0.5 : W / 2 - 0.4;
    for (const dx of xs) {
      if (Math.abs(dx - cx) + 0.85 > room) continue;
      if (chimney && chimney.kind === 'ridge' && Math.abs(chimney.x - dx) < 1.4) continue;
      if (inside(dx, main.y0 - 0.5, blocks, 0)) continue;
      const y = main.y0 + 0.75;
      dormers.push({ part: style.dormer, x: r4(dx), y: r4(y), z: r4(R.zr - (hs - 0.75) * R.pitch) });
    }
  }
  if (style.topper) {
    const cx = (main.x0 + main.x1) / 2, cy = (main.y0 + main.y1) / 2;
    if (main.shape === 'round' || R.type === 'pyramid') topper = { part: style.topper, x: r4(cx), y: r4(cy), z: r4(R.zr - 0.1) };
    else if (R.type === 'hip') topper = { part: style.topper, x: r4(cx), y: r4(cy), z: r4(R.zr + 0.18) };
    else {
      const end = ax === 'x' ? main.x0 - R.ends[0] + 0.35 : main.y0 - R.ends[0] + 0.35;
      topper = { part: style.topper, x: r4(ax === 'x' ? end : cc), y: r4(ax === 'x' ? cc : end), z: r4(R.zr + 0.18) };
    }
  }
  if (style.yard) {
    const lean = blocks.find(b => b.id === 'leanto' && b.walls === 'open');
    if (lean && style.yard !== 'yard.bench') yard = { part: style.yard, x: r4((lean.x0 + lean.x1) / 2), y: r4((lean.y0 + lean.y1) / 2), nx: 0, ny: -1 };
    else {
      const front = walls.find(w => w.b === 0 && w.face === '-y' && w.s === 0 && w.cells.some(c => c.kind === 'door'));
      let u = r[5] < 0.5 ? main.x0 + 0.9 : main.x1 - 0.9;
      if (front) {
        const d = front.cells.find(c => c.kind === 'door').u;
        u = Math.abs(front.a + 0.8 - d) > Math.abs(front.z - 0.8 - d) ? front.a + 0.8 : front.z - 0.8;
      }
      yard = { part: style.yard, x: r4(u), y: r4(main.y0 - (style.yard === 'yard.bench' ? 0.5 : 0.8)), nx: 0, ny: -1 };
    }
  }
  return { chimney, dormers, topper, yard };
}

// ---------------------------------------------------------------- the plan

/**
 * @param {object} rules  the pack's `houses` block
 * @param {{family: string, key: string|number, lot?: {w: number, d: number}}} request
 * @returns {object} plan: {version, family, key, lot, dna, palette, colors, style, storey, tile, blocks, walls,
 *   rings, attics, chimney, dormers, topper, yard, colliders, bounds}
 */
export function generateHouse(rules, { family, key, lot = null }) {
  const F = rules?.families?.[family];
  if (!F) throw new Error(`Unknown house family: ${family}`);
  const K = rules.kit, L = lot ?? rules.lot, k = String(key);
  // 1. style DNA. Small houses lean whimsical, so size and whimsy are correlated.
  const d = houseRng(family, k, 'dna');
  const size = d(), tall = d(), whimsy = clamp01(0.7 * d() + 0.3 * (1 - size)), ornament = d(), tone = d() * 2 - 1, paletteRoll = d();
  const dna = { size, tall, whimsy, ornament, tone };
  const base = F.palettes[Math.floor(paletteRoll * F.palettes.length)], palette = {};
  for (const [slot, hex] of Object.entries(base)) palette[slot] = toned(hex, tone);
  // Weighted, tagged style choices.
  const c = houseRng(family, k, 'plan'), tags = new Set(), style = {};
  for (const step of F.plan) {
    const chanceRoll = c(), pickRoll = c();
    const chance = step.chance === undefined ? 1 : clamp01(step.chance * (0.6 + 0.8 * dna[step.gene ?? 'ornament']));
    if (chanceRoll >= chance) continue;
    const option = choose(pickRoll, step.options.filter(o => allows(o, tags)), o => weightOf(o, dna));
    if (!option) {
      if (step.chance === undefined) throw new Error(`House ${family}: no allowed option for required slot "${step.slot}"`);
      continue;
    }
    for (const t of option.tags ?? []) tags.add(t);
    style[step.slot] = option.id;
  }
  // Flat-roofed families (the desert village) take their own massing, facades and details.
  if (F.form === 'flat') return generateFlat(rules, F, family, k, L, dna, palette, style);
  // 2-4. footprint, facades, details.
  const { blocks, H } = massing(rules, F, style, dna, houseRng(family, k, 'mass'), L);
  const { walls, rings, attics } = facades(rules, F, style, dna, houseRng(family, k, 'facade'), blocks);
  const { chimney, dormers, topper, yard } = details(rules, style, dna, houseRng(family, k, 'detail'), blocks, walls);
  const colliders = blocks.map(b => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, h: r4(Math.max(b.roof.zr, b.zTop)) }));
  const [x0, x1, y0, y1] = extent(blocks, K);
  const top = Math.max(...blocks.map(b => b.roof.zr), chimney ? chimney.top : 0);
  return { version: HOUSE_GRAMMAR_VERSION, family, key: k, lot: L, dna, palette, colors: rules.colors, style, storey: H, tile: F.mass.tile ?? 1,
    blocks, walls, rings, attics, chimney, dormers, topper, yard, colliders, bounds: [r4(x0), r4(x1), r4(y0), r4(y1), r4(top)] };
}

// ---------------------------------------------------------------- expansion

/** The colour a slot takes in this plan: the palette first, then the shared colours; a thatched roof is straw. */
export function houseSlotColor(plan, slot) {
  if (slot === 'Roof' && plan.blocks[0].roof.covering === 'thatch') return plan.colors.thatch;
  const key = slot.charAt(0).toLowerCase() + slot.slice(1);
  return plan.palette[key] ?? plan.colors[key] ?? plan.palette.wall;
}

const wallSlot = walls => (walls === 'stone' || walls === 'belfry' ? 'Masonry' : walls === 'plank' ? 'Plank' : walls === 'log' ? 'TimberDark' : 'Wall');
const storeySlot = (b, s) => (b.walls === 'mixed' ? (s === 0 ? 'Masonry' : 'Wall') : wallSlot(b.walls));
const timberStorey = (b, s) => b.walls === 'timber' || (b.walls === 'mixed' && s >= 1) || (b.walls === 'belfry' && s === b.storeys - 1);
/** The top storey with walls: a belfry's open top storey has none. */
const topWalled = b => (b.walls === 'belfry' ? b.storeys - 2 : b.storeys - 1);
/** A log course's cross-section: a hexagon, its points in and out of the wall. */
const LOG = [[0.19, 0], [0.095, 0.165], [-0.095, 0.165], [-0.19, 0], [-0.095, -0.165], [0.095, -0.165]];

/**
 * Expand a plan into geometry: `pieces` are bevelled convex prisms ({k:'prism', s: colour slot, o: outline,
 * f: frame origin + u, v, w axes, p: polygon in (u, v), w: extrusion range, b: bevel, g: gradient z range,
 * r: round}) and lathes ({k:'lathe', s, o, c: axis base, p: [[r, z]], n, g}); `parts` place library parts
 * ({id, m: origin + x, y, z axes}) or hang them on a placed part's socket ({id, on, socket, pair}).
 */
export function buildHouse(rules, plan) {
  if (plan.form === 'flat') return buildFlat(rules, plan);
  const K = rules.kit, P = K.plinth, H = plan.storey, blocks = plan.blocks, st = plan.style;
  const j = houseRng(plan.family, plan.key, 'jitter'), pieces = [], parts = [];
  const tileScale = plan.tile;

  const prism = (s, o, org, u, v, w, poly, w0, w1, bev, g, round = false) => {
    pieces.push({ k: 'prism', s, o, f: [...org, ...u, ...v, ...w].map(r4), p: poly.map(q => [r4(q[0]), r4(q[1])]), w: [r4(w0), r4(w1)], b: bev, g: [r4(g[0]), r4(g[1])], r: round ? 1 : 0 });
  };
  const rect = (a, b) => [[-a / 2, -b / 2], [a / 2, -b / 2], [a / 2, b / 2], [-a / 2, b / 2]];
  const box = (s, o, c, size, bev, g) => prism(s, o, c, [1, 0, 0], [0, 1, 0], Z, rect(size[0], size[1]), -size[2] / 2, size[2] / 2, bev, g);
  // a beam from p0 to p1, `width` across it and `depth` along `side` (a unit vector square to it)
  const strut = (s, o, p0, p1, width, depth, side, bev, g) => {
    const dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], len = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
    const u = sc(dv, 1 / len);
    prism(s, o, mad(p0, dv, 0.5), u, cross(side, u), side, rect(len, width), -depth / 2, depth / 2, bev, g);
  };
  const place = (id, x, y, z, nx, ny) => {
    parts.push({ id, m: [x, y, z, -ny, nx, 0, -nx, -ny, 0, 0, 0, 1].map(r4) });
    return parts.length - 1;
  };
  const hang = (id, on, socket, pair) => { parts.push({ id, on, socket, pair }); };
  // ridge and hip caps: capsule parts laid end to end from p0 to p1, stretched to fit
  const caps = (p0, p1) => {
    const dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], len = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
    if (len < 0.3) return;
    const n = Math.max(1, Math.floor(len / 1.4 + 0.5)), X = sc(dv, 1 / len), Y = unit(cross(Z, X)), Zl = cross(X, Y), sx = len / n / 1.32;
    const cover = plan.blocks[0].roof.covering, id = cover === 'thatch' ? 'roof.ridge.thatch' : cover === 'snow' ? 'roof.ridge.snow' : 'roof.ridge';
    for (let i = 0; i < n; i++) {
      const c = mad(mad(p0, dv, (i + 0.5) / n), Zl, 0.1);
      parts.push({ id, m: [...c, ...sc(X, sx), ...Y, ...Zl].map(r4) });
    }
  };

  // one planar roof slope: a slab under the surface, then tiles or thatch in rows. T0 is on the top edge,
  // R runs along it, Dn points down the slope and N out of it; q and r are the eave and top extents along R.
  const TL = K.tile[0] * tileScale, TW = K.tile[1] * tileScale, TT = K.tile[2];
  const tile = (top, R, Dn, N, w, len, thick, bev, g, lift = 0.08) => {
    const t = thick * (0.92 + 0.16 * j()), tilt = lift + 0.04 * j(), lat = (j() - 0.5) * 0.04;
    const cs = 1 / Math.sqrt(1 + tilt * tilt), sn = tilt * cs;
    const u = [Dn[0] * cs + N[0] * sn, Dn[1] * cs + N[1] * sn, Dn[2] * cs + N[2] * sn];
    const n = [N[0] * cs - Dn[0] * sn, N[1] * cs - Dn[1] * sn, N[2] * cs - Dn[2] * sn];
    const c = mad(mad(mad(top, R, lat), u, len / 2), n, t / 2);
    prism('Roof', 0.045, c, u, R, n, rect(len, w), -t / 2, t / 2, bev, g);
  };
  // a thatch layer: a soft roll with a rounded section, laid along the slope's top edge, its lower edge lifted
  const roll = (top, R, Dn, N, lo, hi, len, g) => {
    const t = 0.5 * (0.92 + 0.16 * j()), tilt = 0.15 + 0.04 * j(), cs = 1 / Math.sqrt(1 + tilt * tilt), sn = tilt * cs;
    const u = [Dn[0] * cs + N[0] * sn, Dn[1] * cs + N[1] * sn, Dn[2] * cs + N[2] * sn];
    const n = [N[0] * cs - Dn[0] * sn, N[1] * cs - Dn[1] * sn, N[2] * cs - Dn[2] * sn];
    const c = Math.min(0.4 * t, 0.2 * len);
    prism('Roof', 0.045, top, u, n, R, [[c, 0], [len - c, 0], [len, c], [len, t - c], [len - c, t], [c, t], [0, t - c], [0, c]], lo, hi, 0.12, g, true);
  };
  // snow: one soft blanket over the slab, held back from a gable's verges so the roof's edge still shows, and a
  // rounded cushion along the eave in a few lengths of different thickness, overhanging the slab's edge a little
  const blanket = (T0, R, Dn, N, Ls, q, r, g) => {
    const rectangular = q[0] === r[0] && q[1] === r[1], i = rectangular ? 0.14 : 0, back = 0.3, t = 0.2;
    const poly = r[0] === r[1] ? [[q[0], -Ls + back], [q[1], -Ls + back], [r[0], 0]] : [[q[0] + i, -Ls + back], [q[1] - i, -Ls + back], [r[1] - i, 0], [r[0] + i, 0]];
    prism('Snow', 0.035, T0, R, sc(Dn, -1), N, poly, 0, t, 0.08, g);
    const lo = q[0] + i, hi = q[1] - i, width = hi - lo, n = Math.max(1, Math.floor(width / 1.7 + 0.5)), cuts = [lo];
    for (let k = 1; k < n; k++) cuts.push(lo + width * k / n + (j() - 0.5) * 0.4);
    cuts.push(hi);
    for (let k = 0; k < n; k++) {
      const th = 0.36 * (0.88 + 0.24 * j()), d = 0.5 * (0.9 + 0.2 * j()), sag = 0.05 * j(), c = Math.min(0.4 * th, 0.3 * d);
      const org = mad(mad(T0, Dn, Ls - d + 0.1), N, -sag);
      prism('Snow', 0.035, org, Dn, N, R, [[c, 0], [d - c, 0], [d, c], [d, th - c], [d - c, th], [c, th], [0, th - c], [0, c]],
        cuts[k] - (k > 0 ? 0.08 : 0), cuts[k + 1] + (k < n - 1 ? 0.08 : 0), 0.1, g, true);
    }
  };
  const slope = (T0, R, Dn, N, Ls, q, r, g, cover) => {
    const thatch = cover === 'thatch';
    const poly = r[0] === r[1] ? [[q[0], -Ls], [q[1], -Ls], [r[0], 0]] : [[q[0], -Ls], [q[1], -Ls], [r[1], 0], [r[0], 0]];
    prism('Roof', 0.04, T0, R, sc(Dn, -1), N, poly, thatch ? -0.3 : -K.slab, 0, 0.04, g);
    if (cover === 'snow') { blanket(T0, R, Dn, N, Ls, q, r, g); return; }
    // thatch: a few thick, soft layers, each lifting its lower edge more than a tile does
    const len = thatch ? 1.6 * tileScale : TL, step0 = thatch ? 1.05 * tileScale : K.row * tileScale;
    const span = Ls - 0.1 - len, rows = span > 0 ? Math.floor(span / step0 + 0.5) + 1 : 1, step = rows > 1 ? span / (rows - 1) : 0;
    for (let k = 0; k < rows; k++) {
      const dd = 0.1 + k * step, dm = dd + len / 2;
      const lo = r[0] + (q[0] - r[0]) * dm / Ls, hi = r[1] + (q[1] - r[1]) * dm / Ls, width = hi - lo;
      if (width < 0.5) continue;
      const top = mad(T0, Dn, dd);
      if (thatch) { roll(top, R, Dn, N, lo - 0.15, hi + 0.15, len, g); continue; }
      const m = Math.max(1, Math.floor(width / TW + 0.5)), p = width / m;
      if (k % 2 === 0) for (let i = 0; i < m; i++) tile(mad(top, R, lo + (i + 0.5) * p), R, Dn, N, p - 0.06, len, TT, 0.07, g);
      else {
        const hw = p / 2 - 0.06;
        tile(mad(top, R, lo + hw / 2), R, Dn, N, hw, len, TT, 0.07, g);
        for (let i = 0; i < m - 1; i++) tile(mad(top, R, lo + (i + 1) * p), R, Dn, N, p - 0.06, len, TT, 0.07, g);
        tile(mad(top, R, hi - hw / 2), R, Dn, N, hw, len, TT, 0.07, g);
      }
    }
  };

  // ---------------------------------------------------------------- walls, plinth, frame
  blocks.forEach((b, bi) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, W = b.x1 - b.x0, D = b.y1 - b.y0;
    if (b.shape === 'round') {
      const R = W / 2, ring = [];
      for (let k = 0; k < 16; k++) ring.push([DIRS64[k * 4][0] * R, DIRS64[k * 4][1] * R]);
      prism(wallSlot(b.walls), 0.025, [cx, cy, 0], [1, 0, 0], [0, 1, 0], Z, ring, P, b.zTop + 0.02, 0.03, [P, b.zTop], true);
      const chord = 2 * (R + 0.26) * DIRS64[2][1] - 0.05;
      for (let k = 0; k < 16; k++) {
        const d = DIRS64[k * 4 + 2], h = P + 0.02 + (j() * 0.09 - 0.03), dd = 0.46 + (j() - 0.5) * 0.06;
        prism('Stone', 0.04, [cx + d[0] * (R + 0.03), cy + d[1] * (R + 0.03), h / 2], [-d[1], d[0], 0], [d[0], d[1], 0], Z, rect(chord, dd), -h / 2, h / 2, 0.08, [0, P + 0.08]);
      }
      const bands = b.walls === 'stone' ? [b.storeys - 1] : Array.from({ length: b.storeys }, (_, s) => s);
      const band = [];
      for (let k = 0; k < 16; k++) band.push([DIRS64[k * 4][0] * (R + 0.06), DIRS64[k * 4][1] * (R + 0.06)]);
      for (const s of bands) {
        const z = s === b.storeys - 1 ? b.zTop + 0.13 : P + (s + 1) * H;
        prism('Timber', 0.04, [cx, cy, 0], [1, 0, 0], [0, 1, 0], Z, band, z - 0.13, z + 0.13, 0.05, [z - 0.13, z + 0.13], true);
      }
      return;
    }
    if (b.walls === 'open') {
      // a woodshed: posts at the outer corners (and the middle of a long side) up to the roof, and a beam under it
      const R = b.roof, alongY = R.axis === 'y', outer = R.dir > 0 ? (alongY ? b.x1 : b.y1) : (alongY ? b.x0 : b.y0);
      const run = Math.abs(outer - R.wall), zu = R.zr - run * R.pitch - K.slab * Math.sqrt(1 + R.pitch * R.pitch);
      const [a0, a1] = alongY ? [b.y0, b.y1] : [b.x0, b.x1], oc = outer - R.dir * 0.15;
      const at = a1 - a0 > 3.2 ? [a0 + 0.15, (a0 + a1) / 2, a1 - 0.15] : [a0 + 0.15, a1 - 0.15];
      for (const al of at) box('Timber', 0.035, alongY ? [oc, al, zu / 2] : [al, oc, zu / 2], [0.22, 0.22, zu], 0.04, [0, zu]);
      box('Timber', 0.035, alongY ? [oc, (a0 + a1) / 2, zu - 0.12] : [(a0 + a1) / 2, oc, zu - 0.12], alongY ? [0.26, a1 - a0 + 0.1, 0.24] : [a1 - a0 + 0.1, 0.26, 0.24], 0.04, [zu - 0.24, zu]);
      return;
    }
    // walls: one box per run of storeys with the same colour slot (the girt hides the seam); a belfry's walls stop
    // under its open top storey, whose floor is a plank deck standing a little proud of the masonry
    const walled = topWalled(b) + 1;
    let s0 = 0;
    for (let s = 1; s <= walled; s++) {
      if (s < walled && storeySlot(b, s) === storeySlot(b, s0)) continue;
      const z0 = P + s0 * H, z1 = s === b.storeys ? b.zTop + 0.02 : P + s * H;
      box(storeySlot(b, s0), 0.025, [cx, cy, (z0 + z1) / 2], [W, D, z1 - z0], 0.03, [z0, z1]);
      s0 = s;
    }
    if (walled < b.storeys) {
      const zf = P + walled * H;
      box('Plank', 0.035, [cx, cy, zf + 0.06], [W + 0.34, D + 0.34, 0.2], 0.05, [zf - 0.04, zf + 0.16]);
      place('bell.hang', cx, cy, b.zTop, 0, -1);
    }
    // a lean-to's side walls close up under its sloping roof
    if (b.roof.type === 'shed') {
      const R = b.roof, alongY = R.axis === 'y', outer = R.dir > 0 ? (alongY ? b.x1 : b.y1) : (alongY ? b.x0 : b.y0);
      const zu = R.zr - K.slab * Math.sqrt(1 + R.pitch * R.pitch) - 0.02;
      const C = alongY ? [1, 0, 0] : [0, 1, 0], A = alongY ? [0, 1, 0] : [1, 0, 0];
      prism('Plank', 0.025, [0, 0, 0], C, Z, A, [[outer, b.zTop], [R.wall, b.zTop], [R.wall, zu]], alongY ? b.y0 : b.x0, alongY ? b.y1 : b.x1, 0.03, [b.zTop, zu]);
    }
    for (const face of FACES) {
      const [nx, ny] = NORMALS[face], alongX = face === '-y' || face === '+y';
      for (const [a, z, ca, cz] of exposedSpans(bi, face, blocks)) {
        // plinth: a row of chunky stones, the long walls' rows running past the corners
        const ext = alongX ? 0.26 : -0.2, lo = a - (ca ? ext : 0), hi = z + (cz ? ext : 0), len = hi - lo;
        const n = Math.max(1, Math.floor(len / 1.45 + 0.5)), cuts = [lo];
        for (let k = 1; k < n; k++) cuts.push(lo + len * k / n + (j() - 0.5) * 0.24);
        cuts.push(hi);
        for (let k = 0; k < n; k++) {
          const l = cuts[k + 1] - cuts[k] - 0.05, u = (cuts[k] + cuts[k + 1]) / 2;
          const h = P + 0.02 + (j() * 0.09 - 0.03), dd = 0.46 + (j() - 0.5) * 0.06, [px, py] = facePoint(b, face, u);
          box('Stone', 0.04, [px + nx * 0.03, py + ny * 0.03, h / 2], alongX ? [l, dd, h] : [dd, l, h], 0.08, [0, P + 0.08]);
        }
        // plates and girts: a beam at every floor line above a timber storey, and the top plate on every wall
        for (let s = 0; s < b.storeys; s++) {
          const top = s === b.storeys - 1;
          if (!top && !timberStorey(b, s + 1) && !timberStorey(b, s)) continue;
          const zc = top ? b.zTop + 0.13 : P + (s + 1) * H, lo2 = a - (ca ? 0.18 : 0), hi2 = z + (cz ? 0.18 : 0);
          const [px, py] = facePoint(b, face, (lo2 + hi2) / 2), dp = top ? 0.3 : 0.26, hp = top ? 0.28 : 0.24;
          box('Timber', 0.04, [px + nx * 0.04, py + ny * 0.04, zc], alongX ? [hi2 - lo2, dp, hp] : [dp, hi2 - lo2, hp], 0.05, [zc - hp, zc + hp]);
        }
        // log walls: round courses split round the openings; every other course runs past an open corner, the
        // long walls' on the even courses and the gable walls' on the odd ones, so the log ends interlock
        if (b.walls === 'log') {
          const open = [];
          for (const w of plan.walls) if (w.b === bi && w.face === face && w.a === a) for (const c of w.cells) {
            if (c.kind === 'blank') continue;
            const dm = rules.parts[c.part], zb = c.kind === 'door' ? P - 0.02 : P + w.s * H + K.sill;
            open.push([c.u - dm.w / 2 - 0.08, c.u + dm.w / 2 + 0.08, zb - 0.1, zb + dm.h + 0.1]);
          }
          const rows = Math.max(1, Math.floor((b.zTop - P) / 0.36)), step = (b.zTop - P) / rows, org = facePoint(b, face, 0);
          const A = alongX ? [1, 0, 0] : [0, 1, 0], out = [nx, ny, 0];
          for (let k = 0; k < rows; k++) {
            const zc = P + (k + 0.5) * step, ext = k % 2 === (alongX ? 0 : 1) ? 0.34 : 0.1;
            let runs = [[a - (ca ? ext : 0), z + (cz ? ext : 0)]];
            for (const [u0, u1, zb, zt] of open) {
              if (zc < zb || zc > zt) continue;
              const next = [];
              for (const [p0, p1] of runs) { if (u0 > p0) next.push([p0, Math.min(p1, u0)]); if (u1 < p1) next.push([Math.max(p0, u1), p1]); }
              runs = next;
            }
            for (const [p0, p1] of runs) if (p1 - p0 > 0.3) prism('Log', 0.03, [org[0] + nx * 0.02, org[1] + ny * 0.02, zc], out, Z, A, LOG, p0, p1, 0.03, [P, b.zTop], true);
          }
        }
        // a belfry's open storey: a rail round every side at waist height over crossed braces
        if (b.walls === 'belfry') {
          const zf = P + (b.storeys - 1) * H + 0.16, zr = zf + 0.95, [px, py] = facePoint(b, face, (a + z) / 2);
          box('Timber', 0.035, [px + nx * 0.1, py + ny * 0.1, zr], alongX ? [z - a + 0.1, 0.18, 0.18] : [0.18, z - a + 0.1, 0.18], 0.04, [zf, zr]);
          const bays = z - a > 2.6 ? 2 : 1, bw = (z - a - 0.3) / bays;
          for (let k = 0; k < bays; k++) for (const sg of [-1, 1]) {
            const u0 = a + 0.15 + k * bw, p0 = facePoint(b, face, sg < 0 ? u0 : u0 + bw), p1 = facePoint(b, face, sg < 0 ? u0 + bw : u0);
            strut('TimberDark', 0.03, [p0[0] + nx * 0.1, p0[1] + ny * 0.1, zf + 0.05], [p1[0] + nx * 0.1, p1[1] + ny * 0.1, zr - 0.08], 0.14, 0.1, [nx, ny, 0], 0.03, [zf, zr]);
          }
        }
        // plank walls: battens between the openings
        if (b.walls === 'plank') {
          const open = [];
          for (const w of plan.walls) if (w.b === bi && w.face === face && w.a === a) for (const c of w.cells) if (c.kind !== 'blank') open.push([c.u, rules.parts[c.part].w / 2 + 0.12]);
          for (let u = a + 0.3; u < z - 0.2; u += 0.55) {
            if (open.some(([cu, half]) => Math.abs(u - cu) < half)) continue;
            const [px, py] = facePoint(b, face, u), z1 = b.zTop - 0.02;
            box('TimberDark', 0.02, [px + nx * 0.03, py + ny * 0.03, (P + z1) / 2], alongX ? [0.1, 0.06, z1 - P] : [0.06, 0.1, z1 - P], 0.02, [P, z1]);
          }
        }
      }
    }
    // corners: timber posts, or stone quoins up the masonry storeys
    for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
      if (inside(x, y, blocks, bi)) continue;
      const sx = x > cx ? 1 : -1, sy = y > cy ? 1 : -1;
      let zm = P;
      if (b.walls === 'log') continue;
      if (b.walls === 'stone' || b.walls === 'mixed' || b.walls === 'belfry') {
        zm = b.walls === 'stone' ? b.zTop : b.walls === 'belfry' ? P + (b.storeys - 1) * H : P + H;
        const n = Math.max(1, Math.floor((zm - P) / 0.42));
        for (let k = 0; k < n; k++) {
          const h = (zm - P) / n, z = P + (k + 0.5) * h, long = k % 2 === 0;
          const sxz = long ? [0.66, 0.4] : [0.4, 0.66];
          box('Stone', 0.035, [x - sx * (sxz[0] / 2 - 0.06), y - sy * (sxz[1] / 2 - 0.06), z], [sxz[0], sxz[1], h - 0.04], 0.05, [P, zm]);
        }
      }
      if (b.walls !== 'stone' && b.zTop - zm > 0.3) box('Timber', 0.04, [x, y, (zm + b.zTop + 0.05) / 2], [0.3, 0.3, b.zTop + 0.05 - zm], 0.05, [zm, b.zTop]);
    }
  });

  // ---------------------------------------------------------------- roofs
  blocks.forEach((b, bi) => {
    const R = b.roof, K2 = R.pitch, n2 = Math.sqrt(1 + K2 * K2), thatch = R.covering === 'thatch', zPlate = b.zTop + K.plate;
    if (R.type === 'cone') {
      const Rr = (b.x1 - b.x0) / 2, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, E = Rr + 0.45, ez = R.zr - E * K2, Ls = E * n2, g = [ez, R.zr];
      pieces.push({ k: 'lathe', s: 'Roof', o: 0.04, c: [r4(cx), r4(cy), 0], p: [[0, R.zr], [E, ez], [E, ez - 0.2], [0, R.zr - 0.2 * n2]].map(q => [r4(q[0]), r4(q[1])]), n: 16, g: [r4(g[0]), r4(g[1])] });
      if (R.covering === 'snow') {
        // a snow cap: a thick rounded rim over the eave, thinning toward the tip
        pieces.push({ k: 'lathe', s: 'Snow', o: 0.035, c: [r4(cx), r4(cy), 0], p: [[0, R.zr + 0.3], [E - 0.12, ez + 0.3], [E + 0.08, ez + 0.14], [E + 0.02, ez - 0.02], [E - 0.3, ez + 0.3 * K2 - 0.05], [0, R.zr - 0.05]].map(q => [r4(q[0]), r4(q[1])]), n: 16, g: [r4(g[0]), r4(g[1])] });
        if (!(bi === 0 && plan.topper)) place('roof.spire', cx, cy, R.zr + 0.2, 0, -1);
        return;
      }
      const len = thatch ? 1.2 * tileScale : TL, step0 = thatch ? 0.8 * tileScale : K.row * tileScale;
      const span = Ls - 0.35 - len, rows = span > 0 ? Math.floor(span / step0 + 0.5) + 1 : 1, step = rows > 1 ? span / (rows - 1) : 0;
      for (let k = 0; k < rows; k++) {
        const dd = 0.35 + k * step, top = R.zr - dd / n2 * K2, r0 = dd / n2;
        if (thatch) {
          // a thatched cone is a stack of rolled tiers
          const r1 = (dd + len) / n2, bottom = R.zr - (dd + len) / n2 * K2;
          pieces.push({ k: 'lathe', s: 'Roof', o: 0.045, c: [r4(cx), r4(cy), 0], p: [[r0, top + 0.02], [r1 + 0.12, bottom - 0.04], [r1 + 0.02, bottom - 0.3], [r0 - 0.1, top - 0.25]].map(q => [r4(q[0]), r4(q[1])]), n: 16, g: [r4(g[0]), r4(g[1])] });
          continue;
        }
        const rm = (dd + len / 2) / n2, circ = 2 * Math.PI * rm;
        const nt = circ / 8 <= TW * 1.15 ? 8 : circ / 16 <= TW * 1.15 ? 16 : 32;
        if (circ / nt < 0.45) continue;
        for (let i = 0; i < nt; i++) {
          const d = DIRS64[(i * 2 + (k % 2)) * 32 / nt];
          const Dn = [d[0] / n2, d[1] / n2, -K2 / n2], N = [d[0] * K2 / n2, d[1] * K2 / n2, 1 / n2];
          tile([cx + d[0] * r0, cy + d[1] * r0, top], [-d[1], d[0], 0], Dn, N, circ / nt - 0.06, len, TT, 0.07, g);
        }
      }
      if (!(bi === 0 && plan.topper)) place('roof.spire', cx, cy, R.zr - 0.1, 0, -1);
      return;
    }
    const alongX = R.axis === 'x', A = alongX ? [1, 0, 0] : [0, 1, 0], C = alongX ? [0, 1, 0] : [1, 0, 0];
    const at = (al, ac, z) => (alongX ? [al, ac, z] : [ac, al, z]);
    const [a0, a1] = alongX ? [b.x0, b.x1] : [b.y0, b.y1], [c0, c1] = alongX ? [b.y0, b.y1] : [b.x0, b.x1];
    if (R.type === 'shed') {
      const outer = R.dir > 0 ? c1 : c0, run = Math.abs(outer - R.wall) + K.eave + 0.1, Ls = run * n2;
      const T0 = at(0, R.wall - R.dir * 0.1, R.zr + 0.1 * K2), Dn = mad(sc(C, R.dir / n2), Z, -K2 / n2), N = mad(sc(C, R.dir * K2 / n2), Z, 1 / n2);
      slope(T0, A, Dn, N, Ls, [a0 - R.ends[0], a1 + R.ends[1]], [a0 - R.ends[0], a1 + R.ends[1]], [R.zr - run * K2, R.zr], R.covering);
      return;
    }
    const hs = (c1 - c0) / 2, cc = (c0 + c1) / 2, E = hs + K.eave, Ls = E * n2, g = [R.zr - E * K2, R.zr];
    const down = sg => [mad(sc(C, sg / n2), Z, -K2 / n2), mad(sc(C, sg * K2 / n2), Z, 1 / n2)];
    if (R.type === 'gable') {
      const e0 = a0 - R.ends[0], e1 = a1 + R.ends[1];
      for (const sg of [-1, 1]) { const [Dn, N] = down(sg); slope(at(0, cc, R.zr), A, Dn, N, Ls, [e0, e1], [e0, e1], g, R.covering); }
      prism(b.walls === 'mixed' ? 'Wall' : wallSlot(b.walls), 0.025, at(0, cc, 0), C, Z, A, [[-hs + 0.02, zPlate - 0.02], [hs - 0.02, zPlate - 0.02], [0, R.zr - 0.15]], a0, a1, 0.03, [zPlate, R.zr]);
      caps(at(e0 + 0.3, cc, R.zr), at(e1 - 0.3, cc, R.zr));
      const zb = R.zr - K.slab * n2 - 0.1;
      [[0, e0 + 0.12, alongX ? '-x' : '-y', a0 - 0.05], [1, e1 - 0.12, alongX ? '+x' : '+y', a1 + 0.05]].forEach(([i, al, face, line]) => {
        if (R.ends[i] > 0.15 && !thatch) for (const sg of [-1, 1]) strut('Timber', 0.035, at(al, cc, zb), at(al, cc + sg * (E - 0.05), zb - (E - 0.05) * K2), 0.26, 0.16, A, 0.04, g);
        // a timber-framed gable end: king post and braces
        if (!timberStorey(b, b.storeys - 1) || hs * K2 < 1.2 || !exposedAt(bi, face, cc, blocks, 0.6)) return;
        const kh = R.zr - 0.5 - zPlate;
        box('TimberDark', 0.035, at(line, cc, (zPlate + R.zr - 0.5) / 2), alongX ? [0.14, 0.24, kh] : [0.24, 0.14, kh], 0.04, [zPlate, R.zr]);
        for (const sg of [-1, 1]) strut('TimberDark', 0.035, at(line, cc + sg * 0.78 * hs, zPlate + 0.02), at(line, cc + sg * 0.14, zPlate + 0.58 * hs * K2), 0.2, 0.13, A, 0.04, [zPlate, R.zr]);
      });
      return;
    }
    // hip (and pyramid: a hip with no ridge)
    const ha = (a1 - a0) / 2, ca = (a0 + a1) / 2, EA = ha + K.eave, hr = Math.max(0, ha - hs);
    for (const sg of [-1, 1]) { const [Dn, N] = down(sg); slope(at(ca, cc, R.zr), A, Dn, N, Ls, [-EA, EA], [-hr, hr], g, R.covering); }
    for (const sg of [-1, 1]) {
      const Dn = mad(sc(A, sg / n2), Z, -K2 / n2), N = mad(sc(A, sg * K2 / n2), Z, 1 / n2);
      slope(at(ca + sg * hr, cc, R.zr), C, Dn, N, Ls, [-E, E], [0, 0], g, R.covering);
    }
    if (hr > 0.2) caps(at(ca - hr, cc, R.zr), at(ca + hr, cc, R.zr));
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) caps(at(ca + sa * hr, cc, R.zr), at(ca + sa * EA, cc + sb * E, R.zr - E * K2));
    if (R.type === 'pyramid' && !(bi === 0 && plan.topper)) place('roof.spire', alongX ? ca : cc, alongX ? cc : ca, R.zr - 0.1, 0, -1);
  });

  // ---------------------------------------------------------------- openings
  for (const w of plan.walls) {
    const b = blocks[w.b], [nx, ny] = NORMALS[w.face], alongX = w.face === '-y' || w.face === '+y', z0 = P + w.s * H;
    const timber = timberStorey(b, w.s), proud = b.walls === 'log' ? 0.14 : 0;
    w.cells.forEach((c, i) => {
      // on log walls the openings stand out on the courses' faces
      const [qx, qy] = facePoint(b, w.face, c.u), px = qx + nx * proud, py = qy + ny * proud;
      // timber storeys: a stud between neighbouring bays, a brace across every blank panel
      if (timber && i > 0) {
        const u = (w.cells[i - 1].u + c.u) / 2, [sx, sy] = facePoint(b, w.face, u);
        box('Timber', 0.035, [sx + nx * 0.02, sy + ny * 0.02, z0 + H / 2], alongX ? [0.24, 0.22, H] : [0.22, 0.24, H], 0.05, [z0, z0 + H]);
      }
      if (c.kind === 'blank') {
        if (timber) {
          const half = (w.cells.length > 1 ? Math.abs(w.cells[1].u - w.cells[0].u) : w.z - w.a - 1) / 2 - 0.2, flip = c.u > (w.a + w.z) / 2 ? -1 : 1;
          const p0 = facePoint(b, w.face, c.u - flip * half), p1 = facePoint(b, w.face, c.u + flip * half);
          strut('TimberDark', 0.03, [p0[0] + nx * 0.04, p0[1] + ny * 0.04, z0 + 0.3], [p1[0] + nx * 0.04, p1[1] + ny * 0.04, z0 + H - 0.3], 0.2, 0.12, [nx, ny, 0], 0.04, [z0, z0 + H]);
        }
        return;
      }
      const dims = rules.parts[c.part], z = c.kind === 'door' ? P - 0.02 : c.kind === 'oriel' || c.kind === 'banner' ? z0 + 0.25 : z0 + K.sill;
      const idx = place(c.part, px, py, z, nx, ny);
      if (c.kind === 'door') {
        if (st.lantern) hang(st.lantern, idx, 'lamp', false);
        if (st.canopy) hang(st.canopy, idx, 'canopy', false);
        if (st.sign) hang(st.sign, idx, 'sign', false);
        box('Stone', 0.04, [px + nx * 0.5, py + ny * 0.5, 0.13], alongX ? [dims.w + 0.14, 0.62, 0.26] : [0.62, dims.w + 0.14, 0.26], 0.06, [0, 0.26]);
      }
      if (c.shutter) hang(c.shutter, idx, 'shutter', true);
      if (c.sill) hang(c.sill, idx, 'sill', false);
      if (storeySlot(b, w.s) === 'Masonry' && c.kind !== 'oriel' && c.kind !== 'banner') {
        const zl = z + dims.h + 0.14;
        box('Stone', 0.035, [px + nx * 0.05, py + ny * 0.05, zl], alongX ? [dims.w + 0.3, 0.24, 0.22] : [0.24, dims.w + 0.3, 0.22], 0.05, [zl - 0.11, zl + 0.11]);
      }
    });
    // masonry: a few proud stones between the openings, the look-dev sheet's painted stonework
    if (storeySlot(b, w.s) === 'Masonry') {
      const count = Math.floor((w.z - w.a) / 1.1);
      for (let k = 0; k < count; k++) {
        const u = w.a + (k + 0.5 + (j() - 0.5) * 0.6) * (w.z - w.a) / count, zs = z0 + 0.45 + j() * (H - 0.9), sw = 0.46 + 0.3 * j(), sh = 0.24 + 0.12 * j();
        if (u < w.a + 0.6 || u > w.z - 0.6) continue;
        if (w.cells.some(c => c.kind !== 'blank' && Math.abs(u - c.u) < rules.parts[c.part].w / 2 + sw / 2 + 0.12)) continue;
        const [px, py] = facePoint(b, w.face, u);
        box('Stone', 0.03, [px + nx * 0.03, py + ny * 0.03, zs], alongX ? [sw, 0.16, sh] : [0.16, sw, sh], 0.05, [zs - sh / 2, zs + sh / 2]);
      }
    }
  }
  for (const a of plan.attics) {
    const b = blocks[a.b], [nx, ny] = NORMALS[a.face], [px, py] = facePoint(b, a.face, a.u);
    place(a.part, px, py, b.zTop + K.plate + 0.22, nx, ny);
  }
  for (const rg of plan.rings) {
    const b = blocks[rg.b], R = (b.x1 - b.x0) / 2, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (const c of rg.cells) {
      const d = DIRS64[c.k], dims = rules.parts[c.part];
      if (c.kind === 'door') {
        // a flat stone surround gives the door a wall to sit in
        const t = [-d[1], d[0], 0], rad = [d[0], d[1], 0], zt = P + dims.h + 0.4;
        prism('Stone', 0.04, [cx + d[0] * (R + 0.02), cy + d[1] * (R + 0.02), 0], t, rad, Z, rect(dims.w + 0.6, 0.64), 0, zt, 0.06, [0, zt]);
        const idx = place(c.part, cx + d[0] * (R + 0.34), cy + d[1] * (R + 0.34), P - 0.02, d[0], d[1]);
        if (st.lantern) hang(st.lantern, idx, 'lamp', false);
        box('Stone', 0.04, [cx + d[0] * (R + 0.8), cy + d[1] * (R + 0.8), 0.13], [0.9, 0.9, 0.26], 0.06, [0, 0.26]);
        continue;
      }
      const idx = place(c.part, cx + d[0] * (R - 0.03), cy + d[1] * (R - 0.03), P + c.s * H + K.sill, d[0], d[1]);
      if (c.sill) hang(c.sill, idx, 'sill', false);
    }
    if (b.walls !== 'stone') continue;
    // stonework between the windows, on every storey
    for (let s = 0; s < b.storeys; s++) for (let k = 4; k < 64; k += 8) {
      const kk = (k + Math.floor(j() * 3)) % 64, zs = P + s * H + 0.5 + j() * (H - 1.0), sw = 0.46 + 0.3 * j(), sh = 0.24 + 0.12 * j();
      if (rg.cells.some(c => c.s === s && Math.min(Math.abs(c.k - kk), 64 - Math.abs(c.k - kk)) < 4)) continue;
      const d = DIRS64[kk];
      prism('Stone', 0.03, [cx + d[0] * (R + 0.02), cy + d[1] * (R + 0.02), zs], [-d[1], d[0], 0], [d[0], d[1], 0], Z, rect(sw, 0.16), -sh / 2, sh / 2, 0.05, [zs - sh / 2, zs + sh / 2]);
    }
  }

  // ---------------------------------------------------------------- chimney, dormers, topper, yard
  const ch = plan.chimney;
  if (ch) {
    const main = blocks[0], R = main.roof, s = ch.kind === 'ridge' ? 1.0 : 0.95;
    let x, y, z0;
    if (ch.kind === 'ridge') {
      const across = R.axis === 'x' ? Math.abs(ch.y - (main.y0 + main.y1) / 2) : Math.abs(ch.x - (main.x0 + main.x1) / 2);
      x = ch.x; y = ch.y; z0 = R.zr - across * R.pitch - 0.7;
    } else {
      // an outside stack climbing the gable wall from a wide foot
      const [nx, ny] = NORMALS[ch.face], [px, py] = facePoint(main, ch.face, ch.u), alongX = ch.face === '-y' || ch.face === '+y';
      box('Stone', 0.04, [px + nx * 0.36, py + ny * 0.36, (main.zTop + 0.2) / 2], alongX ? [1.4, 0.76, main.zTop + 0.2] : [0.76, 1.4, main.zTop + 0.2], 0.06, [0, main.zTop]);
      x = px + nx * 0.32; y = py + ny * 0.32; z0 = main.zTop;
    }
    const zc = Math.max(ch.top - 1.62, z0 + 0.1);   // a low chimney on a shallow roof is all courses
    box('Stone', 0.04, [x, y, (z0 + zc) / 2], [s, s, zc - z0], 0.06, [z0, ch.top]);
    let z = zc;
    for (let rr = 0; rr < 3; rr++) {
      const off = ch.lean * (rr + 1), h = 0.44;
      const halves = rr % 2 === 0 ? [[[0.52 * s, 1.08 * s], [-0.27 * s, 0]], [[0.52 * s, 1.08 * s], [0.27 * s, 0]]] : [[[1.08 * s, 0.52 * s], [0, -0.27 * s]], [[1.08 * s, 0.52 * s], [0, 0.27 * s]]];
      for (const [[hx, hy], [ox, oy]] of halves) box('Stone', 0.04, [x + ox + off, y + oy, z + h / 2], [hx * (0.97 + 0.06 * j()), hy * (0.97 + 0.06 * j()), h - 0.03], 0.06, [z0, ch.top]);
      z += h;
    }
    const off = ch.lean * 3;
    box('Stone', 0.04, [x + off, y, z + 0.15], [1.3 * s, 1.3 * s, 0.3], 0.06, [z0, ch.top]);
    // under snow the crown wears a soft cap and the flue opens on top of it
    const cap = blocks[0].roof.covering === 'snow' ? 0.16 : 0;
    if (cap) box('Snow', 0.035, [x + off, y, z + 0.3 + cap / 2], [1.24 * s, 1.24 * s, cap + 0.04], 0.07, [z0, ch.top]);
    box('StoneDark', 0, [x + off, y, z + 0.32 + cap], [0.62 * s, 0.62 * s, 0.05], 0.01, [z0, ch.top]);
    if (ch.pot) place('chimney.pot', x + off, y, z + 0.3 + cap, 0, -1);
  }
  for (const d of plan.dormers) place(d.part, d.x, d.y, d.z, 0, -1);
  if (plan.topper) place(plan.topper.part, plan.topper.x, plan.topper.y, plan.topper.z, 0, -1);
  if (plan.yard) place(plan.yard.part, plan.yard.x, plan.yard.y, 0, plan.yard.nx, plan.yard.ny);
  return { pieces, parts };
}

// ---------------------------------------------------------------- flat-roofed families (the desert village)
//
// A family with `form: "flat"` is built from flat-roofed blocks: rounded plaster (or sandstone) walls, a parapet round
// every roof, beam ends (vigas) under it, and one ground-level annex (a lower wing, a wing with an outside stair up to
// its roof terrace, or a walled courtyard in front with a gateway) plus one roof crown (a roof room set back on the
// roof, a dome on a drum, or the lookout's shelter). Blocks carry z0, so a roof room stands on its house; a wall is
// covered by a neighbour only where the neighbour stands at that height. house_grammar.py holds the same code.

/** Rect corners, counter-clockwise from the front-right, with the direction (a DIRS64 index) each corner's arc starts at. */
const FLAT_CORNERS = [[1, -1, 48], [1, 1, 0], [-1, 1, 16], [-1, -1, 32]];

function flatBlock(id, x0, x1, y0, y1, z0, storeys, walls, zTop, ph) {
  return { id, shape: 'rect', x0: r4(x0), x1: r4(x1), y0: r4(y0), y1: r4(y1), z0: r4(z0), storeys, zTop: r4(zTop), walls, roof: { type: 'flat', parapet: r4(ph), zr: r4(zTop + ph) } };
}

function insideZ(x, y, z, blocks, skip) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i !== skip && z > b.z0 - 0.01 && z < b.zTop + 0.01 && x > b.x0 + 0.01 && x < b.x1 - 0.01 && y > b.y0 + 0.01 && y < b.y1 - 0.01) return true;
  }
  return false;
}

/** The stretches of a face no other block covers AT HEIGHT z: [[a, z, cornerA, cornerZ]]. */
function flatSpans(bi, face, blocks, z) {
  const b = blocks[bi], alongX = face === '-y' || face === '+y';
  const line = face === '-y' ? b.y0 : face === '+y' ? b.y1 : face === '-x' ? b.x0 : b.x1;
  const lo = alongX ? b.x0 : b.y0, hi = alongX ? b.x1 : b.y1;
  let spans = [[lo, hi]];
  for (let i = 0; i < blocks.length; i++) {
    const o = blocks[i];
    if (i === bi || !(z > o.z0 - 0.01 && z < o.zTop + 0.01)) continue;
    const p0 = alongX ? o.y0 : o.x0, p1 = alongX ? o.y1 : o.x1;
    if (!(line > p0 + 0.01 && line < p1 - 0.01)) continue;
    const c0 = alongX ? o.x0 : o.y0, c1 = alongX ? o.x1 : o.y1, next = [];
    for (const [a, zz] of spans) {
      if (c1 <= a || c0 >= zz) { next.push([a, zz]); continue; }
      if (c0 > a) next.push([a, c0]);
      if (c1 < zz) next.push([c1, zz]);
    }
    spans = next;
  }
  const out = [];
  for (const [a, zz] of spans) {
    if (zz - a < 0.3) continue;
    const pa = facePoint(b, face, a), pz = facePoint(b, face, zz);
    out.push([r4(a), r4(zz), a === lo && !insideZ(pa[0], pa[1], z, blocks, bi), zz === hi && !insideZ(pz[0], pz[1], z, blocks, bi)]);
  }
  return out;
}

function flatExtent(blocks, court, stair, pad, fp) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  blocks.forEach((b, i) => {
    if (b.z0 > 1.0) return;
    x0 = Math.min(x0, b.x0 - pad); x1 = Math.max(x1, b.x1 + pad); y0 = Math.min(y0, b.y0 - (i === 0 ? fp : pad)); y1 = Math.max(y1, b.y1 + pad);
  });
  for (const R of [court, stair]) if (R) { x0 = Math.min(x0, R.x0 - 0.1); x1 = Math.max(x1, R.x1 + 0.1); y0 = Math.min(y0, R.y0 - 0.1); y1 = Math.max(y1, R.y1 + 0.1); }
  return [x0, x1, y0, y1];
}

function flatFits(blocks, court, stair, lot, pad, fp) {
  const [x0, x1, y0, y1] = flatExtent(blocks, court, stair, pad, fp);
  return x1 - x0 <= lot.w + 1e-6 && y1 - y0 <= lot.d + 1e-6;
}

/** The front pad a house keeps for what hangs off its door (a shop awning reaches two metres out). */
const flatFront = (rules, style) => Math.max(rules.flat.pad, rules.parts[style.canopy]?.out ?? 0);

function flatMassing(rules, F, style, dna, m, lot) {
  const K = rules.kit, FK = rules.flat, M = F.mass, P = K.plinth;
  const gene = g => clamp01(0.75 * g + 0.25 * m());
  const H = snap(K.storey * (0.96 + 0.08 * m()));
  const span = snap(mix(M.span, gene(dna.size)));
  let length = snap(mix(M.length, gene(dna.size)));
  const ph = snap(mix(FK.parapet, gene(dna.ornament)));
  const a = [m(), m(), m(), m(), m(), m(), m(), m()];
  if (M.square) length = span;
  const n = M.storeys[0] + Math.min(M.storeys[1] - M.storeys[0], Math.floor(dna.tall * (M.storeys[1] - M.storeys[0] + 1)));
  const pad = FK.pad, fp = flatFront(rules, style);
  const walls = style.walls || 'adobe', annex = style.annex, CT = FK.court, T = FK.wall;
  const ww = annex === 'wing' ? snap(2.4 + 1.0 * a[1]) : annex === 'terrace' ? snap(3.3 + 0.7 * a[1]) : 0;
  const cd = annex === 'court' ? snap(mix(CT.depth, a[2])) : 0;
  const W = Math.max(M.span[0] * 0.8, Math.min(length, snap(lot.w - 2 * pad - ww)));
  const D = Math.max(M.span[0] * 0.8, Math.min(span, snap(lot.d - pad - fp - (cd ? cd + CT.t : 0))));
  const main = flatBlock('main', -W / 2, W / 2, -D / 2, D / 2, P, n, walls, P + n * H, ph);
  const blocks = [main];
  let court = null, stair = null;
  if (annex === 'wing' || annex === 'terrace') {
    const faces = ['+x', '-x'], first = Math.floor(a[0] * 2);
    for (let i = 0; i < 2; i++) {
      const sg = faces[(first + i) % 2] === '+x' ? 1 : -1;
      const wd = annex === 'terrace' ? snap(Math.max(2.4, D - FK.stair.w - 0.3)) : snap(Math.max(2.4, Math.min(D - 0.4, D * (0.55 + 0.3 * a[2]))));
      const back = annex === 'terrace' || a[3] >= 0.5;
      const y0 = back ? main.y1 - wd : main.y0, y1 = back ? main.y1 : main.y0 + wd;
      const x0 = sg > 0 ? main.x1 - 0.3 : main.x0 - ww, x1 = sg > 0 ? main.x1 + ww : main.x0 + 0.3;
      const w = flatBlock('wing', x0, x1, y0, y1, P, 1, walls, P + H, n > 1 ? snap(ph * 0.85) : snap(Math.max(0.25, ph - 0.25)));
      let st = null;
      if (annex === 'terrace') {
        const inner = sg > 0 ? x0 + 0.65 : x1 - 0.65, outer = sg > 0 ? x1 : x0;
        st = { x0: r4(Math.min(inner, outer)), x1: r4(Math.max(inner, outer)), y0: r4(y0 - FK.stair.w), y1: r4(y0), dir: sg, top: w.zTop };
      }
      if (flatFits([...blocks, w], null, st, lot, pad, fp)) { blocks.push(w); stair = st; break; }
    }
  } else if (annex === 'court') {
    const c = { x0: main.x0, x1: main.x1, y0: r4(main.y0 - cd - CT.t), y1: main.y0, t: CT.t, h: snap(mix(CT.h, a[4])), gate: null };
    if (flatFits(blocks, c, null, lot, pad, fp)) court = c;
  }
  // centre the whole house (courtyard and stair included) on the lot
  const [x0, x1, y0, y1] = flatExtent(blocks, court, stair, pad, fp), dx = snap(-(x0 + x1) / 2), dy = snap(-(y0 + y1) / 2);
  for (const R of [...blocks, ...[court, stair].filter(q => q)]) { R.x0 = r4(R.x0 + dx); R.x1 = r4(R.x1 + dx); R.y0 = r4(R.y0 + dy); R.y1 = r4(R.y1 + dy); }
  // the crown on the main roof
  let dome = null;
  if (style.crown === 'loft') {
    const lw = snap(Math.max(2.2, (W - 2 * T) * (0.45 + 0.2 * a[6]))), ld = snap(Math.max(2.2, (D - 2 * T) * (0.45 + 0.2 * a[7])));
    const ly1 = main.y1 - T, lx0 = a[5] < 0.5 ? main.x0 + T : main.x1 - T - lw;
    blocks.push(flatBlock('loft', lx0, lx0 + lw, ly1 - ld, ly1, main.zTop, 1, walls === 'stone' ? 'stone' : 'adobe', main.zTop + snap(H * 0.92), snap(ph * 0.85)));
  } else if (style.crown === 'dome') {
    const R = r4(Math.min(Math.max(FK.dome.r[0], Math.min(W, D) * 0.3), FK.dome.r[1]));
    const cx = (main.x0 + main.x1) / 2 + (a[5] - 0.5) * Math.max(0, W / 2 - R - T - 0.3), cy = (main.y0 + main.y1) / 2 + Math.max(0, D / 2 - R - T - 0.3) * 0.5;
    dome = { x: r4(cx), y: r4(cy), r: R, z0: main.zTop, drum: FK.dome.drum, top: r4(main.zTop + FK.dome.drum + 1.03 * R) };
  }
  return { blocks, H, court, stair, dome };
}

function flatFacades(rules, F, style, dna, f, blocks, stair) {
  const K = rules.kit, FC = rules.facade, FK = rules.flat, bay = F.mass.bay * (1.15 - 0.3 * dna.ornament);
  const walls = [], dw = rules.parts[style.door].w, P = K.plinth;
  let doorSi = -1, width = 0;
  flatSpans(0, '-y', blocks, P + 0.5).forEach(([a, z, ca, cz], si) => {
    const usable = z - a - (ca ? 0.5 : 0.35) - (cz ? 0.5 : 0.35);
    if (usable >= dw + 0.3 && z - a > width) { doorSi = si; width = z - a; }
  });
  if (doorSi < 0) throw new Error('House: no front wall takes a door');
  const doorRoll = f();
  blocks.forEach((b, bi) => {
    const hb = (b.zTop - b.z0) / b.storeys;
    for (const face of FACES) {
      const kind = face === '-y' ? 'front' : face === '+y' ? 'back' : 'side';
      if (stair && b.id === 'wing' && face === '-y') continue;
      for (let s = 0; s < b.storeys; s++) {
        flatSpans(bi, face, blocks, b.z0 + (s + 0.5) * hb).forEach(([a, z, ca, cz], si) => {
          const us = bays(a, z, ca, cz, bay, K), n = us.length;
          const rolls = us.map(() => f());
          const isDoor = bi === 0 && face === '-y' && s === 0 && si === doorSi;
          const doorAt = isDoor ? (n % 2 ? (n - 1) / 2 : n / 2 - (doorRoll < 0.5 ? 1 : 0)) : b.id === 'loft' && face === '-y' && n ? Math.floor((n - 1) / 2) : -1;
          const middle = n % 2 && bi === 0 && face === '-y' ? (n - 1) / 2 : -1;
          const cells = us.map((u, i) => {
            if (i === doorAt) return cell(u, 'door', isDoor ? style.door : FK.roofDoor);
            const up = style.upper;
            if (i === middle && s >= 1 && s === b.storeys - 1 && (up === 'win.mashrabiya' || up === 'banner.tall')) return cell(u, up === 'win.mashrabiya' ? 'oriel' : 'banner', up);
            const balcony = i === middle && s === 1 && up === 'balcony.desert';
            if (!balcony && rolls[Math.min(i, n - 1 - i)] >= FC[kind]) return cell(u, 'blank');
            const sill = balcony ? 'balcony.desert' : style.flowers && s === 0 && kind !== 'back' ? style.flowers : null;
            return cell(u, 'window', style.window, style.shutters ?? null, sill);
          });
          for (let i = 1; i < n; i++) {
            const p = cells[i - 1], q = cells[i];
            if (p.kind === 'blank' || q.kind === 'blank' || q.u - p.u >= (rules.parts[p.part].w + rules.parts[q.part].w) / 2 + 0.08) continue;
            if (q.kind === 'window') cells[i] = cell(q.u, 'blank'); else if (p.kind === 'window') cells[i - 1] = cell(p.u, 'blank');
          }
          walls.push({ b: bi, face, a, z, ca, cz, s, cells });
        });
      }
    }
  });
  return walls;
}

function flatDetails(rules, style, dna, x, blocks, walls, court, dome) {
  const FK = rules.flat, main = blocks[0], T = FK.wall, r = [x(), x(), x(), x(), x(), x(), x(), x()];
  let chimney = null, topper = null, yard = null;
  const loft = blocks.find(b => b.id === 'loft');
  if (style.chimney === 'stack') {
    let side = r[0] < 0.5 ? -1 : 1;
    if (loft && (loft.x0 + loft.x1) / 2 * side > (main.x0 + main.x1) / 2 * side) side = -side;
    const cx = side < 0 ? main.x0 + T + 0.55 : main.x1 - T - 0.55;
    chimney = { kind: 'stack', x: r4(cx), y: r4(main.y1 - T - 0.55), z0: main.zTop, top: r4(main.roof.zr + 0.75 + 0.5 * dna.whimsy) };
  }
  if (style.topper) {
    if (dome) topper = { part: style.topper, x: dome.x, y: dome.y, z: r4(dome.top - 0.06), s: 1 };
    else if (style.crown === 'lookout') {
      const s = r4(Math.min(main.x1 - main.x0, main.y1 - main.y0) / 3.9);
      topper = { part: style.topper, x: r4((main.x0 + main.x1) / 2), y: r4((main.y0 + main.y1) / 2), z: main.zTop, s };
    }
  }
  const front = walls.find(w => w.b === 0 && w.face === '-y' && w.s === 0 && w.cells.some(c => c.kind === 'door'));
  const d = front.cells.find(c => c.kind === 'door').u;
  if (court) court.gate = { u: d, part: FK.court.gate };
  if (style.yard) {
    const u = Math.abs(front.a + 0.8 - d) > Math.abs(front.z - 0.8 - d) ? front.a + 0.8 : front.z - 0.8;
    yard = { part: style.yard, x: r4(u), y: r4(main.y0 - 0.8), nx: 0, ny: -1 };
  }
  return { chimney, topper, yard };
}

function generateFlat(rules, F, family, k, L, dna, palette, style) {
  const FK = rules.flat;
  const { blocks, H, court, stair, dome } = flatMassing(rules, F, style, dna, houseRng(family, k, 'mass'), L);
  const walls = flatFacades(rules, F, style, dna, houseRng(family, k, 'facade'), blocks, stair);
  const { chimney, topper, yard } = flatDetails(rules, style, dna, houseRng(family, k, 'detail'), blocks, walls, court, dome);
  const ground = blocks.filter(b => b.z0 < 1.0);
  const top = Math.max(...blocks.map(b => b.roof.zr), dome ? dome.top : 0, chimney ? chimney.top : 0);
  const colliders = ground.map((b, i) => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, h: r4(i === 0 ? top : b.roof.zr) }));
  if (stair) colliders.push({ x0: stair.x0, x1: stair.x1, y0: stair.y0, y1: stair.y1, h: stair.top });
  if (court) {
    const t = court.t, g = court.gate, half = FK.court.gw / 2 + 0.46;
    colliders.push({ x0: court.x0, x1: r4(court.x0 + t), y0: court.y0, y1: court.y1, h: court.h });
    colliders.push({ x0: r4(court.x1 - t), x1: court.x1, y0: court.y0, y1: court.y1, h: court.h });
    for (const [a0, a1] of [[court.x0 + t, g.u - half], [g.u + half, court.x1 - t]]) if (a1 - a0 > 0.2) colliders.push({ x0: r4(a0), x1: r4(a1), y0: court.y0, y1: r4(court.y0 + t), h: court.h });
  }
  const [x0, x1, y0, y1] = flatExtent(blocks, court, stair, FK.pad, flatFront(rules, style));
  return { version: HOUSE_GRAMMAR_VERSION, form: 'flat', family, key: k, lot: L, dna, palette, colors: rules.colors, style, storey: H, tile: 1, blocks, walls, rings: [], attics: [],
    chimney, dormers: [], topper, yard, court, stair, dome, colliders, bounds: [r4(x0), r4(x1), r4(y0), r4(y1), r4(top)] };
}

/** A rounded rectangle as a convex polygon (3 points per corner, from DIRS64), relative to (cx, cy). */
function roundRect(x0, x1, y0, y1, rc, cx, cy) {
  const pts = [];
  for (const [sx, sy, k0] of FLAT_CORNERS) {
    const ox = (sx > 0 ? x1 - rc : x0 + rc) - cx, oy = (sy > 0 ? y1 - rc : y0 + rc) - cy;
    for (let q = 0; q < 3; q++) { const d = DIRS64[(k0 + q * 8) % 64]; pts.push([ox + d[0] * rc, oy + d[1] * rc]); }
  }
  return pts;
}

function buildFlat(rules, plan) {
  const K = rules.kit, FK = rules.flat, P = K.plinth, blocks = plan.blocks, st = plan.style, rc = FK.round, T = FK.wall;
  const pieces = [], parts = [];
  const prism = (s, o, org, u, v, w, poly, w0, w1, bev, g, round = false) => {
    pieces.push({ k: 'prism', s, o, f: [...org, ...u, ...v, ...w].map(r4), p: poly.map(q => [r4(q[0]), r4(q[1])]), w: [r4(w0), r4(w1)], b: bev, g: [r4(g[0]), r4(g[1])], r: round ? 1 : 0 });
  };
  const rect = (a, b) => [[-a / 2, -b / 2], [a / 2, -b / 2], [a / 2, b / 2], [-a / 2, b / 2]];
  const box = (s, o, c, size, bev, g) => prism(s, o, c, [1, 0, 0], [0, 1, 0], Z, rect(size[0], size[1]), -size[2] / 2, size[2] / 2, bev, g);
  const lathe = (s, o, c, prof, n, g) => pieces.push({ k: 'lathe', s, o, c: [r4(c[0]), r4(c[1]), 0], p: prof.map(q => [r4(q[0]), r4(q[1])]), n, g: [r4(g[0]), r4(g[1])] });
  const place = (id, x, y, z, nx, ny, s = 1) => { parts.push({ id, m: [x, y, z, -ny * s, nx * s, 0, -nx * s, -ny * s, 0, 0, 0, s].map(r4) }); return parts.length - 1; };
  const hang = (id, on, socket, pair) => { parts.push({ id, on, socket, pair }); };
  const slotOf = (b, s) => (b.walls === 'mixed' ? (s === 0 ? 'Masonry' : 'Wall') : b.walls === 'stone' ? 'Masonry' : 'Wall');
  const column = (s, x, y, z0, z1, r, g) => prism(s, 0.03, [x, y, 0], [1, 0, 0], [0, 1, 0], Z, Array.from({ length: 8 }, (_, k) => [DIRS64[k * 8][0] * r, DIRS64[k * 8][1] * r]), z0, z1, 0.05, g, true);

  blocks.forEach((b, bi) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, ground = b.z0 < 1.0;
    const hb = (b.zTop - b.z0) / b.storeys, ph = b.roof.parapet, zt = b.zTop;
    // the plinth band under a ground block, then one rounded wall prism per run of storeys with the same colour slot
    if (ground) prism('Stone', 0.04, [cx, cy, 0], [1, 0, 0], [0, 1, 0], Z, roundRect(b.x0 - 0.07, b.x1 + 0.07, b.y0 - 0.07, b.y1 + 0.07, rc + 0.07, cx, cy), -0.05, P + 0.02, 0.06, [0, P]);
    let s0 = 0;
    for (let s = 1; s <= b.storeys; s++) {
      if (s < b.storeys && slotOf(b, s) === slotOf(b, s0)) continue;
      const z0 = b.z0 + s0 * hb - (ground ? 0 : 0.02), z1 = s === b.storeys ? zt + 0.02 : b.z0 + s * hb;
      prism(slotOf(b, s0), 0.025, [cx, cy, 0], [1, 0, 0], [0, 1, 0], Z, roundRect(b.x0, b.x1, b.y0, b.y1, rc, cx, cy), z0, z1, 0.05, [z0, z1]);
      s0 = s;
    }
    // the parapet: straight runs on the exposed stretches, a round column at every exposed corner
    const top = slotOf(b, b.storeys - 1), zp = zt + ph / 2, kind = st.parapet || 'plain';
    for (const face of FACES) {
      const [nx, ny] = NORMALS[face], alongX = face === '-y' || face === '+y';
      for (const [a, z, ca, cz] of flatSpans(bi, face, blocks, zp)) {
        let a0 = a + (ca ? rc : 0), a1 = z - (cz ? rc : 0);
        if (plan.stair && b.id === 'wing' && face === '-y') {
          // the parapet opens where the stair arrives on the terrace
          const S = plan.stair;
          if (S.dir > 0) a0 = Math.max(a0, S.x0 + 0.9); else a1 = Math.min(a1, S.x1 - 0.9);
        }
        if (a1 - a0 < 0.25) continue;
        const [px, py] = facePoint(b, face, (a0 + a1) / 2), ox = px - nx * T / 2, oy = py - ny * T / 2;
        if (kind === 'crenel') {
          const lo = ph * 0.55;
          box(top, 0.03, [ox, oy, zt + lo / 2], alongX ? [a1 - a0, T, lo] : [T, a1 - a0, lo], 0.06, [zt, zt + ph]);
          const cnt = Math.max(1, Math.floor((a1 - a0) / 0.95));
          for (let q = 0; q < cnt; q++) {
            const u = a0 + (q + 0.5) * (a1 - a0) / cnt, [qx, qy] = facePoint(b, face, u);
            box(top, 0.03, [qx - nx * T / 2, qy - ny * T / 2, zt + (ph + 0.2) / 2], alongX ? [0.55, T + 0.02, ph + 0.2] : [T + 0.02, 0.55, ph + 0.2], 0.07, [zt, zt + ph + 0.2]);
          }
        } else {
          box(top, 0.03, [ox, oy, zt + ph / 2], alongX ? [a1 - a0, T, ph] : [T, a1 - a0, ph], 0.09, [zt, zt + ph]);
          if (kind === 'stepped' && face === '-y' && a1 - a0 > 2.2) { const sw = snap((a1 - a0) / 3); box(top, 0.03, [ox, oy, zt + (ph + 0.32) / 2], [sw, T + 0.02, ph + 0.32], 0.09, [zt, zt + ph + 0.32]); }
        }
        if (b.walls !== 'stone' && face !== '+y') {
          // beam ends under the parapet, evenly along the run
          const cnt = Math.floor((a1 - a0) / FK.viga);
          for (let q = 0; q < cnt; q++) {
            const u = a0 + (q + 0.5) * (a1 - a0) / cnt, [qx, qy] = facePoint(b, face, u);
            box('Timber', 0.03, [qx + nx * 0.14, qy + ny * 0.14, zt - 0.16], alongX ? [0.17, 0.34, 0.17] : [0.34, 0.17, 0.17], 0.04, [zt - 0.3, zt]);
          }
        }
        if (top === 'Masonry') box('Stone', 0.03, [ox, oy, zt + ph + 0.05], alongX ? [a1 - a0 + 0.04, T + 0.08, 0.1] : [T + 0.08, a1 - a0 + 0.04, 0.1], 0.04, [zt + ph, zt + ph + 0.1]);
      }
    }
    for (const [sx, sy] of FLAT_CORNERS) {
      const x = sx > 0 ? b.x1 : b.x0, y = sy > 0 ? b.y1 : b.y0;
      if (insideZ(x - sx * 0.05, y - sy * 0.05, zp, blocks, bi)) continue;
      const lift = kind === 'stepped' ? 0.3 : kind === 'crenel' ? 0.2 : 0.0;
      column(top, x - sx * rc, y - sy * rc, zt, zt + ph + lift, rc, [zt, zt + ph + lift]);
    }
  });
  // openings
  for (const w of plan.walls) {
    const b = blocks[w.b], [nx, ny] = NORMALS[w.face], alongX = w.face === '-y' || w.face === '+y';
    const hb = (b.zTop - b.z0) / b.storeys, z0 = b.z0 + w.s * hb;
    for (const c of w.cells) {
      if (c.kind === 'blank') continue;
      const [px, py] = facePoint(b, w.face, c.u), dims = rules.parts[c.part];
      const z = c.kind === 'door' ? z0 - 0.02 : c.kind === 'oriel' || c.kind === 'banner' ? z0 + 0.25 : z0 + K.sill;
      const idx = place(c.part, px, py, z, nx, ny);
      if (c.kind === 'door' && z0 < 1.0) {
        if (st.lantern) hang(st.lantern, idx, 'lamp', false);
        if (st.canopy) hang(st.canopy, idx, 'canopy', false);
        if (st.sign) hang(st.sign, idx, 'sign', false);
        box('Stone', 0.04, [px + nx * 0.5, py + ny * 0.5, 0.13], alongX ? [dims.w + 0.14, 0.62, 0.26] : [0.62, dims.w + 0.14, 0.26], 0.06, [0, 0.26]);
      }
      if (c.shutter) hang(c.shutter, idx, 'shutter', true);
      if (c.sill) hang(c.sill, idx, 'sill', false);
    }
  }
  // the walled courtyard: side walls, the front wall either side of the gateway, stone caps, a paved yard
  const C = plan.court;
  if (C) {
    const t = C.t, ch = C.h, g = C.gate, half = FK.court.gw / 2 + 0.46, wslot = slotOf(blocks[0], 0);
    const runs = [[C.x0 + t / 2, C.y0, C.x0 + t / 2, C.y1], [C.x1 - t / 2, C.y0, C.x1 - t / 2, C.y1],
      [C.x0, C.y0 + t / 2, g.u - half + 0.1, C.y0 + t / 2], [g.u + half - 0.1, C.y0 + t / 2, C.x1, C.y0 + t / 2]];
    for (const [ax, ay, bx, by] of runs) {
      const ln = Math.abs(bx - ax) + Math.abs(by - ay);
      if (ln < 0.3) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, along = Math.abs(bx - ax) > Math.abs(by - ay);
      box(wslot, 0.03, [mx, my, ch / 2], along ? [ln, t, ch] : [t, ln, ch], 0.1, [0, ch]);
      box('Stone', 0.03, [mx, my, ch + 0.06], along ? [ln + 0.08, t + 0.1, 0.12] : [t + 0.1, ln + 0.08, 0.12], 0.04, [ch, ch + 0.12]);
    }
    box('Stone', 0.0, [(C.x0 + C.x1) / 2, (C.y0 + t + C.y1) / 2, 0.02], [C.x1 - C.x0 - 2 * t, C.y1 - C.y0 - t, 0.05], 0.02, [0, 0.05]);
    place(g.part, g.u, C.y0 + t / 2, 0, 0, -1);
  }
  // the outside stair up to the wing's roof terrace: one solid cheek under the flight, a tread per step on it, and a
  // low rail along the open side
  const S = plan.stair;
  if (S) {
    const n = Math.max(3, Math.ceil(S.top / FK.stair.rise)), L = S.x1 - S.x0, tr = L / n, rs = S.top / n, wslot = slotOf(blocks[1], 0);
    const [lo, hi] = S.dir > 0 ? [S.x1, S.x0] : [S.x0, S.x1], ymid = (S.y0 + S.y1) / 2, wd = S.y1 - S.y0;
    prism(wslot, 0.03, [0, ymid, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [[lo, 0.0], [hi, 0.0], [hi, S.top - rs]], -wd / 2, wd / 2, 0.04, [0, S.top]);
    for (let i = 0; i < n; i++) {
      const xc = lo + (hi - lo) * (i + 0.5) / n, z0 = Math.max(0.0, (i - 1) * rs), z1 = (i + 1) * rs;
      box('Stone', 0.03, [xc, ymid, (z0 + z1) / 2], [tr + 0.01, wd, z1 - z0], 0.03, [0, S.top]);
    }
    prism(wslot, 0.03, [0, S.y0 + 0.1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [[lo, rs], [lo, rs + 0.5], [hi, S.top + 0.5], [hi, S.top]], -0.1, 0.1, 0.05, [0, S.top + 0.5]);
  }
  // the dome: a drum, then the dome itself, its finial the topper
  const D = plan.dome;
  if (D) {
    const R = D.r, zb = D.z0 + D.drum;
    lathe(slotOf(blocks[0], blocks[0].storeys - 1), 0.03, [D.x, D.y], [[0, D.z0 - 0.05], [R + 0.12, D.z0 - 0.05], [R + 0.12, zb], [0, zb]], 16, [D.z0, zb]);
    lathe('Roof', 0.04, [D.x, D.y], [[0, zb - 0.02], [R * 1.02, zb - 0.02], [R * 1.02, zb + 0.08], [R * 0.97, zb + 0.36 * R], [R * 0.86, zb + 0.62 * R],
      [R * 0.66, zb + 0.84 * R], [R * 0.38, zb + 0.98 * R], [0, zb + 1.03 * R]], 16, [zb, zb + 1.03 * R]);
  }
  // the chimney stack, vents near its top
  const ch = plan.chimney;
  if (ch) {
    box('Wall', 0.03, [ch.x, ch.y, (ch.z0 + ch.top) / 2], [0.9, 0.9, ch.top - ch.z0], 0.07, [ch.z0, ch.top]);
    box('Stone', 0.03, [ch.x, ch.y, ch.top + 0.07], [1.1, 1.1, 0.14], 0.04, [ch.top, ch.top + 0.14]);
    for (const q of [-1, 1]) box('StoneDark', 0.0, [ch.x, ch.y + q * 0.45, ch.top - 0.3], [0.44, 0.04, 0.22], 0.0, [ch.top - 0.4, ch.top]);
  }
  const tp = plan.topper;
  if (tp) place(tp.part, tp.x, tp.y, tp.z, 0, -1, tp.s);
  if (plan.yard) place(plan.yard.part, plan.yard.x, plan.yard.y, 0, plan.yard.nx, plan.yard.ny);
  return { pieces, parts };
}

/** A short fingerprint of an expansion: every number at 1e-4, hashed. The fixtures compare it with the Python port's. */
export function houseDigest(built) {
  const num = v => String(Math.floor(v * 10000 + 0.5));
  const flat = a => a.map(v => (Array.isArray(v) ? flat(v) : typeof v === 'number' ? num(v) : String(v))).join(',');
  const rows = built.pieces.map(p => (p.k === 'prism' ? [p.k, p.s, p.o, p.f, p.p, p.w, p.b, p.g, p.r] : [p.k, p.s, p.o, p.c, p.p, p.n, p.g]).map(v => (Array.isArray(v) ? flat(v) : typeof v === 'number' ? num(v) : v)).join('|'));
  for (const p of built.parts) rows.push(p.m ? `${p.id}|${flat(p.m)}` : `${p.id}|${p.on}|${p.socket}|${p.pair ? 1 : 0}`);
  return { pieces: built.pieces.length, parts: built.parts.length, hash: hashSeed(rows.join('\n')) };
}

/**
 * Structural checks on a pack's house rules, with messages that name the broken rule. When `parts` (the library
 * index: id -> {sockets}) is given, every part named by the rules or placed by the grammar must exist too.
 */
export function validateHouseRules(rules, parts = null) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['houses: missing'];
  for (const k of ['plinth', 'storey', 'plate', 'slab', 'eave', 'over', 'row', 'bay', 'sill']) if (typeof rules.kit?.[k] !== 'number') errors.push(`houses.kit.${k}: missing`);
  if (!(rules.kit?.tile?.length === 3)) errors.push('houses.kit.tile: needs [length, width, thickness]');
  if (!(rules.lot?.w > 0 && rules.lot?.d > 0)) errors.push('houses.lot: needs w and d');
  for (const k of ['front', 'side', 'back', 'attic']) if (typeof rules.facade?.[k] !== 'number') errors.push(`houses.facade.${k}: missing`);
  for (const [f, w] of Object.entries(rules.mix ?? {})) {
    if (!rules.families?.[f]) errors.push(`houses.mix: unknown family "${f}"`);
    if (!(w >= 0)) errors.push(`houses.mix.${f}: needs a weight of 0 or more`);
  }
  const known = id => !!rules.parts?.[id] && (!parts || !!parts[id]);
  const families = Object.values(rules.families ?? {});
  // The pitched grammar's own parts are needed only where a pitched family can reach them.
  // Ridge caps follow the coverings the families can reach (tiles when a family names none); a belfry hangs a bell.
  const reach = slot => new Set(families.filter(F => F.form !== 'flat').flatMap(F => F.plan?.find(s => s.slot === slot)?.options?.map(o => o.id) ?? (slot === 'covering' ? ['tiles'] : [])));
  const ridges = { tiles: 'roof.ridge', thatch: 'roof.ridge.thatch', snow: 'roof.ridge.snow' }, covers = reach('covering');
  const builtIn = [...Object.keys(ridges).filter(c => covers.has(c)).map(c => ridges[c]), ...(reach('walls').has('belfry') ? ['bell.hang'] : [])];
  if (families.some(F => F.form !== 'flat')) for (const id of [...builtIn, 'roof.spire', 'chimney.pot', 'win.slim', 'win.oriel', 'balcony']) if (!known(id)) errors.push(`houses: built-in part "${id}" is not in houses.parts and the library`);
  if (families.some(F => F.form === 'flat')) {
    const FK = rules.flat;
    if (!FK) errors.push('houses.flat: flat-roofed families need the flat kit');
    else {
      for (const k of ['pad', 'round', 'wall', 'viga']) if (typeof FK[k] !== 'number') errors.push(`houses.flat.${k}: missing`);
      if (!(FK.parapet?.length === 2)) errors.push('houses.flat.parapet: needs [min, max]');
      if (!(FK.court?.depth?.length === 2 && FK.court.h?.length === 2 && FK.court.t > 0 && FK.court.gw > 0)) errors.push('houses.flat.court: needs depth, h, t and gw');
      if (!(FK.stair?.w > 0 && FK.stair.rise > 0)) errors.push('houses.flat.stair: needs w and rise');
      if (!(FK.dome?.r?.length === 2 && FK.dome.drum >= 0)) errors.push('houses.flat.dome: needs r and drum');
      for (const id of [FK.roofDoor, FK.court?.gate]) if (!known(id)) errors.push(`houses.flat: part "${id}" is not in houses.parts and the library`);
      if (!(rules.parts?.[FK.roofDoor]?.w > 0 && rules.parts[FK.roofDoor].h > 0)) errors.push(`houses.flat.roofDoor: "${FK.roofDoor}" needs w and h in houses.parts`);
    }
  }
  for (const [id, F] of Object.entries(rules.families ?? {})) {
    const where = `houses.families.${id}`;
    if (!F.palettes?.length) errors.push(`${where}: needs at least one palette`);
    for (const k of ['span', 'length', 'storeys', 'pitch']) if (!(F.mass?.[k]?.length === 2)) errors.push(`${where}.mass.${k}: needs [min, max]`);
    if (!(F.mass?.bay > 0)) errors.push(`${where}.mass.bay: missing`);
    const plan = F.plan ?? [], ids = slot => (plan.find(s => s.slot === slot)?.options ?? []).map(o => o.id);
    for (const req of ['door', 'window']) if (!plan.some(s => s.slot === req && s.chance === undefined)) errors.push(`${where}: the "${req}" slot is required`);
    // Every part that hangs on a socket needs that socket on every host it can land on.
    const hosts = { lamp: ids('door'), canopy: ids('door'), sign: ids('door'), shutter: ids('window'), sill: [...ids('window'), 'win.slim'] };
    for (const step of plan) {
      const at = `${where}.${step.slot}`;
      if (!step.options?.length) errors.push(`${at}: no options`);
      for (const o of step.options ?? []) {
        if (!((o.w ?? 1) >= 0)) errors.push(`${at}: negative weight`);
        if (HOUSE_CHOICES[step.slot]) { if (!HOUSE_CHOICES[step.slot].includes(o.id)) errors.push(`${at}: unknown choice "${o.id}"`); continue; }
        if (!(step.slot in HOUSE_PART_SLOTS)) { errors.push(`${at}: unknown slot`); continue; }
        if (!known(o.id)) errors.push(`${at}: part "${o.id}" is not in houses.parts and the library`);
        if (['door', 'window', 'attic', 'upper'].includes(step.slot) && !(rules.parts?.[o.id]?.w > 0 && rules.parts?.[o.id]?.h > 0)) errors.push(`${at}: part "${o.id}" needs w and h in houses.parts`);
        const socket = HOUSE_PART_SLOTS[step.slot];
        if (socket && parts) for (const host of hosts[socket]) if (parts[host] && !parts[host].sockets.includes(socket)) errors.push(`${at}: "${host}" has no "${socket}" socket for "${o.id}"`);
      }
    }
  }
  return errors;
}
