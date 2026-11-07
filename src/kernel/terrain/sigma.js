/* sigma.js — THE FREEDOM MAP: how much of a world its statements decided.
 *
 * ── the question ──
 * A conditioned world (terrain/condition.js) is a seed's ground bent by the
 * least improbable change that makes its statements true. Near a statement
 * the ground is what was asked; far from every statement it is whatever the
 * seed grew. Between the two it is partly both, and nothing so far said how
 * much. A tool that lets somebody ask for a harbour here and a summit there
 * needs to show the rest of the map: which ground is still the seed's to
 * choose, which the asks have pinned, and which a hand has sculpted.
 *
 * ── the answer, and why it is exact for what it measures ──
 * The correction lives in a linear basis — the recipe's own fbm and continent
 * lattice streams (condition.js createBasis). The ground's sensitivity to
 * those lattice values at a point is a vector φ(x, z) = ∂shape/∂lattice, and
 * that vector is exactly what basis.addPoint writes into a row. The lattice
 * values are independent U[0, 1), variance s² = 1/12, so:
 *
 *     prior variance   s² · φᵀφ
 *     post  variance   s² · (φᵀφ − kᵀ G⁻¹ k),   k = W φ,  G = W Wᵀ
 *
 * with W the rows the solve held — the SAME rows, built by the same code:
 * a summit's two slope rows and a pad's ring rows as much as its height row,
 * and of the inequalities only those the solve had to hold at their bound
 * (one it met without holding constrains nothing). This is the kriging
 * variance: the spread of the ground at (x, z) over every world the seed's
 * lattice could have been that still says what the statements say. sigma is
 * its square root, in metres via terrain.height.
 *
 * ── what it is NOT ──
 * A linear-basis approximation, and the three things it leaves out are the
 * same three condition.js does not bend:
 *   the ridged crest   nonlinear (|noise| folded), so it has no φ. Its share
 *                      of the relief is neither prior nor posterior here.
 *   the domain warp    held fixed: φ is read at the warped coordinates, as
 *                      the solve reads them, so the warp's own randomness is
 *                      not counted as freedom.
 *   the sea floor      heights below the waterline are compressed by
 *                      SEA_FLOOR (heightfield.js); sigma is not, so under the
 *                      water it overstates the spread by up to 1/0.45.
 * So read it as "how much the asks decided of what they COULD decide", not
 * as an error bar on the whole height.
 *
 * ── one deliberate difference from the solve ──
 * The solve adds a Tikhonov term of 1e-6 of G's mean diagonal (condition.js,
 * RIDGE) to keep crowded statements bounded. Read as kriging, that term is
 * measurement noise, and at 1e-6 it is noise of about one thousandth of the
 * prior sigma: ~9 cm at every pinned point on the default world, a floor the
 * map would show as freedom that is not there (the solve meets its points to
 * the millimetre). The variance is taken with SIGMA_RIDGE, a thousand times
 * smaller, which puts that floor at a few millimetres and is still enough to
 * factor the crowded rows a pad makes (tools/test/kernel/sigma.test.js measures both).
 *
 * Pure JS, deterministic: sqrt and the four operations, in a fixed order.
 */

import { seedChannel } from "../seed.js";
import { createHeightSampler } from "./heightfield.js";
import { createBasis, LEVEL_INSET } from "./condition.js";

export const SIGMA_RIDGE = 1e-9;
const NOISE_VARIANCE = 1 / 12;

/* Provenance codes, one byte a cell. */
export const PROVENANCE = { FREE: 0, CONDITIONED: 1, AUTHORED: 2 };

/**
 * posteriorSigma(params, { n = 65, sampler, ridge = SIGMA_RIDGE }) → {
 *   n, size,
 *   prior: Float32Array(n²)   sigma before any statement, metres
 *   post:  Float32Array(n²)   sigma given the statements, metres
 *   ratio: Float32Array(n²)   post / prior (1 where prior is 0)
 *   stats: { priorMedian, postMedian, atStatements, interiorHalved, rows }
 * }
 * Grid cell (i, j) is world ((i/(n−1) − ½)·size, (j/(n−1) − ½)·size), row-
 * major in j, the layout bakeHeightField uses. `sampler` may be passed when
 * the caller already built one from these params; it is only read for its
 * conditioning, and passing it saves a whole solve (condition.js: up to
 * ~2.8 s for a list at MAX_ROWS). `ridge` is the Tikhonov term relative to
 * the mean diagonal (see the header) and is there to be measured, not tuned.
 * atStatements is the largest post sigma at any point a statement the solve
 * stated pins outright (null when there is none; a record MAX_ROWS dropped
 * pins nothing); interiorHalved the share of the cells inside the seed
 * screen's interior (the centred LEVEL_INSET of the world) where the
 * statements at least halved sigma.
 */
export function posteriorSigma(params, { n = 65, sampler, ridge = SIGMA_RIDGE } = {}) {
  const t = params.terrain;
  const size = t.size;
  const { variance, records, rows } = freedom(params, sampler, ridge);
  const metres = (v) => Math.sqrt(v) * t.height;

  const N = n * n;
  const prior = new Float32Array(N), post = new Float32Array(N), ratio = new Float32Array(N);
  const half = (LEVEL_INSET * size) / 2;
  let inside = 0, halved = 0;
  for (let j = 0; j < n; j++) {
    const z = (j / (n - 1) - 0.5) * size;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * size;
      const [a, b] = variance(x, z);
      const at = j * n + i;
      prior[at] = metres(a);
      post[at] = metres(b);
      ratio[at] = a > 0 ? Math.sqrt(b / a) : 1;
      if (Math.abs(x) <= half && Math.abs(z) <= half) {
        inside++;
        if (ratio[at] < 0.5) halved++;
      }
    }
  }

  let atStatements = null;
  for (const [x, z] of pinnedPoints(records, size)) {
    const s = metres(variance(x, z)[1]);
    if (atStatements === null || s > atStatements) atStatements = s;
  }
  return {
    n, size, prior, post, ratio,
    stats: {
      priorMedian: median(prior), postMedian: median(post), atStatements,
      interiorHalved: inside ? halved / inside : 0, rows,
    },
  };
}

/** The same two sigmas at chosen points, `[[x, z], …]` → `[{ prior, post }]`
    in metres — for a probe that wants the freedom at a place rather than a
    map of it. One factorisation for the whole list. */
export function sigmaAt(params, points, { sampler, ridge = SIGMA_RIDGE } = {}) {
  const { variance } = freedom(params, sampler, ridge);
  const metres = (v) => Math.sqrt(v) * params.terrain.height;
  return points.map(([x, z]) => {
    const [a, b] = variance(x, z);
    return { prior: metres(a), post: metres(b) };
  });
}

/* The one piece of arithmetic both readers share: factor the held rows once,
   and return (x, z) → [prior variance, post variance] in shape units². */
function freedom(params, sampler, ridge) {
  const t = params.terrain;
  const height = sampler || createHeightSampler(params);
  const system = height.conditioning?.system || null;
  // The basis is a pure function of (terrain, seed, inv): rebuilt here it is
  // the solve's own, key for key — heightfield.js derives seed and inv so.
  const basis = system?.basis || createBasis({ terrain: t, seed: seedChannel(params.seed, "terrain"), inv: t.frequency / t.size });
  const rows = system ? system.used.map((c) => c.row) : [];
  const m = rows.length;

  // Which rows touch each lattice value, so k = Wφ costs φ's few dozen
  // entries rather than m whole rows.
  const touch = new Map();
  rows.forEach((row, i) => {
    for (const [key, w] of row) {
      const list = touch.get(key);
      if (list) list.push(i, w); else touch.set(key, [i, w]);
    }
  });
  const L = m ? cholesky(rows, ridge) : null;
  const k = new Float64Array(m), y = new Float64Array(m);

  function variance(x, z) {
    const phi = new Map();
    basis.addPoint(phi, 1, x, z);
    let pp = 0;
    k.fill(0);
    for (const [key, w] of phi) {
      pp += w * w;
      const list = touch.get(key);
      if (list) for (let a = 0; a < list.length; a += 2) k[list[a]] += list[a + 1] * w;
    }
    // kᵀG⁻¹k = |L⁻¹k|²: one forward solve.
    let q = 0;
    for (let i = 0; i < m; i++) {
      let s = k[i];
      for (let c = 0; c < i; c++) s -= L[i * m + c] * y[c];
      y[i] = s / L[i * m + i];
      q += y[i] * y[i];
    }
    const post = pp - q;
    return [NOISE_VARIANCE * pp, NOISE_VARIANCE * (post > 0 ? post : 0)];
  }
  /* Only the records that stated rows: one MAX_ROWS dropped was never
     solved, and its points are no more pinned than any other ground. Read
     as "pinned", a dropped coast was measured showing 43.5 m of "sigma at
     the statements", which a caller cannot tell from an unmet one. */
  const stated = new Set((system?.all || []).map((c) => c.record));
  const records = (system?.records || []).filter((_, i) => stated.has(i));
  return { variance, records, rows: m };
}

/**
 * provenanceGrid(params, sigmaResult, { pinnedRatio = 0.5 }) → Uint8Array(n²)
 *   0 FREE         the seed's own ground: the statements left at least
 *                  pinnedRatio of its sigma
 *   1 CONDITIONED  the statements pinned it: ratio < pinnedRatio
 *   2 AUTHORED     inside the radius of a sculpt stroke (terrain.sculpt) —
 *                  a hand decided it, whatever the statements say, because
 *                  strokes are replayed over the conditioned ground
 * Same grid and layout as the sigma result it reads.
 */
export function provenanceGrid(params, sigmaResult, { pinnedRatio = 0.5 } = {}) {
  const { n, size, ratio } = sigmaResult;
  const strokes = (params.terrain?.sculpt || []).filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.r) && s.r > 0);
  const out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = (j / (n - 1) - 0.5) * size;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * size;
      const at = j * n + i;
      let code = ratio[at] < pinnedRatio ? PROVENANCE.CONDITIONED : PROVENANCE.FREE;
      for (const s of strokes) {
        const dx = x - s.x, dz = z - s.z;
        if (dx * dx + dz * dz < s.r * s.r) { code = PROVENANCE.AUTHORED; break; }
      }
      out[at] = code;
    }
  }
  return out;
}

/* The points a record pins outright — an equality at a single place. A level
   is a mean, a corridor and a ray's span are bounds, so none of them pins a
   point; a ray pins its far end only when it is a contact with a stated h
   (without one the far end is wherever the ground ends up). A shoreline's
   vertices count only where they are on the plate, because off it no row
   was stated. */
function pinnedPoints(records, size) {
  const on = (x, z) => Math.abs(x) <= size / 2 && Math.abs(z) <= size / 2;
  const out = [];
  for (const r of records) {
    if (r.type === "point" && r.op === "=") out.push([r.x, r.z]);
    else if (r.type === "summit" || r.type === "pad" || (r.type === "flat" && Number.isFinite(r.h))) out.push([r.x, r.z]);
    else if (r.type === "shoreline") for (const p of r.points) { if (on(p[0], p[1])) out.push(p); }
    else if (r.type === "ray" && r.contact && Number.isFinite(r.h) && on(r.at[0], r.at[1])) out.push(r.at);
  }
  return out;
}

function cholesky(rows, ridge) {
  const m = rows.length;
  const G = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      const [a, b] = rows[i].size <= rows[j].size ? [rows[i], rows[j]] : [rows[j], rows[i]];
      let s = 0;
      for (const [key, w] of a) { const v = b.get(key); if (v !== undefined) s += w * v; }
      G[i * m + j] = s; G[j * m + i] = s;
    }
  }
  let trace = 0;
  for (let i = 0; i < m; i++) trace += G[i * m + i];
  const lift = ridge * (trace / m);
  for (let i = 0; i < m; i++) G[i * m + i] += lift;
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = G[i * m + j];
      for (let c = 0; c < j; c++) s -= L[i * m + c] * L[j * m + c];
      L[i * m + j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j * m + j];
    }
  }
  return L;
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}
