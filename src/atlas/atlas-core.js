// ATLAS/ONE — reconstruction core.
//
// Pure math: no DOM, no WebGL, no three.js. Runs inside a Web Worker (and on
// the main thread as a fallback). Everything it returns is a typed array that
// can be transferred back with zero copies.
//
// The pipeline, in order:
//   1. segment       silhouette from the background, regularised
//   2. depth         shape-from-shading, used ONLY as surface detail later
//   3. camera        focal length estimate — actually used, see unproject()
//   4. inflate       Δu = −4 on the silhouette  →  per-part radius
//   5. volume        F(x,y,z) = H(x,y) − |z|
//   6. isosurface    surface nets on the shell band + Taubin λ/μ
//   7. displace      relief along the normal, limited by the local radius
//   8. shade         projection UVs, confidence, baked AO
//
// Why an isosurface at all: the original built two mirrored heightfield sheets
// stitched at the rim. Only 4.7% of its normals faced the camera and 69% faced
// sideways — the mesh was mostly rim wall, which is why it never read as solid.

import { topology } from './topology.js';
import { buildRig, normalizeWeightsF32 } from './rig.js';
import { shadingField, delightChart, normalDetail, planRelight } from './relight.js';
import { boundarySigma, sigmaGrid, sigmaSummary, SIGMA_CALIBRATED,
         PREDICTIVE, NU, LEVELS, intervalK } from './uncertainty.js';

export const PRESETS = {
  draft:    { w:190, tex:1024, triLabel:'10–40K',  tauLimb:1.00, tauTrunk:1.38,
              reliefAmp:0.18, reliefRad:3, smoothIters:9,  aoSamples:14, cloudStep:2, texSrc:768 },
  balanced: { w:280, tex:2048, triLabel:'80–250K', tauLimb:1.00, tauTrunk:1.38,
              reliefAmp:0.18, reliefRad:3, smoothIters:11, aoSamples:20, cloudStep:2, texSrc:1280 },
  archival: { w:360, tex:4096, triLabel:'300K–1M', tauLimb:1.00, tauTrunk:1.38,
              reliefAmp:0.18, reliefRad:4, smoothIters:13, aoSamples:26, cloudStep:1, texSrc:2048 },
};

/* ------------------------------------------------------------------ basics */

export function boxBlur(a, w, h, rad) {
  const N = w * h, t = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; c++; } }
    t[y * w + x] = s / c;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += t[yy * w + x]; c++; } }
    a[y * w + x] = s / c;
  }
}

// Exact Euclidean distance transform — Felzenszwalb & Huttenlocher's lower
// envelope of parabolas, O(N), separable, seeded with arbitrary f(y) so it can
// measure distance to a SUB-PIXEL boundary rather than to a pixel centre.
//
// This replaces the 3×3 chamfer transform the pipeline used to run. Chamfer
// level sets are octagons, not circles: its error is not a small uniform bias
// but a direction-dependent ripple of up to ~4%. Every downstream field is a
// function of D, and A = sqrt(2rD − D²) has dA/dD → ∞ at the boundary, so that
// ripple was amplified into the periodic sausage banding visible along every
// limb. An exact transform removes the artifact at its source rather than
// smoothing it away afterwards, which is what the boxBlur passes were doing.
function edt1d(f, n, d, v, zb) {
  const INF = 1e20;
  let k = 0; v[0] = 0; zb[0] = -INF; zb[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q*q) - (f[v[k]] + v[k]*v[k])) / (2*q - 2*v[k]);
    while (s <= zb[k]) { k--; s = ((f[q] + q*q) - (f[v[k]] + v[k]*v[k])) / (2*q - 2*v[k]); }
    k++; v[k] = q; zb[k] = s; zb[k+1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zb[k+1] < q) k++;
    const dq = q - v[k];
    d[q] = dq*dq + f[v[k]];
  }
}

// squared distance from every pixel to the nearest seed, where seed[i] holds
// the squared head-start of pixel i (0 for a seed, INF for anything else)
export function edt2d(seed, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n + 1), zb = new Float64Array(n + 2);
  const out = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed[y * w + x];
    edt1d(f, h, d, v, zb);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    edt1d(f, w, d, v, zb);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

// Signed distance to a SUB-PIXEL silhouette — Gustavson & Strand's
// anti-aliased EDT. Positive inside, negative outside, zero on the boundary.
//
// A binary mask is a staircase: a nearly-horizontal edge steps a whole pixel
// every few columns. That matters more here than anywhere else in the pipeline
// because dA/dD → ∞ as D → 0, so the rim amplifies every step into a visible
// ring — which is why limbs came out segmented like caterpillars however much
// the mesh was smoothed afterwards. Blurring the indicator with a small tent
// fits a local line to the staircase; its 0.5 level set is the sub-pixel edge,
// and (α − ½)∕|∇α| is the signed offset from a pixel centre to it. Seeding the
// exact transform with those offsets propagates them: f(y) = d₀(y)² makes the
// lower envelope return sqrt((x−y)² + d₀²), the true distance to a boundary
// running perpendicular to the offset.
// The matte the sub-pixel boundary is read off. Exported because σ has to be
// divided by the SAME gradient the offset was divided by — a second, slightly
// different smoothing here would put the boundary's variance in the wrong units
// and nothing would notice. See src/uncertainty.js.
export function coverageBlur(mask, w, h, coverage) {
  const N = w * h, a = new Float32Array(N);
  if (coverage) { a.set(coverage); boxBlur(a, w, h, 1); }
  else { for (let i = 0; i < N; i++) a[i] = mask[i]; boxBlur(a, w, h, 1); boxBlur(a, w, h, 1); }
  return a;
}

export function subpixelSignedDistance(mask, w, h, coverage) {
  const N = w * h, INF = 1e20;
  const a = coverageBlur(mask, w, h, coverage);

  const inSeed = new Uint8Array(N), outSeed = new Uint8Array(N), off = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, m = mask[i];
    const l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i;
    const u = y > 0 ? i - w : i, d = y < h - 1 ? i + w : i;
    if (mask[l] === m && mask[r] === m && mask[u] === m && mask[d] === m) continue;
    const gx = (a[r] - a[l]) * 0.5, gy = (a[d] - a[u]) * 0.5;
    const g = Math.hypot(gx, gy);
    // capped at half a pixel: the offset is now ADDED, and a straight edge that
    // crosses a pixel cannot be further than 0.5px from its centre. The old cap
    // of 1.5 was harmless under quadrature but over-corrects badly at a concave
    // cusp, where the blurred coverage gradient is least trustworthy.
    let d0 = g > 1e-4 ? Math.abs(a[i] - 0.5) / g : 0.5;
    if (d0 > 0.5) d0 = 0.5; else if (d0 < 0.02) d0 = 0.02;
    off[i] = d0;
    if (m) inSeed[i] = 1; else outSeed[i] = 1;
  }
  // The sub-pixel offset is added ALONG THE NORMAL, not in quadrature.
  //
  // Seeding the exact transform with f = d0² makes the lower envelope return
  // sqrt(L² + d0²), which is the distance to a boundary running PERPENDICULAR to
  // the offset — the one orientation that never occurs. For the case that does
  // occur, a boundary whose normal points back along the ray to the seed, the
  // answer is L + d0, and quadrature undershoots it by very nearly the whole d0:
  // sqrt(L² + d0²) − (L + d0) → −d0 for L ≫ d0. A flat ~0.5px bias, on every
  // field derived from D. It used to cancel — the radius was sqrt(u)/rho with
  // rho = sqrt(u)/D measured from the same transform, so D divided out — but the
  // radius is now D itself on the medial axis, and a 1px deficit on a 6px limb is
  // a 16% thickness error. So: find the Euclidean-nearest boundary seed, then add
  // that seed's own offset.
  const ri = nearestSeedD(inSeed, w, h), ro = nearestSeedD(outSeed, w, h);
  const phi = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = mask[i] ? ri : ro, sgn = mask[i] ? 1 : -1;
    const q = s.dist2[i];
    if (!(q < INF)) { phi[i] = sgn * 0.5; continue; }        // no boundary at all
    phi[i] = sgn * (Math.sqrt(q) + off[s.near[i]]);
  }
  return phi;
}

// Unsigned interior distance — the same field, clamped at the silhouette.
// Normalized convolution — average over VALID samples only.
//
// Every field in this pipeline is zero outside the silhouette, so blurring one
// with a plain box mixes those zeros in and the low-pass sags toward the rim.
// A band-pass residual f − lowpass(f) then grows a bright rind around the whole
// subject: not a feature of the image, just the filter falling off the edge of
// its own support. That rind was being displaced outward as relief, which is
// where the corrugation along every limb came from. Dividing by the identically
// blurred indicator is exact, because blurring is linear: blurᵖ(f·m)∕blurᵖ(m)
// is the mean of f over whatever part of the kernel actually landed on data.
export function maskedBlur(f, mask, w, h, rad, passes) {
  const N = w * h, a = new Float32Array(N), m = new Float32Array(N);
  for (let i = 0; i < N; i++) if (mask[i]) { a[i] = f[i]; m[i] = 1; }
  for (let p = 0; p < passes; p++) { boxBlur(a, w, h, rad); boxBlur(m, w, h, rad); }
  const o = new Float32Array(N);
  for (let i = 0; i < N; i++) o[i] = m[i] > 1e-4 ? a[i] / m[i] : 0;
  return o;
}

export function distanceTransform(mask, w, h, coverage) {
  const phi = subpixelSignedDistance(mask, w, h, coverage);
  for (let i = 0; i < phi.length; i++) if (phi[i] < 0) phi[i] = 0;
  return phi;
}

export function sampleBilinear(f, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  return f[y0 * w + x0] * (1 - fx) * (1 - fy) + f[y0 * w + x0 + 1] * fx * (1 - fy)
       + f[(y0 + 1) * w + x0] * (1 - fx) * fy + f[(y0 + 1) * w + x0 + 1] * fx * fy;
}

/* --------------------------------------------------------------- segment */

export function hasAlpha(px, N) { for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 250) return true; return false; }

// Blur the indicator and re-threshold at 0.5: a morphological open-close that
// deletes protrusions and notches thinner than the kernel. Inflating an
// unregularised boundary grows a needle spike at every 1px notch, because the
// local radius there really is ~1px.
// Morphological opening at a given scale, done exactly with the EDT rather than
// by blurring: O = the union of every radius-ρ disk that fits inside the mask,
//
//     O = { p : ∃c, |p−c| ≤ ρ and D(c) ≥ ρ }.
//
// That union has two properties, and it is worth being clear about which one is
// load-bearing here, because the obvious guess is the wrong one. It deletes any
// region whose inscribed radius is below ρ — and it also guarantees that every
// CONVEX arc of the resulting boundary has curvature radius at least ρ, since
// the result is a union of disks of that radius. The second property is the one
// that matters.
//
// The failure being fixed is a sharp convex tip, not a thin part. Measured on
// the wedge tips of the test figure: local feature size there is already 1.145
// and no pixel in the silhouette is under 1, yet the shell still comes out with
// 28 non-manifold edges. H = sqrt(2rD − D²) has to reach 0 at the silhouette for
// the surface to close, and along a straight edge the band where H is under a
// voxel is a thin strip that surface nets resolves cleanly. At a tip the
// boundary turns through most of 180° within a couple of pixels, so that band
// is a 2D patch instead of a strip: both sheets of F = H − |z| land inside the
// same cells over a small area, and get welded into edges shared by four
// triangles. Blunting the tip is what fixes it, and an opening blunts it to a
// known radius.
//
// The threshold is empirical, swept against mesh topology through the full
// pipeline over four shoulder geometries: ρ = 1 leaves 10/28/18 non-manifold
// edges on three of them, ρ = 2 clears all four. It is quoted in grid cells
// rather than image fractions on purpose — the constraint comes from the volume
// grid, which IS the working grid, so the same cell count is right at every
// preset. Cost at ρ = 2 is 0.01–0.06% of the silhouette.
export function openToScale(mask, w, h, rho) {
  const N = w * h, INF = 1e20;
  const phi = subpixelSignedDistance(mask, w, h, null);
  const seed = new Float64Array(N);
  let core = 0;
  for (let i = 0; i < N; i++) {
    const keep = mask[i] && phi[i] >= rho;
    seed[i] = keep ? 0 : INF;
    if (keep) core++;
  }
  // Nothing at all survives the erosion: the whole subject is below the
  // representable scale. Deleting it would be worse than rendering it badly, so
  // hand the mask back untouched and let the topology report say what it is.
  if (!core) return mask;
  // Both halves have to measure radius the same way. Eroding against a sub-pixel
  // distance and then dilating against a lattice one makes the two ρ's disagree
  // by up to half a pixel, and the disagreement is not even monotone in ρ: the
  // reachable squared offsets jump 0, 1, 2, 4, so ρ = 1.75 dilates no further
  // than ρ = 1.42 while eroding a third further in. Swept against mesh topology
  // that showed up as 0 non-manifold edges at ρ = 1, 10 at ρ = 1.5, 2 at ρ = 1.75
  // and 0 again at ρ = 2 — an artefact of the measure, not of the geometry. So
  // the dilation runs on the same sub-pixel transform as the erosion.
  const coreMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) coreMask[i] = seed[i] === 0 ? 1 : 0;
  const spread = subpixelSignedDistance(coreMask, w, h, null);
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = (mask[i] && spread[i] >= -rho) ? 1 : 0;
  return out;
}

export function regulariseMask(mask, w, h, rad, minFeature = 0) {
  const N = w * h, f = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = mask[i];
  boxBlur(f, w, h, rad);
  let out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = f[i] >= 0.5 ? 1 : 0;
  if (minFeature > 0) out = openToScale(out, w, h, minFeature);
  const lbl = new Int32Array(N).fill(-1);
  let comp = 0, best = 0, bestId = -1;
  for (let i = 0; i < N; i++) {
    if (out[i] && lbl[i] < 0) {
      const st = [i]; lbl[i] = comp; let cnt = 0;
      while (st.length) {
        const k = st.pop(); cnt++; const x = k % w, y = (k / w) | 0;
        const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
        for (const j of nb) if (j >= 0 && out[j] && lbl[j] < 0) { lbl[j] = comp; st.push(j); }
      }
      if (cnt > best) { best = cnt; bestId = comp; }
      comp++;
    }
  }
  for (let i = 0; i < N; i++) if (lbl[i] !== bestId) out[i] = 0;
  return out;
}

// How far from the background colour a pixel must sit before it counts as
// subject. A fixed floor of 0.10 (≈25/255) is catastrophic on the common case of
// a dark subject on a clean dark ground: a black sleeve reads 20–60, so the
// threshold cut through the garment itself. The separation to resolve is set by
// how noisy the BACKGROUND is, so measure that — but measure it ROBUSTLY.
//
// The rule this replaces was mean centre + q95 + 3.5·(q95 − q50). Every one of
// those statistics is fragile: the mean breaks down at the first outlier and q95
// by construction at 5%. A subject that runs off the edge of the frame
// contaminates far more than 5% of the 1px border, and past that point q95 IS a
// subject pixel, so the threshold leapt to its 0.42 cap and the border flood fill
// swallowed the subject whole — a cliff, not a slope. Median centre and MAD scale
// both have breakdown 0.5, so contamination degrades the estimate smoothly.
//
// Calibration: for isotropic Gaussian background noise ‖px − μ‖/σ ~ χ₃, whose
// median is 1.5382σ and whose MAD about that median is 0.4602σ. So
//     thr = median + 8.69·MAD = (1.5382 + 8.69·0.4602)σ = 5.538σ,
// a false-subject rate of 1e-6 per pixel. (The old rule sat at 7.196σ — 3.3e-11,
// far more conservative than anything the problem asks for, and it bought that
// conservatism with the breakdown point.)
export const MAD_K = 8.69;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

export function backgroundModel(samples) {
  const centre = [0, 1, 2].map((c) => quantile(samples.map((s) => s[c]).sort((a, b) => a - b), 0.5));
  const d = samples.map((s) => Math.hypot(s[0] - centre[0], s[1] - centre[1], s[2] - centre[2]) / 255)
                   .sort((a, b) => a - b);
  const med = quantile(d, 0.5);
  const mad = Math.max(quantile(d.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5), 4e-4);
  // The ceiling is a backstop against a runaway estimate, not a working limit.
  // It was 0.42, calibrated against the old rule's 7.196-sigma clean-frame value;
  // this rule sits at 5.538 sigma, and 0.42 would clip the estimator's own honest
  // answer once the border is ~40% contaminated. A breakdown-0.5 estimator cannot
  // run away below 50% contamination, and past that "background" is genuinely
  // ambiguous, so the backstop only has to catch that case.
  return { centre, med, mad, thr: Math.min(0.55, Math.max(0.014, med + MAD_K * mad)) };
}

export function segment(px, lum, w, h, hasA) {
  const N = w * h, bg = [0, 0, 0], bs = []; let bc = 0;
  const sample = (i) => { bg[0] += px[i * 4]; bg[1] += px[i * 4 + 1]; bg[2] += px[i * 4 + 2];
                          bs.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]); bc++; };
  for (let x = 0; x < w; x++) { sample(x); sample((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { sample(y * w); sample(y * w + w - 1); }
  bg[0] /= bc; bg[1] /= bc; bg[2] /= bc;
  let varr = 0;
  for (const s of bs) varr += (s[0] - bg[0]) ** 2 + (s[1] - bg[1]) ** 2 + (s[2] - bg[2]) ** 2;
  varr = Math.sqrt(varr / bs.length) / 255;

  let model = backgroundModel(bs);
  const distTo = (i, c) => Math.hypot(px[i*4] - c[0], px[i*4+1] - c[1], px[i*4+2] - c[2]) / 255;

  // background = everything within thr of the background colour that is also
  // CONNECTED to the frame, so an interior region that happens to match is kept
  const floodBg = (c, thr) => {
    const cand = new Uint8Array(N), out = new Uint8Array(N), st = [];
    for (let i = 0; i < N; i++) if (distTo(i, c) < thr) cand[i] = 1;
    const seed = (i) => { if (cand[i] && !out[i]) { out[i] = 1; st.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (st.length) {
      const i = st.pop(), x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !out[j] && cand[j]) { out[j] = 1; st.push(j); }
    }
    return out;
  };

  let isBg = new Uint8Array(N);
  if (hasA) { for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 128) isBg[i] = 1; }
  else {
    isBg = floodBg(model.centre, model.thr);
    // ONE re-estimation pass. The border frame is a thin and easily contaminated
    // sample; the region just labelled background is a much larger and cleaner
    // one. Re-fitting on it and re-segmenting removes the contamination path
    // entirely for any subject that does not surround the frame.
    const step = Math.max(1, Math.floor(N / 20000));
    const smp = [];
    for (let i = 0; i < N; i += step) if (isBg[i]) smp.push([px[i*4], px[i*4+1], px[i*4+2]]);
    if (smp.length > 256) {
      const m2 = backgroundModel(smp);
      if (m2.thr < model.thr * 1.5) { model = m2; isBg = floodBg(m2.centre, m2.thr); }
    }
  }
  const thr = model.thr;
  const dist = (i) => distTo(i, model.centre);
  const mask0 = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask0[i] = isBg[i] ? 0 : 1;

  // largest connected component
  const lbl = new Int32Array(N).fill(-1);
  let comp = 0, best = 0, bestId = -1;
  for (let i = 0; i < N; i++) {
    if (mask0[i] && lbl[i] < 0) {
      const st = [i]; lbl[i] = comp; let cnt = 0;
      while (st.length) {
        const k = st.pop(); cnt++; const x = k % w, y = (k / w) | 0;
        const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
        for (const j of nb) if (j >= 0 && mask0[j] && lbl[j] < 0) { lbl[j] = comp; st.push(j); }
      }
      if (cnt > best) { best = cnt; bestId = comp; }
      comp++;
    }
  }
  let components = 0;
  { const seen = {}; for (let i = 0; i < N; i++) if (lbl[i] >= 0) seen[lbl[i]] = (seen[lbl[i]] || 0) + 1;
    components = Object.values(seen).filter(v => v > N * 0.004).length; }
  const m2 = new Uint8Array(N);
  for (let i = 0; i < N; i++) m2[i] = (lbl[i] === bestId) ? 1 : 0;

  // fill interior holes
  const inv = new Uint8Array(N), st2 = [];
  for (let x = 0; x < w; x++) { if (!m2[x]) { inv[x] = 1; st2.push(x); } const b = (h - 1) * w + x; if (!m2[b]) { inv[b] = 1; st2.push(b); } }
  for (let y = 0; y < h; y++) { const l = y * w; if (!m2[l]) { inv[l] = 1; st2.push(l); } const r = y * w + w - 1; if (!m2[r]) { inv[r] = 1; st2.push(r); } }
  while (st2.length) {
    const i = st2.pop(), x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !m2[j] && !inv[j]) { inv[j] = 1; st2.push(j); }
  }
  for (let i = 0; i < N; i++) if (!m2[i] && !inv[i]) m2[i] = 1;

  // Open to 2 cells. The blur-and-rethreshold above is a separable box, so what
  // it removes depends on a feature's ORIENTATION — a diagonal wedge tapering to
  // a point survives a radius-2 blur that would have deleted the same feature
  // axis-aligned. An opening is isotropic, and it bounds the convex curvature of
  // the silhouette, which is what the isosurface actually needs. See openToScale.
  const mask = regulariseMask(m2, w, h, 2, 2);

  // HOW FAR THE REGULARISATION MOVED THE SILHOUETTE, in pixels, measured rather
  // than assumed. `regulariseMask` blurs the committed mask at radius 2,
  // re-thresholds at ½ and then opens to two cells — every one of those steps
  // moves the boundary, and at a curved or thin feature it moves it by more than
  // the sub-pixel matte ever localised it to. That displacement is a real
  // contribution to how well the silhouette's position is known, and without it
  // the uncertainty model has to absorb it as a mystery gain on the matte's own
  // noise. So: take the signed distance to the PRE-regularisation boundary and
  // read it at the boundary the regularisation produced. The rms of that IS the
  // shift, in the units σ wants.
  let regShift = 0;
  {
    const pre = subpixelSignedDistance(m2, w, h, null);
    let s2 = 0, nb = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, mv = mask[i];
      if (mask[i-1] === mv && mask[i+1] === mv && mask[i-w] === mv && mask[i+w] === mv) continue;
      const d = pre[i]; s2 += d * d; nb++;
    }
    regShift = nb ? Math.sqrt(s2 / nb) : 0;
  }

  // Anti-aliased coverage. The working grid is an area-averaged reduction of
  // the source, so a boundary pixel genuinely holds a fractional mix of subject
  // and background — that fraction is a sub-pixel matte, and it is a far better
  // estimate of where the silhouette runs than re-blurring the binary mask.
  // Only trusted where it agrees with the committed mask; where it disagrees
  // (a shadowed fold reading as background, say) the mask wins and the boundary
  // falls back to the half-pixel default.
  const alpha = new Float32Array(N);
  const a0 = thr * 0.35, a1 = thr * 1.65;
  for (let i = 0; i < N; i++) {
    const t = Math.max(0, Math.min(1, (dist(i) - a0) / (a1 - a0)));
    const v = hasA ? px[i * 4 + 3] / 255 : t * t * (3 - 2 * t);
    alpha[i] = (v >= 0.5) === !!mask[i] ? v : (mask[i] ? 0.75 : 0.25);
  }

  let minx = w, miny = h, maxx = 0, maxy = 0, area = 0, edge = 0, peri = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) {
      area++;
      if (x < minx) minx = x; if (y < miny) miny = y;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y;
      const b = (x === 0 || y === 0 || x === w - 1 || y === h - 1);
      const bd = (x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) || (y > 0 && !mask[i - w]) || (y < h - 1 && !mask[i + w]);
      if (bd) { peri++; if (b) edge++; }
    }
  }
  return { mask, alpha, thr, components, bounds: { minx, miny, maxx, maxy, area },
           edgeTouch: peri ? edge / peri : 0, bgVar: varr,
           // The background model's own scale, kept because the matte's noise is
           // what sets how well the boundary can be localised, and that is the
           // first term of the per-vertex σ. `mad` is the median absolute
           // deviation of the border pixels' colour distance from their median,
           // in units of /255 — a breakdown-0.5 estimator of the background's
           // spread, which is exactly the quantity the threshold is built from.
           bgMed: model.med, bgMad: model.mad, regShift };
}

/* ------------------------------------------------------- shape from shading */
// Kept from the original pipeline, but its output is now used ONLY as
// high-frequency surface detail. Single-image SFS is unreliable at low
// frequency (the bas-relief ambiguity), so the global shape comes from the
// well-posed inflation instead.

export function depthField(mask, dist, lum, px, w, h) {
  const N = w * h;
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; gx[i] = (lum[i + 1] - lum[i - 1]) * 0.5; gy[i] = (lum[i + w] - lum[i - w]) * 0.5;
  }
  let mx = 0; for (let i = 0; i < N; i++) if (dist[i] > mx) mx = dist[i];
  const R = Math.max(1, mx);
  const z0 = new Float32Array(N);
  for (let i = 0; i < N; i++) { if (!mask[i]) continue; const D = Math.min(dist[i], R); z0[i] = Math.sqrt(Math.max(0, 2 * R * D - D * D)) / R; }
  const ls = lum.slice(); boxBlur(ls, w, h, 1);

  // light azimuth from the occluding contour: there the surface normal lies in
  // the image plane along the silhouette normal, so I ≈ ambient + Lx·cosθ + Ly·sinθ
  const mf = new Float32Array(N); for (let i = 0; i < N; i++) mf[i] = mask[i];
  boxBlur(mf, w, h, 2); boxBlur(mf, w, h, 2);
  let S1 = 0, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, SI = 0, SIx = 0, SIy = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    if (mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) continue;
    let ox = -(mf[i + 1] - mf[i - 1]) * 0.5, oy = -(mf[i + w] - mf[i - w]) * 0.5;
    const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
    const I = ls[i];
    S1++; Sx += ox; Sy += oy; Sxx += ox * ox; Syy += oy * oy; Sxy += ox * oy; SI += I; SIx += I * ox; SIy += I * oy;
  }
  let az;
  const det = S1 * (Sxx * Syy - Sxy * Sxy) - Sx * (Sx * Syy - Sxy * Sy) + Sy * (Sx * Sxy - Sxx * Sy);
  if (S1 > 16 && Math.abs(det) > 1e-9) {
    const bx = (S1 * (SIx * Syy - SIy * Sxy) - SI * (Sx * Syy - Sy * Sxy) + Sy * (Sx * SIy - SIx * Sy)) / det;
    const by = (S1 * (Sxx * SIy - Sxy * SIx) - Sx * (Sx * SIy - Sy * SIx) + SI * (Sx * Sxy - Sxx * Sy)) / det;
    az = Math.atan2(by, bx);
  } else {
    let mgx = 0, mgy = 0; for (let i = 0; i < N; i++) if (mask[i]) { mgx += gx[i]; mgy += gy[i]; }
    az = Math.atan2(mgy, mgx);
  }
  // slant + albedo by interior validation (contour amplitude is biased ~30°)
  //
  // The fit's own goodness is kept, not just its parameters. Delighting divides
  // by this model, so how much of the interior's variation it actually explains
  // decides whether the division means anything: R² is the fraction of the
  // luminance variance the single-distant-light Lambertian model accounts for,
  // and it is the number the relight export gates on. See src/relight.js.
  let Lx, Ly, Lz, ambient = 0, albDenom;
  let fitR2 = 0, fitRms = 0, fitN = 0;
  {
    const interior = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!mask[i] || dist[i] < 3) continue;
      const n0x = -R * (z0[i + 1] - z0[i - 1]) * 0.5, n0y = -R * (z0[i + w] - z0[i - w]) * 0.5;
      const l = Math.hypot(n0x, n0y, 1);
      interior.push(n0x / l, n0y / l, 1 / l, ls[i]);
    }
    let bestSlant = 0.87, bestErr = Infinity, alpha = 0.6, beta = 0.1;
    if (interior.length >= 200) {
      for (let k = 0; k <= 24; k++) {
        const s = 0.26 + (1.31 - 0.26) * k / 24;
        const cx = Math.sin(s) * Math.cos(az), cy = Math.sin(s) * Math.sin(az), cz = Math.cos(s);
        let sd = 0, si = 0, sdd = 0, sdi = 0, n = 0;
        for (let t = 0; t < interior.length; t += 4) {
          const d = Math.max(0, interior[t] * cx + interior[t + 1] * cy + interior[t + 2] * cz), I = interior[t + 3];
          sd += d; si += I; sdd += d * d; sdi += d * I; n++;
        }
        const dn = n * sdd - sd * sd; if (Math.abs(dn) < 1e-9) continue;
        const a = (n * sdi - sd * si) / dn, b = (si - a * sd) / n;
        if (a <= 0.02) continue;
        let err = 0;
        for (let t = 0; t < interior.length; t += 4) {
          const d = Math.max(0, interior[t] * cx + interior[t + 1] * cy + interior[t + 2] * cz);
          const e = a * d + b - interior[t + 3]; err += e * e;
        }
        if (err < bestErr) { bestErr = err; bestSlant = s; alpha = a; beta = b; }
      }
    }
    Lz = Math.cos(bestSlant); const sl = Math.sin(bestSlant);
    Lx = sl * Math.cos(az); Ly = sl * Math.sin(az);
    ambient = Math.max(0, beta); albDenom = Math.max(0.04, alpha);

    // R² = 1 − SSE∕SST on the same interior samples the sweep scored. SST is the
    // total variation of the interior luminance about its own mean, so R² is
    // exactly "how much of what varies across this subject is explained by one
    // distant light on a Lambertian surface". A subject that is mostly texture,
    // or lit by several sources, or shiny, scores low here — and that is the
    // case where dividing the photograph by this model does damage.
    fitN = interior.length / 4;
    if (fitN > 0 && isFinite(bestErr)) {
      let si = 0;
      for (let t = 3; t < interior.length; t += 4) si += interior[t];
      const mean = si / fitN;
      let sst = 0;
      for (let t = 3; t < interior.length; t += 4) { const d = interior[t] - mean; sst += d * d; }
      fitRms = Math.sqrt(bestErr / fitN);
      fitR2 = sst > 1e-9 ? Math.max(0, 1 - bestErr / sst) : 0;
    }
  }
  { const l = Math.hypot(Lx, Ly, Lz) || 1; Lx /= l; Ly /= l; Lz /= l; }

  const cr = new Float32Array(N), cg = new Float32Array(N);
  for (let i = 0; i < N; i++) { const s = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] + 1; cr[i] = px[i * 4] / s; cg[i] = px[i * 4 + 1] / s; }
  const tx = new Float32Array(N), ty = new Float32Array(N), fid = new Float32Array(N), TG = 1.6;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    let n0x = (z0[mask[i - 1] ? i - 1 : i] - z0[mask[i + 1] ? i + 1 : i]) * 0.5;
    let n0y = (z0[mask[i - w] ? i - w : i] - z0[mask[i + w] ? i + w : i]) * 0.5;
    let n0z = 0.14;
    { const l = Math.hypot(n0x, n0y, n0z) || 1; n0x /= l; n0y /= l; n0z /= l; }
    const c = Math.max(0.05, Math.min(1, (ls[i] - ambient) / albDenom));
    const dn = n0x * Lx + n0y * Ly + n0z * Lz;
    let vx = n0x - dn * Lx, vy = n0y - dn * Ly, vz = n0z - dn * Lz;
    const vl = Math.hypot(vx, vy, vz);
    let nx, ny, nz;
    if (vl < 1e-4) { nx = Lx; ny = Ly; nz = Lz; }
    else { const s = Math.sqrt(Math.max(0, 1 - c * c)); vx /= vl; vy /= vl; vz /= vl; nx = c * Lx + s * vx; ny = c * Ly + s * vy; nz = c * Lz + s * vz; }
    if (nz < 0.05) nz = 0.05;
    let et = Math.min(1, dist[i] / (0.22 * R)); et = et * et * (3 - 2 * et);
    const chg = Math.abs(cr[i + 1] - cr[i - 1]) + Math.abs(cg[i + 1] - cg[i - 1])
              + Math.abs(cr[i + w] - cr[i - w]) + Math.abs(cg[i + w] - cg[i - w]);
    et *= Math.exp(-7 * chg);
    fid[i] = et;
    tx[i] = Math.max(-TG, Math.min(TG, -nx / nz));
    ty[i] = Math.max(-TG, Math.min(TG, -ny / nz));
  }
  const lambda = 0.3, kappa = 9.0;
  const wR = new Float32Array(N), wD = new Float32Array(N), divG = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1) { const f = 0.1 + 0.9 * 0.5 * (fid[i] + fid[i + 1]); wR[i] = Math.exp(-kappa * Math.abs(lum[i] - lum[i + 1])) * f; }
    if (y < h - 1) { const f = 0.1 + 0.9 * 0.5 * (fid[i] + fid[i + w]); wD[i] = Math.exp(-kappa * Math.abs(lum[i] - lum[i + w])) * f; }
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const exr = mask[i + 1] ? wR[i] * 0.5 * (tx[i] + tx[i + 1]) : 0;
    const exl = mask[i - 1] ? wR[i - 1] * 0.5 * (tx[i - 1] + tx[i]) : 0;
    const eyd = mask[i + w] ? wD[i] * 0.5 * (ty[i] + ty[i + w]) : 0;
    const eyu = mask[i - w] ? wD[i - w] * 0.5 * (ty[i - w] + ty[i]) : 0;
    divG[i] = (exr - exl) + (eyd - eyu);
  }
  const depth = z0.slice();
  let iters = 0;
  for (let it = 0; it < 300; it++) {
    let maxUpd = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!mask[i]) { depth[i] = 0; continue; }
      let sw = 0, acc = 0;
      if (mask[i - 1]) { const v = wR[i - 1]; sw += v; acc += v * depth[i - 1]; }
      if (mask[i + 1]) { const v = wR[i]; sw += v; acc += v * depth[i + 1]; }
      if (mask[i - w]) { const v = wD[i - w]; sw += v; acc += v * depth[i - w]; }
      if (mask[i + w]) { const v = wD[i]; sw += v; acc += v * depth[i + w]; }
      let v = (acc - divG[i] + lambda * z0[i]) / (sw + lambda + 1e-6);
      v = depth[i] + 1.5 * (v - depth[i]); if (v < 0) v = 0;
      const u = Math.abs(v - depth[i]); if (u > maxUpd) maxUpd = u;
      depth[i] = v;
    }
    iters = it + 1; if (maxUpd < 1e-5) break;
  }
  const zlp = maskedBlur(depth, mask, w, h, 5, 6);
  const dGain = 0.32;
  for (let i = 0; i < N; i++) { if (!mask[i]) { depth[i] = 0; continue; } depth[i] = Math.max(0, z0[i] + dGain * (depth[i] - zlp[i])); }
  {
    const t = depth.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      let s = t[i] * 3, c = 3;
      for (const j of [i - 1, i + 1, i - w, i + w]) if (mask[j]) { s += t[j]; c++; }
      depth[i] = s / c;
    }
  }
  let dmx = 0; for (let i = 0; i < N; i++) if (mask[i] && depth[i] > dmx) dmx = depth[i];
  const invd = dmx > 1e-4 ? 1 / dmx : 1;
  for (let i = 0; i < N; i++) depth[i] = mask[i] ? Math.min(1, depth[i] * invd) : 0;

  const conf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const dn = dist[i] / R, reliab = Math.min(1, 0.4 + Math.hypot(gx[i], gy[i]) * 6);
    let c = (0.45 + 0.4 * dn) * (0.55 + 0.45 * reliab);
    if (lum[i] > 0.93) c *= 0.5; if (lum[i] < 0.05) c *= 0.8;
    conf[i] = Math.max(0.12, Math.min(1, c));
  }
  return { depth, conf, iters, light: { x: +Lx.toFixed(2), y: +Ly.toFixed(2), z: +Lz.toFixed(2) },
           // The fitted model itself, for anything that wants to divide by it.
           lambert: { Lx, Ly, Lz, alpha: albDenom, ambient, r2: fitR2, rms: fitRms, n: fitN } };
}

export function surfaceNormals(depth, mask, w, h, relief) {
  const N = w * h, nrm = new Float32Array(N * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const l = depth[x > 0 ? i - 1 : i], r = depth[x < w - 1 ? i + 1 : i];
    const u = depth[y > 0 ? i - w : i], d = depth[y < h - 1 ? i + w : i];
    let nx = (l - r) * relief * 8, ny = (u - d) * relief * 8, nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / len; nrm[i * 3 + 1] = ny / len; nrm[i * 3 + 2] = nz / len;
  }
  return nrm;
}

// The lens is READ, never estimated. See src/exif.js for why: this used to be
// `35 + (1 − fill)*40`, a map from how much of the frame the subject fills to a
// focal length in millimetres, with a fabricated confidence interval attached.
// It drove the perspective taper, so an invented number was bending the mesh.
//
// A photograph that does not carry its focal length is reconstructed
// orthographically. That is the correct limit — an unknown lens is not a 50mm
// lens — and the app says "lens unknown" rather than guessing.
export function cameraFromLens(lens) {
  return {
    known: !!(lens && lens.known),
    fRel: lens && lens.known ? lens.fRel : 0,
    mm35: lens && lens.known ? lens.mm35 : null,
    source: lens && lens.known ? lens.source : 'none',
    reason: lens ? lens.reason : 'not supplied',
    // Whether the declared focal length could be checked against the decoded
    // image's aspect ratio. False means a crop cannot be ruled out — which is
    // not the same as "the lens is wrong", and is not the same as "verified".
    cropChecked: !!(lens && lens.cropChecked),
  };
}

// planViews() used to live here. It returned a list of camera stations with a
// `dev` "silhouette deviation" and an `excluded` flag, and the report printed
// "N working views · M excluded by consistency". Nothing was rendered and
// nothing was scored: `dev` carried a `Math.sin(i * 2.7) * 0.02` decorative
// wobble and exclusion was `dev > 0.055 && i % 5 === 4`, i.e. every fifth
// station got a red cross. It is deleted rather than repaired. Scoring real
// synthetic views against the reconstructed solid is a genuine measurement and
// belongs in its own phase, with its own test.

/* ------------------------------------------------------ Poisson inflation */
// Δu = −4 on the silhouette, u = 0 on the boundary, A = sqrt(u).
//   disk  radius R : u = R²−ρ²    → A = sqrt(R²−ρ²), an exact hemisphere
//   strip half-w a : u = 2(a²−x²) → A = √2·sqrt(a²−x²), a cylinder ×√2
// Every part inflates to ITS OWN radius, and because u solves an elliptic PDE
// the field is smooth in the interior by construction. The original used one
// global R = max(EDT), so an arm 1/6 the torso's width came out 60% as thick.

function sorSweeps(u, mask, w, h, sweeps, omega, rhs) {
  let mx = 0;
  for (let it = 0; it < sweeps; it++) {
    mx = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        if (!mask[i]) { u[i] = 0; continue; }
        const s = (mask[i - 1] ? u[i - 1] : 0) + (mask[i + 1] ? u[i + 1] : 0)
                + (mask[i - w] ? u[i - w] : 0) + (mask[i + w] ? u[i + w] : 0);
        const v = (s + rhs) * 0.25;
        const nv = u[i] + omega * (v - u[i]);
        const d = Math.abs(nv - u[i]); if (d > mx) mx = d;
        u[i] = nv < 0 ? 0 : nv;
      }
    }
    if (mx < 1e-4) return { res: mx, iters: it + 1 };
  }
  return { res: mx, iters: sweeps };
}

function downMask(mask, w, h) {
  const nw = w >> 1, nh = h >> 1, m = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let c = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) c += mask[(2 * y + dy) * w + (2 * x + dx)] ? 1 : 0;
    m[y * nw + x] = c >= 2 ? 1 : 0;
  }
  return { mask: m, w: nw, h: nh };
}

export function poissonInflate(mask, w, h) {
  const pyr = [{ mask, w, h }];
  while (pyr[pyr.length - 1].w > 40 && pyr[pyr.length - 1].h > 40) {
    const p = pyr[pyr.length - 1];
    pyr.push(downMask(p.mask, p.w, p.h));
  }
  let u = null, total = 0, res = 0;
  for (let L = pyr.length - 1; L >= 0; L--) {
    const lv = pyr[L];
    const nu = new Float32Array(lv.w * lv.h);
    if (u) { // prolongate — u has units of length², so ×4 per level
      const pw = pyr[L + 1].w, ph = pyr[L + 1].h;
      for (let y = 0; y < lv.h; y++) {
        const sy = Math.min(ph - 1, y >> 1);
        for (let x = 0; x < lv.w; x++) {
          const sx = Math.min(pw - 1, x >> 1);
          nu[y * lv.w + x] = lv.mask[y * lv.w + x] ? u[sy * pw + sx] * 4 : 0;
        }
      }
    }
    const om = 2 / (1 + Math.PI / Math.max(lv.w, lv.h));
    const r = sorSweeps(nu, lv.mask, lv.w, lv.h, L === 0 ? 5000 : 900, om, 4);
    total += r.iters; res = r.res;
    u = nu;
  }
  return { u, iters: total, res };
}

// ρ = sqrt(u)/D on the medial axis, reported as a DIAGNOSTIC only. It is 1 for
// disk-like parts and √2 for strip-like ones, but it is NOT confined to [1, √2]:
// that holds for convex silhouettes and fails on every waist. For a union of two
// disks of radius R whose centres are 2(R−δ) apart, the waist clearance is
// D = sqrt(2Rδ − δ²) (the nearest boundary is the corner where the circles
// cross, not the facing arc, which is interior), u there is ≈ 2.1·R·D, and so
//        ρ ≈ 1.45·sqrt(R/D) ∝ (R/δ)^(1/4)  →  unbounded.
// It first passes √2 at a neck ≈ 0.84 of the lobe radius — an entirely ordinary
// waist. The old code rejected samples outside [0.85, 1.75] and then clamped to
// [1, √2], so it saturated on exactly the geometry it most needed to measure and
// over-thickened it by 20–30% at anatomical waists and ~2× at a severe pinch.
// Nothing is divided by ρ any more; the half-thickness comes from the union of
// maximal inscribed balls instead. See ballUnionHalfThickness below.
export function medialRatio(u, dist, mask, w, h) {
  const N = w * h, num = new Float32Array(N), den = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const D = dist[i]; if (D < 2) continue;
    if (!(D >= dist[i - 1] && D >= dist[i + 1] && D >= dist[i - w] && D >= dist[i + w])) continue;
    num[i] = Math.sqrt(Math.max(0, u[i])); den[i] = D;
  }
  // masked, so the average is over samples that actually exist rather than over
  // the zeros outside the silhouette
  const nb = maskedBlur(num, mask, w, h, 6, 4), db = maskedBlur(den, mask, w, h, 6, 4);
  const rho = new Float32Array(N);
  for (let i = 0; i < N; i++) rho[i] = mask[i] && db[i] > 1e-8 ? nb[i] / db[i] : 1;
  return rho;
}

// HALF-THICKNESS BY THE UNION OF MAXIMAL INSCRIBED BALLS.
//
//     A(x)² = max over m in Omega of [ D(m)² − |x−m|² ]
//
// i.e. inflate every interior point into the largest ball that fits there, and
// take the upper envelope. That IS the solid a silhouette determines under the
// stated prior of circular cross-sections, and it is exact on both calibration
// shapes by construction: a disk of radius R has its largest ball at the centre,
// so A = sqrt(R²−rho²), an exact hemisphere; a strip of half-width a gives
// A = sqrt(a²−x²), an exact cylinder. No PDE solve, no ratio to divide out.
//
// This replaces a three-stage chain — medial axis by feature transform, geodesic
// Dijkstra to carry r off it, Jacobi diffusion to take the Voronoi seams out —
// and it replaces it because that chain propagated a LOCAL FEATURE SIZE and then
// used it as a 3D thickness, which is only the same thing on the medial axis
// itself. The failure was not subtle once measured in 3D. The angle test that
// declares a pixel medial compares its own nearest boundary point against a
// neighbour's, and one to two pixels in from a CURVED boundary those two lattice
// directions disagree by more than the threshold from rasterisation alone. On a
// disk of radius 60 that seeded 56 spurious medial pixels carrying r ≈ 1.5
// against 12 genuine ones carrying r ≈ 59, and since the seeds are Dirichlet data
// for a nearest-seed propagation, every pixel geodesically closer to the rim than
// to the centre inherited r ≈ 1.5. Measured: r collapsed from 58 to 1.8 between
// rho = 28 and rho = 40, so the outer 47% of the disk's radius came out a 1.5px
// flange around a puck. Front-on it is invisible — the silhouette is still exact
// — and it is the whole model from any other angle.
//
// Three properties are worth stating because they are what make this safe:
//
//   1. A(x) >= D(x) always, taking m = x. The old chain had no such invariant,
//      and buildVolume was CLAMPING D to r to stay real — which is exactly what
//      converted a bad radius into a thin flange instead of a NaN.
//   2. It cannot leak radius across background. A(x) > 0 needs an inscribed ball
//      containing x, and a ball spanning two parts is not inscribed. That is a
//      stronger guarantee than the geodesic propagation it replaces, which only
//      made the leak long rather than impossible.
//   3. It is the same lower envelope of parabolas as edt2d, mirrored:
//      max_m [g(m) − |x−m|²] = −min_m [(−g(m)) + |x−m|²]. So seeding the exact
//      transform with −D² and negating gives A² in two separable O(N) passes.
export function ballUnionHalfThickness(mask, w, h, dist) {
  const N = w * h, INF = 1e20;
  const seed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const d = mask[i] ? Math.max(0, dist[i]) : 0;
    seed[i] = mask[i] ? -(d * d) : INF;
  }
  const neg = edt2d(seed, w, h);
  const A = new Float32Array(N);
  for (let i = 0; i < N; i++) A[i] = mask[i] ? Math.sqrt(Math.max(0, -neg[i])) : 0;
  return A;
}

/**
 * The same envelope, carrying WHICH ball won at each pixel.
 *
 * A(x)² = D(m)² − |x−m|² for the winning seed m, so the winner's own radius
 * R(x) = D(m) and the in-plane offset G(x) = |x−m| come out of the transform for
 * free once it carries the index — and they satisfy A² + G² = R² exactly, by
 * construction rather than to within a finite difference.
 *
 * That identity is why this exists. R is the coordinate the boundary's error is
 * WELL CONDITIONED in: near the rim A ≈ √(2RD), so ∂A/∂D = R/A → ∞ and a
 * variance stated in A is unbounded exactly where the surface is largest. Stated
 * in R it is the localisation error of one boundary — a fraction of a pixel,
 * roughly constant over the silhouette — and the divergent Jacobian is applied
 * once, in closed form, rather than accumulated through a chain. See
 * src/uncertainty.js.
 *
 * Differencing A² would give G too (∇(A²) = −2(x−m)), and it is not good enough:
 * at a seam between two balls' territories the winning seed jumps, the
 * difference straddles the jump, and G comes out arbitrarily large on exactly
 * the pixels — waists, part junctions — where the uncertainty matters most.
 */
export function ballUnionField(mask, w, h, dist) {
  const N = w * h, INF = 1e20;
  // The envelope is seeded with −D² TILTED by −ε·D, which breaks ties toward the
  // larger ball and changes nothing else.
  //
  // Ties concentrate at the rim, and they matter there because the propagation
  // divides by R. A(x)² is the same number for every ball that attains the max,
  // so the solid does not care which one the envelope returns — but R and G are
  // that ball's own radius and offset, and they differ enormously between a tied
  // pair. Measured on a rasterised disk of radius 40: R reads 38.97 across the
  // whole interior either way, and in the outermost ~1.5px band the untilted
  // envelope returns balls as small as R = 1.50 where the tilted one returns
  // 5.50. Neither is a bug in the transform — one to two pixels inside a
  // discretised boundary the central ball genuinely does not reach, because D at
  // the centre pixel is 38.97 while the rim pixel sits 39-40px away from it, so
  // the envelope there really is made of small local balls. What the tilt buys
  // is that among balls that tie, the largest is returned, which keeps R away
  // from zero and the variance propagation away from 0/0.
  const EPSTIE = 1e-6;
  const seed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const d = mask[i] ? Math.max(0, dist[i]) : 0;
    seed[i] = mask[i] ? -(d * d) - EPSTIE * d : INF;
  }
  const { near } = edt2dNear(seed, w, h);
  // A is then recomputed from the WINNER's own untilted radius rather than read
  // off the tilted envelope, so the tilt cannot leak into the geometry: for the
  // seed m that won, A² = D(m)² − |x−m|² by definition, and R² = A² + G² holds
  // to float32 by construction rather than to within a finite difference.
  const A = new Float32Array(N), R = new Float32Array(N), G = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const m = near[i];
    const r = Math.max(0, dist[m]);
    const x = i % w, y = (i - x) / w, mx = m % w, my = (m - mx) / w;
    const g = Math.hypot(x - mx, y - my);
    R[i] = r; G[i] = g;
    A[i] = Math.sqrt(Math.max(0, r * r - g * g));
  }
  return { A, R, G, near };
}

// A quantile of a field over the silhouette only. Used where the code wants
// "how big is this subject" and must not hand that answer to a single outlier.
export function quantileOver(f, mask, N, q) {
  const v = [];
  for (let i = 0; i < N; i++) if (mask[i]) v.push(f[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * v.length)))];
}

// masked, for the same reason maskedBlur exists: a plain box mixes in the zeros
// outside the silhouette and the result sags toward the rim
function softLocalMax(a, mask, w, h, p, rad, passes) {
  const N = w * h, t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = Math.pow(Math.max(0, a[i]), p);
  const s = maskedBlur(t, mask, w, h, rad, passes);
  const o = new Float32Array(N);
  for (let i = 0; i < N; i++) o[i] = Math.pow(Math.max(0, s[i]), 1 / p);
  return o;
}

// Mirroring ±z is only legitimate when the image plane is the subject's
// sagittal plane. Horizontal-flip IoU separates the cases: ~1 frontal (z is
// depth, chest ≠ back), ~0.5 profile (z is lateral, so bilateral symmetry
// makes the mirror honest rather than an assumption).
//
// The mirror has to be taken about the SUBJECT's own axis. Reflecting about the
// image's centre column, x -> w−1−x, measures how well the subject overlaps its
// reflection in the frame, which is a statement about FRAMING and not about
// pose: it is maximal only when the subject happens to be centred, and it falls
// off with translation at a rate set by how wide the subject is, not by how
// symmetric it is. Measured on a rigorously mirror-symmetric test figure, moving
// it 5px off centre in a 280px frame took the IoU from 1.00 to 0.60 and 10px took
// it to 0.41 — across the frontal/profile decision boundary — so tau flipped from
// 1/1.38 to 1.38 and the reconstructed depth of an unchanged object changed by
// 90%. So: search for the reflection axis that best explains the silhouette, and
// report the IoU there. Framing-invariant by construction, and the axis it finds
// is a useful output in its own right.
//
// Cost is one pass over the subject's bounding box per candidate column, at half-
// pixel steps across that box — a few million operations on a 280px grid, which
// is well under the cost of the transform that produced the mask.
export function lateralAxis(mask, w, h) {
  let minx = w, maxx = -1, miny = h, maxy = -1, area = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    area++;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  if (area === 0) return { sym: 1, frontal: true, axis: (w - 1) / 2 };

  // IoU of the mask against its reflection x -> 2c − x, counted over the union of
  // the box and its image so nothing falls off the grid unaccounted for.
  const iou = (c) => {
    let inter = 0, uni = 0;
    for (let y = miny; y <= maxy; y++) {
      const row = y * w;
      for (let x = minx; x <= maxx; x++) {
        const a = mask[row + x];
        const xr = Math.round(2 * c - x);
        const b = (xr >= 0 && xr < w) ? mask[row + xr] : 0;
        if (a && b) inter++;
        if (a || b) uni++;
      }
    }
    return uni ? inter / uni : 0;
  };

  // The best axis of a bilaterally symmetric silhouette is its centroid column,
  // and for an asymmetric one it is near it; sweeping the whole box at half-pixel
  // steps costs little and removes the assumption entirely.
  let best = -1, axis = (minx + maxx) / 2;
  for (let c2 = 2 * minx; c2 <= 2 * maxx; c2++) {
    const c = c2 / 2, v = iou(c);
    if (v > best) { best = v; axis = c; }
  }
  return { sym: best, frontal: best > 0.72, axis };
}

/* ------------------------------------------------------------ relief gating */
// A geometric crease gives a smooth shading ramp (large |∇I|, small |∇²I|); a
// printed or woven edge gives a step. The regional term additionally damps
// areas DENSE with colour edges — a face is skin/hair/glasses/beard, and
// without it the glasses get carved into the skull.

export function reliefGate(lum, px, mask, w, h) {
  const N = w * h;
  const cr = new Float32Array(N), cg = new Float32Array(N);
  for (let i = 0; i < N; i++) { const s = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] + 1; cr[i] = px[i * 4] / s; cg[i] = px[i * 4 + 1] / s; }
  const chroma = new Float32Array(N), gate = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    chroma[i] = Math.abs(cr[i + 1] - cr[i - 1]) + Math.abs(cg[i + 1] - cg[i - 1])
              + Math.abs(cr[i + w] - cr[i - w]) + Math.abs(cg[i + w] - cg[i - w]);
  }
  const reg = maskedBlur(chroma, mask, w, h, Math.max(2, Math.round(w * 0.03)), 3);
  let rm = 0, rc = 0; for (let i = 0; i < N; i++) if (mask[i]) { rm += reg[i]; rc++; }
  const rmean = rm / Math.max(1, rc) + 1e-6;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const gx = (lum[i + 1] - lum[i - 1]) * 0.5, gy = (lum[i + w] - lum[i - w]) * 0.5;
    const g = Math.hypot(gx, gy);
    const lap = Math.abs(lum[i + 1] + lum[i - 1] + lum[i + w] + lum[i - w] - 4 * lum[i]);
    const step = lap / (g + 0.02);
    gate[i] = (1 / (1 + 2.6 * step)) * Math.exp(-9 * chroma[i]) * (1 / (1 + 1.6 * Math.pow(reg[i] / rmean, 1.7)));
  }
  boxBlur(gate, w, h, 1);
  for (let i = 0; i < N; i++) if (!mask[i]) gate[i] = 0;
  return gate;
}

// Detail band normalised by a LOCAL RMS. A single global scale lets the loudest
// region set the amplitude for the whole subject: ripped denim carries far more
// luminance structure than a face, so the face arrived flat.
export function reliefField(depth, gate, mask, w, h, lowRad, lowPass, rmsRad) {
  const N = w * h;
  const lo = maskedBlur(depth, mask, w, h, lowRad, lowPass);
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = mask[i] ? (depth[i] - lo[i]) * gate[i] : 0;
  const sq = new Float32Array(N), wt = new Float32Array(N);
  for (let i = 0; i < N; i++) if (mask[i]) { sq[i] = d[i] * d[i]; wt[i] = 1; }
  for (let p = 0; p < 2; p++) { boxBlur(sq, w, h, rmsRad); boxBlur(wt, w, h, rmsRad); }
  let g2 = 0, gc = 0; for (let i = 0; i < N; i++) if (mask[i]) { g2 += d[i] * d[i]; gc++; }
  const grms = Math.sqrt(g2 / Math.max(1, gc));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const lrms = Math.sqrt(Math.max(0, sq[i] / Math.max(1e-6, wt[i])));
    out[i] = Math.max(-1.6, Math.min(1.6, d[i] / (lrms * 0.75 + grms * 0.60 + 1e-6)));
  }
  boxBlur(out, w, h, 1);
  return out;
}

/* ------------------------------------------------------------------ volume */
// The inflation is solved on a COARSE grid and only the part-radius r is
// carried up. u has units of length², so a fixed absolute SOR tolerance gets
// relatively stricter as the grid grows; the solve was exhausting its sweep
// budget unconverged and the model got THINNER at higher quality settings
// (measured Z/X 0.51 → 0.41 → 0.36). r is a part-scale quantity with no fine
// detail to lose, so this is both correct and ~2.8× faster.

export function buildVolume(art, cfg) {
  const { w, h, mask, alpha } = art, N = w * h;

  // The Poisson solve is now kept only for the ρ REGIME DIAGNOSTIC that the
  // report surfaces; nothing downstream divides by it any more. It still runs on
  // a coarse grid because ρ is a part-scale quantity with no fine detail to lose.
  let cm = mask, cw = w, ch = h, levels = 0;
  while (Math.max(cw, ch) > 200) { const d = downMask(cm, cw, ch); cm = d.mask; cw = d.w; ch = d.h; levels++; }
  const pi = poissonInflate(cm, cw, ch);
  const cdist = distanceTransform(cm, cw, ch);
  const crho = medialRatio(pi.u, cdist, cm, cw, ch);

  // D is the sub-pixel signed distance, so D = 0 IS the silhouette and every
  // cross-section closes there exactly.
  const phi = subpixelSignedDistance(mask, w, h, alpha);

  // The in-plane half-thickness is the upper envelope of the maximal inscribed
  // balls — exact on a disk (hemisphere) and on a strip (cylinder), computed at
  // FULL resolution because it is two separable O(N) passes and there is nothing
  // to be gained by coarsening it. See ballUnionHalfThickness.
  const Dpos = new Float32Array(N);
  for (let i = 0; i < N; i++) Dpos[i] = mask[i] ? Math.max(0, phi[i]) : 0;
  // R and G ride along: the winning ball's radius and the in-plane offset to its
  // centre, which are what the boundary's variance has to be propagated in. They
  // cost nothing here — the same transform produces them — and reconstructing
  // them afterwards costs a second pass or a finite difference that breaks at
  // exactly the pixels that matter. See ballUnionField and src/uncertainty.js.
  const bu = ballUnionField(mask, w, h, Dpos);
  const A = bu.A;
  let amax = 0;
  for (let i = 0; i < N; i++) if (mask[i] && A[i] > amax) amax = A[i];

  // Part scale, used only to decide how trunk-like a location is. It is read at
  // a high QUANTILE rather than at the maximum: a max has breakdown point zero,
  // so one thick region — or one unrelated object the segmentation happened to
  // keep — set the reference for the whole subject and moved every other part's
  // anisotropy with it. See the tau note below for what this does and does not
  // fix; the reference is still global, because a single view carries no
  // absolute scale to key it to.
  const P = softLocalMax(A, mask, w, h, 4, 6, 2);
  const pmax = quantileOver(P, mask, N, 0.98);

  const lat = art.lat || lateralAxis(mask, w, h);
  // Anisotropy: the unseen axis is not the in-plane one. A cross-section is an
  // ellipse with semi-axis A in-plane and τ·A out-of-plane. Stated as a prior
  // because a single view cannot measure it.
  //
  // τ for the trunk depends on WHICH axis the camera happened to put in the
  // image plane, and that is exactly what the mirror-IoU already measures. A
  // torso cross-section is roughly a 1.4:1 ellipse, wide across the shoulders
  // and shallow front-to-back. Seen in profile the shallow axis is in-plane and
  // the unseen axis is the wide one, so τ > 1; seen frontally it is the other
  // way round and τ must be < 1. The pipeline used to apply τ = 1.38 either
  // way, which inflated every frontal subject into a barrel.
  //
  // KNOWN LIMIT, stated because it is a prior and not a measurement: which parts
  // count as trunk is decided by P/pmax, a comparison against the subject's own
  // 98th-percentile part scale. That reference is global, so a subject whose
  // silhouette gains a large connected companion — an arm round a bag, a figure
  // touching a chair — re-ranks every other part against it. Measured on a fixed
  // 20px bar joined by a disk of growing radius, the bar's half-thickness moves
  // from 0.72·A to 1.01·A as the disk passes ~35px: a 39% swing driven by
  // something that is not the bar. A single view carries no absolute scale, so
  // there is nothing better to key it to without semantics; the quantile bounds
  // how abruptly the reference can move, and tools/test/atlas/geometry3d.mjs pins the size
  // of the residual so it cannot grow silently.
  const ss = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const front = ss(0.45, 0.80, lat.sym);
  const tl = cfg.tauLimb;
  const tt = cfg.tauTrunk * (1 - front) + (1 / cfg.tauTrunk) * front;
  const H = new Float32Array(N);
  const pref = pmax > 1e-6 ? pmax : 1;
  for (let i = 0; i < N; i++) { if (!mask[i]) continue; H[i] = (tl + (tt - tl) * ss(0.45, 0.95, P[i] / pref)) * A[i]; }
  const Hb = maskedBlur(H, mask, w, h, 1, 1);

  // TWO SHEETS. The solid is Zb(x,y) ≤ z ≤ Zf(x,y).
  //
  // The field used to be F = H(x,y) − |z|, which is exactly mirror-symmetric in z
  // by construction — so no amount of evidence about the far side could be
  // expressed in it. A back photograph and a profile photograph both say things
  // about where the two surfaces are INDIVIDUALLY, and a single half-thickness
  // has nowhere to put that. Two independent sheets are a strict generalisation:
  // one image still produces Zf = +H, Zb = −H and reconstructs bit-identically.
  //
  // Outside the silhouette the field must keep falling, or the isosurface clamps
  // flat against the mask edge instead of closing. φ is a true signed distance,
  // so continuing with Zf = φ and Zb = −φ closes the shell exactly on the
  // silhouette: H already reaches 0 there, and beyond it Zf < Zb, which is empty.
  const Zf = new Float32Array(N), Zb = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (mask[i]) { const v = Math.max(0, Hb[i]); Zf[i] = v; Zb[i] = -v; }
    else { const v = Math.max(-6, phi[i]); Zf[i] = v; Zb[i] = -v; }
  }

  let nStrip = 0, cnt = 0, rsum = 0;
  for (let i = 0; i < cw * ch; i++) if (cm[i]) { cnt++; rsum += crho[i]; if (crho[i] > 1.28) nStrip++; }

  // ρ on the working grid, for the rig's waist test. It is computed coarse on
  // purpose — a part-scale quantity with no fine detail to lose, and it comes
  // out of a masked blur of radius 6 run four times, so it carries nothing
  // above that scale to be lost by resampling. Bilinear back up is exact enough
  // for finding a local maximum along a branch, which is all it is used for.
  const rhoFull = new Float32Array(N);
  const sx = cw / w, sy = ch / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    rhoFull[i] = mask[i] ? sampleBilinear(crho, cw, ch, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) : 1;
  }

  const vol = { Zf, Zb, A, P, lat, w, h, mask, D: Dpos, rho: rhoFull,
                R: bu.R, G: bu.G,
                stats: { sweeps: pi.iters, res: pi.res, rho: rsum / cnt, strip: nStrip / cnt,
                         amax, sym: lat.sym, frontal: lat.frontal, tauTrunk: tt,
                         // The part-scale reference the anisotropy is keyed to,
                         // and the limb end of the τ ramp. Both are inputs to
                         // the τ term of σ, which has to differentiate the very
                         // smoothstep this line evaluates.
                         pref, tauLimb: tl,
                         solveW: cw, solveH: ch } };
  return setZGrid(vol);
}

// The k axis is a grid, so it needs an integer origin and a length. zHalf is the
// grid coordinate of z = 0; world z = k − zHalf. Two cells of margin on each
// side keep the isosurface off the ends of the array. Called again whenever a
// later stage moves the sheets — a profile view can push them well past what the
// single-view field asked for.
export function setZGrid(vol) {
  const { Zf, Zb } = vol, N = Zf.length;
  let hi = 0, lo = 0;
  for (let i = 0; i < N; i++) { if (Zf[i] > hi) hi = Zf[i]; if (Zb[i] < lo) lo = Zb[i]; }
  const zHalf = Math.ceil(-lo) + 2;
  vol.zHalf = zHalf;
  vol.nz = zHalf + Math.ceil(hi) + 3;
  return vol;
}

/* ------------------------------------------------- multi-view constraints */
// A silhouette constrains the object only in the directions PERPENDICULAR to
// that camera's optical axis. Front and back share an axis, so they constrain
// the same two dimensions and say nothing whatever about depth — measured on a
// known solid, the visual hull from [0°,180°] is identical to the one from [0°]
// under orthography, and under perspective it shrinks in volume while leaving
// the depth through the torso unchanged at 5.00x the truth. The information a
// view at angle a adds about depth goes as sin(a), so a PROFILE is what carries
// geometry and a back view is what carries texture. These two functions are
// therefore quite different jobs: this one measures, registerSimilarity paints.

// Rows of a mask that contain any subject, and the column extent on each.
function rowSpans(mask, w, h) {
  const lo = new Int32Array(h).fill(-1), hi = new Int32Array(h).fill(-1);
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    const row = y * w;
    for (let x = 0; x < w; x++) if (mask[row + x]) { if (a < 0) a = x; b = x; }
    lo[y] = a; hi[y] = b;
    if (a >= 0) { if (y0 < 0) y0 = y; y1 = y; }
  }
  return { lo, hi, y0, y1 };
}

// Registration of a profile view against the front view.
//
// Only ONE degree of freedom is identifiable from the two silhouettes, and it is
// worth being explicit about which. The subject's top and bottom are the same
// physical points in both photographs, so the vertical extents correspond and fix
// a scale; assuming the two frames share a lens and a subject distance, that same
// scale converts the profile's horizontal axis into the front grid's units. What
// is NOT identifiable is which way the subject turned — a left profile and a
// right profile have mirror-image silhouettes, and nothing in either picture says
// which one you took. So `facing` is declared, not inferred, and the pipeline is
// arranged so that the part that depends on it (the front/back asymmetry) is
// separable from the part that does not (the total depth per row), which is the
// larger prize and is invariant under the flip.
export function profileConstraint(frontMask, w, h, profMask, pw, ph, facing = 'left') {
  const F = rowSpans(frontMask, w, h), P = rowSpans(profMask, pw, ph);
  const zlo = new Float32Array(h), zhi = new Float32Array(h), valid = new Uint8Array(h);
  if (F.y0 < 0 || P.y0 < 0 || F.y1 <= F.y0 || P.y1 <= P.y0) return { zlo, zhi, valid, scale: 1, rows: 0 };

  const scale = (F.y1 - F.y0) / (P.y1 - P.y0);        // profile px -> front-grid px

  // Depth origin: the profile silhouette's own area centroid column. Any choice
  // is a convention — the silhouettes cannot say where z = 0 is — but the
  // centroid is stable under matting noise and puts the model's mass on the axis
  // the viewer orbits about.
  let sx = 0, n = 0;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (profMask[y * pw + x]) { sx += x + 0.5; n++; }
  const uc = n ? sx / n : pw / 2;
  const sgn = facing === 'right' ? 1 : -1;             // image x -> world z direction

  let rows = 0;
  for (let y = 0; y < h; y++) {
    if (F.lo[y] < 0) continue;
    const py = P.y0 + (y - F.y0) / scale;
    const p0 = Math.floor(py), t = py - p0;
    // linear blend of the two neighbouring profile rows, so the depth profile
    // does not step whenever the two grids beat against each other
    let a0 = -1, a1 = -1, b0 = -1, b1 = -1;
    if (p0 >= 0 && p0 < ph && P.lo[p0] >= 0) { a0 = P.lo[p0]; b0 = P.hi[p0]; }
    const p1 = p0 + 1;
    if (p1 >= 0 && p1 < ph && P.lo[p1] >= 0) { a1 = P.lo[p1]; b1 = P.hi[p1]; }
    let u0, u1;
    if (a0 >= 0 && a1 >= 0) { u0 = a0 + (a1 - a0) * t; u1 = b0 + (b1 - b0) * t; }
    else if (a0 >= 0) { u0 = a0; u1 = b0; }
    else if (a1 >= 0) { u0 = a1; u1 = b1; }
    else continue;
    const e0 = sgn * (u0 + 0.0 - uc) * scale, e1 = sgn * (u1 + 1.0 - uc) * scale;
    zlo[y] = Math.min(e0, e1); zhi[y] = Math.max(e0, e1);
    valid[y] = 1; rows++;
  }
  // The row extents are matte-noise limited, and the depth of a body varies
  // slowly down its length, so a short running mean costs nothing real and keeps
  // one bad row from scaling a whole slice of the model.
  smoothValidRows(zlo, valid, h, 2);
  smoothValidRows(zhi, valid, h, 2);
  return { zlo, zhi, valid, scale, rows, uc, facing };
}

function smoothValidRows(f, valid, h, rad) {
  const t = Float32Array.from(f);
  for (let y = 0; y < h; y++) {
    if (!valid[y]) continue;
    let s = 0, c = 0;
    for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < h && valid[yy]) { s += t[yy]; c++; } }
    f[y] = s / c;
  }
}

// Apply the profile's per-row depth to a volume built from the front view.
//
// What the profile measures is the row's TOTAL depth — its silhouette is a union
// over x, so it reports max_x of the depth at that row and cannot say which x it
// belongs to. So the row is rescaled rather than carved: k(y) is chosen to make
// the model's own deepest column at that row match the measurement, which
// preserves the trunk/limb structure the front view established while replacing
// the global tau prior with a per-row measurement. For a pose whose deepest part
// at a row is NOT its widest part — an arm punched toward the camera — that
// attribution is wrong, which is why k is bounded and smoothed rather than
// trusted outright, and why the fit is measured and reported afterwards.
//
// The centre offset is applied to the exterior continuation as well. Inside the
// silhouette H reaches 0 at the boundary, so the sheets meet at z = c(y) there;
// if the exterior still continued from z = 0 the shell would not close.
// The smallest sheet separation the grid can resolve, in CELLS. Quoted in cells
// rather than as an image fraction because the constraint is the volume grid's
// own resolution — two sheets have to land in different cells to come back as two
// surfaces — so the same number is right at every preset. Swept against mesh
// topology through the full pipeline.
export const MIN_SEPARATION = 3;

export function applyProfile(vol, prof, opts = {}) {
  const { w, h, Zf, Zb } = vol;
  const { kMin = 0.35, kMax = 3.0, useCentre = true, minSep = MIN_SEPARATION } = opts;
  const k = new Float32Array(h), cen = new Float32Array(h), ok = new Uint8Array(h);

  for (let y = 0; y < h; y++) {
    if (!prof.valid[y]) continue;
    let mHalf = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const d = (Zf[row + x] - Zb[row + x]) * 0.5;
      if (d > mHalf) mHalf = d;
    }
    if (mHalf < 1) continue;                          // nothing to scale at this row
    const measured = (prof.zhi[y] - prof.zlo[y]) * 0.5;
    if (!(measured > 0)) continue;
    k[y] = Math.max(kMin, Math.min(kMax, measured / mHalf));
    cen[y] = useCentre ? (prof.zhi[y] + prof.zlo[y]) * 0.5 : 0;
    ok[y] = 1;
  }
  // Fill rows the profile could not speak for by holding the nearest answer, so
  // the scale does not step at the ends of the subject.
  let last = -1;
  for (let y = 0; y < h; y++) if (ok[y]) { if (last < 0) for (let z = 0; z < y; z++) { k[z] = k[y]; cen[z] = cen[y]; } last = y; }
  if (last < 0) return { applied: 0, k, cen };
  for (let y = last + 1; y < h; y++) { k[y] = k[last]; cen[y] = cen[last]; }
  for (let y = 0; y < h; y++) if (!ok[y] && y < last) {
    let a = y; while (a >= 0 && !ok[a]) a--;
    let b = y; while (b < h && !ok[b]) b++;
    if (a >= 0 && b < h) { const t = (y - a) / (b - a); k[y] = k[a] + (k[b] - k[a]) * t; cen[y] = cen[a] + (cen[b] - cen[a]) * t; }
  }
  const all = new Uint8Array(h).fill(1);
  smoothValidRows(k, all, h, 3);
  smoothValidRows(cen, all, h, 3);

  // The scale is FLOORED so it can never push two sheets closer together than the
  // grid can tell apart, and the floor is written in the quantity that actually
  // constrains it — the separation itself, not the distance from the boundary.
  //
  // The two sheets meet at the silhouette, so just inside it they are only a few
  // cells apart; the shell closes there because that separation still spans enough
  // cells for surface nets to resolve them separately. Scaling a row by k shrinks
  // that band by the same factor, and at k = 0.35 the last mask pixel of a limb
  // went from about 5.3 cells of separation to 1.85 — at which point both sheets
  // fall in one cell, share one vertex, and weld into edges shared by four
  // triangles. Measured on a figure whose true depth is half what the prior
  // assumes: 900 non-manifold edges, 884 of them within two cells of the
  // silhouette, every one on a row where k sat at its floor.
  //
  //     g = max( k , min(1, MIN_SEPARATION / 2 / half) )
  //
  // so a column already thinner than the minimum keeps exactly the geometry the
  // single-view field gave it — which is known to close — a column far above it
  // takes k in full, and the two meet continuously in between. What the profile
  // measures is the row's DEEPEST column, which is far above the floor, so the
  // measurement is unaffected: the floor only ever touches the rim, which is the
  // part a profile view cannot speak to and the part that has to stay shut.
  //
  // The exterior is left alone for a related reason: out there the sheets are ±φ,
  // a true signed distance falling one cell per cell, and that slope is what makes
  // the field cross zero cleanly instead of running alongside itself.
  //
  // KNOWN RESIDUAL: the floor removes the systematic pinch, not every one. A
  // single cell at a concave notch — between the legs, under an arm — where a
  // scale change and the centreline's shear meet can still weld: measured, 0 to 2
  // non-manifold edges in 200,000 to 600,000 triangles. It does not scale away
  // (1, 0, 0, 2, 2 over grids from 180x240 to 300x400), so it is reported by the
  // topology pane rather than smoothed over, and tools/test/atlas/multiview3d.mjs bounds it.
  const mask = vol.mask, hMin = minSep * 0.5;
  let applied = 0, floored = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w, ky = k[y] || 1, cy = cen[y];
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const half = (Zf[i] - Zb[i]) * 0.5, mid = (Zf[i] + Zb[i]) * 0.5;
      let g = ky;
      if (mask && !mask[i]) g = 1;
      else if (half > 1e-6) {
        const floor = Math.min(1, hMin / half);
        if (floor > g) { g = floor; floored++; }
      }
      Zf[i] = cy + mid + half * g;
      Zb[i] = cy + mid - half * g;
    }
    if (ok[y]) applied++;
  }
  setZGrid(vol);
  return { applied, floored, k, cen };
}

// Registration of a BACK view onto the front grid.
//
// A back photograph is horizontally mirrored relative to the front — you walk
// around the subject, so their left stays on their left and swaps sides in the
// frame. After un-mirroring, the two silhouettes are the same shape and the
// remaining freedom is a similarity: scale (different subject distance) and
// translation (different framing). Rotation is deliberately not solved for; it
// is rarely the error, and a four-parameter search that can also rotate will
// happily rotate to cover up a subject who moved instead.
//
// Estimated by moments and refined by pattern search on silhouette IoU, which is
// the quantity that actually matters and is what gets reported afterwards. The
// IoU is the honest confidence in this registration: a subject who shifted their
// weight between the two shots cannot be registered by any transform, and the
// number says so rather than the pipeline pretending otherwise.
export function registerSimilarity(dstMask, dw, dh, srcMask, sw, sh, mirror = true) {
  const mom = (m, w, h) => {
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { n++; sx += x + 0.5; sy += y + 0.5; }
    return n ? { n, cx: sx / n, cy: sy / n } : null;
  };
  const src = (x, y) => {
    const xi = Math.floor(mirror ? sw - 1 - x : x), yi = Math.floor(y);
    return (xi >= 0 && yi >= 0 && xi < sw && yi < sh) ? srcMask[yi * sw + xi] : 0;
  };
  const D = mom(dstMask, dw, dh);
  let S = null;
  { let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (src(x + 0.5, y + 0.5)) { n++; sx += x + 0.5; sy += y + 0.5; }
    if (n) S = { n, cx: sx / n, cy: sy / n }; }
  if (!D || !S) return { ok: false, iou: 0, s: 1, tx: 0, ty: 0, mirror };

  // dst (x,y) -> src (x - tx)/s, (y - ty)/s
  const iou = (s, tx, ty) => {
    let inter = 0, uni = 0;
    for (let y = 0; y < dh; y += 1) for (let x = 0; x < dw; x += 1) {
      const a = dstMask[y * dw + x];
      const b = src((x + 0.5 - tx) / s, (y + 0.5 - ty) / s);
      if (a && b) inter++;
      if (a || b) uni++;
    }
    return uni ? inter / uni : 0;
  };
  let s = Math.sqrt(D.n / S.n);
  let tx = D.cx - s * S.cx, ty = D.cy - s * S.cy;
  let best = iou(s, tx, ty);
  let step = Math.max(2, Math.round(Math.max(dw, dh) * 0.03)), sStep = 0.06;
  for (let pass = 0; pass < 7; pass++) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [ds, dx, dy] of [[0, step, 0], [0, -step, 0], [0, 0, step], [0, 0, -step],
                                  [sStep, 0, 0], [-sStep, 0, 0]]) {
        const v = iou(s + ds, tx + dx, ty + dy);
        if (v > best + 1e-6) { best = v; s += ds; tx += dx; ty += dy; moved = true; }
      }
    }
    step = Math.max(0.25, step * 0.5); sStep *= 0.5;
  }
  return { ok: best > 0, iou: best, s, tx, ty, mirror };
}

// The same resampling for a single-channel field — a matte, in practice.
export function warpField(src, sw, sh, reg, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let u = (x + 0.5 - reg.tx) / reg.s, v = (y + 0.5 - reg.ty) / reg.s;
    if (reg.mirror) u = sw - u;
    const xi = Math.max(0, Math.min(sw - 1.001, u - 0.5)), yi = Math.max(0, Math.min(sh - 1.001, v - 0.5));
    const x0 = xi | 0, y0 = yi | 0, fx = xi - x0, fy = yi - y0;
    out[y * dw + x] = src[y0*sw+x0]*(1-fx)*(1-fy) + src[y0*sw+x0+1]*fx*(1-fy)
                    + src[(y0+1)*sw+x0]*(1-fx)*fy + src[(y0+1)*sw+x0+1]*fx*fy;
  }
  return out;
}

// Resample a source image into the destination grid through a registration, so
// everything downstream — UVs, relief, confidence — keeps working in one
// coordinate system instead of carrying a transform around.
export function warpThrough(srcPx, sw, sh, reg, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let u = (x + 0.5 - reg.tx) / reg.s, v = (y + 0.5 - reg.ty) / reg.s;
    if (reg.mirror) u = sw - u;
    const xi = Math.max(0, Math.min(sw - 1.001, u - 0.5)), yi = Math.max(0, Math.min(sh - 1.001, v - 0.5));
    const x0 = xi | 0, y0 = yi | 0, fx = xi - x0, fy = yi - y0;
    const o = (y * dw + x) * 4;
    for (let c = 0; c < 4; c++) {
      const i00 = (y0 * sw + x0) * 4 + c, i10 = (y0 * sw + x0 + 1) * 4 + c;
      const i01 = ((y0 + 1) * sw + x0) * 4 + c, i11 = ((y0 + 1) * sw + x0 + 1) * 4 + c;
      out[o + c] = srcPx[i00] * (1-fx) * (1-fy) + srcPx[i10] * fx * (1-fy)
                 + srcPx[i01] * (1-fx) * fy + srcPx[i11] * fx * fy;
    }
  }
  return out;
}

// The model's own profile silhouette, re-measured off the finished volume and
// scored against the one that was supplied. This is the honesty check on the
// whole multi-view path: it is cheap, it needs no ground truth, and it catches a
// bad registration, a wrong facing, or a pose the per-row attribution cannot
// represent. Reported, not acted on.
export function profileFit(vol, prof, mask) {
  const { w, h, Zf, Zb } = vol;
  let inter = 0, uni = 0, rows = 0;
  for (let y = 0; y < h; y++) {
    if (!prof.valid[y]) continue;
    let lo = Infinity, hi = -Infinity;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (Zb[row + x] < lo) lo = Zb[row + x];
      if (Zf[row + x] > hi) hi = Zf[row + x];
    }
    if (!(hi > lo)) continue;
    const a0 = prof.zlo[y], a1 = prof.zhi[y];
    const i0 = Math.max(lo, a0), i1 = Math.min(hi, a1);
    inter += Math.max(0, i1 - i0);
    uni += Math.max(hi, a1) - Math.min(lo, a0);
    rows++;
  }
  return { iou: uni > 0 ? inter / uni : 0, rows };
}

/* -------------------------------------------------------- surface nets */
// F(x,y,z) = min( Zf(x,y) − z , z − Zb(x,y) ), positive exactly inside the solid.
// Along a column F rises to a plateau and falls again, so a column can only
// change sign near z ≈ Zb and near z ≈ Zf. Walking those two thin k-bands
// instead of the whole volume keeps extraction O(surface area), which is what
// the mirrored form H − |z| bought and this must not give up.

function sheetBand(lo, hi, zHalf, nz) {
  const cl = (x) => Math.max(0, Math.min(nz - 2, x));
  return [cl(Math.floor(zHalf + lo) - 2), cl(Math.ceil(zHalf + hi) + 1)];
}
// Merged into one span when the two bands touch, which is the thin-part case —
// keeping them separate there would emit the same cells twice.
function kBands(fLo, fHi, bLo, bHi, zHalf, nz) {
  const B = sheetBand(bLo, bHi, zHalf, nz), F = sheetBand(fLo, fHi, zHalf, nz);
  if (F[0] <= B[1] + 1) return [Math.min(B[0], F[0]), Math.max(B[1], F[1])];
  return [B[0], B[1], F[0], F[1]];
}

export function surfaceNets(vol) {
  const { Zf, Zb, w, h, zHalf, nz } = vol, nx = w, ny = h;
  const cellIdx = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos = [];
  const CE = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const cx = [0,1,0,1,0,1,0,1], cy = [0,0,1,1,0,0,1,1], cz = [0,0,0,0,1,1,1,1];
  const v = new Float64Array(8);
  const fc = new Float64Array(4), bc = new Float64Array(4);

  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const p0 = j*w+i, p1 = p0+1, p2 = (j+1)*w+i, p3 = p2+1;
    fc[0]=Zf[p0]; fc[1]=Zf[p1]; fc[2]=Zf[p2]; fc[3]=Zf[p3];
    bc[0]=Zb[p0]; bc[1]=Zb[p1]; bc[2]=Zb[p2]; bc[3]=Zb[p3];
    let solid = false, fLo = fc[0], fHi = fc[0], bLo = bc[0], bHi = bc[0];
    for (let c = 0; c < 4; c++) {
      if (fc[c] > bc[c]) solid = true;
      if (fc[c] < fLo) fLo = fc[c]; if (fc[c] > fHi) fHi = fc[c];
      if (bc[c] < bLo) bLo = bc[c]; if (bc[c] > bHi) bHi = bc[c];
    }
    if (!solid) continue;                       // nothing of the object in this column
    const bands = kBands(fLo, fHi, bLo, bHi, zHalf, nz);
    for (let bi = 0; bi < bands.length; bi += 2)
    for (let k = bands[bi]; k <= bands[bi+1]; k++) {
      const t = k - zHalf, t1 = t + 1;
      for (let c = 0; c < 4; c++) {
        const a0 = fc[c] - t,  b0 = t  - bc[c];
        const a1 = fc[c] - t1, b1 = t1 - bc[c];
        v[c]     = a0 < b0 ? a0 : b0;
        v[c + 4] = a1 < b1 ? a1 : b1;
      }
      let neg = 0; for (let c = 0; c < 8; c++) if (v[c] <= 0) neg++;
      if (neg === 0 || neg === 8) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 12; e++) {
        const a = CE[e][0], b = CE[e][1], va = v[a], vb = v[b];
        if ((va > 0) === (vb > 0)) continue;
        const tt = va / (va - vb);
        sx += cx[a] + (cx[b]-cx[a])*tt; sy += cy[a] + (cy[b]-cy[a])*tt; sz += cz[a] + (cz[b]-cz[a])*tt; n++;
      }
      const ci = cid(i, j, k);
      if (cellIdx[ci] >= 0) continue;
      cellIdx[ci] = pos.length / 3;
      pos.push(i + sx/n, j + sy/n, k + sz/n);
    }
  }

  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (!flip) idx.push(a,b,c, a,c,d); else idx.push(a,c,b, a,d,c);
  };
  const F = (i, j, k) => {
    const p = j*w+i, t = k - zHalf, a = Zf[p] - t, b = t - Zb[p];
    return a < b ? a : b;
  };
  const edgePass = (di, dj) => {
    for (let j = 0; j < ny - dj; j++) for (let i = 0; i < nx - di; i++) {
      const pa = j*w+i, pb = (j+dj)*w+(i+di);
      if (Zf[pa] <= Zb[pa] && Zf[pb] <= Zb[pb]) continue;
      const bands = kBands(Math.min(Zf[pa], Zf[pb]), Math.max(Zf[pa], Zf[pb]),
                           Math.min(Zb[pa], Zb[pb]), Math.max(Zb[pa], Zb[pb]), zHalf, nz);
      for (let bi = 0; bi < bands.length; bi += 2)
      for (let k = bands[bi]; k <= bands[bi+1]+1; k++) {
        if (k < 0 || k >= nz) continue;
        const f0 = F(i,j,k), f1 = F(i+di, j+dj, k);
        if ((f0 > 0) === (f1 > 0)) continue;
        if (di === 1) {
          if (j < 1 || k < 1) continue;
          quad(cellIdx[cid(i,j-1,k-1)], cellIdx[cid(i,j,k-1)], cellIdx[cid(i,j,k)], cellIdx[cid(i,j-1,k)], !(f0 > 0));
        } else {
          if (i < 1 || k < 1) continue;
          quad(cellIdx[cid(i-1,j,k-1)], cellIdx[cid(i-1,j,k)], cellIdx[cid(i,j,k)], cellIdx[cid(i,j,k-1)], !(f0 > 0));
        }
      }
    }
  };
  edgePass(1, 0); edgePass(0, 1);
  for (let j = 1; j < ny; j++) for (let i = 1; i < nx; i++) {
    const p = j*w+i; if (Zf[p] <= Zb[p]) continue;
    const cand = [Math.floor(zHalf + Zf[p]), Math.ceil(zHalf + Zb[p]) - 1];
    for (let c2 = 0; c2 < 2; c2++) for (let k = cand[c2]-2; k <= cand[c2]+2; k++) {
      if (k < 0 || k >= nz - 1) continue;
      const f0 = F(i,j,k), f1 = F(i,j,k+1);
      if ((f0 > 0) === (f1 > 0)) continue;
      quad(cellIdx[cid(i-1,j-1,k)], cellIdx[cid(i,j-1,k)], cellIdx[cid(i,j,k)], cellIdx[cid(i-1,j,k)], !(f0 > 0));
    }
  }
  return { pos, idx };
}

// Taubin λ/μ — alternating shrink and un-shrink passes remove the voxel
// staircase without the volume loss of repeated Laplacian smoothing.
export function taubin(pos, idx, iters, lam, mu) {
  const n = pos.length / 3;
  const adj = new Array(n); for (let i = 0; i < n; i++) adj[i] = [];
  const seen = new Set();
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t+1], idx[t+2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e+1)%3];
      const k = a < b ? a * 1e7 + b : b * 1e7 + a;
      if (seen.has(k)) continue; seen.add(k);
      adj[a].push(b); adj[b].push(a);
    }
  }
  const tmp = new Float64Array(pos.length);
  const pass = (f) => {
    for (let i = 0; i < n; i++) {
      const a = adj[i];
      if (!a.length) { tmp[i*3]=pos[i*3]; tmp[i*3+1]=pos[i*3+1]; tmp[i*3+2]=pos[i*3+2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of a) { sx += pos[j*3]; sy += pos[j*3+1]; sz += pos[j*3+2]; }
      sx /= a.length; sy /= a.length; sz /= a.length;
      tmp[i*3]   = pos[i*3]   + f * (sx - pos[i*3]);
      tmp[i*3+1] = pos[i*3+1] + f * (sy - pos[i*3+1]);
      tmp[i*3+2] = pos[i*3+2] + f * (sz - pos[i*3+2]);
    }
    pos.set(tmp);
  };
  for (let it = 0; it < iters; it++) { pass(lam); pass(mu); }
}

export function vertexNormals(P, idx, n) {
  const nrm = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t+1], c = idx[t+2];
    const ax = P[a*3], ay = P[a*3+1], az = P[a*3+2];
    const ux = P[b*3]-ax, uy = P[b*3+1]-ay, uz = P[b*3+2]-az;
    const vx = P[c*3]-ax, vy = P[c*3+1]-ay, vz = P[c*3+2]-az;
    const fx = uy*vz - uz*vy, fy = uz*vx - ux*vz, fz = ux*vy - uy*vx;
    nrm[a*3]+=fx; nrm[a*3+1]+=fy; nrm[a*3+2]+=fz;
    nrm[b*3]+=fx; nrm[b*3+1]+=fy; nrm[b*3+2]+=fz;
    nrm[c*3]+=fx; nrm[c*3+1]+=fy; nrm[c*3+2]+=fz;
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(nrm[i*3], nrm[i*3+1], nrm[i*3+2]) || 1;
    nrm[i*3]/=l; nrm[i*3+1]/=l; nrm[i*3+2]/=l;
  }
  return nrm;
}

// Ambient occlusion sampled straight out of the field. Cavity darkening is a
// large part of whether a render reads as a solid rather than a silhouette.
export function bakeAO(pos, nrm, vol, samples, radius) {
  const { Zf, Zb, w, h, zHalf } = vol;
  const inside = (x, y, z) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false;
    const t = z - zHalf;
    return Zf[yi*w+xi] > t && t > Zb[yi*w+xi];
  };
  const n = pos.length / 3, ao = new Float32Array(n), dirs = [];
  for (let s = 0; s < samples; s++) {
    const u = (s + 0.5) / samples, ph = Math.acos(1 - u), th = s * 2.39996323;
    dirs.push([Math.sin(ph)*Math.cos(th), Math.sin(ph)*Math.sin(th), Math.cos(ph)]);
  }
  const steps = [0.35, 0.7, 1.0];
  for (let i = 0; i < n; i++) {
    const px = pos[i*3], py = pos[i*3+1], pz = pos[i*3+2];
    const nx = nrm[i*3], ny = nrm[i*3+1], nz = nrm[i*3+2];
    const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = Math.abs(nx) < 0.9 ? 0 : 1;
    let tx = ay*nz, ty = -ax*nz, tz = ax*ny - ay*nx;
    const tl = Math.hypot(tx, ty, tz) || 1; tx/=tl; ty/=tl; tz/=tl;
    const bx = ny*tz - nz*ty, by = nz*tx - nx*tz, bz = nx*ty - ny*tx;
    let open = 0;
    for (const d of dirs) {
      const dx = d[0]*tx + d[1]*bx + d[2]*nx;
      const dy = d[0]*ty + d[1]*by + d[2]*ny;
      const dz = d[0]*tz + d[1]*bz + d[2]*nz;
      let blocked = false;
      for (const s of steps) {
        const r = radius * s;
        if (inside(px + dx*r + nx*0.6, py + dy*r + ny*0.6, pz + dz*r + nz*0.6)) { blocked = true; break; }
      }
      if (!blocked) open++;
    }
    ao[i] = open / dirs.length;
  }
  return ao;
}

/* ---------------------------------------------------------------- texture */

// Nearest-seed transform: the same lower envelope as edt2d, carrying the index
// of the winning seed. Gives an exact Voronoi assignment in O(N), which is both
// better and far cheaper than iterated dilation — a 30-pass 3×3 bleed at
// texture resolution is a hundred million operations and still only reaches
// 30px, while this reaches everywhere in two separable passes.
function edt1dNear(f, fi, n, d, di, v, zb) {
  const INF = 1e20;
  let k = 0; v[0] = 0; zb[0] = -INF; zb[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q*q) - (f[v[k]] + v[k]*v[k])) / (2*q - 2*v[k]);
    while (s <= zb[k]) { k--; s = ((f[q] + q*q) - (f[v[k]] + v[k]*v[k])) / (2*q - 2*v[k]); }
    k++; v[k] = q; zb[k] = s; zb[k+1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zb[k+1] < q) k++;
    const dq = q - v[k];
    d[q] = dq*dq + f[v[k]];
    di[q] = fi[v[k]];
  }
}

/**
 * The lower envelope of parabolas over an ARBITRARY seed function, carrying the
 * winning index. `edt2d` computes the same envelope and throws the index away;
 * `nearestSeedD` keeps the index but only for a 0/∞ seed. This is the general
 * case both of those are instances of, and `ballUnionField` needs it: the seed
 * there is −D², not an indicator, and which seed won is the whole point.
 */
export function edt2dNear(seed, w, h) {
  const N = w * h, n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const fi = new Int32Array(n), di = new Int32Array(n);
  const v = new Int32Array(n + 1), zb = new Float64Array(n + 2);
  const out = new Float64Array(N), near = new Int32Array(N);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { const i = y*w+x; f[y] = seed[i]; fi[y] = i; }
    edt1dNear(f, fi, h, d, di, v, zb);
    for (let y = 0; y < h; y++) { out[y*w+x] = d[y]; near[y*w+x] = di[y]; }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { f[x] = out[row+x]; fi[x] = near[row+x]; }
    edt1dNear(f, fi, w, d, di, v, zb);
    for (let x = 0; x < w; x++) { out[row+x] = d[x]; near[row+x] = di[x]; }
  }
  return { d: out, near };
}

// For every pixel, the flat index of the nearest seed pixel.
export function nearestSeed(isSeed, w, h) { return nearestSeedD(isSeed, w, h).near; }

// ...and the squared distance to it, which subpixelSignedDistance needs so it can
// add that seed's own sub-pixel offset along the normal.
export function nearestSeedD(isSeed, w, h) {
  const N = w * h, INF = 1e20, n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const fi = new Int32Array(n), di = new Int32Array(n);
  const v = new Int32Array(n + 1), zb = new Float64Array(n + 2);
  const dist = new Float64Array(N), near = new Int32Array(N);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { const i = y*w+x; f[y] = isSeed[i] ? 0 : INF; fi[y] = i; }
    edt1dNear(f, fi, h, d, di, v, zb);
    for (let y = 0; y < h; y++) { dist[y*w+x] = d[y]; near[y*w+x] = di[y]; }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { f[x] = dist[row+x]; fi[x] = near[row+x]; }
    edt1dNear(f, fi, w, d, di, v, zb);
    for (let x = 0; x < w; x++) { dist[row+x] = d[x]; near[row+x] = di[x]; }
  }
  return { near, dist2: dist };
}

// Projective texture, prefiltered by the LOCAL UV STRETCH.
//
// The atlas parameterisation IS the camera projection, so a texel covers
// 1∕(n·ẑ) times as much surface as it does image. On a shell that closes at the
// silhouette n·ẑ → 0 at the rim, so a single row of boundary pixels is
// magnified across the whole side of the model — which is why the
// reconstruction came out wrapped in stripes from any angle but head-on. The
// colours were never wrong (a rim really is the colour of the silhouette); the
// SAMPLING RATE was wrong, by two orders of magnitude, and a magnified signal
// that is not prefiltered to match is aliasing by definition.
//
// So: extend subject colour outward as an exact Voronoi fill, build a mip
// pyramid over it, and read each texel at LOD = log2(stretch), where the
// front sheet is z = H(x,y) and stretch = 1∕(n·ẑ) = sqrt(1 + |∇H|²). The
// stripes collapse into a smooth radial continuation of the edge colour, which
// is the honest reading of a surface the camera only ever saw edge-on.
// How far inside the silhouette the colour fill is seeded, in WORKING-GRID
// pixels — one pixel in, which is the width of the band the matte is uncertain
// over. Swept at 1x, 2x, 3x and 4x texture upsampling against the mean atlas
// luminance two texels outside the silhouette, over a subject on a 232 ground:
// 0.5px still leaves 76 at 4x, 1.0px holds 56-58 everywhere, and 2.5px buys
// nothing further (65-67) while eroding more of a thin limb than it needs to.
export const FILL_ERODE_PX = 1.0;
// One extra working pixel for the far half, which is the scale of the
// registration residual it has to absorb. Swept on the app's own grids: 0 leaves
// 3.06% of the far half brighter than the subject can be, 1 brings it to 0.17%
// — level with the near half's 0.23% — and 2 and beyond buy 0.04% while eroding
// more of a thin limb than they need to.
export const BACK_ERODE_EXTRA = 1.0;

export function projectTexture(px, tw, th, alpha, sw, sh, stretch, erodePx = FILL_ERODE_PX) {
  const TN = tw * th;
  const sx = sw / tw, sy = sh / th;

  const fg = new Uint8Array(TN);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++)
    fg[y*tw+x] = sampleBilinear(alpha, sw, sh, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) >= 0.5 ? 1 : 0;

  // The fill is seeded from a slightly ERODED silhouette. A boundary pixel of
  // an area-averaged image is a mix of subject and background, so seeding the
  // fill with it drags the background's colour across the entire side of the
  // model — the one place a projective atlas has to invent the most. Stepping
  // in past the anti-aliased edge costs nothing and keeps the sides the colour
  // of the subject. Kept small: erode far enough to reach the object's bulk and
  // the Voronoi cells of a thin limb start to fan out across it.
  //
  // The distance to step in is set by the WORKING grid, not by the texture. The
  // silhouette here is `fg`, obtained by sampling the working-grid matte `alpha`,
  // so its transition band is tw/sw texels wide however large the texture is —
  // and the erosion has to clear that band. Sizing it as a fraction of the
  // texture instead does the opposite: it stays near-constant in texels while the
  // band it must clear grows with the upsampling. Measured on a subject over a
  // 232-luminance ground, mean atlas luminance two texels outside the silhouette
  // went 54 at 1x upsampling, 147 at 2x, 55 at 3x, 76 at 4x — background flooding
  // the side of the model at exactly the resolutions the app actually uses, and
  // not at the one the tests happened to exercise. In working-grid pixels the
  // right number is stable, and it is swept below.
  const INF = 1e20, sIn = new Float64Array(TN);
  for (let i = 0; i < TN; i++) sIn[i] = fg[i] ? INF : 0;
  const dIn = edt2d(sIn, tw, th);
  const erode = Math.max(2, Math.round(erodePx * tw / sw));
  const core = new Uint8Array(TN);
  let nCore = 0;
  for (let i = 0; i < TN; i++) if (dIn[i] >= erode * erode) { core[i] = 1; nCore++; }
  const seeds = nCore > 64 ? core : fg;

  const near = nearestSeed(seeds, tw, th);
  const L = Math.max(1, Math.min(7, Math.floor(Math.log2(Math.min(tw, th))) - 2));
  const mips = [];
  {
    const l0 = new Float32Array(TN * 3);
    for (let i = 0; i < TN; i++) {
      // The eroded core, not the silhouette, decides where a texel may take its
      // colour from ITSELF. Everything else takes the nearest core texel's.
      // Reading `fg` here instead left a one-texel rind that copied the source
      // pixel directly — and a texel with alpha just over a half is half
      // background, so that rind carried the ground's colour. It is a thin
      // line, and it lands in the worst possible place: the silhouette, where a
      // projective atlas is magnified by 1/(n·ẑ), so a six-texel run comes back
      // as a thirteen-pixel band down the fold of every off-axis view. Measured
      // 316 texels over 150 luminance on a subject that cannot exceed 122.
      const j = seeds[i] ? i : near[i];
      l0[i*3] = px[j*4]; l0[i*3+1] = px[j*4+1]; l0[i*3+2] = px[j*4+2];
    }
    mips.push({ d: l0, w: tw, h: th });
  }
  for (let l = 1; l <= L; l++) {
    const p = mips[l-1], nw = Math.max(1, p.w >> 1), nh = Math.max(1, p.h >> 1);
    const d = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const x0 = Math.min(p.w-1, 2*x), x1 = Math.min(p.w-1, 2*x+1);
      const y0 = Math.min(p.h-1, 2*y), y1 = Math.min(p.h-1, 2*y+1);
      for (let c = 0; c < 3; c++)
        d[(y*nw+x)*3+c] = (p.d[(y0*p.w+x0)*3+c] + p.d[(y0*p.w+x1)*3+c]
                         + p.d[(y1*p.w+x0)*3+c] + p.d[(y1*p.w+x1)*3+c]) * 0.25;
    }
    mips.push({ d, w: nw, h: nh });
  }
  const tapMip = (l, u, v, o) => {
    const m = mips[l];
    const x = Math.max(0, Math.min(m.w - 1.001, u * m.w - 0.5));
    const y = Math.max(0, Math.min(m.h - 1.001, v * m.h - 0.5));
    const x0 = x|0, y0 = y|0, fx = x - x0, fy = y - y0;
    const i00 = (y0*m.w+x0)*3, i10 = (y0*m.w+x0+1)*3, i01 = ((y0+1)*m.w+x0)*3, i11 = ((y0+1)*m.w+x0+1)*3;
    for (let c = 0; c < 3; c++)
      o[c] = m.d[i00+c]*(1-fx)*(1-fy) + m.d[i10+c]*fx*(1-fy) + m.d[i01+c]*(1-fx)*fy + m.d[i11+c]*fx*fy;
  };

  const out = new Uint8ClampedArray(TN * 4);
  const a = [0,0,0], b = [0,0,0];
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = y*tw+x;
    const s = sampleBilinear(stretch, sw, sh, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
    let lod = Math.log2(Math.max(1, s));
    if (lod > L) lod = L; if (lod < 0) lod = 0;
    const l0 = lod | 0, l1 = Math.min(L, l0 + 1), t = lod - l0;
    const u = (x + 0.5) / tw, v = (y + 0.5) / th;
    tapMip(l0, u, v, a);
    if (t > 1e-3) tapMip(l1, u, v, b); else { b[0]=a[0]; b[1]=a[1]; b[2]=a[2]; }
    out[i*4]   = a[0] + (b[0]-a[0])*t;
    out[i*4+1] = a[1] + (b[1]-a[1])*t;
    out[i*4+2] = a[2] + (b[2]-a[2])*t;
    out[i*4+3] = 255;
  }
  return out;
}

/* ---------------------------------------------------------------- reports */

// `topology` now lives in ./topology.js — it reads a position and index buffer
// and nothing else, and leaving it here meant the certificate verifier had to
// import the whole reconstruction to count edges. Re-exported so every existing
// `import { topology } from './atlas-core.js'` resolves to the same function.
export { topology };

// TWO KINDS OF NUMBER COME OUT OF HERE, and they are not equally good.
//
// `observed` / `completed` are GEOMETRY. A vertex is unobserved when no camera
// could see it: on one photograph that is the far side (n·ẑ < 0), and with a
// registered back view it is the grazing band both cameras see edge-on. That is
// a fact about the surface and the camera stations, and the area-weighted
// fraction is exactly what it says.
//
// `pct` is a histogram of `aconf`, which is an INDEX, not a probability. It is
// a product of hand-tuned smoothsteps in |n·ẑ| clamped to [0.12, 1]: it is
// monotone in the right things — grazing surface is less well sampled than
// face-on surface, unobserved surface less than observed — and that is the whole
// of its content. It has no units, no calibration and no coverage guarantee.
// `aconf[i] = 0.62` does not mean the surface is within any distance of the
// truth with any probability.
//
// So the median is GONE. Reporting the median of a dimensionless index to two
// decimals implies a calibrated scale that does not exist, and it was the single
// most authoritative-looking number in the panel. Turning this index into a
// calibrated per-vertex σ, scored against the analytic fixtures, is real work
// with a real test; it is not done by formatting.
/**
 * Re-render the finished solid's own silhouette at the input camera, and score
 * it against the matte the segmentation committed to.
 *
 * This is the one check that asks whether the exported mesh is still a
 * reconstruction OF THIS PHOTOGRAPH. Everything else in the report measures a
 * field, or a property of the mesh in isolation; a solid can be watertight, well
 * conditioned and beautifully skinned while sitting a few pixels off the subject
 * it came from, and nothing else here would notice. It is also the only number in
 * the certificate that closes the loop from the exported bytes back to the input.
 *
 * SUB-PIXEL, because a binary rasterisation cannot resolve what it is measuring.
 * The matte `alpha` is fractional at the boundary — that is the whole point of it
 * — so the re-render is supersampled SS×SS per pixel and reduced to a coverage in
 * [0, 1], and the two are compared as fuzzy sets:
 *
 *     IoU = Σ min(a, b) ∕ Σ max(a, b)
 *
 * which is the ordinary IoU when both are indicators and degrades gracefully when
 * they are not. At SS = 3 a boundary pixel is resolved to a ninth of itself,
 * which is finer than the matte's own uncertainty.
 *
 * No depth buffer and no culling: the surface is closed, so a pixel is inside the
 * silhouette exactly when SOME triangle covers it, whichever way that triangle
 * faces.
 *
 * THE REFERENCE IS BUILT HERE rather than taken from the caller, because there is
 * a wrong thing lying around that looks right. `seg.alpha` is the smoothstep of
 * each pixel's distance from the background colour, kept only where it agrees
 * with the committed mask — so in the background it is small but NOT zero, and
 * summed over 46,000 background pixels that is real area: measured on the test
 * figure, 11,917 against a silhouette of 5,894. Scoring against it directly puts
 * the IoU at 0.48 for a re-projection that is in fact exact to a pixel. What the
 * silhouette actually is: the mask, with `alpha` admitted only on the boundary
 * band where it means a partial covering.
 *
 * @param {object} frame  the model↔grid mapping `reconstruct` reports
 */
export function silhouetteIoU(positions, indices, frame, mask, alpha, w, h, SS = 3) {
  const { md, S, cx0, cy0, ccx, ccy, ccz, invD0 } = frame;
  const gw = w * SS, gh = h * SS;
  const cov = new Uint8Array(gw * gh);

  // model → grid, inverting the un-projection: z is recovered first because the
  // lateral scale k depends on it.
  const toGrid = (i) => {
    const z = (positions[i*3+2] + ccz) * md / S;
    const k = 1 - z * invD0;
    const kk = Math.abs(k) < 1e-6 ? 1e-6 : k;
    return [((positions[i*3] + ccx) * md / S) / kk + cx0,
            cy0 - ((positions[i*3+1] + ccy) * md / S) / kk];
  };

  for (let t = 0; t < indices.length; t += 3) {
    const a = toGrid(indices[t]), b = toGrid(indices[t+1]), c = toGrid(indices[t+2]);
    const ax = a[0]*SS, ay = a[1]*SS, bx = b[0]*SS, by = b[1]*SS, cx = c[0]*SS, cy = c[1]*SS;
    let x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    let x1 = Math.min(gw - 1, Math.ceil(Math.max(ax, bx, cx)));
    let y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    let y1 = Math.min(gh - 1, Math.ceil(Math.max(ay, by, cy)));
    if (x1 < x0 || y1 < y0) continue;
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(d) < 1e-12) continue;
    const inv = 1 / d;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const l1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * inv;
        const l2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
        if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
        cov[y * gw + x] = 1;
      }
    }
  }

  const inv2 = 1 / (SS * SS);
  let inter = 0, uni = 0, area = 0, ref = 0, peri = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y*w + x;
    let c = 0;
    for (let sy = 0; sy < SS; sy++) {
      const row = (y*SS + sy) * gw + x*SS;
      for (let sx = 0; sx < SS; sx++) c += cov[row + sx];
    }
    const b = c * inv2;
    const m = mask[i] ? 1 : 0;
    const edge = (x > 0 && !mask[i-1] !== !m) || (x < w-1 && !mask[i+1] !== !m)
              || (y > 0 && !mask[i-w] !== !m) || (y < h-1 && !mask[i+w] !== !m);
    const a = edge && alpha ? Math.max(0, Math.min(1, alpha[i])) : m;
    inter += Math.min(a, b); uni += Math.max(a, b); area += b; ref += a;
    if (edge) peri++;
  }
  // IoU IS NOT THE SUB-PIXEL NUMBER, and quoting it as one would misread it. It
  // is perimeter-sensitive: the symmetric difference of two silhouettes that
  // agree to within δ of a pixel everywhere is about δ·perimeter, so the IoU a
  // perfect re-projection can reach depends on how much boundary the subject has.
  // On the test figure — 5,959px of silhouette against roughly 600px of
  // perimeter — half a pixel of disagreement caps it at about 0.95, and a
  // threshold of 0.97 would be failing a mesh that is exact.
  //
  // The quantity that IS sub-pixel, and that means the same thing on a disk and
  // on a five-limbed figure, is the mean boundary displacement the disagreement
  // implies: (symmetric difference) ∕ (perimeter), in pixels.
  const symDiff = uni - inter;
  return { iou: uni > 0 ? inter / uni : 0, renderedArea: area, referenceArea: ref,
           perimeter: peri, offsetPx: peri > 0 ? symDiff / peri : 0, ss: SS };
}

/**
 * Where the surface came from, as an area-weighted three-way split.
 *
 * The words are chosen to name three genuinely different things, and each one is
 * read off a field that already exists rather than off a threshold invented here:
 *
 *   measured  — the position is pinned by the silhouette. The boundary's own
 *               localisation error dominates σ there (shared fraction < ½), which
 *               is what "the photograph put this surface here" means numerically.
 *   inflated  — a camera saw it, but its DEPTH is the inflation and the anisotropy
 *               prior, not a measurement: the prior's variance dominates σ.
 *   authored  — no camera saw it at all. On one photograph that is the mirrored
 *               far side; with a back view it is the grazing band both cameras
 *               see edge-on.
 *
 * Area-weighted over triangles, not counted over vertices, because a vertex count
 * is a statement about tessellation density and this is a statement about surface.
 */
export function provenanceReport(positions, indices, agen, shared) {
  let m = 0, i2 = 0, au = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t+1], c = indices[t+2];
    const e1 = [positions[b*3]-positions[a*3], positions[b*3+1]-positions[a*3+1], positions[b*3+2]-positions[a*3+2]];
    const e2 = [positions[c*3]-positions[a*3], positions[c*3+1]-positions[a*3+1], positions[c*3+2]-positions[a*3+2]];
    const cx = e1[1]*e2[2]-e1[2]*e2[1], cy = e1[2]*e2[0]-e1[0]*e2[2], cz = e1[0]*e2[1]-e1[1]*e2[0];
    const ar = 0.5 * Math.hypot(cx, cy, cz);
    const g = (agen[a] + agen[b] + agen[c]) / 3;
    const s = (shared[a] + shared[b] + shared[c]) / 3;
    if (g >= 0.5) au += ar; else if (s < 0.5) m += ar; else i2 += ar;
  }
  const tot = m + i2 + au;
  return tot > 0
    ? { measured: m/tot, inflated: i2/tot, authored: au/tot, area: tot }
    : { measured: 0, inflated: 0, authored: 0, area: 0 };
}

export function confidenceReport(positions, indices, aconf, agen) {
  const nT = indices.length / 3;
  let obs = 0, tot = 0;
  for (let t = 0; t < nT; t++) {
    const a = indices[t*3], b = indices[t*3+1], c = indices[t*3+2];
    const ax = positions[a*3], ay = positions[a*3+1], az = positions[a*3+2];
    const ux = positions[b*3]-ax, uy = positions[b*3+1]-ay, uz = positions[b*3+2]-az;
    const vx = positions[c*3]-ax, vy = positions[c*3+1]-ay, vz = positions[c*3+2]-az;
    const cx = uy*vz-uz*vy, cy = uz*vx-ux*vz, cz = ux*vy-uy*vx;
    const ar = Math.hypot(cx, cy, cz) / 2;
    tot += ar;
    if ((agen[a] + agen[b] + agen[c]) / 3 < 0.5) obs += ar;
  }
  const buckets = [0, 0, 0, 0];
  for (let i = 0; i < aconf.length; i++) {
    if (agen[i] > 0.5) buckets[3]++;
    else if (aconf[i] > 0.75) buckets[0]++;
    else if (aconf[i] > 0.5) buckets[1]++;
    else buckets[2]++;
  }
  const s = aconf.length || 1;
  return { observed: obs/tot, completed: 1 - obs/tot,
           indexIsQualitative: true,
           pct: [buckets[0]/s, buckets[1]/s, buckets[2]/s, buckets[3]/s] };
}

/* ------------------------------------------------------------- the pipeline */

const noop = () => {};

// `extra` carries the optional companion views:
//   { back:    { px, w, h, tex? },   a photograph from behind
//     profile: { px, w, h },         a photograph from the side
//     facing:  'left' | 'right' }    which way the profile subject faces
// Both are optional and independent, and the single-image path is unchanged.
// They do very different jobs, and the split is not cosmetic: the profile is the
// only one of the two that carries any information about depth at all.
//
// `opts.lens` is the record src/exif.js produces — `{known, fRel, mm35, source}`
// — or nothing. It is the ONLY route by which a focal length enters, and it
// cannot be synthesised from the pixels. Without it the un-projection is
// orthographic.
export function reconstruct(px, w, h, modeName, report = noop, tex = null, extra = null, opts = null) {
  const cfg = PRESETS[modeName] || PRESETS.balanced;
  const N = w * h;
  const log = [], notes = [];
  const L = (text, color) => log.push({ text, color: color || 'ink' });
  const NOTE = (mark, text, color) => notes.push({ mark, text, color });
  const t0 = Date.now();

  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = (0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2]) / 255;
  const alpha = hasAlpha(px, N);

  report({ phase: 0, stage: 0, progress: 5 });
  L(`normalize · working grid ${w}×${h}px`);
  L(`alpha · ${alpha ? 'present' : 'none'}`);

  report({ phase: 1, stage: 1, progress: 12 });
  L('subject segmentation · trimap boundary');
  const seg = segment(px, lum, w, h, alpha);
  if (!seg.bounds.area) throw new Error('no subject found — try an image with a clearer background');
  if (seg.components > 1) NOTE('※', `Multiple foreground objects detected (${seg.components}). Primary subject isolated by area.`, 'amber');
  if (seg.edgeTouch > 0.06) NOTE('※', `Subject touches the image edge at ${(seg.edgeTouch*100).toFixed(0)}% of its silhouette. Completion there is generative.`, 'amber');
  if (seg.bgVar > 0.06) NOTE('※', 'Background is complex; boundary confidence reduced near textured regions.', 'amber');
  const dist = distanceTransform(seg.mask, w, h, seg.alpha);

  report({ phase: 1, stage: 2, progress: 20 });
  const cam = cameraFromLens(opts && opts.lens);
  if (cam.known) {
    L(`lens · ${cam.mm35}mm equiv · f = ${cam.fRel.toFixed(3)}·long side · ${cam.source}`, 'blue');
    NOTE('◎', `Focal length ${cam.mm35}mm (35mm equivalent), `
             + (cam.source === 'declared' ? 'declared by the host.' : `read from ${cam.source}.`)
             + ` The un-projection carries the taper this lens imposes.`
             + (cam.cropChecked ? '' : ' The image dimensions could not be checked against the'
               + ' sensor’s, so a crop — which changes the field of view without changing'
               + ' any EXIF field — cannot be ruled out.'), 'blue');
  } else {
    L(`lens · unknown (${cam.reason}) · un-projecting orthographically`, 'amber');
    NOTE('※', `Lens unknown — ${cam.reason}. The subject is un-projected orthographically:`
             + ` no perspective taper is applied, because none can be measured. A focal length`
             + ` is never inferred from the picture.`, 'amber');
  }

  report({ phase: 2, stage: 3, progress: 30 });
  L('monocular depth · shape-from-shading + screened Poisson');
  const dep = depthField(seg.mask, dist, lum, px, w, h);
  L(`light est · L=(${dep.light.x},${dep.light.y},${dep.light.z})`, 'blue');
  L(`surface normals · SOR converged in ${dep.iters} sweeps`);
  const nrmField = surfaceNormals(dep.depth, seg.mask, w, h, 0.6);

  report({ phase: 3, stage: 4, progress: 40 });
  const lat = lateralAxis(seg.mask, w, h);
  L(`symmetry · mirror-IoU ${lat.sym.toFixed(3)} about x = ${lat.axis.toFixed(1)}`
    + ` (frame centre ${((w - 1) / 2).toFixed(1)})`, 'blue');

  report({ phase: 4, stage: 5, progress: 50 });
  L('volume · half-thickness from the union of maximal inscribed balls');
  const art = { w, h, mask: seg.mask, dist, alpha: seg.alpha, lat };
  const vol = buildVolume(art, cfg);
  const vs = vol.stats;
  L(`inflation · ${vs.sweeps} SOR sweeps · residual ${vs.res.toExponential(1)} on a ${vs.solveW}×${vs.solveH} grid`);
  L(`regime · ρ = √u ⁄ D = ${vs.rho.toFixed(2)} mean · ${Math.round(vs.strip*100)}% strip-like`, 'blue');
  L(`anisotropy · τ_trunk = ${vs.tauTrunk.toFixed(2)} (${vs.frontal ? 'frontal — trunk flattened' : 'profile — trunk widened'})`, 'blue');
  // The skeleton falls out of fields that already exist: the feature transform
  // the texture fill needs, and ρ. See src/rig.js.
  const bgSeed = new Uint8Array(N);
  for (let i = 0; i < N; i++) bgSeed[i] = seg.mask[i] ? 0 : 1;
  const rig = buildRig({ mask: seg.mask, A: vol.A, rho: vol.rho,
                         near: nearestSeedD(bgSeed, w, h).near, w, h });
  L(`skeleton · ${rig.stats.joints} joints · ${rig.stats.bones} bones`
    + ` · ${rig.stats.branches} branches · ${rig.stats.waists} waists`
    + ` (ρ ${rig.stats.waistsRho}, A ${rig.stats.waistsA})`, 'blue');
  NOTE('◎', `Cross-sections are the upper envelope of the maximal balls that fit inside the silhouette, so a disk reconstructs as an exact hemisphere and a strip as an exact cylinder, and no radius can cross a gap. ρ = √u∕D is reported as a regime diagnostic only — 1 for disk-like parts, √2 for strip-like ones, and unbounded at a waist, where it reaches ${vs.rho.toFixed(2)} on this subject.`, 'blue');
  NOTE(vs.frontal ? '◎' : '§', vs.frontal
    ? `Silhouette mirror-IoU ${vs.sym.toFixed(2)} — subject reads FRONTAL, so the image plane is not the sagittal plane and the two sides of the volume are an assumption, not a symmetry. The trunk is flattened out of plane (τ = ${vs.tauTrunk.toFixed(2)}) because the wide axis is the one being measured.`
    : `Silhouette mirror-IoU ${vs.sym.toFixed(2)} — subject reads in PROFILE, so the image plane is the sagittal plane and the lateral mirror is a real bilateral symmetry rather than a guess. The trunk is widened out of plane (τ = ${vs.tauTrunk.toFixed(2)}) because the measured axis is the shallow one.`,
    vs.frontal ? 'amber' : 'green');

  // ---------------------------------------------------------------- profile
  // The one view that carries depth. See profileConstraint for why a back view
  // does not, and applyProfile for what a single profile can and cannot say.
  let prof = null, pfit = null, papply = null;
  if (extra && extra.profile && extra.profile.px) {
    report({ phase: 4, stage: 5, progress: 55 });
    const pv = extra.profile, pN = pv.w * pv.h;
    const plum = new Float32Array(pN);
    for (let i = 0; i < pN; i++) plum[i] = (0.299*pv.px[i*4] + 0.587*pv.px[i*4+1] + 0.114*pv.px[i*4+2]) / 255;
    const pseg = segment(pv.px, plum, pv.w, pv.h, hasAlpha(pv.px, pN));
    if (pseg.bounds.area > 16) {
      prof = profileConstraint(seg.mask, w, h, pseg.mask, pv.w, pv.h, (extra.facing === 'right') ? 'right' : 'left');
      const before = profileFit(vol, prof, seg.mask);
      papply = applyProfile(vol, prof, {});
      pfit = profileFit(vol, prof, seg.mask);
      L(`profile · registered at ${prof.scale.toFixed(3)}× over ${prof.rows} rows`
        + ` · depth fit ${before.iou.toFixed(2)} → ${pfit.iou.toFixed(2)}`, 'green');
      let kmin = 9, kmax = 0;
      for (let y = 0; y < h; y++) if (papply.k[y]) { kmin = Math.min(kmin, papply.k[y]); kmax = Math.max(kmax, papply.k[y]); }
      NOTE('◎', `Profile view supplied — the out-of-plane thickness is MEASURED per row rather than assumed. The anisotropy prior τ was rescaled by ${kmin.toFixed(2)}–${kmax.toFixed(2)} down the subject, and the reconstruction's own side silhouette now matches the supplied profile at IoU ${pfit.iou.toFixed(2)} (it was ${before.iou.toFixed(2)} on the front view alone).`, 'green');
      NOTE('※', `A profile silhouette reports the deepest part of each row and cannot say which part that is, so the row is rescaled rather than carved. Where the deepest part of a row is not also its widest — an arm reaching toward the camera — that attribution is wrong; the scale is bounded and smoothed so the error stays local. Which way the profile subject faces is declared, not measured: it is set to "${prof.facing}". The total depth does not depend on it, but the front-to-back asymmetry does.`, 'amber');
    } else {
      NOTE('※', 'Profile view supplied but no subject could be segmented from it; it was ignored.', 'amber');
    }
  }

  // ------------------------------------------------------------------- back
  // Texture and surface relief for the far side, and an honest confidence field.
  // It adds nothing to the geometry, by the argument in profileConstraint.
  let backReg = null, backPx = null, backTex = null, backDep = null, backLum = null, backAlpha = null;
  if (extra && extra.back && extra.back.px) {
    report({ phase: 4, stage: 5, progress: 58 });
    const bv = extra.back, bN = bv.w * bv.h;
    const blum = new Float32Array(bN);
    for (let i = 0; i < bN; i++) blum[i] = (0.299*bv.px[i*4] + 0.587*bv.px[i*4+1] + 0.114*bv.px[i*4+2]) / 255;
    const bseg = segment(bv.px, blum, bv.w, bv.h, hasAlpha(bv.px, bN));
    if (bseg.bounds.area > 16) {
      backReg = registerSimilarity(seg.mask, w, h, bseg.mask, bv.w, bv.h, true);
      backPx = warpThrough(bv.px, bv.w, bv.h, backReg, w, h);
      // The back's OWN matte, brought into the front's grid. The far atlas half
      // is filled only where both views agree there is subject, and that is not
      // fussiness: the colour fill is seeded a fixed distance inside the
      // silhouette, and a registration residual of the same order puts those
      // seeds on the back photograph's edge pixels — half subject, half
      // background. Their Voronoi cells then carry that background across the
      // whole side of the model. Measured at the app's own grids, with a residual
      // of 2.4 texels against 2.6 texels of erosion: 10.8% of the far half came
      // back brighter than the subject can be, in runs up to 170 texels.
      backAlpha = warpField(bseg.alpha, bv.w, bv.h, backReg, w, h);
      const bt = bv.tex || bv;
      // the same registration, expressed in the texture grid's own units
      const ts = (bt.w / bv.w);
      backTex = { px: warpThrough(bt.px, bt.w, bt.h, { s: backReg.s * (tex ? tex.w / w : 1) / ts,
                                                       tx: backReg.tx * (tex ? tex.w / w : 1),
                                                       ty: backReg.ty * (tex ? tex.h / h : 1),
                                                       mirror: true },
                                  tex ? tex.w : w, tex ? tex.h : h),
                  w: tex ? tex.w : w, h: tex ? tex.h : h };
      backLum = new Float32Array(N);
      for (let i = 0; i < N; i++) backLum[i] = (0.299*backPx[i*4] + 0.587*backPx[i*4+1] + 0.114*backPx[i*4+2]) / 255;
      // The back is resampled into the FRONT's grid, so it shares the front's
      // mask and distance field and every downstream index keeps meaning the
      // same thing. That is the whole reason to warp rather than carry a
      // transform through the pipeline.
      backDep = depthField(seg.mask, dist, backLum, backPx, w, h);
      L(`back view · registered at ${backReg.s.toFixed(3)}× · silhouette agreement ${backReg.iou.toFixed(3)}`,
        backReg.iou > 0.9 ? 'green' : 'amber');
      if (backReg.iou < 0.9) NOTE('※', `The back view's silhouette agrees with the front's at only IoU ${backReg.iou.toFixed(2)} after registration. A similarity transform cannot absorb a subject who moved between the two exposures; the back texture will be misplaced by roughly that much.`, 'amber');
      else NOTE('◎', `Back view supplied and registered at IoU ${backReg.iou.toFixed(2)}. The far side of the model is now photographed rather than mirrored — its texture and its surface relief are its own. It adds nothing to the depth: two cameras on the same optical axis constrain the same two dimensions.`, 'green');
    } else {
      NOTE('※', 'Back view supplied but no subject could be segmented from it; it was ignored.', 'amber');
    }
  }
  const hasBack = !!backPx;

  // ------------------------------------------------------------ uncertainty
  // Computed here, after the profile has had its say and before the isosurface,
  // because it reads the sheets the isosurface is about to walk. Two grids, one
  // per sheet; with one photograph they are identical.
  const bsig = boundarySigma(seg, w, h, coverageBlur(seg.mask, w, h, seg.alpha));
  const sgrid = sigmaGrid(vol, { sigmaR: bsig.sigmaR, profileK: papply ? papply.k : null });
  // Continued outside the silhouette by nearest-neighbour, for the same reason
  // `sheetStretch` is: the shell closes at the boundary, so vertices land a
  // fraction of a pixel outside it, and bilinear sampling into the zeros there
  // would report a confident surface exactly where the surface is least certain.
  {
    const nb = nearestSeed(seg.mask, w, h);
    for (const f of [sgrid.front, sgrid.back, sgrid.wFront, sgrid.wBack])
      for (let i = 0; i < N; i++) if (!seg.mask[i]) f[i] = f[nb[i]];
  }
  L(`uncertainty · σ_boundary ${bsig.sigmaR.toFixed(3)}px`
    + ` = matte ${bsig.matte.toFixed(3)}`
    + (bsig.floored ? ' (at the 1∕√12 quantisation floor)' : bsig.ceiled ? ' (at the ceiling)' : '')
    + ` ⊕ regularisation ${bsig.reg.toFixed(3)}`
    + ` · |∇α| ${bsig.grad.toFixed(3)} over ${bsig.n} boundary px`, 'blue');

  report({ phase: 5, stage: 6, progress: 62 });
  L('isosurface · surface nets on the shell band · Taubin λ∕μ');
  const sn = surfaceNets(vol);
  const pos = new Float64Array(sn.pos);
  const idx = new Int32Array(sn.idx);
  const n = pos.length / 3;
  if (!n) throw new Error('empty volume — subject too small after segmentation');
  // Where the isosurface put each vertex, before anything moved it. Kept so the
  // total displacement the mesh stages apply — Taubin twice and the relief
  // between them — can be MEASURED rather than assumed negligible. It is not
  // negligible: it is the difference between the surface σ's model describes,
  // which is the field's own level set, and the surface actually exported.
  const posRaw = Float64Array.from(pos);
  taubin(pos, idx, cfg.smoothIters, 0.62, -0.64);

  const Pv = new Float32Array(n * 3);
  const sync = () => { for (let i = 0; i < n; i++) { Pv[i*3]=pos[i*3]; Pv[i*3+1]=pos[i*3+1]; Pv[i*3+2]=pos[i*3+2]; } };
  sync();
  let nv = vertexNormals(Pv, idx, n);

  report({ phase: 5, stage: 6, progress: 70 });
  // Relief as a NORMAL DISPLACEMENT, not a thickness modulation. A photograph
  // constrains the surface it can see; modulating thickness smears that
  // evidence around the whole cross-section. The limit keeps it a fraction of
  // the LOCAL radius, so a fabric crease cannot become a cliff on a wrist.
  //
  // Its AMPLITUDE is set by the scale of the detail band, not by how thick the
  // part is. Scaling by the local radius handed the torso ±4px of displacement
  // from exactly the normalised signal that gave a wrist ±0.5px, so every wide
  // surface came out corrugated. A shading feature of wavelength λ on a
  // Lambertian surface implies a height perturbation of order λ·δn, and λ is a
  // constant in pixels — the band's own cutoff.
  const gate = reliefGate(lum, px, seg.mask, w, h);
  const rr = cfg.reliefRad;
  const rel = reliefField(dep.depth, gate, seg.mask, w, h, rr, 4, Math.max(4, Math.round(w * 0.055)));
  // Each sheet takes its detail from the photograph that actually saw it. With
  // one image the back sheet is displaced by the front's relief mirrored onto it,
  // which is a guess wearing the clothes of a measurement; with a back view it is
  // the back's own shading.
  const relB = hasBack
    ? reliefField(backDep.depth, reliefGate(backLum, backPx, seg.mask, w, h),
                  seg.mask, w, h, rr, 4, Math.max(4, Math.round(w * 0.055)))
    : null;
  if (cfg.reliefAmp > 0) {
    for (let i = 0; i < n; i++) {
      const x = pos[i*3], y = pos[i*3+1];
      const xi = Math.max(0, Math.min(w-1, Math.round(x))), yi = Math.max(0, Math.min(h-1, Math.round(y)));
      if (!seg.mask[yi*w+xi]) continue;
      const facingBack = nv[i*3+2] < 0;
      const field = (facingBack && relB) ? relB : rel;
      const r = sampleBilinear(field, w, h, x, y), a = sampleBilinear(vol.A, w, h, x, y);
      const face = Math.pow(Math.abs(nv[i*3+2]), 1.3);
      let d = cfg.reliefAmp * rr * r * face;
      const lim = 0.28 * a; if (d > lim) d = lim; if (d < -lim) d = -lim;
      pos[i*3] += nv[i*3]*d; pos[i*3+1] += nv[i*3+1]*d; pos[i*3+2] += nv[i*3+2]*d;
    }
    sync(); taubin(pos, idx, 2, 0.32, -0.33); sync();
    nv = vertexNormals(Pv, idx, n);
  }

  // The measurement. Along the vertex's own normal, because that is the
  // direction σ is stated in — a vertex sliding ALONG the surface is Taubin
  // doing its job and is not a displacement of the surface at all.
  let meshShift = 0;
  {
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = pos[i*3] - posRaw[i*3], dy = pos[i*3+1] - posRaw[i*3+1], dz = pos[i*3+2] - posRaw[i*3+2];
      const d = dx*nv[i*3] + dy*nv[i*3+1] + dz*nv[i*3+2];
      s2 += d * d;
    }
    meshShift = Math.sqrt(s2 / Math.max(1, n));
  }
  L(`mesh · smoothing and relief moved the surface ${meshShift.toFixed(3)}px rms along its normal`, 'blue');

  report({ phase: 5, stage: 7, progress: 80 });
  // Perspective un-projection from the estimated focal length. A pixel (x,y) at
  // scene depth Z back-projects to X = (x−cx)·Z/f, so the lateral scale applied
  // at depth z is k = Z/D0 = (D0 − z)/D0, and the reconstruction carries the
  // taper the lens actually imposed.
  //
  // D0 is the subject's distance EXPRESSED IN THE UNITS z IS ALREADY IN, and that
  // pins it exactly rather than by estimate. H, and therefore z, is measured in
  // pixels of the working grid — that is, in pixels of the image plane resampled
  // to the subject's own depth. One such pixel subtends 1/f_px radians, so a
  // distance of D0 of them is D0/f_px radians, and the subject sits at exactly
  // f_px of them: D0 = f_px, with no free parameter.
  //
  // It used to be f_px·objH/md, which is f_px scaled by how much of the frame the
  // subject fills. That is dimensionally a different quantity, and it makes the
  // taper too strong by md/objH — the smaller the subject in frame, the more the
  // model is bent. Measured over the un-projection alone at zHalf = 30: a subject
  // filling the frame got 15.9% of front-to-back lateral scale against a correct
  // 15.9%, but one filling a quarter of it got 37.6% against a correct 8.2%, a
  // 4.6x exaggeration. Front-on that is invisible, because it is a scale along the
  // view axis; off-axis it is a wedge, and it is the one error here that grows as
  // the subject gets smaller in frame — i.e. on exactly the casual photographs
  // the tool is aimed at.
  //
  // AND: f_px has to COME from somewhere. It used to come from a fabricated
  // focal length, so "no free parameter" was true only downstream of one. Now
  // f_px = fRel · md with fRel read from EXIF, and when the photograph does not
  // carry a focal length there is no taper at all: 1/D0 = 0, so k ≡ 1 and the
  // un-projection is orthographic. An unknown lens is not a 50mm lens.
  const md = Math.max(w, h), S = 2.4;
  const fpx = cam.known ? cam.fRel * md : 0;
  // A subject deeper than the camera is far would invert through the lens
  // (k ≤ 0). No real photograph does that, so it means the reconstruction's own
  // depth has outgrown the declared lens. The clamp keeps the un-projection
  // sane, and — unlike before — says when it bound, because a clamped taper is
  // no longer the taper the lens describes.
  const D0floor = 2.2 * vol.zHalf;
  const clamped = cam.known && fpx < D0floor;
  const D0 = cam.known ? Math.max(fpx, D0floor) : Infinity;
  const invD0 = cam.known ? 1 / D0 : 0;
  if (clamped) {
    NOTE('※', `The ${cam.mm35}mm lens places the subject nearer than its own reconstructed`
             + ` depth, which cannot happen in a photograph. The perspective taper has been`
             + ` limited to ${(fpx / D0floor).toFixed(2)}× of what that focal length implies.`, 'amber');
    L(`un-projection · taper limited · f_px ${fpx.toFixed(0)} < floor ${D0floor.toFixed(0)}`, 'amber');
  } else {
    L(`un-projection · ${cam.known ? `D₀ = f_px = ${fpx.toFixed(0)}` : 'orthographic · k ≡ 1'}`,
      cam.known ? 'blue' : 'amber');
  }
  const cx0 = w / 2, cy0 = h / 2;

  // How much a badly registered back view should be discounted. Two separate
  // things get called "generated" and they should not be conflated: surface no
  // camera saw, and surface a camera saw but cannot be placed. The first is the
  // grazing band at the silhouette, and it is unobserved however good the
  // registration is; the second is the whole far side when the subject moved
  // between exposures. So they are combined with a max, not multiplied.
  const backMiss = hasBack ? Math.max(0, Math.min(1, (0.92 - backReg.iou) / 0.22)) : 1;
  const P = new Float32Array(n * 3);
  const aconf0 = new Float32Array(n), agen0 = new Float32Array(n), sig0 = new Float32Array(n);
  // How much of this vertex's variance comes from the source that is one scalar
  // for the whole subject rather than per-vertex noise. It is what separates
  // "the silhouette put this here" from "the anisotropy prior put this here",
  // and so it is what the provenance histogram is read off.
  const shr0 = new Float32Array(n);
  const u0a = new Float32Array(n), v0a = new Float32Array(n);
  const sideA = new Uint8Array(n);
  // Skin indices and weights are read at the vertex's own (x, y) on the working
  // grid, which is only available here — after this loop the vertex is in model
  // space and the grid coordinate is gone.
  const skinJ0 = new Uint16Array(n * 4), skinW0 = new Float32Array(n * 4);
  const ss = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x-e0)/(e1-e0))); return t*t*(3-2*t); };
  for (let i = 0; i < n; i++) {
    const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2] - vol.zHalf;
    const k = 1 - z * invD0;          // invD0 = 0 when the lens is unknown → k ≡ 1
    P[i*3] = ((x - cx0) * k) / md * S;
    P[i*3+1] = ((cy0 - y) * k) / md * S;
    P[i*3+2] = z / md * S;
    const xi = Math.max(0, Math.min(w-1, Math.round(x))), yi = Math.max(0, Math.min(h-1, Math.round(y)));
    const q = yi * w + xi;
    const nz = nv[i*3+2];
    // A single view samples a surface at a rate proportional to n·ẑ, and it
    // samples the far side not at all. Both facts become the confidence field
    // and the atlas half, so the artifact reports what it actually observed.
    // aconf is a QUALITATIVE INDEX in [0.12, 1], not a probability and not a
    // distance. It orders surface by how well the available cameras sampled it;
    // the numeric value has no calibrated meaning. See confidenceReport.
    const graze = ss(0.10, 0.45, Math.abs(nz));
    // "Generated" means no camera saw it. On one image that is the whole far
    // side. With a registered back view the only surface nobody photographed is
    // the grazing band at the silhouette, where BOTH cameras see it edge-on —
    // so the honest field is a function of |n·ẑ| rather than of its sign.
    const rim = 1 - ss(0.06, 0.30, Math.abs(nz));           // seen edge-on by every camera
    const far = ss(-0.20, 0.20, -nz);                      // facing away from the front view
    const back = hasBack ? Math.max(rim, far * backMiss) : far;
    // UVs from the continuous surface position, not the rounded pixel it landed
    // in: quantising them to the working grid caps the atlas at working-grid
    // detail no matter how large the texture is.
    u0a[i] = Math.max(0, Math.min(1, x / w)); v0a[i] = 1 - Math.max(0, Math.min(1, y / h));
    sideA[i] = nz >= 0 ? 0 : 1;              // which camera's chart this belongs in
    // σ along THIS vertex's normal, from the sheet it belongs to. Sampled
    // bilinearly at the vertex's own continuous grid position rather than at the
    // pixel it rounds to, for the same reason the UVs are.
    // ...in quadrature with the displacement the mesh stages applied, which is a
    // measured scalar for this run and applies to every vertex equally: σ's model
    // describes the field's own level set, and this is how far the exported
    // surface was moved off it.
    sig0[i] = Math.hypot(sampleBilinear(sideA[i] ? sgrid.back : sgrid.front, w, h, x, y), meshShift);
    shr0[i] = sampleBilinear(sideA[i] ? sgrid.wBack : sgrid.wFront, w, h, x, y);
    agen0[i] = back;
    aconf0[i] = Math.max(0.12, Math.min(1, dep.conf[q] * (0.55 + 0.45*graze) * (1 - 0.55*back) + 0.15 * (1 - 0.5*back)));
    const sk = rig.skinAt(x, y);
    for (let s = 0; s < 4; s++) { skinJ0[i*4+s] = sk.idx[s]; skinW0[i*4+s] = sk.wt[s]; }
    normalizeWeightsF32(skinW0, i * 4);
  }
  // The un-projection mirrors y — image rows run downward, the model's Y runs
  // up — and a mirror reverses orientation. The surface nets' winding is
  // correct in grid space and inside-out in model space, so every normal
  // pointed into the solid and FrontSide culling was showing the far wall of
  // the model through the near one. Measured signed volume was −0.187 before
  // this flip. It has to happen after all the grid-space work (relief, AO) and
  // before the model-space normals are taken.
  for (let t = 0; t < idx.length; t += 3) { const s = idx[t+1]; idx[t+1] = idx[t+2]; idx[t+2] = s; }
  const nrm0 = vertexNormals(P, idx, n);
  const ao0 = bakeAO(pos, nv, vol, cfg.aoSamples, Math.max(5, w * 0.045));

  report({ phase: 5, stage: 7, progress: 88 });
  // ATLAS SEAM SPLIT — the atlas packs the observed half in u∈[0,0.5] and the
  // inferred half in u∈[0.5,1]. A triangle whose vertices land on opposite
  // halves interpolates u across the midline and samples the whole atlas,
  // painting a band of garbage down the silhouette.
  const dup = new Map();
  const oPos = [], oNrm = [], oUv = [], oConf = [], oGen = [], oAo = [], oSkJ = [], oSkW = [],
        oSig = [], oShr = [];
  for (let i = 0; i < n; i++) {
    oPos.push(P[i*3], P[i*3+1], P[i*3+2]);
    oNrm.push(nrm0[i*3], nrm0[i*3+1], nrm0[i*3+2]);
    oUv.push(sideA[i] ? 0.5 + u0a[i]*0.5 : u0a[i]*0.5, v0a[i]);
    oConf.push(aconf0[i]); oGen.push(agen0[i]); oAo.push(ao0[i]); oSig.push(sig0[i]); oShr.push(shr0[i]);
    // A seam duplicate is the same point of the surface wearing the other
    // chart's UV, so it must carry the same bones. Splitting them here would
    // tear the mesh along the silhouette on the first frame of any pose.
    for (let s = 0; s < 4; s++) { oSkJ.push(skinJ0[i*4+s]); oSkW.push(skinW0[i*4+s]); }
  }
  let nOut = n;
  const remap = (v, want) => {
    if (sideA[v] === want) return v;
    const k = v*2 + want;
    const hit = dup.get(k); if (hit !== undefined) return hit;
    const r = nOut++;
    oPos.push(P[v*3], P[v*3+1], P[v*3+2]);
    oNrm.push(nrm0[v*3], nrm0[v*3+1], nrm0[v*3+2]);
    oUv.push(want ? 0.5 + u0a[v]*0.5 : u0a[v]*0.5, v0a[v]);
    oConf.push(aconf0[v]); oGen.push(agen0[v]); oAo.push(ao0[v]); oSig.push(sig0[v]); oShr.push(shr0[v]);
    for (let s = 0; s < 4; s++) { oSkJ.push(skinJ0[v*4+s]); oSkW.push(skinW0[v*4+s]); }
    dup.set(k, r); return r;
  };
  const oIdx = new Uint32Array(idx.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t+1], c = idx[t+2];
    const want = (sideA[a] + sideA[b] + sideA[c]) >= 2 ? 1 : 0;
    oIdx[t] = remap(a, want); oIdx[t+1] = remap(b, want); oIdx[t+2] = remap(c, want);
  }

  const positions = new Float32Array(oPos);
  const normals = new Float32Array(oNrm);
  const uvs = new Float32Array(oUv);
  const aconf = new Float32Array(oConf);
  const agen = new Float32Array(oGen);
  const sigma = new Float32Array(oSig);
  const shared = new Float32Array(oShr);
  const skinJoints = new Uint16Array(oSkJ);
  const skinWeights = new Float32Array(oSkW);
  const ao = new Float32Array(oAo);

  // centre on the bounding box
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
  for (let i = 0; i < nOut; i++) {
    const x=positions[i*3], y=positions[i*3+1], z=positions[i*3+2];
    if(x<mnx)mnx=x; if(y<mny)mny=y; if(z<mnz)mnz=z;
    if(x>mxx)mxx=x; if(y>mxy)mxy=y; if(z>mxz)mxz=z;
  }
  const ccx=(mnx+mxx)/2, ccy=(mny+mxy)/2, ccz=(mnz+mxz)/2;
  for (let i = 0; i < nOut; i++) { positions[i*3]-=ccx; positions[i*3+1]-=ccy; positions[i*3+2]-=ccz; }

  // The joints ride through the SAME un-projection and the same centring as the
  // vertices, or the bind pose does not sit inside the mesh. They live on the
  // image plane, so their grid z is zero and k(0) = 1 — no taper term, whether
  // or not a lens is known.
  const skeleton = rig.joints.map((j, ji) => ({
    index: ji,
    parent: j.parent,
    r: j.r / md * S,
    x: (j.x - cx0) / md * S - ccx,
    y: (cy0 - j.y) / md * S - ccy,
    z: -ccz,
    gx: j.x, gy: j.y,
  }));

  // baked AO rides in the colour attribute so the lit material renders
  // texture × occlusion with no second UV set and no aoMap
  // The two atlas halves meet along the silhouette, and a hard step between
  // "observed" and "inferred" reads as a seam painted down the middle of the
  // model. Carrying most of that difference as a smooth per-vertex ramp in
  // agen instead keeps the honesty — inferred surface still renders visibly
  // dimmer — without the line.
  const baseColor = new Float32Array(nOut * 3);
  for (let i = 0; i < nOut; i++) {
    const k = (0.34 + 0.66*ao[i]) * (1 - 0.40*agen[i]);
    baseColor[i*3]=k; baseColor[i*3+1]=k; baseColor[i*3+2]=k;
  }
  const confColor = new Float32Array(nOut * 3);
  for (let v = 0; v < nOut; v++) {
    const cf = aconf[v], gen = agen[v];
    let r, g, b;
    if (gen > 0.5) { r=.79; g=.25; b=.20; }
    else if (cf > 0.75) { r=.62; g=.72; b=.79; }
    else if (cf > 0.5) { r=.54; g=.65; b=.72; }
    else { r=.77; g=.54; b=.18; }
    confColor[v*3]=r; confColor[v*3+1]=g; confColor[v*3+2]=b;
  }

  report({ phase: 6, stage: 8, progress: 94 });
  const topo = topology(positions, oIdx);
  L(`watertight · ${topo.watertight ? 'yes' : 'no'} · shells ${topo.shells} · seam duplicates ${nOut - n}`, topo.watertight ? 'green' : 'amber');
  const conf = confidenceReport(positions, oIdx, aconf, agen);
  const prov = provenanceReport(positions, oIdx, agen, shared);
  L(`provenance · measured ${(prov.measured*100).toFixed(0)}%`
    + ` · inflated ${(prov.inflated*100).toFixed(0)}%`
    + ` · authored ${(prov.authored*100).toFixed(0)}% of surface area`, 'blue');
  const sigStats = sigmaSummary(sigma);
  // px → model units, so a reader of the exported attribute can put σ in the
  // same space as the vertex it belongs to without re-deriving the framing.
  sigStats.pxToModel = S / md;
  sigStats.calibrated = SIGMA_CALIBRATED;
  // The predictive σ is the scale OF, and the multipliers it implies. Carried
  // together because either alone misleads: a scale without its family reads as
  // a standard deviation, and a family without its scale cannot be applied.
  sigStats.family = PREDICTIVE;
  sigStats.nu = NU;
  sigStats.intervals = LEVELS.map((L) => ({ level: L, k: intervalK(L) }));
  L(`uncertainty · scale median ${sigStats.p50.toFixed(2)}px · p90 ${sigStats.p90.toFixed(2)}px`
    + ` · ${PREDICTIVE} ν ${NU}`
    + ` · ${sigStats.intervals.map((iv) => `${(iv.level*100).toFixed(0)}% = ±${iv.k.toFixed(2)}×`).join(' ')}`
    + (SIGMA_CALIBRATED ? '' : ' · UNCALIBRATED'), SIGMA_CALIBRATED ? 'blue' : 'amber');
  NOTE(SIGMA_CALIBRATED ? '◎' : '※',
    `Every vertex carries σ — the SCALE of a ${PREDICTIVE} predictive (ν ${NU}) of the surface's`
    + ` position along its own normal, in pixels of the ${w}px working grid`
    + ` (×${(S/md).toFixed(4)} for model units). It combines the boundary's localisation`
    + ` error, propagated in the reconstructed radius R = √(A²+G²) where the Jacobian is`
    + ` bounded, with the anisotropy prior's spread through the trunk/limb ramp`
    + (papply ? ' and the profile\'s row-attribution ambiguity' : '')
    + `. Median ${sigStats.p50.toFixed(2)}px, p90 ${sigStats.p90.toFixed(2)}px. It is a t and`
    + ` not a Gaussian because the anisotropy prior's error is one scalar per subject times`
    + ` the local thickness, which pooled is a scale mixture — so ±1σ is NOT 68% of anything`
    + ` here: the multipliers are `
    + sigStats.intervals.map((iv) => `${(iv.level*100).toFixed(0)}% at ±${iv.k.toFixed(2)}`).join(', ')
    + `.`
    + (SIGMA_CALIBRATED
      ? ` Coverage is scored against analytic ground truth in tools/test/atlas/uncertainty.mjs — on`
        + ` SYNTHETIC fixtures; no real-photograph validation set exists.`
      : ` IT IS NOT CALIBRATED: the coverage test against analytic ground truth did not pass,`
        + ` so σ orders the surface by uncertainty and those multipliers name a shape, not a`
        + ` probability. Read it as a relative measure only.`),
    SIGMA_CALIBRATED ? 'blue' : 'amber');
  NOTE('※', `σ is conditional on the far side being the near side's mirror. With one photograph`
    + ` nothing measures the subject's front-to-back asymmetry, so σ on inferred surface`
    + ` describes how uncertain the MIRRORED surface is, not how wrong the mirror is.`
    + ` Confidence mode colours which is which.`, 'amber');
  NOTE('§', hasBack
    ? 'The rear is photographed, not inferred. What remains structurally completed is the grazing band at the silhouette, which both cameras see edge-on — inspect it in Confidence mode.'
    : 'Rear and occluded surfaces are structurally completed by symmetry — inspect them in Confidence mode.', 'green');
  if (!topo.watertight) NOTE('※', `Mesh is not closed (${topo.boundary} boundary edges, ${topo.nonman} non-manifold). Sub-voxel features can pinch at low resolution — try a higher reconstruction mode.`, 'amber');

  // How much the projective atlas magnifies the image at each point: the front
  // sheet is z = H(x,y), so 1∕(n·ẑ) = sqrt(1 + |∇H|²). Extended outside the
  // silhouette by nearest-neighbour, because the rim's texels project there.
  // Each atlas half is a projection of its OWN sheet, so each needs its own
  // stretch: the two sheets have different gradients wherever the model is not
  // mirror-symmetric in z, which is exactly what a profile view creates.
  const sheetStretch = (Hs) => {
    const st = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y*w+x; if (!seg.mask[i]) continue;
      const gx = (Hs[x < w-1 ? i+1 : i] - Hs[x > 0 ? i-1 : i]) * (x > 0 && x < w-1 ? 0.5 : 1);
      const gy = (Hs[y < h-1 ? i+w : i] - Hs[y > 0 ? i-w : i]) * (y > 0 && y < h-1 ? 0.5 : 1);
      st[i] = Math.sqrt(1 + gx*gx + gy*gy);
    }
    const near = nearestSeed(seg.mask, w, h);
    for (let i = 0; i < N; i++) if (!seg.mask[i]) st[i] = st[near[i]];
    boxBlur(st, w, h, 1);
    return st;
  };
  const stretch = sheetStretch(vol.Zf);
  const texW = tex ? tex.w : w, texH = tex ? tex.h : h;
  // Each atlas half is square because the UV chart is the normalised image
  // rectangle, but there is no point sizing it past the detail it will hold:
  // packing an 853×1280 projection into 2048×2048 spends four times the texels
  // on an upscale of itself.
  const atlasS = Math.min(cfg.tex, 2048, Math.max(texW, texH));
  const padded = projectTexture(tex ? tex.px : px, texW, texH, seg.alpha, w, h, stretch);
  // The far half of the atlas: a photograph of the far side if there is one, and
  // otherwise nothing, in which case the caller mirrors the near half and
  // desaturates it to say so.
  let bothAlpha = null;
  if (hasBack) {
    bothAlpha = new Float32Array(N);
    for (let i = 0; i < N; i++) bothAlpha[i] = Math.min(seg.alpha[i], backAlpha[i]);
  }
  // The far half needs more margin than the near one. Its matte is the
  // intersection of two mattes brought together by a registration that is only
  // ever good to about a pixel, so its boundary is that much less trustworthy
  // than a single view's, and a seed placed on it carries the far photograph's
  // background straight down the fold.
  const paddedBack = hasBack
    ? projectTexture(backTex.px, texW, texH, bothAlpha, w, h, sheetStretch(vol.Zb),
                     FILL_ERODE_PX + BACK_ERODE_EXTRA)
    : null;
  L(`atlas · projective ${texW}×${texH} · stretch-prefiltered`
    + (hasBack ? ' · far half observed' : ' · far half mirrored'), 'blue');

  // ---------------------------------------------------------------- relight
  // Divide the photograph by the light that was fitted to it, so what is
  // exported is the surface rather than the studio. This can only be done
  // because the geometry is already reconstructed: n is evaluated, not guessed.
  const plan = planRelight(dep.lambert);
  let albedo = null, albedoBack = null, normalMap = null;
  if (plan.ok) {
    const { gain } = shadingField(nrmField, seg.mask, w, h, dep.lambert);
    const toGrid = (u, v) => [u * w, v * h];
    albedo = delightChart(padded, texW, texH, gain, w, h, toGrid);
    if (paddedBack) {
      // The far surface faces the other way, so it is shaded by the same light
      // through the mirrored normal. With one photograph the far chart is a copy
      // of the near one and this branch does not run at all.
      const flip = new Float32Array(nrmField.length);
      for (let i = 0; i < nrmField.length; i += 3) {
        flip[i] = nrmField[i]; flip[i+1] = nrmField[i+1]; flip[i+2] = -nrmField[i+2];
      }
      const gb = shadingField(flip, seg.mask, w, h, dep.lambert).gain;
      albedoBack = delightChart(paddedBack, texW, texH, gb, w, h, toGrid);
    }
    normalMap = normalDetail(albedo, texW, texH, texW / w);
    L(`relight · Lambertian fit R² ${plan.r2.toFixed(3)} · albedo separated`
      + ` · roughness ${plan.roughness}`, 'green');
    NOTE('◎', `The studio light was fitted to the interior and divided out, so the exported`
             + ` texture is albedo rather than a photograph: R² ${plan.r2.toFixed(3)} of the`
             + ` subject's shading is explained by one distant light on a Lambertian surface.`
             + ` The normal map carries only detail finer than the ${w}px geometry grid — what`
             + ` the mesh already has is not encoded twice — and roughness is a single factor,`
             + ` because one photograph under one unknown light cannot separate a specular`
             + ` lobe per texel.`, 'blue');
  } else {
    L(`relight · declined · ${plan.reason} · exporting baked colour`, 'amber');
    NOTE('※', `This asset is NOT relightable: ${plan.reason}. The exported texture is the`
             + ` photograph with its original lighting baked in, so it will not respond to a`
             + ` scene's own lights. Dividing by a fit this weak would carve the fit's errors`
             + ` into the colour.`, 'amber');
  }

  // point cloud for the fusion stage of the Evidence Dial
  const cstep = cfg.cloudStep;
  const cpos = [], ccol = [];
  for (let y = 0; y < h; y += cstep) for (let x = 0; x < w; x += cstep) {
    const i = y*w+x; if (!seg.mask[i] || dep.depth[i] < 0.02) continue;
    cpos.push((x - w/2)/md*S, (h/2 - y)/md*S, dep.depth[i]*0.6);
    ccol.push(px[i*4]/255, px[i*4+1]/255, px[i*4+2]/255);
  }

  // visualisation layers, as RGBA byte buffers the main thread turns into textures
  const maskRGB = new Uint8ClampedArray(N*4), depthRGB = new Uint8ClampedArray(N*4), normalRGB = new Uint8ClampedArray(N*4);
  for (let i = 0; i < N; i++) {
    const m = seg.mask[i];
    maskRGB[i*4]   = m?238:23; maskRGB[i*4+1] = m?234:23; maskRGB[i*4+2] = m?224:20; maskRGB[i*4+3] = 255;
    if (!m) {
      depthRGB[i*4]=23; depthRGB[i*4+1]=23; depthRGB[i*4+2]=20; depthRGB[i*4+3]=255;
      normalRGB[i*4]=23; normalRGB[i*4+1]=23; normalRGB[i*4+2]=20; normalRGB[i*4+3]=255;
    } else {
      const d = dep.depth[i];
      depthRGB[i*4]=Math.round(40+d*200); depthRGB[i*4+1]=Math.round(70+d*120); depthRGB[i*4+2]=Math.round(140-d*70); depthRGB[i*4+3]=255;
      normalRGB[i*4]=Math.round((nrmField[i*3]*.5+.5)*255);
      normalRGB[i*4+1]=Math.round((nrmField[i*3+1]*.5+.5)*255);
      normalRGB[i*4+2]=Math.round((nrmField[i*3+2]*.5+.5)*255);
      normalRGB[i*4+3]=255;
    }
  }

  // The loop closed: the finished solid re-rendered at the camera it came from,
  // scored against the matte the segmentation committed to. It runs here, at the
  // end, because it is a check on the EXPORTED geometry and not on any field.
  const frame = { md, S, cx0, cy0, ccx, ccy, ccz, zHalf: vol.zHalf, invD0,
                  orthographic: !cam.known };
  const reproj = silhouetteIoU(positions, oIdx, frame, seg.mask, seg.alpha, w, h);
  const reprojOK = reproj.offsetPx < 1;
  L(`re-projection · silhouette IoU ${reproj.iou.toFixed(4)}`
    + ` · boundary off by ${reproj.offsetPx.toFixed(3)}px mean`
    + ` (${reproj.ss}× supersampled over ${reproj.perimeter}px of perimeter)`,
    reprojOK ? 'green' : 'amber');
  NOTE(reprojOK ? '◎' : '※', `The finished solid was re-rendered at the camera it came from and`
    + ` scored against the input's own matte: IoU ${reproj.iou.toFixed(3)}, which is a mean`
    + ` boundary displacement of ${reproj.offsetPx.toFixed(2)}px over ${reproj.perimeter}px of`
    + ` perimeter. IoU alone would not say this — it is perimeter-sensitive, so the ceiling a`
    + ` perfect re-projection can reach depends on how much boundary the subject has.`
    + (reprojOK
      ? ` Sub-pixel: the exported mesh still occupies the silhouette it was built from.`
      : ` OVER A PIXEL: the mesh has drifted from the subject it was built from —`
        + ` smoothing, the relief displacement or the un-projection — rather than merely`
        + ` being uncertain about depth.`),
    reprojOK ? 'green' : 'amber');

  const ms = Date.now() - t0;
  L(`publication · artifact ready in ${ms}ms`, 'green');
  report({ phase: 6, stage: 8, progress: 100 });

  return {
    positions, normals, uvs, indices: oIdx, aconf, agen, ao, baseColor, confColor, sigma,
    padded, paddedBack, maskRGB, depthRGB, normalRGB,
    pbr: { ok: plan.ok, r2: plan.r2, roughness: plan.roughness || null, reason: plan.reason,
           albedo, albedoBack, normalMap,
           light: dep.light, rms: dep.lambert.rms, samples: dep.lambert.n },
    cloud: { positions: new Float32Array(cpos), colors: new Float32Array(ccol) },
    topo, conf, prov, cam, log, notes, sigStats,
    rig: { joints: skeleton, bones: rig.bones.map(b => ({ a: b.a, c: b.c })),
           skinJoints, skinWeights, stats: rig.stats },
    // Everything needed to map model space back to the working grid and to the
    // image the reconstruction came from. It is not bookkeeping: re-rendering
    // the solid's own silhouette at the input camera and scoring it against the
    // input matte is the only way to check that the mesh still IS the
    // photograph's subject, and that check cannot be done without this.
    //
    //   grid (x, y, z_grid) → model:  X = ((x − cx0)·k)/md·S − ccx
    //                                 Y = ((cy0 − y)·k)/md·S − ccy
    //                                 Z = z/md·S − ccz,   z = z_grid − zHalf
    //                                 k = 1 − z·invD0
    // and back, which is why invD0 rather than D0 is the stored form: it is 0
    // exactly when the un-projection is orthographic, and there is no infinity
    // to carry through a JSON round trip.
    frame,
    reproj,
    stats: { ...vs, ms, seamDup: nOut - n, w, h, texW, texH, atlasS, mode: modeName,
             // The two measured displacements σ is built from, kept so the
             // certificate can quote them and the calibration suite can rebuild
             // σ without reconstructing twice.
             regShift: seg.regShift, meshShift, sigmaR: bsig.sigmaR,
             tex: cfg.tex, triLabel: cfg.triLabel,
             backIoU: backReg ? backReg.iou : null, backScale: backReg ? backReg.s : null,
             profileIoU: pfit ? pfit.iou : null, profileRows: prof ? prof.rows : 0,
             profileScale: prof ? prof.scale : null, views: 1 + (hasBack ? 1 : 0) + (prof ? 1 : 0) },
    summary: {
      format: 'GLB', tris: topo.triangles.toLocaleString(), tex: (atlasS * 2) + '×' + atlasS,
      watertight: topo.watertight ? 'Yes' : 'No',
      observed: Math.round(conf.observed*100) + '%',
      completed: Math.round(conf.completed*100) + '%',
      lens: cam.known ? `${cam.mm35}mm equiv` : 'unknown — orthographic',
      coord: 'RH · Y-up',
    },
  };
}
