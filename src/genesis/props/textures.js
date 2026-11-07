// Procedural builder-block textures: 512² canvas maps generated at first use
// and cached per style:kind — no assets, no network (CSP-safe), seeded rng so
// the editor and VSight grow the identical surface. Maps are grayscale-biased
// so each part's color tints the shared canvas; a tangent-space normal map is
// derived from the same pixels (Sobel over luminance) for real relief.
//
// TEXTURE STYLES are genre skins over the same kinds — the door that reads
// battle-royale cartoon, survival-horror rot, or MMORPG medieval is the same
// geometry with a different style:
//   real    — grounded PBR-ish surfaces (default)
//   toon    — flat fills, posterized bands, inked seams, soft relief
//   grim    — stains, mold, drips, cracks, deep relief, darkened
//   fantasy — aged + carved: border ornament, rune bands, worn warmth
// A style is picked by the structure theme (themes.js) or per placement
// (record.style); blockMaps(kind, style) returns the dressed maps.

import * as THREE from "three";

const cache = new Map();

function rng(seedStr) {
  let s = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) { s ^= seedStr.charCodeAt(i); s = Math.imul(s, 0x01000193); }
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Relief strength per kind — mortar joints cut deep, plaster barely ripples.
const RELIEF = {
  plaster: 0.9, concrete: 1.3, wood: 1.6, stone: 2.4, shingle: 2.2,
  brick: 2.6, metal: 0.8, rooftile: 3.0, board: 1.8, foliage: 2.2,
};

export const TEXTURE_STYLES = {
  real: { noise: 1, relief: 1, posterize: 0, outline: 0, stains: 0, cracks: 0, ornament: 0, tone: [1, 1, 1] },
  toon: { noise: 0.12, relief: 0.35, posterize: 5, outline: 0.8, stains: 0, cracks: 0, ornament: 0, tone: [1.08, 1.05, 1.0] },
  grim: { noise: 1.4, relief: 1.35, posterize: 0, outline: 0, stains: 1, cracks: 1, ornament: 0, tone: [0.84, 0.83, 0.81] },
  fantasy: { noise: 1, relief: 1.15, posterize: 0, outline: 0, stains: 0.35, cracks: 0.25, ornament: 1, tone: [1.02, 0.98, 0.9] },
};

const KINDS = {
  // Soft mottled render — interior/exterior wall finish.
  plaster(ctx, S, r, st) {
    ctx.fillStyle = "#d8d5d0";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600 * st.noise; i++) {
      const v = (198 + r() * 44) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.22)`;
      ctx.beginPath();
      ctx.arc(r() * S, r() * S, 1 + r() * 10, 0, 7);
      ctx.fill();
    }
    // trowel sweeps: long faint arcs a plasterer leaves behind
    ctx.lineWidth = 2;
    for (let i = 0; i < 40 * st.noise; i++) {
      const v = (200 + r() * 30) | 0;
      ctx.strokeStyle = `rgba(${v},${v},${v},0.10)`;
      ctx.beginPath();
      ctx.arc(r() * S, r() * S, 40 + r() * 120, r() * 7, r() * 7 + 0.5 + r());
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(120,118,114,0.28)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 2 * st.noise; i++) {
      let x = r() * S, y = r() * S * 0.4;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (r() - 0.5) * 30; y += 20 + r() * 30; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  },
  // Speckled aggregate, formwork seams, faint stains, hairline cracks.
  concrete(ctx, S, r, st) {
    ctx.fillStyle = "#c9cbcd";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 60 * st.noise; i++) {
      const v = (165 + r() * 60) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.16)`;
      ctx.beginPath();
      ctx.arc(r() * S, r() * S, 12 + r() * 50, 0, 7);
      ctx.fill();
    }
    for (let i = 0; i < 9000 * st.noise; i++) {
      const v = (120 + r() * 130) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
      ctx.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2);
    }
    for (let y = 128; y < S; y += 128) { // formwork pour seams + tie divots
      ctx.fillStyle = "rgba(105,107,110,0.45)";
      ctx.fillRect(0, y, S, 2);
      ctx.fillStyle = "rgba(230,231,232,0.5)";
      ctx.fillRect(0, y + 2, S, 1);
      for (const fx of [0.25, 0.75]) {
        ctx.fillStyle = "rgba(112,114,117,0.6)";
        ctx.beginPath(); ctx.arc(S * fx + (r() - 0.5) * 30, y - 40 - r() * 40, 4, 0, 7); ctx.fill();
      }
    }
    ctx.strokeStyle = "rgba(90,92,95,0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4 * st.noise; i++) {
      let x = r() * S, y = r() * S;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 60; y += r() * 40; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  },
  // Horizontal planks: seams, streaky grain, the odd knot.
  wood(ctx, S, r, st) {
    ctx.fillStyle = "#d8cfc2";
    ctx.fillRect(0, 0, S, S);
    const plank = 128;
    for (let y = 0; y < S; y += plank) {
      for (let i = 0; i < 220 * st.noise; i++) {
        const v = (170 + r() * 70) | 0;
        ctx.strokeStyle = `rgba(${v},${v - 8},${v - 18},0.35)`;
        ctx.lineWidth = 1 + r() * 2;
        const gy = y + 5 + r() * (plank - 10), wob = (r() - 0.5) * 10;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.bezierCurveTo(S * 0.33, gy + wob, S * 0.66, gy - wob, S, gy);
        ctx.stroke();
      }
      if (r() < 0.85 * Math.min(st.noise * 2, 1)) { // knot with grain rings
        const kx = r() * S, ky = y + plank * (0.3 + r() * 0.4);
        for (let q = 3; q > 0; q--) {
          ctx.strokeStyle = `rgba(120,100,84,${0.18 * q})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(kx, ky, 4 + q * 4, 3 + q * 3, 0, 0, 7); ctx.stroke();
        }
        ctx.fillStyle = "rgba(110,92,76,0.6)";
        ctx.beginPath(); ctx.ellipse(kx, ky, 5, 4, 0, 0, 7); ctx.fill();
      }
      ctx.fillStyle = "rgba(70,60,50,0.55)";
      ctx.fillRect(0, y + plank - 3, S, 3); // seam
      ctx.fillStyle = "rgba(255,250,240,0.18)";
      ctx.fillRect(0, y, S, 2); // caught light on the plank's top edge
    }
  },
  // Running-bond block courses with dark mortar and per-block wear.
  stone(ctx, S, r, st) {
    ctx.fillStyle = "#6e6d6a";
    ctx.fillRect(0, 0, S, S); // mortar shows through the joints
    const course = 64, block = 128;
    for (let y = 0, row = 0; y < S; y += course, row++) {
      const off = row % 2 ? block / 2 : 0;
      for (let x = -block; x < S; x += block) {
        const v = (168 + r() * 52) | 0;
        ctx.fillStyle = `rgb(${v},${v},${v - 4})`;
        const bx = x + off + 4, by = y + 4, bw = block - 8, bh = course - 8;
        ctx.fillRect(bx, by, bw, bh);
        for (let i = 0; i < 60 * st.noise; i++) {
          const s = (140 + r() * 90) | 0;
          ctx.fillStyle = `rgba(${s},${s},${s},0.35)`;
          ctx.fillRect(bx + r() * bw, by + r() * bh, 2, 2);
        }
        ctx.strokeStyle = "rgba(120,120,116,0.3)";
        ctx.lineWidth = 1;
        for (let i = 0; i < 2 * st.noise; i++) {
          const sx = bx + r() * bw * 0.6, sy = by + r() * bh;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 20 + r() * 30, sy - 8 - r() * 10); ctx.stroke();
        }
        ctx.strokeStyle = "rgba(60,60,58,0.35)";
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = "rgba(255,252,246,0.22)";
        ctx.fillRect(bx, by, bw, 2); // top edge catches the sun
      }
    }
  },
  // Overlapping shingle rows: shadowed bottom edges, staggered seams.
  shingle(ctx, S, r, st) {
    ctx.fillStyle = "#c4c0bc";
    ctx.fillRect(0, 0, S, S);
    const row = 64, tab = 64;
    for (let y = 0, k = 0; y < S; y += row, k++) {
      const off = k % 2 ? tab / 2 : 0;
      for (let x = -tab; x < S; x += tab) {
        const v = (170 + r() * 55) | 0;
        ctx.fillStyle = `rgb(${v},${v - 4},${v - 8})`;
        ctx.fillRect(x + off + 2, y, tab - 4, row - 5);
        for (let i = 0; i < 5 * st.noise; i++) { // weather streaks per tab
          const sv = (150 + r() * 40) | 0;
          ctx.fillStyle = `rgba(${sv},${sv - 4},${sv - 8},0.3)`;
          ctx.fillRect(x + off + 3 + r() * (tab - 8), y + r() * 10, 2, row - 10);
        }
      }
      const g = ctx.createLinearGradient(0, y + row - 16, 0, y + row);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y + row - 16, S, 16);
    }
  },
  // Running-bond brick with recessed mortar joints — tint sets the clay.
  brick(ctx, S, r, st) {
    ctx.fillStyle = "#8a8683";
    ctx.fillRect(0, 0, S, S); // mortar
    const course = 24, brick = 84, gap = 4;
    for (let y = 0, row = 0; y < S; y += course, row++) {
      const off = (row % 2) * (brick / 2);
      for (let x = -brick; x < S + brick; x += brick) {
        const v = (176 + r() * 56) | 0;
        ctx.fillStyle = `rgb(${v},${(v * 0.94) | 0},${(v * 0.9) | 0})`;
        const bx = x + off + gap / 2, by = y + gap / 2, bw = brick - gap, bh = course - gap;
        ctx.fillRect(bx, by, bw, bh);
        for (let i = 0; i < 16 * st.noise; i++) { // kiln speckle
          const s = (130 + r() * 110) | 0;
          ctx.fillStyle = `rgba(${s},${(s * 0.92) | 0},${(s * 0.88) | 0},0.35)`;
          ctx.fillRect(bx + r() * bw, by + r() * bh, 1.6, 1.6);
        }
        if (r() < 0.12 * st.noise) { // the odd over-fired dark header
          ctx.fillStyle = "rgba(70,64,60,0.35)";
          ctx.fillRect(bx, by, bw, bh);
        }
        ctx.fillStyle = "rgba(255,250,244,0.16)";
        ctx.fillRect(bx, by, bw, 1.5);
        ctx.fillStyle = "rgba(50,46,44,0.25)";
        ctx.fillRect(bx, by + bh - 1.5, bw, 1.5);
      }
    }
  },
  // Painted panel steel: brushed sheen, seams, rivets, honest scratches.
  metal(ctx, S, r, st) {
    ctx.fillStyle = "#b9bcbf";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 900 * st.noise; i++) { // horizontal brushing
      const v = (170 + r() * 50) | 0;
      ctx.strokeStyle = `rgba(${v},${v + 2},${v + 4},0.12)`;
      ctx.lineWidth = 1;
      const y = r() * S;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y + (r() - 0.5) * 4); ctx.stroke();
    }
    for (let y = 0; y < S; y += 128) { // panel seams + rivet lines
      ctx.fillStyle = "rgba(92,95,98,0.55)";
      ctx.fillRect(0, y, S, 2);
      ctx.fillStyle = "rgba(235,237,239,0.4)";
      ctx.fillRect(0, y + 2, S, 1);
      for (let x = 16; x < S; x += 64) {
        ctx.fillStyle = "rgba(150,153,156,1)";
        ctx.beginPath(); ctx.arc(x, y + 12, 3.2, 0, 7); ctx.fill();
        ctx.fillStyle = "rgba(226,228,230,0.8)";
        ctx.beginPath(); ctx.arc(x - 0.8, y + 11.2, 1.2, 0, 7); ctx.fill();
      }
    }
    ctx.strokeStyle = "rgba(120,122,124,0.4)";
    for (let i = 0; i < 14 * st.noise; i++) { // scratches
      ctx.lineWidth = 0.8 + r();
      const x = r() * S, y = r() * S, a = r() * 7;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * (10 + r() * 60), y + Math.sin(a) * (10 + r() * 60));
      ctx.stroke();
    }
  },
  // Barrel roof tiles: cylindrical columns with real curvature in the
  // luminance, overlapped rows — the normal map does the heavy lifting.
  rooftile(ctx, S, r, st) {
    ctx.fillStyle = "#c8c2ba";
    ctx.fillRect(0, 0, S, S);
    const col = 64, row = 128;
    for (let x = 0; x < S; x += col) {
      const tone = 0.92 + r() * 0.16;
      for (let px = 0; px < col; px++) { // half-round profile across the tile
        const t = px / col;
        const v = (150 + 95 * Math.sin(t * Math.PI)) * tone;
        ctx.fillStyle = `rgb(${(v | 0)},${((v * 0.97) | 0)},${((v * 0.93) | 0)})`;
        ctx.fillRect(x + px, 0, 1, S);
      }
    }
    for (let y = row; y <= S; y += row) { // row overlaps: shadow + lit lip
      const g = ctx.createLinearGradient(0, y - 22, 0, y);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.5)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 22, S, 22);
      ctx.fillStyle = "rgba(255,252,246,0.25)";
      ctx.fillRect(0, y % S, S, 3);
    }
    for (let i = 0; i < 260 * st.noise; i++) { // lichen freckles
      const v = (140 + r() * 60) | 0;
      ctx.fillStyle = `rgba(${v},${v},${(v * 0.9) | 0},0.25)`;
      ctx.beginPath(); ctx.arc(r() * S, r() * S, 1 + r() * 3, 0, 7); ctx.fill();
    }
  },
  // Vertical board-and-batten: doors, fences, shed cladding.
  board(ctx, S, r, st) {
    ctx.fillStyle = "#d4cabc";
    ctx.fillRect(0, 0, S, S);
    const plank = 128;
    for (let x = 0; x < S; x += plank) {
      for (let i = 0; i < 200 * st.noise; i++) { // vertical grain
        const v = (168 + r() * 68) | 0;
        ctx.strokeStyle = `rgba(${v},${v - 10},${v - 20},0.33)`;
        ctx.lineWidth = 1 + r() * 1.6;
        const gx = x + 5 + r() * (plank - 10), wob = (r() - 0.5) * 9;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.bezierCurveTo(gx + wob, S * 0.33, gx - wob, S * 0.66, gx, S);
        ctx.stroke();
      }
      if (r() < 0.7 * Math.min(st.noise * 2, 1)) {
        const ky = r() * S, kx = x + plank * (0.3 + r() * 0.4);
        ctx.fillStyle = "rgba(115,96,80,0.55)";
        ctx.beginPath(); ctx.ellipse(kx, ky, 3, 5, 0, 0, 7); ctx.fill();
      }
      ctx.fillStyle = "rgba(70,60,50,0.55)";
      ctx.fillRect(x + plank - 3, 0, 3, S); // gap between boards
      ctx.fillStyle = "rgba(255,250,240,0.16)";
      ctx.fillRect(x, 0, 2, S);
    }
  },
  // Massed leaves for tree canopies and bushes: layered leaf lenses over a
  // green-gray base, dark air-gap pockets underneath so the Sobel normal digs
  // real depth between clusters. Kept close to neutral so each canopy's own
  // color (and a theme's foliage tint) drives the hue.
  foliage(ctx, S, r, st) {
    // Light like every kind — the part's leaf colour multiplies this canvas,
    // so a mid-tone base would render canopies near-black.
    ctx.fillStyle = "#c3cdab";
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 90 * st.noise; i++) { // shadow pockets between clusters
      const v = (118 + r() * 40) | 0;
      ctx.fillStyle = `rgba(${v},${v + 8},${v - 6},0.5)`;
      ctx.beginPath();
      ctx.ellipse(r() * S, r() * S, 14 + r() * 42, 10 + r() * 30, r() * 7, 0, 7);
      ctx.fill();
    }
    for (let i = 0; i < 2400 * st.noise; i++) { // the leaves themselves
      const lum = 0.72 + r() * 0.5;
      const v = (196 * lum) | 0, g = (214 * lum) | 0, b = (158 * lum) | 0;
      ctx.fillStyle = `rgba(${v},${g},${b},0.85)`;
      const x = r() * S, y = r() * S, len = 4 + r() * 9, a = r() * Math.PI;
      ctx.beginPath();
      ctx.ellipse(x, y, len, len * 0.42, a, 0, 7);
      ctx.fill();
      if (r() < 0.3) { // glint on the upper leaves
        ctx.fillStyle = `rgba(226,238,196,${0.12 + r() * 0.14})`;
        ctx.beginPath();
        ctx.ellipse(x - len * 0.2, y - len * 0.2, len * 0.5, len * 0.2, a, 0, 7);
        ctx.fill();
      }
    }
  },
};

/* ── style post-passes ── */

// Horror dressing: damp blotches, drip streaks down the surface, mold
// clusters with a faint green cast.
function stainsPass(ctx, S, r, amt) {
  for (let i = 0; i < 14 * amt; i++) {
    const x = r() * S, y = r() * S, rad = 20 + r() * 70;
    const g = ctx.createRadialGradient(x, y, rad * 0.2, x, y, rad);
    const a = 0.12 + r() * 0.16;
    g.addColorStop(0, `rgba(28,26,24,${a})`);
    g.addColorStop(1, "rgba(28,26,24,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 10 * amt; i++) { // drips
    const x = r() * S, y = r() * S * 0.7, len = 40 + r() * 160, w = 2 + r() * 3;
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, "rgba(30,28,26,0.28)");
    g.addColorStop(1, "rgba(30,28,26,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, len);
  }
  for (let i = 0; i < 8 * amt; i++) { // mold clusters
    const cx = r() * S, cy = r() * S;
    for (let k = 0; k < 26; k++) {
      const v = (70 + r() * 60) | 0;
      ctx.fillStyle = `rgba(${(v * 0.82) | 0},${v},${(v * 0.8) | 0},0.3)`;
      ctx.beginPath();
      ctx.arc(cx + (r() - 0.5) * 46, cy + (r() - 0.5) * 46, 1 + r() * 3, 0, 7);
      ctx.fill();
    }
  }
}

// Structural cracks: jagged branching dark polylines.
function cracksPass(ctx, S, r, amt) {
  ctx.strokeStyle = "rgba(24,23,22,0.5)";
  for (let i = 0; i < 6 * amt; i++) {
    ctx.lineWidth = 0.8 + r() * 1.4;
    let x = r() * S, y = r() * S;
    ctx.beginPath(); ctx.moveTo(x, y);
    const steps = 5 + (r() * 5) | 0;
    for (let k = 0; k < steps; k++) {
      x += (r() - 0.5) * 56; y += (r() - 0.3) * 46;
      ctx.lineTo(x, y);
      if (r() < 0.3) { // branch
        ctx.moveTo(x, y);
        ctx.lineTo(x + (r() - 0.5) * 40, y + r() * 30);
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  }
}

// Fantasy dressing: carved double border, corner accents, a rune band.
function ornamentPass(ctx, S, r) {
  const dark = "rgba(52,48,44,0.4)", lite = "rgba(255,250,240,0.22)";
  for (const [inset, w] of [[12, 2], [22, 1.2]]) {
    ctx.strokeStyle = dark; ctx.lineWidth = w;
    ctx.strokeRect(inset, inset, S - inset * 2, S - inset * 2);
    ctx.strokeStyle = lite; ctx.lineWidth = 1;
    ctx.strokeRect(inset + 1.5, inset + 1.5, S - inset * 2 - 3, S - inset * 2 - 3);
  }
  for (const [cx, cy] of [[12, 12], [S - 12, 12], [12, S - 12], [S - 12, S - 12]]) {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 7, cy); ctx.lineTo(cx, cy + 7); ctx.lineTo(cx - 7, cy);
    ctx.closePath(); ctx.fill();
  }
  // rune band: angular glyphs along one carved course
  const by = S * (0.3 + r() * 0.4);
  ctx.strokeStyle = "rgba(46,42,38,0.42)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const gx = 44 + i * ((S - 88) / 7), gh = 14 + r() * 8;
    ctx.beginPath();
    ctx.moveTo(gx, by - gh / 2); ctx.lineTo(gx, by + gh / 2); // stave
    const arms = 1 + (r() * 2) | 0;
    for (let a = 0; a < arms; a++) {
      const ay = by - gh / 2 + r() * gh;
      ctx.moveTo(gx, ay);
      ctx.lineTo(gx + (r() < 0.5 ? -1 : 1) * (5 + r() * 7), ay + (r() - 0.5) * 10);
    }
    ctx.stroke();
  }
}

// Toon finishing: quantize tones into flat bands, then ink the strong edges.
function posterizeOutlinePass(canvas, levels, outline) {
  const S = canvas.width, ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, S, S), d = img.data;
  if (levels > 0) {
    const q = 255 / (levels - 1);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.round(d[i] / q) * q;
      d[i + 1] = Math.round(d[i + 1] / q) * q;
      d[i + 2] = Math.round(d[i + 2] / q) * q;
    }
  }
  if (outline > 0) {
    const lum = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) lum[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const at = (x, y) => lum[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const g = Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(at(x, y + 1) - at(x, y - 1));
        if (g > 26) {
          const o = (y * S + x) * 4, k = 1 - Math.min(1, (g - 26) / 90) * outline;
          d[o] *= k; d[o + 1] *= k; d[o + 2] *= k;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Style tone cast baked into the canvas (part colors still tint on top).
function tonePass(canvas, tone) {
  if (tone[0] === 1 && tone[1] === 1 && tone[2] === 1) return;
  const S = canvas.width, ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * tone[0]);
    d[i + 1] = Math.min(255, d[i + 1] * tone[1]);
    d[i + 2] = Math.min(255, d[i + 2] * tone[2]);
  }
  ctx.putImageData(img, 0, 0);
}

/* Roughness map from the same canvas: crevices scuff toward the part's full
   roughness, raised highlights polish a little below it. Constant roughness
   is the tell of a rendered surface — every material answers a moving light
   identically. The variation is small (×0.68 at the brightest texel) so
   nothing turns glossy; it just makes highlights track the surface story the
   color map is already telling. */
function roughnessCanvas(src) {
  const S = src.width;
  const px = src.getContext("2d").getImageData(0, 0, S, S).data;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const l = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    const v = Math.round(255 * (1 - l * 0.32)); // texel multiplies material.roughness
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

// Tangent-space normal map from the color canvas's luminance (Sobel, wrapped
// edges so tiling stays seamless). flipY-aware: G encodes +dy in canvas space.
function normalCanvas(src, strength) {
  const S = src.width;
  const px = src.getContext("2d").getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    h[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
  }
  const out = document.createElement("canvas");
  out.width = out.height = S;
  const octx = out.getContext("2d");
  const img = octx.createImageData(S, S);
  const d = img.data;
  // The wrapped neighbour indices are the same for every row, so they are
  // computed once instead of doing two modulos per sample through a closure.
  // Output is byte-identical to the straightforward version (verified over
  // every kind × style 512² map); this is purely the same arithmetic with the
  // addressing hoisted out of the inner loop.
  const xp = new Int32Array(S), xm = new Int32Array(S);
  for (let x = 0; x < S; x++) { xp[x] = (x + 1) % S; xm[x] = (x - 1 + S) % S; }
  for (let y = 0; y < S; y++) {
    const row = y * S, up = ((y - 1 + S) % S) * S, dn = ((y + 1) % S) * S;
    for (let x = 0; x < S; x++) {
      const dx = (h[row + xp[x]] - h[row + xm[x]]) * strength;
      const dy = (h[dn + x] - h[up + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (row + x) * 4;
      d[o] = 127.5 * (1 - dx * inv);
      d[o + 1] = 127.5 * (1 + dy * inv);
      d[o + 2] = 255 * ((1 * inv + 1) / 2);
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// → { map, normal } base textures for kind+style; callers clone() to set repeat.
export function blockMaps(kind, style = "real") {
  const k = KINDS[kind] ? kind : "plaster";
  const sName = TEXTURE_STYLES[style] ? style : "real";
  const st = TEXTURE_STYLES[sName];
  const key = sName + ":" + k;
  if (!cache.has(key)) {
    const S = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    const r = rng("blocktex:" + key);
    KINDS[k](ctx, S, r, st);
    if (st.stains) stainsPass(ctx, S, r, st.stains);
    if (st.cracks) cracksPass(ctx, S, r, st.cracks);
    if (st.ornament) ornamentPass(ctx, S, r);
    tonePass(canvas, st.tone);
    if (st.posterize || st.outline) posterizeOutlinePass(canvas, st.posterize, st.outline);
    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const normal = new THREE.CanvasTexture(normalCanvas(canvas, (RELIEF[k] ?? 1.5) * st.relief));
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.anisotropy = 4;
    const rough = new THREE.CanvasTexture(roughnessCanvas(canvas));
    rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
    rough.anisotropy = 4;
    cache.set(key, { map, normal, rough });
  }
  return cache.get(key);
}
