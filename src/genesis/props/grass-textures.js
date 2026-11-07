// Procedural detail atlas: the textures Unity's grass system would call
// "Detail Texture", drawn at first use on a 768² canvas — no assets, no
// network (CSP-safe), fixed seed so every session grows the identical
// sprites. 3×3 cells, indexed by DETAIL_PROTOTYPES[].atlasCell:
//   0 grass blades · 1 dense wild tuft · 2 flowering stems · 3 broadleaf weed
//   4 fern fronds  · 5 water reeds     · 6 clover mat      · 7 heather sprigs
//   8 spare
//
// THE CELL IS STILL 256 PIXELS. The grid went from 2×2 to 3×3 and the canvas
// from 512 to 768 in the same step, on purpose: a cell is 256 px either way,
// so cells 0–3 are drawn by the same code from the same seeds at the same
// scale and the four original species are byte-identical to what they were.
// Growing the grid without growing the canvas would have quietly halved every
// blade's resolution to make room for the new ones.
//
// Colour discipline: the waving-grass shader multiplies the texel by
// 2 × instanceTint (Unity's historic DOUBLE combine), so the sprites are
// painted around 50% luminance in a near-neutral green — the healthy/dry
// per-instance colour owns the hue, the texture owns the shape and shading.
// Transparent texels get their RGB flood-filled with the average foliage
// colour so mipmaps never bleed dark halos into the cutout edge.

import * as THREE from "three";

const CELLS = 3;          // 3×3 grid
const SIZE = 768;         // 256 px per cell — unchanged from the 2×2 atlas
const GUTTER = 6;         // px kept clear inside each cell edge

let cached = null;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// One blade: a tapered quadratic strip from (x,0) curving `lean` px sideways,
// root shaded darker than the tip so the cutout reads rooted, not pasted.
function blade(ctx, r, x, w, h, lean, lum) {
  const tipX = x + lean, midX = x + lean * 0.35;
  const g = ctx.createLinearGradient(0, 0, 0, -h);
  // Painted LIGHT (like every block texture): the shader multiplies the texel
  // by the linear instance colour, so a dark sprite goes black. Roots still
  // shade darker than tips for the rooted look.
  const base = 0.58 * lum, tip = 1.02 * lum;
  g.addColorStop(0, `rgb(${(150 * base) | 0},${(160 * base) | 0},${(122 * base) | 0})`);
  g.addColorStop(1, `rgb(${(216 * tip) | 0},${(228 * tip) | 0},${(170 * tip) | 0})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, 0);
  ctx.quadraticCurveTo(midX - w / 2, -h * 0.55, tipX, -h);
  ctx.quadraticCurveTo(midX + w / 2, -h * 0.55, x + w / 2, 0);
  ctx.closePath();
  ctx.fill();
}

function grassCell(ctx, r, S, count, hMin, hMax, wMax) {
  ctx.save();
  ctx.translate(0, S - GUTTER); // ground line at the cell's bottom
  for (let i = 0; i < count; i++) {
    const x = GUTTER + wMax + r() * (S - 2 * (GUTTER + wMax));
    const h = (hMin + r() * (hMax - hMin)) * (S - 2 * GUTTER);
    const w = 6 + r() * wMax;
    const lean = (r() - 0.5) * h * 0.55;
    blade(ctx, r, x, w, h, lean, 0.82 + r() * 0.5);
  }
  ctx.restore();
}

function flowerCell(ctx, r, S) {
  grassCell(ctx, r, S, 12, 0.3, 0.55, 6);
  ctx.save();
  ctx.translate(0, S - GUTTER);
  for (let i = 0; i < 7; i++) {
    const x = S * 0.14 + r() * S * 0.72;
    const h = (0.45 + r() * 0.4) * (S - 2 * GUTTER);
    const lean = (r() - 0.5) * h * 0.3;
    // stem
    ctx.strokeStyle = `rgb(${128 + (r() * 30) | 0},${160 + (r() * 30) | 0},104)`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(x + lean * 0.4, -h * 0.6, x + lean, -h);
    ctx.stroke();
    // five petals + a warm centre; near-white so the instance tint stays soft
    const cx = x + lean, cy = -h, pr = 7 + r() * 5;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2 + r() * 0.3;
      ctx.fillStyle = `rgba(${232 + (r() * 20) | 0},${228 + (r() * 20) | 0},${210 + (r() * 24) | 0},0.96)`;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * pr, cy + Math.sin(a) * pr, pr * 0.78, pr * 0.5, a, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = "rgb(214,178,84)";
    ctx.beginPath(); ctx.arc(cx, cy, pr * 0.42, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function weedCell(ctx, r, S) {
  ctx.save();
  ctx.translate(S / 2, S - GUTTER);
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i / 8 - 0.5) * 1.9 + (r() - 0.5) * 0.2;
    const len = (0.42 + r() * 0.4) * (S - 2 * GUTTER);
    const wid = len * (0.16 + r() * 0.08);
    const lum = 0.72 + r() * 0.5;
    const tx = Math.cos(a) * len, ty = Math.sin(a) * len;
    const px = -Math.sin(a), py = Math.cos(a);
    // lanceolate leaf: two quadratic edges to a point, darker mid-vein
    ctx.fillStyle = `rgb(${(158 * lum) | 0},${(196 * lum) | 0},${(126 * lum) | 0})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(tx * 0.5 + px * wid, ty * 0.5 + py * wid, tx, ty);
    ctx.quadraticCurveTo(tx * 0.5 - px * wid, ty * 0.5 - py * wid, 0, 0);
    ctx.fill();
    ctx.strokeStyle = `rgba(96,124,80,0.55)`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(tx * 0.55, ty * 0.55, tx, ty); ctx.stroke();
  }
  ctx.restore();
}

/* ── the four species the 2×2 atlas had no room for ──
   Same discipline as the cells above: painted LIGHT around 50% luminance in a
   near-neutral green, because the shader multiplies the texel by the linear
   instance colour and a dark sprite goes black. Each one is drawn as the
   SILHOUETTE that tells it apart at twenty metres — a fern is arched fronds,
   a reed is a vertical stroke, clover is round leaves near the ground,
   heather is a woody stem with a flowering head — because at the distance
   detail actually reads, shape is the only channel left. */

// A pinnate frond: an arching rachis with leaflets stepping down both sides.
function fernCell(ctx, r, S) {
  ctx.save();
  ctx.translate(S / 2, S - GUTTER);
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (i / 6 - 0.5) * 2.0 + (r() - 0.5) * 0.18;
    const len = (0.5 + r() * 0.42) * (S - 2 * GUTTER);
    const lum = 0.7 + r() * 0.44;
    // The rachis arches: the tip droops away from vertical under its own load.
    const arch = (a + Math.PI / 2) * 0.55;
    const tx = Math.cos(a + arch) * len, ty = Math.sin(a + arch) * len;
    const mx = Math.cos(a) * len * 0.55, my = Math.sin(a) * len * 0.55;
    ctx.strokeStyle = `rgb(${(120 * lum) | 0},${(150 * lum) | 0},${(94 * lum) | 0})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
    // Leaflets, shortening toward the tip so the frond tapers.
    const leaves = 11;
    for (let k = 1; k <= leaves; k++) {
      const t = k / (leaves + 1);
      const px = 2 * (1 - t) * t * mx + t * t * tx, py = 2 * (1 - t) * t * my + t * t * ty;
      const dx = tx - mx || 1, dy = ty - my;
      const nl = Math.hypot(dx, dy) || 1;
      const nx = -dy / nl, ny = dx / nl;
      const lw = len * 0.17 * (1 - t * 0.75);
      ctx.fillStyle = `rgb(${(146 * lum) | 0},${(184 * lum) | 0},${(114 * lum) | 0})`;
      for (const s of [1, -1]) {
        ctx.beginPath();
        ctx.ellipse(px + nx * lw * s * 0.6, py + ny * lw * s * 0.6, lw, lw * 0.34,
          Math.atan2(ny * s, nx * s), 0, 7);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

// Reeds: near-vertical culms with a dark seed head. Almost no lean — a reed
// bends at the base in wind, not along its length, which the shader does.
function reedCell(ctx, r, S) {
  ctx.save();
  ctx.translate(0, S - GUTTER);
  for (let i = 0; i < 14; i++) {
    const x = GUTTER + 10 + r() * (S - 2 * GUTTER - 20);
    const h = (0.62 + r() * 0.36) * (S - 2 * GUTTER);
    const lean = (r() - 0.5) * h * 0.16;
    const lum = 0.78 + r() * 0.42;
    const w = 4 + r() * 4;
    ctx.fillStyle = `rgb(${(150 * lum) | 0},${(168 * lum) | 0},${(112 * lum) | 0})`;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, 0);
    ctx.quadraticCurveTo(x + lean * 0.4 - w / 4, -h * 0.6, x + lean, -h);
    ctx.quadraticCurveTo(x + lean * 0.4 + w / 4, -h * 0.6, x + w / 2, 0);
    ctx.closePath(); ctx.fill();
    if (r() < 0.62) { // seed head on most, so the stand is not uniform
      ctx.fillStyle = `rgb(${(142 * lum) | 0},${(122 * lum) | 0},${(84 * lum) | 0})`;
      ctx.beginPath();
      ctx.ellipse(x + lean, -h + h * 0.06, w * 0.85, h * 0.075, 0, 0, 7);
      ctx.fill();
    }
  }
  ctx.restore();
}

// A clover mat: round trifoliate leaves on short stalks, all low in the cell,
// so the sprite reads as ground cover rather than as something standing up.
function cloverCell(ctx, r, S) {
  ctx.save();
  ctx.translate(0, S - GUTTER);
  for (let i = 0; i < 22; i++) {
    const x = GUTTER + 14 + r() * (S - 2 * GUTTER - 28);
    const h = (0.16 + r() * 0.3) * (S - 2 * GUTTER);
    const lum = 0.74 + r() * 0.44;
    ctx.strokeStyle = `rgb(${(118 * lum) | 0},${(152 * lum) | 0},${(92 * lum) | 0})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, -h); ctx.stroke();
    const lr = 9 + r() * 7;
    ctx.fillStyle = `rgb(${(150 * lum) | 0},${(192 * lum) | 0},${(118 * lum) | 0})`;
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k / 3) * Math.PI * 2 + r() * 0.2;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * lr * 0.72, -h + Math.sin(a) * lr * 0.72, lr * 0.66, lr * 0.55, a, 0, 7);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Heather: woody sprigs, small scale-leaves crowded up the stem, a lighter
// flowering head. Dry, sparse, and stiff — the opposite silhouette to a fern.
function heatherCell(ctx, r, S) {
  ctx.save();
  ctx.translate(0, S - GUTTER);
  for (let i = 0; i < 13; i++) {
    const x = GUTTER + 12 + r() * (S - 2 * GUTTER - 24);
    const h = (0.34 + r() * 0.4) * (S - 2 * GUTTER);
    const lean = (r() - 0.5) * h * 0.34;
    const lum = 0.72 + r() * 0.4;
    ctx.strokeStyle = `rgb(${(126 * lum) | 0},${(120 * lum) | 0},${(88 * lum) | 0})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.quadraticCurveTo(x + lean * 0.4, -h * 0.6, x + lean, -h);
    ctx.stroke();
    const steps = 9;
    for (let k = 2; k <= steps; k++) {
      const t = k / steps;
      const px = x + lean * t * t, py = -h * t;
      const lw = 4 + r() * 3;
      // Scale-leaves low on the stem, the flowering head at the top.
      const flower = t > 0.66;
      ctx.fillStyle = flower
        ? `rgb(${(196 * lum) | 0},${(170 * lum) | 0},${(190 * lum) | 0})`
        : `rgb(${(132 * lum) | 0},${(158 * lum) | 0},${(104 * lum) | 0})`;
      for (const s of [1, -1]) {
        ctx.beginPath();
        ctx.ellipse(px + s * lw * 0.9, py, lw, lw * 0.62, 0, 0, 7);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/* Flood transparent texels with the average opaque colour: mip levels blend
   RGB regardless of alpha, and black under a thin blade's cutout crushes the
   whole sprite toward black two mips down.

   This CANNOT be done on the canvas — 2D canvases store premultiplied
   alpha, so any RGB written under alpha 0 is discarded on the spot (the
   first version of this file did exactly that, and every blade rendered as
   a black silhouette). The fill happens on the raw pixel copy instead, and
   the texture uploads those bytes directly. */
function bleedPixels(d) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  if (!n) return;
  r = (r / n) | 0; g = (g / n) | 0; b = (b / n) | 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 40) { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
}

/* The atlas is seed-independent — like Unity's grass textures it is an
   asset, not a generated world feature — so one canvas serves every world
   and the cache never grows. */
export function makeDetailAtlas({ anisotropy = 4 } = {}) {
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  const cell = SIZE / CELLS;
  const draw = [
    // Blades are deliberately chunky: a 3-px blade is gone two mip levels
    // down, and grass that only exists at mip 0 reads as flickering dirt.
    (c, r) => grassCell(c, r, cell, 20, 0.5, 0.94, 13),
    (c, r) => grassCell(c, r, cell, 34, 0.34, 0.8, 11),
    (c, r) => flowerCell(c, r, cell),
    (c, r) => weedCell(c, r, cell),
    (c, r) => fernCell(c, r, cell),
    (c, r) => reedCell(c, r, cell),
    (c, r) => cloverCell(c, r, cell),
    (c, r) => heatherCell(c, r, cell),
    // Cell 8: dry straw, the same blade shape run short and sparse. Not
    // reachable from the default prototype set — it is here so an authored
    // prototype can ask for a burnt-out variant without a code change.
    (c, r) => grassCell(c, r, cell, 14, 0.28, 0.62, 9),
  ];
  for (let i = 0; i < draw.length; i++) {
    ctx.save();
    ctx.translate((i % CELLS) * cell, Math.floor(i / CELLS) * cell);
    ctx.beginPath(); ctx.rect(0, 0, cell, cell); ctx.clip();
    draw[i](ctx, rng(0x5eed + i * 7919));
    ctx.restore();
  }

  // Raw-pixel upload: the bleed fill survives (see bleedPixels), and the rows
  // are flipped by hand so v=0 is the sprite's bottom — the same orientation
  // atlasCellUv assumes.
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  bleedPixels(img.data);
  const flipped = new Uint8Array(img.data.length);
  const rowBytes = SIZE * 4;
  for (let y = 0; y < SIZE; y++) {
    flipped.set(img.data.subarray(y * rowBytes, (y + 1) * rowBytes), (SIZE - 1 - y) * rowBytes);
  }
  const texture = new THREE.DataTexture(flipped, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  cached = { texture, cells: CELLS, size: SIZE, gutter: GUTTER };
  return cached;
}

// UV rectangle of an atlas cell, inset past the gutter so filtering never
// samples the neighbour sprite.
export function atlasCellUv(cellIndex) {
  const inset = (GUTTER * 0.5) / SIZE;
  const w = 1 / CELLS;
  const cx = (cellIndex % CELLS) * w;
  // Canvas y runs down, texture v runs up: flip the row.
  const cy = 1 - w - Math.floor(cellIndex / CELLS) * w;
  return { u0: cx + inset, v0: cy + inset, u1: cx + w - inset, v1: cy + w - inset };
}
