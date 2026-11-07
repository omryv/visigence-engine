/**
 * GRAMMAR CORE: the small pieces every seeded generator shares (Arcade's creatures, houses, trees and
 * village). A generator draws a STYLE DNA from its seed, then fills
 * slots with weighted choices whose weights are conditioned on that DNA and gated by compatibility tags.
 * The Blender preview's Python ports (tools/blender/v2/core/grammar_core.py and the Arcade grammars)
 * mirror these line for line; keep the weight order, the floor(x + 0.5) rounding and the clamps identical
 * when editing.
 */

export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Weighted choice with a pre-drawn roll in [0, 1). Returns null when nothing has weight. */
export function choose(roll, items, weight) {
  let total = 0;
  for (const it of items) total += weight(it);
  if (!(total > 0)) return null;
  let t = roll * total;
  for (const it of items) { t -= weight(it); if (t < 0) return it; }
  return items[items.length - 1];
}

/** An option's weight, conditioned on the DNA: `favor: {round: 0.8}` scales it by up to 1.8x toward round creatures. */
export function weightOf(option, dna) {
  let w = option.w ?? 1;
  for (const [gene, f] of Object.entries(option.favor ?? {})) w *= Math.max(0.05, 1 + f * (2 * dna[gene] - 1));
  return w;
}

/** Compatibility tags: `needs` requires every tag already chosen, `clash` forbids any of them. */
export function allows(option, tags) {
  return (option.needs ?? []).every(t => tags.has(t)) && !(option.clash ?? []).some(t => tags.has(t));
}

/** Lighten or darken an sRGB hex colour by the tone gene (+-14 levels): siblings differ, families stay recognisable. */
export function toned(hex, tone) {
  const n = parseInt(hex.slice(1), 16);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(c => Math.min(255, Math.max(0, Math.floor(c + tone * 14 + 0.5))).toString(16).padStart(2, '0')).join('');
}

/**
 * Unit directions k * 2pi / 64, from half-angle square roots and the angle-sum recurrence: identical in JS and
 * Python, so no generator needs trigonometry (whose last bits differ between the two).
 */
export const DIRS64 = (() => {
  let c = 0, s = 1;
  for (let i = 0; i < 4; i++) { const nc = Math.sqrt((1 + c) / 2), ns = Math.sqrt((1 - c) / 2); c = nc; s = ns; }
  const q = [[1, 0]];
  for (let k = 1; k < 16; k++) { const a = q[k - 1][0], b = q[k - 1][1]; q.push([a * c - b * s, a * s + b * c]); }
  const out = [];
  for (let k = 0; k < 64; k++) {
    const quad = Math.floor(k / 16), i = k % 16, a = q[i][0], b = q[i][1];
    out.push(quad === 0 ? [a, b] : quad === 1 ? [-b, a] : quad === 2 ? [-a, -b] : [b, -a]);
  }
  return out;
})();
