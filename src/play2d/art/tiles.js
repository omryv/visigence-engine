/**
 * Terrain and decor, drawn in the Arcade toon style with autotiling: each cell reads its
 * neighbours (`info.at(dx, dy)`) and draws the edges, caps, lips, corners and shorelines that
 * make a painted grid look built rather than stamped. Side view (platformer) draws blocks with
 * grass caps; top view draws a 3/4 world where walls show a front face and water has banks.
 *
 * Every function draws one cell in tile units with its origin at the cell's top-left (the
 * caller has already called draw.unit). The facade in index.js caches the results.
 */
import { BIOME_PALETTES, INK, mix } from './palette.js';
import { rr, ell, fs, lit, shadow, sparkle, glow, TAU } from './draw.js';
import { cellHash } from '../core/grid.js';

// Codes (catalog.js): side 1 ground, 2 brick, 3 plank, 4 iceblock, 5 crumble, 6 thorns, 7 ladder,
// 8 water, 9 blockA, 10 blockB; top 20 wall, 21 path, 22 pond, 23 bridge, 24 bush, 25 icefloor,
// 26 pit, 27 pad, 28 gate, 29 tallgrass.
export const SIDE_SOLID = new Set([1, 2, 4, 5]);
const WALLISH = new Set([20]);
const WATERISH = new Set([22, 23]);
const PATHISH = new Set([21, 23, 27]);

export const pal = biome => BIOME_PALETTES[biome] || BIOME_PALETTES.meadow;

/** 4-bit exposure mask: bit set where the neighbour does NOT satisfy `same`. */
export function openMask(at, same) {
  let m = 0;
  if (!same(at(0, -1))) m |= 1;
  if (!same(at(1, 0))) m |= 2;
  if (!same(at(0, 1))) m |= 4;
  if (!same(at(-1, 0))) m |= 8;
  return m;
}

/** What a tile's appearance depends on, as a cache key fragment. */
export function tileVariantKey(code, info) {
  const at = info.at;
  const v = Math.floor(cellHash(info.x | 0, info.y | 0, code) * 4);
  switch (code) {
    case 1: case 2: case 4: return openMask(at, c => SIDE_SOLID.has(c)) + ':' + v;
    case 3: return openMask(at, c => c === 3) + ':' + v;
    case 5: return v;
    case 6: return thornDir(at);
    case 7: return openMask(at, c => c === 7);
    case 8: return (at(0, -1) !== 8 ? 1 : 0) + (at(0, 1) !== 8 ? 2 : 0);
    case 9: case 10: return (info.toggle ? 1 : 0) + ':' + openMask(at, c => c === code);
    case 0: return v;
    case 20: return openMask(at, c => WALLISH.has(c)) + ':' + v + ':' + (cornerMask(at, c => WALLISH.has(c)));
    case 21: return openMask(at, c => PATHISH.has(c)) + ':' + v;
    case 22: return openMask(at, c => WATERISH.has(c)) + ':' + v;
    case 23: return (WATERISH.has(at(-1, 0)) || WATERISH.has(at(1, 0)) || !WATERISH.has(at(0, -1)) ? 'h' : 'v') + openMask(at, c => WATERISH.has(c));
    case 24: return v;
    case 25: return openMask(at, c => c === 25) + ':' + v;
    case 26: return openMask(at, c => c === 26);
    case 27: return v;
    case 28: return openMask(at, c => c === 28 || c === 20);
    case 29: return v;
    default: return v;
  }
}
function cornerMask(at, same) {
  let m = 0;
  if (!same(at(1, -1))) m |= 1;
  if (!same(at(1, 1))) m |= 2;
  if (!same(at(-1, 1))) m |= 4;
  if (!same(at(-1, -1))) m |= 8;
  return m;
}
function thornDir(at) {
  if (SIDE_SOLID.has(at(0, 1))) return 'up';
  if (SIDE_SOLID.has(at(0, -1))) return 'down';
  if (SIDE_SOLID.has(at(-1, 0))) return 'right';
  if (SIDE_SOLID.has(at(1, 0))) return 'left';
  return 'up';
}

/** Tiles whose look changes every frame (drawn live on top of a cached base). */
export const ANIMATED = new Set([8, 22, 5]);

/** Draw a static tile cell (the cacheable part). */
export function drawTile(ctx, code, info) {
  const P = pal(info.biome);
  const fn = TILE[code];
  if (fn) fn(ctx, P, info);
}

/** Draw the moving part of an animated tile (water surfaces, crumble shake). */
export function drawTileLive(ctx, code, info) {
  const P = pal(info.biome);
  const t = info.t || 0;
  if (code === 8) {
    if (info.at(0, -1) !== 8) {
      const k = t * 1.4 + (info.x || 0) * 0.9;
      ctx.save();
      ctx.strokeStyle = P.water.foam;
      ctx.lineWidth = Math.max(ctx.lineWidth, 0.06);
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) { const x = i / 8; const y = 0.12 + Math.sin(k * TAU + x * TAU) * 0.035; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
      ctx.restore();
    }
    const s = (t * 0.35 + cellHash(info.x, info.y, 8)) % 1;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(0.2 + s * 0.4, 0.45 + s * 0.3, 0.18, 0.03);
  } else if (code === 22) {
    const s = (t * 0.25 + cellHash(info.x, info.y, 22)) % 1;
    ctx.save();
    ctx.globalAlpha = Math.sin(s * Math.PI) * 0.8;
    ctx.fillStyle = P.water.light;
    ctx.fillRect(0.18 + s * 0.3, 0.3 + cellHash(info.x, info.y, 5) * 0.4, 0.22, 0.035);
    ctx.fillRect(0.5 - s * 0.2, 0.62, 0.14, 0.03);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Side view

/** The block silhouette, rounding outer corners where two open sides meet. */
function blockPath(ctx, open, r = 0.2) {
  const n = open & 1, e = open & 2, s = open & 4, w = open & 8;
  const tl = n && w ? r : 0, tr = n && e ? r : 0, br = s && e ? r : 0, bl = s && w ? r : 0;
  ctx.beginPath();
  ctx.moveTo(tl, 0);
  ctx.lineTo(1 - tr, 0);
  if (tr) ctx.arcTo(1, 0, 1, tr, tr);
  ctx.lineTo(1, 1 - br);
  if (br) ctx.arcTo(1, 1, 1 - br, 1, br);
  ctx.lineTo(bl, 1);
  if (bl) ctx.arcTo(0, 1, 0, 1 - bl, bl);
  ctx.lineTo(0, tl);
  if (tl) ctx.arcTo(0, 0, tl, 0, tl);
  ctx.closePath();
}
/** Ink along exposed edges only, so a run of blocks reads as one mass. */
function edgeInk(ctx, open, r = 0.2) {
  const n = open & 1, e = open & 2, s = open & 4, w = open & 8;
  ctx.beginPath();
  if (n) { ctx.moveTo(w ? r : 0, 0); ctx.lineTo(e ? 1 - r : 1, 0); }
  if (e) { ctx.moveTo(1, n ? r : 0); ctx.lineTo(1, s ? 1 - r : 1); }
  if (s) { ctx.moveTo(e ? 1 - r : 1, 1); ctx.lineTo(w ? r : 0, 1); }
  if (w) { ctx.moveTo(0, s ? 1 - r : 1); ctx.lineTo(0, n ? r : 0); }
  if (n && w) { ctx.moveTo(0, r); ctx.arcTo(0, 0, r, 0, r); }
  if (n && e) { ctx.moveTo(1 - r, 0); ctx.arcTo(1, 0, 1, r, r); }
  if (s && e) { ctx.moveTo(1, 1 - r); ctx.arcTo(1, 1, 1 - r, 1, r); }
  if (s && w) { ctx.moveTo(r, 1); ctx.arcTo(0, 1, 0, 1 - r, r); }
  ctx.stroke();
}

function ground(ctx, P, info) {
  const open = openMask(info.at, c => SIDE_SOLID.has(c));
  const x = info.x | 0, y = info.y | 0;
  ctx.save();
  blockPath(ctx, open);
  ctx.clip();
  ctx.fillStyle = P.soil.base;
  ctx.fillRect(0, 0, 1, 1);
  // strata: a gentle band that lines up across neighbours
  ctx.fillStyle = mix(P.soil.base, P.soil.dark, 0.18);
  const band = 0.55 + Math.sin(x * 0.9) * 0.06;
  ctx.beginPath(); ctx.moveTo(0, band); ctx.bezierCurveTo(0.35, band - 0.05, 0.65, band + 0.05, 1, band + Math.sin((x + 1) * 0.9) * 0.06 - Math.sin(x * 0.9) * 0.06); ctx.lineTo(1, band + 0.14); ctx.lineTo(0, band + 0.14); ctx.closePath(); ctx.fill();
  // specks and pebbles
  for (let i = 0; i < 3; i++) {
    const hx = cellHash(x, y, 10 + i), hy = cellHash(x, y, 20 + i);
    ctx.fillStyle = i === 0 ? P.soil.light : P.soil.speck;
    ell(ctx, 0.12 + hx * 0.76, 0.3 + hy * 0.6, 0.05 + (i === 0 ? 0.02 : 0), 0.035); ctx.fill();
  }
  // light from the upper left, shade on the lower right
  if (open & 8) { ctx.fillStyle = P.soil.light; ctx.fillRect(0, 0, 0.07, 1); }
  if (open & 2) { ctx.fillStyle = P.soil.dark; ctx.fillRect(0.9, 0, 0.1, 1); }
  if (open & 4) { ctx.fillStyle = P.soil.dark; ctx.fillRect(0, 0.88, 1, 0.12); }
  ctx.restore();
  edgeInk(ctx, open);
  if (open & 1) grassCap(ctx, P, open, x, y);
}

function grassCap(ctx, P, open, x, y) {
  const G = P.grass;
  const l = open & 8 ? -0.05 : 0, r = open & 2 ? 1.05 : 1;
  const depth = 0.26;
  const drips = 4;
  const dripAt = i => depth + (i % 2 ? 0.05 : -0.02) + cellHash(x * 5 + i, y, 3) * 0.05;
  const cap = () => {
    ctx.beginPath();
    ctx.moveTo(l, 0.02);
    ctx.lineTo(r, 0.02);
    ctx.lineTo(r, dripAt(drips));
    for (let i = drips - 1; i >= 0; i--) {
      const px = l + (r - l) * (i / drips);
      ctx.quadraticCurveTo(px + (r - l) / drips * 0.5, dripAt(i + 1) + 0.05, px, dripAt(i));
    }
    ctx.closePath();
  };
  cap();
  ctx.fillStyle = G.base;
  ctx.fill();
  // ink: the top line, the drip line, and the ends only where the cap is exposed
  ctx.beginPath();
  ctx.moveTo(l, 0.02); ctx.lineTo(r, 0.02);
  ctx.moveTo(r, dripAt(drips));
  for (let i = drips - 1; i >= 0; i--) {
    const px = l + (r - l) * (i / drips);
    ctx.quadraticCurveTo(px + (r - l) / drips * 0.5, dripAt(i + 1) + 0.05, px, dripAt(i));
  }
  if (open & 8) { ctx.moveTo(l, 0.02); ctx.lineTo(l, dripAt(0)); }
  if (open & 2) { ctx.moveTo(r, 0.02); ctx.lineTo(r, dripAt(drips)); }
  ctx.stroke();
  ctx.fillStyle = G.dark;
  ctx.fillRect(Math.max(0, l), 0.16, Math.min(1, r) - Math.max(0, l), 0.05);
  ctx.fillStyle = G.light;
  rr(ctx, Math.max(0.02, l + 0.06), 0.045, Math.min(0.98, r - 0.06) - Math.max(0.02, l + 0.06), 0.05, 0.025);
  ctx.fill();
  // blades poking above the edge
  for (let i = 0; i < 3; i++) {
    const bx = 0.15 + cellHash(x, y, 40 + i) * 0.7, bh = 0.07 + cellHash(x, y, 50 + i) * 0.07;
    ctx.beginPath(); ctx.moveTo(bx - 0.04, 0.03); ctx.lineTo(bx + 0.01, -bh); ctx.lineTo(bx + 0.05, 0.03);
    ctx.fillStyle = G.base; ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = G.base;
  ctx.fillRect(Math.max(0, l) + 0.01, 0.028, Math.min(1, r) - Math.max(0, l) - 0.02, 0.03);
}

function brick(ctx, P, info) {
  const open = openMask(info.at, c => SIDE_SOLID.has(c));
  const S = P.stone;
  ctx.save();
  blockPath(ctx, open, 0.12);
  ctx.clip();
  ctx.fillStyle = S.base; ctx.fillRect(0, 0, 1, 1);
  const off = (info.y | 0) % 2 ? 0.5 : 0;
  ctx.fillStyle = S.dark;
  ctx.fillRect(0, 0.48, 1, 0.05);
  for (const [row, dx] of [[0, off], [0.5, 0.5 - off]]) {
    ctx.fillRect(((dx + 0.5) % 1) - 0.025, row, 0.05, 0.5);
    ctx.fillStyle = S.light; ctx.fillRect(0, row + 0.03, 1, 0.05); ctx.fillStyle = S.dark;
  }
  if (open & 2) { ctx.fillStyle = S.dark; ctx.fillRect(0.9, 0, 0.1, 1); }
  if (open & 4) { ctx.fillStyle = S.dark; ctx.fillRect(0, 0.9, 1, 0.1); }
  const h = cellHash(info.x, info.y, 7);
  if (h > 0.6) { ctx.strokeStyle = S.dark; ctx.beginPath(); ctx.moveTo(0.2 + h * 0.3, 0.1); ctx.lineTo(0.3 + h * 0.2, 0.3); ctx.stroke(); ctx.strokeStyle = INK; }
  ctx.restore();
  edgeInk(ctx, open, 0.12);
  if ((open & 1) && info.biome === 'snow') snowCap(ctx, open);
}
function snowCap(ctx, open) {
  const l = open & 8 ? -0.04 : 0, r = open & 2 ? 1.04 : 1;
  ctx.beginPath(); ctx.moveTo(l, 0.08); ctx.quadraticCurveTo(l, -0.06, 0.3, -0.05); ctx.lineTo(r - 0.2, -0.05); ctx.quadraticCurveTo(r, -0.06, r, 0.1); ctx.quadraticCurveTo(0.6, 0.2, 0.4, 0.12); ctx.quadraticCurveTo(0.2, 0.2, l, 0.08); ctx.closePath();
  fs(ctx, '#ffffff');
}

function plank(ctx, P, info) {
  const open = openMask(info.at, c => c === 3);
  const W = P.wood;
  const l = open & 8 ? 0.04 : 0, r = open & 2 ? 0.96 : 1;
  // support brackets at open ends
  ctx.fillStyle = W.dark;
  if (open & 8) { ctx.beginPath(); ctx.moveTo(0.12, 0.3); ctx.lineTo(0.28, 0.3); ctx.lineTo(0.14, 0.52); ctx.closePath(); fs(ctx, W.dark); }
  if (open & 2) { ctx.beginPath(); ctx.moveTo(0.88, 0.3); ctx.lineTo(0.72, 0.3); ctx.lineTo(0.86, 0.52); ctx.closePath(); fs(ctx, W.dark); }
  ctx.fillStyle = W.base;
  ctx.fillRect(l, 0.02, r - l, 0.3);
  ctx.fillStyle = W.light; ctx.fillRect(l, 0.03, r - l, 0.06);
  ctx.fillStyle = W.dark; ctx.fillRect(l, 0.25, r - l, 0.07);
  ctx.strokeStyle = W.dark;
  ctx.beginPath(); const gx = 0.2 + cellHash(info.x, info.y, 3) * 0.5; ctx.moveTo(gx, 0.14); ctx.lineTo(gx + 0.25, 0.14); ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.beginPath(); ctx.moveTo(l, 0.02); ctx.lineTo(r, 0.02); ctx.moveTo(l, 0.32); ctx.lineTo(r, 0.32);
  if (open & 8) { ctx.moveTo(l, 0.02); ctx.lineTo(l, 0.32); }
  if (open & 2) { ctx.moveTo(r, 0.02); ctx.lineTo(r, 0.32); }
  ctx.stroke();
  // nails
  ctx.fillStyle = '#5b5560';
  ell(ctx, 0.5, 0.17, 0.025, 0.025); ctx.fill();
}

function iceblock(ctx, P, info) {
  const open = openMask(info.at, c => SIDE_SOLID.has(c));
  const I = P.ice;
  ctx.save(); blockPath(ctx, open, 0.14); ctx.clip();
  ctx.fillStyle = I.base; ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = I.dark; ctx.beginPath(); ctx.moveTo(1, 0.4); ctx.lineTo(1, 1); ctx.lineTo(0.4, 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = I.light; ctx.beginPath(); ctx.moveTo(0.1, 0.2); ctx.lineTo(0.3, 0.08); ctx.lineTo(0.2, 0.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(0.62, 0.18, 0.18, 0.04);
  ctx.restore();
  edgeInk(ctx, open, 0.14);
  if (open & 1) { ctx.fillStyle = I.light; ctx.fillRect(0.08, 0.03, 0.84, 0.05); }
}

function crumble(ctx, P, info) {
  const k = info.crumble || 0;
  const S = P.soil;
  ctx.save();
  if (k > 0) ctx.translate(Math.sin((info.t || 0) * 60) * 0.03 * k, 0);
  rr(ctx, 0.03, 0.03, 0.94, 0.94, 0.1);
  ctx.fillStyle = mix(S.light, '#f2d6a8', 0.4); ctx.fill();
  ctx.save(); rr(ctx, 0.03, 0.03, 0.94, 0.94, 0.1); ctx.clip();
  ctx.fillStyle = S.base; ctx.fillRect(0, 0.72, 1, 0.3);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0.08, 0.08, 0.84, 0.06);
  ctx.restore();
  rr(ctx, 0.03, 0.03, 0.94, 0.94, 0.1); ctx.stroke();
  ctx.strokeStyle = S.dark;
  ctx.beginPath(); ctx.moveTo(0.3, 0.03); ctx.lineTo(0.42, 0.3); ctx.lineTo(0.34, 0.5); ctx.moveTo(0.42, 0.3); ctx.lineTo(0.7, 0.42); ctx.lineTo(0.78, 0.7);
  if (k > 0.3) { ctx.moveTo(0.1, 0.6); ctx.lineTo(0.34, 0.5); ctx.moveTo(0.7, 0.42); ctx.lineTo(0.95, 0.3); }
  ctx.stroke();
  ctx.restore();
}

function thorns(ctx, P, info) {
  const T = P.thorn;
  const dir = thornDir(info.at);
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[dir]);
  ctx.translate(-0.5, -0.5);
  // vine base
  ctx.beginPath(); ctx.moveTo(-0.02, 0.84); ctx.bezierCurveTo(0.3, 0.72, 0.6, 0.98, 1.02, 0.84); ctx.lineTo(1.02, 1); ctx.lineTo(-0.02, 1); ctx.closePath();
  fs(ctx, T.base);
  for (let i = 0; i < 3; i++) {
    const cx = 0.18 + i * 0.32, h = 0.5 + cellHash(info.x, info.y, i) * 0.12;
    ctx.beginPath(); ctx.moveTo(cx - 0.13, 0.9); ctx.lineTo(cx, 0.9 - h); ctx.lineTo(cx + 0.13, 0.9); ctx.closePath();
    lit(ctx, () => { ctx.beginPath(); ctx.moveTo(cx - 0.13, 0.9); ctx.lineTo(cx, 0.9 - h); ctx.lineTo(cx + 0.13, 0.9); ctx.closePath(); }, T.spike, mix(T.spike, T.dark, 0.35), 0.035);
  }
  ctx.fillStyle = T.dark; ell(ctx, 0.5, 0.86, 0.06, 0.04); ctx.fill();
  ctx.restore();
}

function ladder(ctx, P, info) {
  const W = P.wood;
  const open = openMask(info.at, c => c === 7);
  ctx.strokeStyle = INK;
  for (const x of [0.2, 0.8]) {
    rr(ctx, x - 0.06, open & 1 ? 0.04 : -0.02, 0.12, open & 1 ? 1 : 1.04, 0.04); fs(ctx, W.base);
  }
  for (const y of [0.22, 0.72]) { rr(ctx, 0.16, y - 0.05, 0.68, 0.1, 0.04); fs(ctx, W.light); }
  // vine
  ctx.strokeStyle = P.foliage.dark;
  ctx.beginPath(); ctx.moveTo(0.2, 0); ctx.bezierCurveTo(0.35, 0.3, 0.05, 0.6, 0.2, 1); ctx.stroke();
  ctx.fillStyle = P.foliage.base;
  for (const [lx, ly] of [[0.28, 0.3], [0.1, 0.62]]) { ell(ctx, lx, ly, 0.07, 0.04, 0.6); ctx.fill(); ctx.strokeStyle = INK; ctx.stroke(); }
  ctx.strokeStyle = INK;
}

function water(ctx, P, info) {
  const top = info.at(0, -1) !== 8;
  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = P.water.base;
  ctx.fillRect(0, top ? 0.12 : 0, 1, top ? 0.88 : 1);
  if (info.at(0, 1) !== 8) { ctx.fillStyle = P.water.deep; ctx.fillRect(0, 0.7, 1, 0.3); }
  ctx.restore();
}

function toggleBlock(ctx, P, info, code) {
  const solid = code === 9 ? !info.toggle : !!info.toggle;
  const col = code === 9 ? ['#d98a1e', '#ffb23f', '#ffe08a'] : ['#3fa6d9', '#7fd6ff', '#d9f5ff'];
  if (solid) {
    rr(ctx, 0.03, 0.03, 0.94, 0.94, 0.12);
    lit(ctx, () => rr(ctx, 0.03, 0.03, 0.94, 0.94, 0.12), col[1], col[0], 0.06);
    ctx.fillStyle = col[2]; rr(ctx, 0.12, 0.1, 0.5, 0.08, 0.04); ctx.fill();
    ctx.fillStyle = 'rgba(43,29,20,0.55)';
    if (code === 9) { ell(ctx, 0.5, 0.55, 0.14, 0.14); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(0.5, 0.36); ctx.lineTo(0.66, 0.66); ctx.lineTo(0.34, 0.66); ctx.closePath(); ctx.fill(); }
  } else {
    ctx.save();
    ctx.setLineDash([0.12, 0.1]);
    ctx.strokeStyle = col[1];
    ctx.lineWidth = Math.max(ctx.lineWidth, 0.06);
    rr(ctx, 0.08, 0.08, 0.84, 0.84, 0.1); ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Top view

function floor(ctx, P, info) {
  const F = P.floor, x = info.x | 0, y = info.y | 0;
  ctx.fillStyle = F.base;
  ctx.fillRect(0, 0, 1, 1);
  if (cellHash(x, y, 91) > 0.55) { ctx.fillStyle = mix(F.base, F.light, 0.35); ell(ctx, 0.3 + cellHash(x, y, 92) * 0.4, 0.3 + cellHash(x, y, 93) * 0.4, 0.28, 0.2); ctx.fill(); }
  ctx.strokeStyle = F.dark;
  ctx.lineWidth *= 0.9;
  for (let i = 0; i < 3; i++) {
    const hx = cellHash(x, y, 60 + i), hy = cellHash(x, y, 70 + i);
    const px = 0.12 + hx * 0.76, py = 0.15 + hy * 0.72;
    ctx.beginPath();
    if (info.biome === 'desert') { ctx.moveTo(px - 0.14, py); ctx.quadraticCurveTo(px, py - 0.06, px + 0.14, py); }
    else if (info.biome === 'snow') { ctx.fillStyle = '#ffffff'; sparkle(ctx, px, py, 0.04, '#ffffff'); ctx.fillStyle = F.dark; ctx.moveTo(px - 0.08, py + 0.1); ctx.lineTo(px + 0.06, py + 0.1); }
    else { ctx.moveTo(px - 0.05, py + 0.04); ctx.lineTo(px - 0.02, py - 0.06); ctx.moveTo(px + 0.02, py + 0.04); ctx.lineTo(px + 0.05, py - 0.05); }
    ctx.stroke();
  }
  ctx.lineWidth /= 0.9;
  ctx.strokeStyle = INK;
}

function wall(ctx, P, info) {
  const at = info.at;
  const open = openMask(at, c => WALLISH.has(c));
  const W = P.wall, x = info.x | 0, y = info.y | 0;
  const front = open & 4 ? 0.36 : 0;
  const r = 0.2;
  // front face
  if (front) {
    ctx.fillStyle = W.dark;
    ctx.fillRect(open & 8 ? 0.04 : 0, 1 - front, 1 - (open & 8 ? 0.04 : 0) - (open & 2 ? 0.04 : 0), front);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0.96, 1, 0.04);
    if (info.biome === 'meadow') {
      ctx.fillStyle = mix(W.dark, '#1f5a2a', 0.4);
      for (let i = 0; i < 4; i++) { ell(ctx, 0.12 + i * 0.26, 1 - front * 0.45, 0.1, 0.06); ctx.fill(); }
    } else {
      ctx.fillStyle = mix(W.dark, INK, 0.25);
      ctx.fillRect(0, 1 - front * 0.5, 1, 0.03);
      const off = y % 2 ? 0.25 : 0.6;
      ctx.fillRect(off, 1 - front, 0.03, front * 0.5);
      ctx.fillRect((off + 0.5) % 1, 1 - front * 0.5, 0.03, front * 0.5);
    }
    ctx.beginPath();
    ctx.moveTo(open & 8 ? 0.04 : 0, 1); ctx.lineTo(open & 2 ? 0.96 : 1, 1);
    if (open & 8) { ctx.moveTo(0.04, 1 - front); ctx.lineTo(0.04, 1); }
    if (open & 2) { ctx.moveTo(0.96, 1 - front); ctx.lineTo(0.96, 1); }
    ctx.stroke();
  }
  // top face: inset where exposed so walls read as solid blocks
  const l = open & 8 ? 0.04 : 0, t = open & 1 ? 0.04 : 0, rr_ = open & 2 ? 0.96 : 1, b = 1 - front;
  const n = open & 1, e = open & 2, s = !!front, w = open & 8;
  const tl = n && w ? r : 0, tr = n && e ? r : 0, br = s && e ? r * 0.6 : 0, bl = s && w ? r * 0.6 : 0;
  const top = () => {
    ctx.beginPath();
    ctx.moveTo(l + tl, t); ctx.lineTo(rr_ - tr, t); if (tr) ctx.arcTo(rr_, t, rr_, t + tr, tr);
    ctx.lineTo(rr_, b - br); if (br) ctx.arcTo(rr_, b, rr_ - br, b, br);
    ctx.lineTo(l + bl, b); if (bl) ctx.arcTo(l, b, l, b - bl, bl);
    ctx.lineTo(l, t + tl); if (tl) ctx.arcTo(l, t, l + tl, t, tl);
    ctx.closePath();
  };
  top();
  ctx.fillStyle = W.base; ctx.fill();
  ctx.save(); top(); ctx.clip();
  if (info.biome === 'meadow') {
    // leafy hedge top
    for (let i = 0; i < 5; i++) {
      const hx = cellHash(x, y, 100 + i), hy = cellHash(x, y, 110 + i);
      ctx.fillStyle = i % 2 ? W.top : W.light;
      ell(ctx, 0.1 + hx * 0.8, 0.1 + hy * (b - 0.2), 0.16, 0.12); ctx.fill();
    }
    ctx.fillStyle = mix(W.base, '#1f5a2a', 0.3);
    for (let i = 0; i < 3; i++) { ell(ctx, cellHash(x, y, 120 + i), cellHash(x, y, 130 + i) * b, 0.06, 0.04); ctx.fill(); }
  } else if (info.biome === 'desert') {
    ctx.fillStyle = W.top; ctx.fillRect(0, 0, 1, b);
    ctx.fillStyle = W.base;
    ctx.fillRect(0, b * 0.5 - 0.02, 1, 0.04);
    ctx.fillRect(y % 2 ? 0.3 : 0.7, 0, 0.04, b * 0.5); ctx.fillRect(y % 2 ? 0.8 : 0.2, b * 0.5, 0.04, b * 0.5);
  } else {
    ctx.fillStyle = W.top; ctx.fillRect(0, 0, 1, b);
    ctx.fillStyle = W.light; ell(ctx, 0.35, b * 0.35, 0.3, 0.14); ctx.fill();
    ctx.fillStyle = W.base; ctx.fillRect(0, b - 0.05, 1, 0.05);
  }
  // light edge on the lit sides
  if (n) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0, t, 1, 0.05); }
  if (w) { ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(l, 0, 0.05, 1); }
  if (e) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(rr_ - 0.06, 0, 0.06, 1); }
  ctx.restore();
  // ink on exposed edges of the top face
  ctx.beginPath();
  if (n) { ctx.moveTo(l + tl, t); ctx.lineTo(rr_ - tr, t); }
  if (e) { ctx.moveTo(rr_, t + tr); ctx.lineTo(rr_, b - br); }
  if (w) { ctx.moveTo(l, b - bl); ctx.lineTo(l, t + tl); }
  if (s) { ctx.moveTo(rr_ - br, b); ctx.lineTo(l + bl, b); }
  if (tl) { ctx.moveTo(l, t + tl); ctx.arcTo(l, t, l + tl, t, tl); }
  if (tr) { ctx.moveTo(rr_ - tr, t); ctx.arcTo(rr_, t, rr_, t + tr, tr); }
  if (br) { ctx.moveTo(rr_, b - br); ctx.arcTo(rr_, b, rr_ - br, b, br); }
  if (bl) { ctx.moveTo(l + bl, b); ctx.arcTo(l, b, l, b - bl, bl); }
  ctx.stroke();
}

function path(ctx, P, info) {
  const open = openMask(info.at, c => PATHISH.has(c));
  const Q = P.path, F = P.floor, x = info.x | 0, y = info.y | 0;
  ctx.fillStyle = Q.base;
  ctx.fillRect(0, 0, 1, 1);
  // pebbles / cobbles
  for (let i = 0; i < 4; i++) {
    const hx = cellHash(x, y, 140 + i), hy = cellHash(x, y, 150 + i);
    ctx.fillStyle = i % 2 ? Q.light : Q.dark;
    ell(ctx, 0.15 + hx * 0.7, 0.15 + hy * 0.7, 0.07, 0.045); ctx.fill();
  }
  // soft grass (or sand, or snow) edges where the path meets open ground
  ctx.fillStyle = F.base;
  const edge = (side) => {
    ctx.save();
    ctx.translate(0.5, 0.5); ctx.rotate(side * Math.PI / 2); ctx.translate(-0.5, -0.5);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(1, 0); ctx.lineTo(1, 0.1);
    for (let i = 4; i >= 0; i--) ctx.quadraticCurveTo(i / 4 + 0.125, 0.18 + ((i + side) % 2) * 0.04, i / 4, 0.1);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = Q.dark; ctx.beginPath();
    for (let i = 0; i <= 4; i++) { if (i) ctx.quadraticCurveTo((i - 1) / 4 + 0.125, 0.18 + ((i - 1 + side) % 2) * 0.04, i / 4, 0.1); else ctx.moveTo(0, 0.1); }
    ctx.stroke(); ctx.strokeStyle = INK;
    ctx.restore();
  };
  if (open & 1) edge(0);
  if (open & 2) edge(1);
  if (open & 4) edge(2);
  if (open & 8) edge(3);
}

function pond(ctx, P, info) {
  const open = openMask(info.at, c => WATERISH.has(c));
  const Wt = P.water;
  ctx.fillStyle = Wt.base;
  ctx.fillRect(0, 0, 1, 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, 1, 1); ctx.clip();
  ctx.fillStyle = Wt.deep;
  const inset = 0.18;
  rr(ctx, open & 8 ? inset : -0.1, open & 1 ? inset + 0.06 : -0.1, 1.2 - (open & 8 ? inset : 0) - (open & 2 ? inset + 0.1 : 0), 1.2 - (open & 1 ? inset + 0.06 : 0) - (open & 4 ? inset + 0.1 : 0), 0.2);
  ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();
  // banks
  const bank = P.floor.dark;
  if (open & 1) { ctx.fillStyle = bank; ctx.fillRect(0, 0, 1, 0.12); ctx.fillStyle = Wt.foam; ctx.fillRect(0, 0.12, 1, 0.04); }
  if (open & 8) { ctx.fillStyle = Wt.foam; ctx.fillRect(0, 0, 0.05, 1); }
  if (open & 2) { ctx.fillStyle = Wt.foam; ctx.fillRect(0.95, 0, 0.05, 1); }
  if (open & 4) { ctx.fillStyle = Wt.foam; ctx.fillRect(0, 0.94, 1, 0.06); }
  ctx.beginPath();
  if (open & 1) { ctx.moveTo(0, 0.12); ctx.lineTo(1, 0.12); }
  if (open & 2) { ctx.moveTo(1, 0); ctx.lineTo(1, 1); }
  if (open & 4) { ctx.moveTo(0, 1); ctx.lineTo(1, 1); }
  if (open & 8) { ctx.moveTo(0, 0); ctx.lineTo(0, 1); }
  ctx.stroke();
  if (cellHash(info.x, info.y, 33) > 0.82 && open === 0) {
    ell(ctx, 0.5, 0.5, 0.18, 0.12); fs(ctx, P.foliage.base);
    ctx.fillStyle = '#ff9fc7'; ell(ctx, 0.5, 0.46, 0.05, 0.04); ctx.fill();
  }
}

function bridge(ctx, P, info) {
  pond(ctx, P, { ...info, at: (dx, dy) => { const c = info.at(dx, dy); return c === 23 ? 22 : c; } });
  const horiz = WATERISH.has(info.at(-1, 0)) || WATERISH.has(info.at(1, 0)) || !WATERISH.has(info.at(0, -1));
  const W = P.wood;
  ctx.save();
  if (!horiz) { ctx.translate(0.5, 0.5); ctx.rotate(Math.PI / 2); ctx.translate(-0.5, -0.5); }
  // planks across the direction of travel
  for (let i = 0; i < 4; i++) {
    rr(ctx, i * 0.25 + 0.01, 0.14, 0.23, 0.72, 0.03);
    fs(ctx, i % 2 ? W.base : W.light);
  }
  ctx.fillStyle = W.dark;
  ctx.fillRect(0, 0.1, 1, 0.07); ctx.fillRect(0, 0.83, 1, 0.07);
  ctx.beginPath(); ctx.moveTo(0, 0.1); ctx.lineTo(1, 0.1); ctx.moveTo(0, 0.9); ctx.lineTo(1, 0.9); ctx.stroke();
  ctx.restore();
}

function bush(ctx, P, info) {
  floor(ctx, P, info);
  const Fo = P.foliage, x = info.x | 0, y = info.y | 0;
  shadow(ctx, 0.52, 0.82, 0.42, 0.12, 0.25);
  const blob = () => {
    ctx.beginPath();
    ctx.arc(0.3, 0.55, 0.24, Math.PI * 0.6, Math.PI * 1.6);
    ctx.arc(0.55, 0.32, 0.26, Math.PI * 1.1, Math.PI * 1.9);
    ctx.arc(0.74, 0.55, 0.22, Math.PI * 1.5, Math.PI * 0.4);
    ctx.quadraticCurveTo(0.5, 0.92, 0.26, 0.76);
    ctx.closePath();
  };
  lit(ctx, blob, Fo.base, Fo.dark, 0.06);
  ctx.fillStyle = Fo.light;
  ell(ctx, 0.42, 0.34, 0.1, 0.06, -0.4); ctx.fill();
  if (cellHash(x, y, 55) > 0.5) {
    ctx.fillStyle = info.biome === 'snow' ? '#ffffff' : P.flower[Math.floor(cellHash(x, y, 56) * 4)];
    for (let i = 0; i < 3; i++) { ell(ctx, 0.3 + i * 0.18, 0.5 + (i % 2) * 0.12, 0.035, 0.035); ctx.fill(); }
  }
  if (info.biome === 'snow') { ctx.fillStyle = '#ffffff'; ell(ctx, 0.5, 0.2, 0.2, 0.07); ctx.fill(); }
}

function icefloor(ctx, P, info) {
  const open = openMask(info.at, c => c === 25);
  const I = P.ice;
  ctx.fillStyle = I.base; ctx.fillRect(0, 0, 1, 1);
  ctx.strokeStyle = I.light; ctx.lineWidth *= 1.3;
  const h = cellHash(info.x, info.y, 25);
  ctx.beginPath(); ctx.moveTo(0.15 + h * 0.3, 0.2); ctx.lineTo(0.45 + h * 0.3, 0.5); ctx.moveTo(0.55, 0.7); ctx.lineTo(0.75, 0.85); ctx.stroke();
  ctx.lineWidth /= 1.3;
  ctx.strokeStyle = I.dark;
  ctx.beginPath();
  if (open & 1) { ctx.moveTo(0, 0.02); ctx.lineTo(1, 0.02); }
  if (open & 2) { ctx.moveTo(0.98, 0); ctx.lineTo(0.98, 1); }
  if (open & 4) { ctx.moveTo(0, 0.98); ctx.lineTo(1, 0.98); }
  if (open & 8) { ctx.moveTo(0.02, 0); ctx.lineTo(0.02, 1); }
  ctx.stroke(); ctx.strokeStyle = INK;
}

function pit(ctx, P, info) {
  const open = openMask(info.at, c => c === 26);
  floor(ctx, P, info);
  const K = P.pit;
  const l = open & 8 ? 0.1 : 0, t = open & 1 ? 0.1 : 0, r = open & 2 ? 0.9 : 1, b = open & 4 ? 0.9 : 1;
  const n = open & 1, e = open & 2, s = open & 4, w = open & 8, R = 0.22;
  const hole = () => {
    const tl = n && w ? R : 0, tr = n && e ? R : 0, br = s && e ? R : 0, bl = s && w ? R : 0;
    ctx.beginPath();
    ctx.moveTo(l + tl, t); ctx.lineTo(r - tr, t); if (tr) ctx.arcTo(r, t, r, t + tr, tr);
    ctx.lineTo(r, b - br); if (br) ctx.arcTo(r, b, r - br, b, br);
    ctx.lineTo(l + bl, b); if (bl) ctx.arcTo(l, b, l, b - bl, bl);
    ctx.lineTo(l, t + tl); if (tl) ctx.arcTo(l, t, l + tl, t, tl);
    ctx.closePath();
  };
  hole(); ctx.fillStyle = K.deep; ctx.fill();
  ctx.save(); hole(); ctx.clip();
  if (n) { ctx.fillStyle = K.rim; ctx.fillRect(0, t, 1, 0.24); ctx.fillStyle = mix(K.rim, K.deep, 0.5); ctx.fillRect(0, t + 0.24, 1, 0.08); }
  ctx.restore();
  hole(); ctx.stroke();
}

function pad(ctx, P, info) {
  floor(ctx, P, info);
  rr(ctx, 0.14, 0.14, 0.72, 0.72, 0.1);
  fs(ctx, mix(P.path.base, '#ffd35c', 0.35));
  rr(ctx, 0.24, 0.24, 0.52, 0.52, 0.06);
  ctx.save(); ctx.setLineDash([0.08, 0.07]); ctx.strokeStyle = '#b8740f'; ctx.stroke(); ctx.restore();
  ctx.strokeStyle = '#b8740f';
  ctx.beginPath(); ctx.moveTo(0.4, 0.4); ctx.lineTo(0.6, 0.6); ctx.moveTo(0.6, 0.4); ctx.lineTo(0.4, 0.6); ctx.stroke();
  ctx.strokeStyle = INK;
}

function gate(ctx, P, info) {
  floor(ctx, P, info);
  const horiz = WALLISH.has(info.at(-1, 0)) || WALLISH.has(info.at(1, 0)) || info.at(-1, 0) === 28 || info.at(1, 0) === 28;
  ctx.save();
  if (!horiz) { ctx.translate(0.5, 0.5); ctx.rotate(Math.PI / 2); ctx.translate(-0.5, -0.5); }
  rr(ctx, -0.02, 0.36, 1.04, 0.28, 0.08); fs(ctx, '#ffcf3f');
  ctx.strokeStyle = '#b8740f';
  for (let i = 0; i < 4; i++) { const cx = 0.12 + i * 0.25; ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; const px = cx + Math.cos(a) * 0.07, py = 0.5 + Math.sin(a) * 0.07; if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.closePath(); ctx.stroke(); }
  ctx.restore();
  ctx.strokeStyle = INK;
}

function tallgrass(ctx, P, info) {
  floor(ctx, P, info);
  const x = info.x | 0, y = info.y | 0;
  const col = info.biome === 'snow' ? { base: '#9cc7b0', light: '#c9e6d6', dark: '#6f9f88' }
    : info.biome === 'desert' ? { base: '#d9b567', light: '#f0d493', dark: '#b8904a' }
    : { base: P.grass.base, light: P.grass.light, dark: P.grass.dark };
  for (const [cx, cy, s] of [[0.28, 0.5, 1], [0.7, 0.42, 0.9], [0.52, 0.86, 1.05]]) {
    for (let i = 0; i < 5; i++) {
      const lean = (i - 2) * 0.07 + (cellHash(x, y, 160 + i) - 0.5) * 0.05;
      const h = (0.3 + cellHash(x, y, 170 + i) * 0.14) * s;
      ctx.beginPath();
      ctx.moveTo(cx - 0.05 + i * 0.025, cy);
      ctx.quadraticCurveTo(cx + lean * 0.4, cy - h * 0.6, cx + lean, cy - h);
      ctx.quadraticCurveTo(cx + lean * 0.3 + 0.03, cy - h * 0.5, cx + 0.02 + i * 0.025, cy);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? col.base : col.light;
      ctx.fill();
    }
    ctx.strokeStyle = col.dark;
    ctx.beginPath(); ctx.moveTo(cx - 0.1, cy); ctx.lineTo(cx + 0.14, cy); ctx.stroke();
  }
  ctx.strokeStyle = INK;
}

const TILE = {
  0: floor, 1: ground, 2: brick, 3: plank, 4: iceblock, 5: crumble, 6: thorns, 7: ladder, 8: water,
  9: (ctx, P, info) => toggleBlock(ctx, P, info, 9), 10: (ctx, P, info) => toggleBlock(ctx, P, info, 10),
  20: wall, 21: path, 22: pond, 23: bridge, 24: bush, 25: icefloor, 26: pit, 27: pad, 28: gate, 29: tallgrass,
};
export const TILE_CODES = Object.keys(TILE).map(Number);

// ---------------------------------------------------------------------------------------------
// Decor

/** Where each decor item draws, in tiles relative to its cell's top-left: [x0, y0, x1, y1]. */
export const DECOR_BOUNDS = {
  55: [-1, -2.4, 2, 1.1], 57: [-0.3, -1.8, 1.3, 1.1], 58: [-0.2, -2.6, 4.3, 1.1], 59: [-0.9, -0.3, 2.9, 1.2],
};
export const decorBounds = code => DECOR_BOUNDS[code] || [-0.25, -0.35, 1.25, 1.1];

export function drawDecor(ctx, code, info) {
  const P = pal(info.biome);
  const fn = DECOR_DRAW[code];
  if (fn) fn(ctx, P, info, info.view || 'side');
}

function flowerDecor(ctx, P, info, view) {
  const x = info.x | 0, y = info.y | 0;
  const base = view === 'side' ? 1 : 0.82;
  for (let i = 0; i < 3; i++) {
    const fx = 0.2 + i * 0.3 + (cellHash(x, y, 200 + i) - 0.5) * 0.1, fh = 0.2 + cellHash(x, y, 210 + i) * 0.18;
    const fy = base - fh - (view === 'top' ? (i % 2) * 0.2 : 0);
    ctx.strokeStyle = P.foliage.dark; ctx.beginPath(); ctx.moveTo(fx, base - (view === 'top' ? (i % 2) * 0.2 : 0)); ctx.lineTo(fx, fy); ctx.stroke(); ctx.strokeStyle = INK;
    const col = P.flower[Math.floor(cellHash(x, y, 220 + i) * P.flower.length)];
    if (info.biome === 'desert' && i === 1) {
      rr(ctx, fx - 0.06, fy - 0.1, 0.12, 0.22, 0.06); fs(ctx, '#6fae4a');
      ell(ctx, fx, fy - 0.12, 0.05, 0.04); fs(ctx, col);
      continue;
    }
    for (let k = 0; k < 5; k++) { const a = k * TAU / 5; ell(ctx, fx + Math.cos(a) * 0.05, fy + Math.sin(a) * 0.05, 0.045, 0.045); ctx.fillStyle = col; ctx.fill(); }
    ell(ctx, fx, fy, 0.035, 0.035); ctx.fillStyle = '#ffd23f'; ctx.fill();
  }
}
function tuftDecor(ctx, P, info, view) {
  const G = info.biome === 'snow' ? P.foliage : P.grass.base === '#f3d48f' ? { base: '#c9a45a', light: '#e8c47a', dark: '#a8823f' } : P.foliage;
  const base = view === 'side' ? 1 : 0.8;
  for (let i = 0; i < 5; i++) {
    const bx = 0.25 + i * 0.12, h = 0.2 + cellHash(info.x, info.y, 230 + i) * 0.16, lean = (i - 2) * 0.05;
    ctx.beginPath(); ctx.moveTo(bx - 0.04, base); ctx.quadraticCurveTo(bx, base - h * 0.6, bx + lean, base - h); ctx.quadraticCurveTo(bx + 0.02, base - h * 0.4, bx + 0.05, base); ctx.closePath();
    fs(ctx, i % 2 ? G.base : G.light);
  }
}
function rockDecor(ctx, P, info, view) {
  const S = P.stone;
  const base = view === 'side' ? 1 : 0.78;
  if (view === 'top') shadow(ctx, 0.5, base, 0.36, 0.1, 0.2);
  const r = () => { ctx.beginPath(); ctx.moveTo(0.14, base); ctx.quadraticCurveTo(0.1, base - 0.36, 0.42, base - 0.46); ctx.quadraticCurveTo(0.8, base - 0.48, 0.88, base - 0.2); ctx.quadraticCurveTo(0.92, base, 0.14, base); ctx.closePath(); };
  lit(ctx, r, S.base, S.dark, 0.06);
  ctx.fillStyle = S.light; ell(ctx, 0.38, base - 0.34, 0.1, 0.05, -0.3); ctx.fill();
  if (info.biome === 'snow') { ctx.beginPath(); ctx.moveTo(0.2, base - 0.3); ctx.quadraticCurveTo(0.42, base - 0.52, 0.8, base - 0.4); ctx.quadraticCurveTo(0.5, base - 0.34, 0.2, base - 0.3); fs(ctx, '#ffffff'); }
}
function mushroomDecor(ctx, P, info, view) {
  const base = view === 'side' ? 1 : 0.8;
  for (const [mx, s] of [[0.35, 1], [0.66, 0.7]]) {
    rr(ctx, mx - 0.05 * s, base - 0.26 * s, 0.1 * s, 0.26 * s, 0.04); fs(ctx, '#f6e6cc');
    ctx.beginPath(); ctx.moveTo(mx - 0.18 * s, base - 0.24 * s); ctx.bezierCurveTo(mx - 0.18 * s, base - 0.46 * s, mx + 0.18 * s, base - 0.46 * s, mx + 0.18 * s, base - 0.24 * s); ctx.closePath();
    fs(ctx, info.biome === 'snow' ? '#8a5fe0' : '#ff5a4f');
    ctx.fillStyle = '#fff4e6'; ell(ctx, mx - 0.05 * s, base - 0.34 * s, 0.035 * s, 0.03 * s); ctx.fill();
  }
}
function fenceDecor(ctx, P, info, view) {
  const W = P.wood;
  const join = c => c === 54;
  const l = join(info.at?.(-1, 0)), r = join(info.at?.(1, 0));
  const base = view === 'side' ? 1 : 0.85;
  rr(ctx, l ? 0 : 0.15, base - 0.46, (r ? 1 : 0.85) - (l ? 0 : 0.15), 0.09, 0.03); fs(ctx, W.base);
  rr(ctx, l ? 0 : 0.15, base - 0.26, (r ? 1 : 0.85) - (l ? 0 : 0.15), 0.09, 0.03); fs(ctx, W.base);
  for (const px of [0.2, 0.8]) {
    ctx.beginPath(); ctx.moveTo(px - 0.07, base); ctx.lineTo(px - 0.07, base - 0.56); ctx.lineTo(px, base - 0.64); ctx.lineTo(px + 0.07, base - 0.56); ctx.lineTo(px + 0.07, base); ctx.closePath();
    fs(ctx, W.light);
  }
  if (info.biome === 'snow') { ctx.fillStyle = '#ffffff'; ctx.fillRect(l ? 0 : 0.15, base - 0.49, (r ? 1 : 0.85) - (l ? 0 : 0.15), 0.04); }
}
function treeDecor(ctx, P, info, view) {
  const Fo = P.foliage, T = P.trunk, x = info.x | 0, y = info.y | 0;
  const base = view === 'side' ? 1 : 0.85;
  if (view === 'top') shadow(ctx, 0.5, base, 0.7, 0.2, 0.25);
  if (info.biome === 'desert') {
    // palm: curved trunk and fronds
    ctx.beginPath(); ctx.moveTo(0.4, base); ctx.quadraticCurveTo(0.3, base - 1.2, 0.62, base - 2); ctx.lineTo(0.74, base - 1.96); ctx.quadraticCurveTo(0.46, base - 1.2, 0.6, base); ctx.closePath();
    fs(ctx, '#b8874f');
    ctx.strokeStyle = '#8e5c34'; for (let i = 1; i < 6; i++) { const k = i / 6; ctx.beginPath(); ctx.moveTo(0.4 + (0.62 - 0.4) * k - 0.08 + k * 0.1, base - 2 * k); ctx.lineTo(0.56 + k * 0.12, base - 2 * k + 0.02); ctx.stroke(); } ctx.strokeStyle = INK;
    const cx = 0.68, cy = base - 2.02;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.62;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.45, -0.22, 0.95, 0.18); ctx.quadraticCurveTo(0.45, 0.02, 0, 0.08); ctx.closePath();
      fs(ctx, i % 2 ? Fo.base : Fo.light);
      ctx.restore();
    }
    ell(ctx, cx - 0.06, cy + 0.1, 0.07, 0.07); fs(ctx, '#8e5c34'); ell(ctx, cx + 0.08, cy + 0.12, 0.07, 0.07); fs(ctx, '#7a4d2a');
    return;
  }
  if (info.biome === 'snow') {
    // pine with snow shelves
    rr(ctx, 0.42, base - 0.45, 0.16, 0.45, 0.04); fs(ctx, T.base);
    for (let i = 0; i < 3; i++) {
      const w = 0.95 - i * 0.24, ty = base - 0.35 - i * 0.55;
      ctx.beginPath(); ctx.moveTo(0.5 - w, ty); ctx.lineTo(0.5, ty - 0.85); ctx.lineTo(0.5 + w, ty); ctx.quadraticCurveTo(0.5, ty + 0.12, 0.5 - w, ty); ctx.closePath();
      lit(ctx, () => { ctx.beginPath(); ctx.moveTo(0.5 - w, ty); ctx.lineTo(0.5, ty - 0.85); ctx.lineTo(0.5 + w, ty); ctx.quadraticCurveTo(0.5, ty + 0.12, 0.5 - w, ty); ctx.closePath(); }, Fo.base, Fo.dark, 0.06);
      ctx.beginPath(); ctx.moveTo(0.5 - w * 0.9, ty - 0.04); ctx.quadraticCurveTo(0.2, ty - 0.2, 0.5, ty - 0.52); ctx.quadraticCurveTo(0.62, ty - 0.2, 0.5 + w * 0.7, ty - 0.08); ctx.quadraticCurveTo(0.5, ty - 0.02, 0.5 - w * 0.9, ty - 0.04); ctx.closePath();
      fs(ctx, '#ffffff');
    }
    return;
  }
  // oak: trunk and three puffs of canopy
  ctx.beginPath(); ctx.moveTo(0.38, base); ctx.lineTo(0.42, base - 0.9); ctx.lineTo(0.58, base - 0.9); ctx.lineTo(0.62, base); ctx.quadraticCurveTo(0.5, base + 0.04, 0.38, base); ctx.closePath();
  fs(ctx, T.base);
  ctx.fillStyle = T.dark; ctx.fillRect(0.53, base - 0.85, 0.05, 0.8);
  const puffs = [[0.5, base - 1.55, 0.72], [0.02, base - 1.05, 0.5], [0.98, base - 1.05, 0.5], [0.5, base - 1.0, 0.55]];
  const canopy = () => { ctx.beginPath(); for (const [px, py, r] of puffs) { ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, TAU); } };
  canopy(); ctx.fillStyle = Fo.dark; ctx.fill();
  ctx.save(); canopy(); ctx.clip();
  ctx.translate(-0.08, -0.1); canopy(); ctx.fillStyle = Fo.base; ctx.fill();
  ctx.translate(-0.12, -0.14); ctx.fillStyle = Fo.light;
  ell(ctx, 0.35, base - 1.7, 0.25, 0.16); ctx.fill(); ell(ctx, -0.05, base - 1.15, 0.16, 0.1); ctx.fill();
  ctx.restore();
  // outline only the outer silhouette
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.lineWidth *= 2;
  canopy(); ctx.stroke();
  ctx.restore();
  if (cellHash(x, y, 240) > 0.5) { ctx.fillStyle = '#ff5a4f'; for (const [ax, ay] of [[0.2, base - 1.3], [0.75, base - 1.6], [0.6, base - 1.1]]) { ell(ctx, ax, ay, 0.06, 0.06); ctx.fill(); ctx.stroke(); } }
}
function shrubDecor(ctx, P, info, view) {
  const Fo = P.foliage;
  const base = view === 'side' ? 1 : 0.82;
  if (view === 'top') shadow(ctx, 0.5, base, 0.4, 0.1, 0.2);
  const blob = () => { ctx.beginPath(); ctx.moveTo(0.1, base); ctx.bezierCurveTo(0, base - 0.4, 0.3, base - 0.62, 0.5, base - 0.5); ctx.bezierCurveTo(0.7, base - 0.66, 1.02, base - 0.4, 0.9, base); ctx.closePath(); };
  lit(ctx, blob, Fo.base, Fo.dark, 0.05);
  ctx.fillStyle = Fo.light; ell(ctx, 0.35, base - 0.4, 0.1, 0.06, -0.4); ctx.fill();
  if (info.biome === 'snow') { ctx.beginPath(); ctx.moveTo(0.14, base - 0.3); ctx.quadraticCurveTo(0.4, base - 0.66, 0.84, base - 0.34); ctx.quadraticCurveTo(0.5, base - 0.42, 0.14, base - 0.3); fs(ctx, '#ffffff'); }
}
function lampDecor(ctx, P, info, view) {
  const base = view === 'side' ? 1 : 0.85;
  if (view === 'top') shadow(ctx, 0.5, base, 0.2, 0.06, 0.25);
  if (info.time === 'night' || info.time === 'golden') glow(ctx, 0.5, base - 1.45, info.time === 'night' ? 1.4 : 0.8, 'rgba(255, 200, 110, 0.9)', info.time === 'night' ? 0.55 : 0.3);
  rr(ctx, 0.44, base - 1.3, 0.12, 1.3, 0.04); fs(ctx, '#4a3b33');
  rr(ctx, 0.36, base - 0.12, 0.28, 0.12, 0.03); fs(ctx, '#5b4a3a');
  ctx.beginPath(); ctx.moveTo(0.3, base - 1.3); ctx.lineTo(0.7, base - 1.3); ctx.lineTo(0.62, base - 1.62); ctx.lineTo(0.38, base - 1.62); ctx.closePath(); fs(ctx, '#ffd26b');
  ctx.beginPath(); ctx.moveTo(0.3, base - 1.62); ctx.lineTo(0.5, base - 1.78); ctx.lineTo(0.7, base - 1.62); ctx.closePath(); fs(ctx, '#4a3b33');
}
function cottageDecor(ctx, P, info, view) {
  const base = view === 'side' ? 1 : 0.9;
  const style = info.biome;
  const wall = style === 'desert' ? '#e8b77a' : style === 'snow' ? '#c9a27a' : '#f4e3c0';
  const wallShade = style === 'desert' ? '#c98f55' : style === 'snow' ? '#9e7650' : '#d9c49a';
  const roof = style === 'desert' ? '#d9774a' : style === 'snow' ? '#7a5a8a' : '#d9574a';
  const roofShade = style === 'desert' ? '#b85a34' : style === 'snow' ? '#5a3f6a' : '#a83d33';
  if (view === 'top') shadow(ctx, 2, base, 2.1, 0.3, 0.25);
  // walls
  const x0 = 0.3, x1 = 3.7, wy = base - 1.3;
  rr(ctx, x0, wy, x1 - x0, 1.3, 0.05); lit(ctx, () => rr(ctx, x0, wy, x1 - x0, 1.3, 0.05), wall, wallShade, 0.08);
  if (style === 'meadow') { ctx.strokeStyle = '#8e5c34'; ctx.lineWidth *= 2; ctx.beginPath(); ctx.moveTo(x0 + 0.05, wy + 0.55); ctx.lineTo(x1 - 0.05, wy + 0.55); ctx.moveTo(1.2, wy); ctx.lineTo(1.2, base); ctx.moveTo(2.8, wy); ctx.lineTo(2.8, base); ctx.stroke(); ctx.lineWidth /= 2; ctx.strokeStyle = INK; }
  // door and windows
  rr(ctx, 1.65, base - 0.85, 0.7, 0.85, 0.3); fs(ctx, '#8e5c34');
  ell(ctx, 2.2, base - 0.4, 0.04, 0.04); ctx.fillStyle = '#ffcf3f'; ctx.fill();
  const lit_ = info.time === 'night' || info.time === 'golden';
  for (const wx of [0.75, 3.0]) {
    rr(ctx, wx, base - 1.0, 0.5, 0.45, 0.06); fs(ctx, lit_ ? '#ffd26b' : '#8fd3ff');
    ctx.beginPath(); ctx.moveTo(wx + 0.25, base - 1.0); ctx.lineTo(wx + 0.25, base - 0.55); ctx.moveTo(wx, base - 0.78); ctx.lineTo(wx + 0.5, base - 0.78); ctx.stroke();
    if (lit_) glow(ctx, wx + 0.25, base - 0.78, 0.6, 'rgba(255, 200, 110, 0.7)', 0.4);
  }
  // roof
  const roofPath = () => {
    ctx.beginPath();
    if (style === 'desert') { ctx.moveTo(x0 - 0.15, wy + 0.05); ctx.lineTo(x0 - 0.1, wy - 0.3); ctx.lineTo(x1 + 0.1, wy - 0.3); ctx.lineTo(x1 + 0.15, wy + 0.05); }
    else { ctx.moveTo(x0 - 0.3, wy + 0.1); ctx.lineTo(2, wy - 1.2); ctx.lineTo(x1 + 0.3, wy + 0.1); }
    ctx.closePath();
  };
  lit(ctx, roofPath, roof, roofShade, 0.1);
  if (style !== 'desert') {
    ctx.strokeStyle = roofShade;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x0 - 0.3 + i * 0.42, wy + 0.1 - i * 0.3); ctx.lineTo(x1 + 0.3 - i * 0.42, wy + 0.1 - i * 0.3); ctx.stroke(); }
    ctx.strokeStyle = INK;
    rr(ctx, 2.7, wy - 1.05, 0.3, 0.6, 0.03); fs(ctx, '#8a939c');
  } else {
    ell(ctx, 2, wy - 0.3, 0.6, 0.35); ctx.save(); ctx.beginPath(); ctx.rect(1, wy - 1, 2, 0.7); ctx.clip(); ell(ctx, 2, wy - 0.3, 0.6, 0.45); fs(ctx, '#f2c98d'); ctx.restore();
  }
  if (style === 'snow') { ctx.beginPath(); ctx.moveTo(x0 - 0.3, wy + 0.1); ctx.lineTo(2, wy - 1.2); ctx.lineTo(x1 + 0.3, wy + 0.1); ctx.quadraticCurveTo(3, wy - 0.1, 2, wy - 0.95); ctx.quadraticCurveTo(1, wy - 0.1, x0 - 0.3, wy + 0.1); ctx.closePath(); fs(ctx, '#ffffff'); }
}
function cloudDecor(ctx, P, info) {
  const puff = () => { ctx.beginPath(); ctx.arc(0.3, 0.55, 0.42, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(0.95, 0.3, 0.55, Math.PI * 1.05, Math.PI * 1.95); ctx.arc(1.6, 0.52, 0.45, Math.PI * 1.5, Math.PI * 0.5); ctx.closePath(); };
  ctx.save(); ctx.globalAlpha = 0.95;
  lit(ctx, puff, P.cloud, P.cloudShade, 0.08);
  ctx.restore();
}
function barrelDecor(ctx, P, info, view) {
  const base = view === 'side' ? 1 : 0.85;
  if (view === 'top') shadow(ctx, 0.5, base, 0.32, 0.09, 0.25);
  const b = () => { ctx.beginPath(); ctx.moveTo(0.22, base); ctx.quadraticCurveTo(0.12, base - 0.36, 0.22, base - 0.72); ctx.lineTo(0.78, base - 0.72); ctx.quadraticCurveTo(0.88, base - 0.36, 0.78, base); ctx.closePath(); };
  lit(ctx, b, P.wood.base, P.wood.dark, 0.05);
  ctx.fillStyle = '#5b5560'; ctx.fillRect(0.16, base - 0.56, 0.68, 0.06); ctx.fillRect(0.16, base - 0.2, 0.68, 0.06);
  ell(ctx, 0.5, base - 0.72, 0.28, 0.07); fs(ctx, P.wood.light);
}
function crystalDecor(ctx, P, info, view) {
  const base = view === 'side' ? 1 : 0.85;
  glow(ctx, 0.5, base - 0.35, 0.6, 'rgba(143, 240, 255, 0.8)', 0.35);
  for (const [cx, h, w, a] of [[0.36, 0.5, 0.12, -0.25], [0.6, 0.7, 0.15, 0.1], [0.78, 0.36, 0.1, 0.4]]) {
    ctx.save(); ctx.translate(cx, base); ctx.rotate(a);
    const c = () => { ctx.beginPath(); ctx.moveTo(-w, 0); ctx.lineTo(-w, -h * 0.75); ctx.lineTo(0, -h); ctx.lineTo(w, -h * 0.75); ctx.lineTo(w, 0); ctx.closePath(); };
    lit(ctx, c, '#8ff0ff', '#3fc2e0', 0.03);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(-w * 0.6, -h * 0.7, w * 0.35, h * 0.55);
    ctx.restore();
  }
}

const DECOR_DRAW = {
  50: flowerDecor, 51: tuftDecor, 52: rockDecor, 53: mushroomDecor, 54: fenceDecor, 55: treeDecor,
  56: shrubDecor, 57: lampDecor, 58: cottageDecor, 59: cloudDecor, 60: barrelDecor, 61: crystalDecor,
};
export const DECOR_CODES = Object.keys(DECOR_DRAW).map(Number);

/** Maze pollen: a soft golden dot. */
export function drawDot(ctx, cx, cy, size) {
  const r = Math.max(1.5, size * 0.09);
  ctx.fillStyle = '#ffe38a';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.4, 0, TAU); ctx.fill();
}
