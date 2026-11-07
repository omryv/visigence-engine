// Is σ a real predictive scale, or a number with units glued on?
//   node tools/test/atlas/uncertainty.mjs
//
// This is the only test in the suite whose purpose is to be able to FAIL its own
// phase. σ replaces a categorical confidence label with a length, and a length
// that no coverage test could reject would be the same fabrication in better
// units — `aconf` quoted to two decimals is exactly what the README removed. So
// the bands here are fixed in advance, the calibration scalars are fitted on a
// training split and scored on a disjoint one, and src/uncertainty.js carries a
// SIGMA_CALIBRATED flag that this file checks against its own verdict. If the
// flag and the verdict disagree the suite fails, so the flag cannot drift into
// being an assertion about something that stopped being true.
//
// THE PREDICTIVE IS A STUDENT-t, and phase 1's Gaussian is why. A Gaussian could
// not hold 1σ and 2σ at once (70.0% and 91.8% against 68.3% and 95.4%) because
// the anisotropy prior's error is one scalar per subject times the local
// thickness, which pooled is a scale mixture — and a scale mixture of Gaussians
// IS a t. So the bands are stated at COVERAGE LEVELS, 68% and 95% within ±2
// points, evaluated on the t-quantile interval for the fitted ν. The old
// 0.66–0.70 / 0.94–0.96 bands were Gaussian ±1σ and ±2σ; under a t those
// multiples are not those levels, so reusing them would have been a category
// error rather than a stricter test.
//
// GROUND TRUTH is the analytic solid of tools/test/atlas/multiview.mjs: every vertex is
// walked along its own normal until the ray crosses the exact surface of the
// union of ellipsoids, and the signed crossing distance IS the error. Not the
// depth-map difference — that is only defined where the surface is a graph over
// the image, and it is undefined at the rim, which is half of what σ is about.
//
// THE POPULATION. A prior's spread cannot be scored on one subject: with one
// solid, "the prior is wrong by 17% here" is a single draw and any σ can be made
// to cover it. So the fixtures are a POPULATION — four solids, each at eleven
// depth scales drawn from the quantiles of the lognormal the prior declares.
// Train on two solids, score on the other two. The split is by SOLID and not by
// view, because two views of one solid share its depth error entirely and a
// split across them would leak.
//
// WHAT THIS CAN AND CANNOT ESTABLISH, stated because the difference decides how
// much the coverage number is worth:
//
//   * It CAN establish that the propagation is right — that σ grows and shrinks
//     across the surface the way the errors actually do. The reliability diagram
//     and the NLL against the best single constant σ are that test, and neither
//     is circular: a constant σ is free to be exactly the right size on average,
//     so beating it means σ's SHAPE carries information.
//   * It CANNOT establish that the declared τ spread is right for a real
//     photograph. The population is drawn from that same declared prior, so the
//     coverage number inherits it. If the prior is wrong for a subject, σ is
//     wrong for it by the same factor and nothing here would know.
import { reconstruct, segment, distanceTransform, buildVolume, coverageBlur,
         nearestSeed, PRESETS } from '../../../src/atlas/atlas-core.js';
import { boundarySigma, sigmaGrid, offsetShell, TAU_LOG_SD, SIGMA_CALIBRATED,
         SIGMA_R_GAIN, CALIBRATION_REPORT, FITTED_OPTIMUM, INTERVAL_K,
         P_REF_SWING, P_REF_BASIS,
         NU, LEVELS, intervalK, tCdf, tQuantile, tLogPdf, tEntropy,
         lgamma, digamma } from '../../../src/atlas/uncertainty.js';
import { camera, render, FIGURE, insideSolid, reseed } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
};
const f2 = (v, n = 3) => (v >= 0 ? ' ' : '') + v.toFixed(n);

const W = 200, H = 260, FOC = 6.0, DIST = 4.0, SPAN = 0.95;
// world units → working-grid pixels, from the fixture camera's own geometry
const GPP = (W / 2) * FOC / (DIST * SPAN);
const VSTRIDE = 5;                       // score every 5th vertex; ~5,500 per view

/* ------------------------------------------------------------- the solids */

const scaleDepth = (p, s) => p.map(([cx, cy, cz, ax, ay, az]) => [cx, cy, cz*s, ax, ay, az*s]);

// Deliberately different SHAPES, not different framings of one. Two carry limbs
// and two do not; two are near front/back symmetric and two are not. A σ that
// only works on figures would pass a split made of figures.
const SOLIDS = {
  // train
  figure: FIGURE,
  blob: [                                    // no limbs, no waist, one lump
    [ 0.00,  0.00,  0.00, 0.34, 0.40, 0.20],
    [ 0.00,  0.30,  0.05, 0.24, 0.22, 0.16],
  ],
  // test
  asym: [                                    // strongly front/back asymmetric
    [ 0.00,  0.10,  0.00, 0.30, 0.34, 0.13],
    [ 0.00,  0.14,  0.20, 0.21, 0.25, 0.14],  // chest thrown well forward
    [ 0.00,  0.52,  0.04, 0.15, 0.17, 0.15],
    [-0.38,  0.10,  0.02, 0.09, 0.28, 0.09],
    [ 0.38,  0.10,  0.02, 0.09, 0.28, 0.09],
  ],
  thin: [                                    // thin limbs against a thick trunk
    [ 0.00,  0.06,  0.00, 0.26, 0.32, 0.17],
    [ 0.00,  0.50,  0.00, 0.13, 0.15, 0.13],
    [-0.34,  0.04,  0.00, 0.055, 0.30, 0.055],
    [ 0.34,  0.04,  0.00, 0.055, 0.30, 0.055],
    [-0.12, -0.44,  0.00, 0.065, 0.32, 0.065],
    [ 0.12, -0.44,  0.00, 0.065, 0.32, 0.065],
  ],
};
const TRAIN = ['figure', 'blob'], TEST = ['asym', 'thin'];

// Depth scales at the 10/30/50/70/90th percentiles of the lognormal the prior
// declares. Not a hand-picked spread: the population IS the prior, which is what
// makes "does σ cover it" a question about the propagation.
const ZQ = [-1.5932, -1.1503, -0.8416, -0.5244, -0.2533, 0, 0.2533, 0.5244, 0.8416, 1.1503, 1.5932];
const DEPTHS = ZQ.map((z) => Math.exp(z * TAU_LOG_SD));

/* --------------------------------------------------------- the measurement */

function shoot(parts) {
  reseed(97);
  return render(camera(0, 0, DIST, FOC), W, H, { span: SPAN, parts });
}

// Signed distance from a world point along `n` to the solid's surface, positive
// when the point is OUTSIDE — the reconstruction is too fat there. Bracketed by
// a march at half-pixel steps and then bisected, so the answer is exact to
// within 2^-40 of the bracket rather than to within the march.
function surfaceError(parts, p, n, maxT) {
  const inside = (t) => insideSolid(parts, p[0]+t*n[0], p[1]+t*n[1], p[2]+t*n[2]);
  const i0 = inside(0), STEPS = 128, step = maxT / STEPS;
  let lo = 0, hi = null;
  for (let k = 1; k <= STEPS; k++) {
    const t = k * step;
    if (inside(t) !== i0) { lo = (k-1)*step; hi = t; break; }
    if (inside(-t) !== i0) { lo = -(k-1)*step; hi = -t; break; }
  }
  if (hi === null) return null;
  for (let it = 0; it < 40; it++) { const m = (lo+hi)/2; if (inside(m) === i0) lo = m; else hi = m; }
  return (i0 ? -1 : 1) * Math.abs((lo + hi) / 2);
}

// One fixture view: the errors, and everything needed to rebuild σ for any
// candidate calibration without reconstructing again.
function sample(parts) {
  const im = shoot(parts);
  const r = reconstruct(im.px, W, H, 'balanced', () => {});

  // The same volume the pipeline built, rebuilt here so σ can be re-evaluated
  // through the real sigmaGrid for each candidate parameter pair. Deterministic
  // and single-view, so it is the same object bit for bit.
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W*H; i++) lum[i] = (0.299*im.px[i*4] + 0.587*im.px[i*4+1] + 0.114*im.px[i*4+2]) / 255;
  const seg = segment(im.px, lum, W, H, false);
  const vol = buildVolume({ w: W, h: H, mask: seg.mask,
                            dist: distanceTransform(seg.mask, W, H, seg.alpha), alpha: seg.alpha },
                          PRESETS.balanced);
  const bs = boundarySigma(seg, W, H, coverageBlur(seg.mask, W, H, seg.alpha));

  const fr = r.frame, kwm = GPP * fr.S / fr.md;
  const nV = r.positions.length / 3;
  const gx = [], gy = [], side = [], err = [], agen = [];
  for (let i = 0; i < nV; i += VSTRIDE) {
    const X = r.positions[i*3], Y = r.positions[i*3+1], Z = r.positions[i*3+2];
    const p = [(X + fr.ccx)/kwm, (Y + fr.ccy)/kwm, (Z + fr.ccz)/kwm];
    const n = [r.normals[i*3], r.normals[i*3+1], r.normals[i*3+2]];
    const e = surfaceError(parts, p, n, 0.40);
    if (e === null) continue;
    const px = fr.cx0 + p[0]*GPP, py = fr.cy0 - p[1]*GPP;
    if (px < 0 || px > W-1 || py < 0 || py > H-1) continue;
    gx.push(px); gy.push(py); side.push(n[2] < 0 ? 1 : 0);
    err.push(e * GPP); agen.push(r.agen[i]);
  }
  return { vol, seg, bs, gx, gy, side, err: Float64Array.from(err), agen,
           meshShift: r.stats.meshShift, r };
}

const bilin = (fld, x, y) => {
  x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y));
  const x0 = x|0, y0 = y|0, fx = x-x0, fy = y-y0;
  return fld[y0*W+x0]*(1-fx)*(1-fy) + fld[y0*W+x0+1]*fx*(1-fy)
       + fld[(y0+1)*W+x0]*(1-fx)*fy + fld[(y0+1)*W+x0+1]*fx*fy;
};

// σ for one view under a candidate calibration, through the shipping sigmaGrid.
function sigmaFor(s, gainR, tauSd) {
  const sg = sigmaGrid(s.vol, { sigmaR: Math.max(1e-3, s.bs.sigmaR * gainR), tauLogSd: tauSd });
  // continued outside the silhouette exactly as reconstruct does
  const near = nearestSeedIdx(s.seg.mask);
  for (const fl of [sg.front, sg.back]) for (let i = 0; i < W*H; i++) if (!s.seg.mask[i]) fl[i] = fl[near[i]];
  const out = new Float64Array(s.gx.length);
  for (let i = 0; i < s.gx.length; i++)
    out[i] = Math.hypot(bilin(s.side[i] ? sg.back : sg.front, s.gx[i], s.gy[i]), s.meshShift);
  return out;
}
// The feature transform is the same for every candidate calibration of a given
// view, and it is the expensive part of the resample, so it is cached per mask.
const _nearCache = new Map();
function nearestSeedIdx(mask) {
  let v = _nearCache.get(mask);
  if (!v) { v = nearestSeed(mask, W, H); _nearCache.set(mask, v); }
  return v;
}

/* ------------------------------------------------------------------ scoring */

const LOG2PI = Math.log(2 * Math.PI);

// Gaussian, kept for the record: the phase-1 numbers have to stay reproducible
// beside the phase-1b ones or "the t is better" is an assertion.
function nllGauss(err, sig) {
  let s = 0;
  for (let i = 0; i < err.length; i++) {
    const v = Math.max(1e-6, sig[i]);
    s += (err[i]*err[i])/(v*v) + Math.log(2*Math.PI*v*v);
  }
  return 0.5 * s / err.length;
}

// The predictive: e ~ scale · t_ν, so log p(e) = tLogPdf(e/s, ν) − log s.
//
// The two lgamma calls are hoisted out of the loop rather than left inside
// tLogPdf. The fit evaluates this a few million times per candidate ν and
// lgamma is a nine-term series; leaving it under the loop made the fit take
// longer than every other suite combined. Checked against tLogPdf below.
function tConst(nu) {
  return { C: lgamma((nu+1)/2) - lgamma(nu/2) - 0.5*Math.log(nu*Math.PI), k: (nu+1)/2 };
}
function nllT(err, sig, nu) {
  const { C, k } = tConst(nu);
  let s = 0;
  for (let i = 0; i < err.length; i++) {
    const v = Math.max(1e-6, sig[i]), z = err[i] / v;
    s += Math.log(v) - C + k * Math.log1p(z*z/nu);
  }
  return s / err.length;
}

// Coverage of the interval ±k·scale, and the pieces the Gneiting split needs.
function coverAt(err, sig, k) {
  let c = 0;
  for (let i = 0; i < err.length; i++) if (Math.abs(err[i]) <= k * Math.max(1e-6, sig[i])) c++;
  return c / err.length;
}
function spreadStats(err, sig, nu) {
  const { C, k } = tConst(nu);
  let logs = 0, z2 = 0, lp = 0;
  for (let i = 0; i < err.length; i++) {
    const v = Math.max(1e-6, sig[i]), z = err[i] / v;
    logs += Math.log(v); z2 += z*z; lp += -C + k * Math.log1p(z*z/nu);
  }
  const n = err.length;
  return { meanLogSigma: logs/n, meanZ2: z2/n, meanNegLogStd: lp/n, n };
}

// Pool-adjacent-violators: the closest non-decreasing sequence to `y`, which is
// what the reliability diagram is compared against now that strict pointwise
// monotonicity has been retired. See the criterion note at the verdict.
function isotonic(y) {
  const v = y.slice(), w = y.map(() => 1), idx = y.map((_, i) => [i, i]);
  let i = 0;
  while (i < v.length - 1) {
    if (v[i] <= v[i+1]) { i++; continue; }
    const nw = w[i] + w[i+1];
    v[i] = (v[i]*w[i] + v[i+1]*w[i+1]) / nw;
    w[i] = nw; idx[i] = [idx[i][0], idx[i+1][1]];
    v.splice(i+1, 1); w.splice(i+1, 1); idx.splice(i+1, 1);
    if (i > 0) i--;
  }
  const out = new Array(y.length);
  for (let b = 0; b < v.length; b++) for (let k = idx[b][0]; k <= idx[b][1]; k++) out[k] = v[b];
  return out;
}

const rankOf = (a) => {
  const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  o.forEach(([, i], k) => { r[i] = k + 1; });
  return r;
};
function spearman(a, b) {
  const ra = rankOf(a), rb = rankOf(b), n = a.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - 6*d2 / (n * (n*n - 1));
}
function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const x = a[i]-ma, y = b[i]-mb; sab += x*y; sa += x*x; sb += y*y; }
  return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa*sb) : 0;
}

/* ------------------------------------------------------------------ the run */

console.log('POPULATION — four solids at eleven depth scales each');
console.log(`   depth scales (lognormal quantiles at log-sd ${TAU_LOG_SD}):`
          + ` ${DEPTHS.map((d) => d.toFixed(3)).join(', ')}`);

const sets = {};
for (const key of [...TRAIN, ...TEST]) {
  sets[key] = [];
  for (const d of DEPTHS) sets[key].push(sample(scaleDepth(SOLIDS[key], d)));
  const all = sets[key].flatMap((s) => Array.from(s.err));
  const rms = Math.sqrt(all.reduce((a, b) => a + b*b, 0) / all.length);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  console.log(`   ${key.padEnd(7)} ${String(all.length).padStart(6)} scored vertices`
    + ` · error mean ${f2(mean, 2)}px rms ${rms.toFixed(2)}px`
    + `   [${TRAIN.includes(key) ? 'train' : 'TEST'}]`);
}

const cat = (keys) => {
  const err = [], views = [];
  for (const k of keys) for (const s of sets[k]) { views.push(s); for (const e of s.err) err.push(e); }
  return { err: Float64Array.from(err), views };
};
const trainSet = cat(TRAIN), testSet = cat(TEST);
const sigmaOf = (set, gainR, tauSd) => {
  const out = [];
  for (const s of set.views) for (const v of sigmaFor(s, gainR, tauSd)) out.push(v);
  return Float64Array.from(out);
};

/* --------------------------------------------------------------- the fit */

// Three scalars now: the two that set the scale, and ν, which sets how heavy the
// per-subject scatter is. ν does not change σ at all — only how the same σ is
// scored — so the σ field is computed once per (gain, τ log-sd) and ν is swept
// inside that, which is why a three-dimensional fit costs what the old
// two-dimensional one did.
console.log('\nFIT — three scalars, on the training solids only, by Student-t NLL');
let best = null;
const NUS = [1.6, 2.0, 2.4, 2.8, 3.2, 4, 5, 7, 10, 20, 60];
for (const g of [0.5, 1, 2, 4, 8]) {
  for (const s of [0.15, 0.20, 0.30, 0.45, 0.60, 0.80, 1.10]) {
    const sig = sigmaOf(trainSet, g, s);
    for (const nu of NUS) {
      const v = nllT(trainSet.err, sig, nu);
      if (!best || v < best.v) best = { g, s, nu, v };
    }
  }
}
for (const g of [best.g*0.7, best.g*0.85, best.g, best.g*1.2, best.g*1.4]) {
  for (const s of [best.s*0.85, best.s*0.93, best.s, best.s*1.08, best.s*1.18]) {
    const sig = sigmaOf(trainSet, g, s);
    for (const nu of [best.nu*0.8, best.nu*0.9, best.nu, best.nu*1.1, best.nu*1.25]) {
      const v = nllT(trainSet.err, sig, nu);
      if (v < best.v) best = { g, s, nu, v };
    }
  }
}
// `g` is a multiplier ON TOP of the σ_R the pipeline computes — boundarySigma has
// already applied SIGMA_R_GAIN by the time it is reached — so g = 1 is "as
// shipped" whatever that constant becomes, and the fitted g is how far the
// shipped scale is from the maximum-likelihood one rather than a value it could
// be set to. The two are not the same parameter: SIGMA_R_GAIN scales the matte
// term BEFORE the quantisation floor and the quadrature with the regularisation
// shift, and g scales the total after both.
console.log(`   σ_R ×${best.g.toFixed(3)} on the shipping σ_R (which carries SIGMA_R_GAIN ${SIGMA_R_GAIN})`
          + ` · τ log-sd ${best.s.toFixed(3)} (declared ${TAU_LOG_SD}) · ν ${best.nu.toFixed(2)}`);
console.log(`   train NLL ${best.v.toFixed(4)}`);
console.log(`   the interval multipliers that ν implies:`
  + LEVELS.map((L) => `  ${(L*100).toFixed(0)}% → ±${intervalK(L, best.nu).toFixed(3)} scales`).join('')
  + `   (a Gaussian's would be ${LEVELS.map((L) => intervalK(L, 1e9).toFixed(3)).join(' and ')})`);

/* ------------------------------------------------------------ the held-out */

// WHAT IS SCORED IS WHAT IS SHIPPED, and that is the whole of this block.
//
// The fit above is a measurement OF the declaration, not a source for it: the
// engine declares σ_R's gain and the τ prior's spread and exports σ built from
// them, so a coverage figure computed at the fit's optimum would describe a field
// no file ever carries. It did. Scored at the optimum the held-out coverage reads
// 62.6% and 93.3%; scored at the declaration — the σ that is actually in every
// GLB's `_SIGMA` — it reads 49.0% and 86.8%, because the optimum wants 1.70× more
// scale and a 30% wider τ prior than the engine declares. Those first two numbers
// were what CALIBRATION_REPORT carried and what every certificate quoted.
//
// So the declaration is what is scored here, and the optimum is reported beside
// it as what the fit found. ν is the one of the three the engine ships AT its
// fitted value, and there is a check below that says so.
const SHIP = { g: 1, s: TAU_LOG_SD, nu: NU };
const sigTest = sigmaOf(testSet, SHIP.g, SHIP.s);
const covT = LEVELS.map((L) => coverAt(testSet.err, sigTest, intervalK(L, SHIP.nu)));
const spT = spreadStats(testSet.err, sigTest, SHIP.nu);
const nllSigT = nllT(testSet.err, sigTest, SHIP.nu);

// ...and the same score at the fit's own optimum, for the record. This is the
// number the phase originally reported, and keeping it visible is what makes the
// gap above a measurement rather than a claim.
const sigTestFit = sigmaOf(testSet, best.g, best.s);
const covFit = LEVELS.map((L) => coverAt(testSet.err, sigTestFit, intervalK(L, best.nu)));
const nllFit = nllT(testSet.err, sigTestFit, best.nu);

// SAME-FAMILY BASELINE: the best constant-scale t, with BOTH its scale and its ν
// fitted on the test errors themselves. That is the most generous honest
// baseline there is, and it is the one the gate uses — the t has an extra degree
// of freedom over the Gaussian and it must not be allowed to win with it.
let bc = null;
for (let li = 0; li < 2; li++) {
  const scales = li === 0
    ? [1, 2, 3, 4, 5, 6, 8, 10, 14].map((v) => v)
    : [bc.s*0.85, bc.s*0.92, bc.s, bc.s*1.08, bc.s*1.18];
  const nus = li === 0 ? NUS : [bc.nu*0.8, bc.nu*0.9, bc.nu, bc.nu*1.1, bc.nu*1.25];
  for (const sc of scales) {
    const arr = new Float64Array(testSet.err.length).fill(sc);
    for (const nu of nus) {
      const v = nllT(testSet.err, arr, nu);
      if (!bc || v < bc.v) bc = { s: sc, nu, v };
    }
  }
}
const constArr = new Float64Array(testSet.err.length).fill(bc.s);
const covC = LEVELS.map((L) => coverAt(testSet.err, constArr, intervalK(L, bc.nu)));
const spC = spreadStats(testSet.err, constArr, bc.nu);

// ...and the two Gaussian numbers from phase 1, unchanged, for the record.
const nllSigG = nllGauss(testSet.err, sigTest);
let se = 0; for (const e of testSet.err) se += e*e;
const sConstG = Math.sqrt(se / testSet.err.length);
const nllConstG = 0.5 * (1 + Math.log(2*Math.PI*sConstG*sConstG));

console.log('\nHELD-OUT — the two solids the fit never saw, scored at the SHIPPED declaration');
console.log(`   scored vertices          ${spT.n}`);
for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  console.log(`   ${(L*100).toFixed(0)}% t-interval          ${(covT[i]*100).toFixed(1)}%`
    + `   (nominal ${(L*100).toFixed(0)}%, band ${((L-0.02)*100).toFixed(0)}–${((L+0.02)*100).toFixed(0)}%)`
    + `   [at the fit's optimum: ${(covFit[i]*100).toFixed(1)}%]`);
}
console.log(`\n   Student-t NLL, σ(x)      ${nllSigT.toFixed(4)}`
  + `   [at the fit's optimum: ${nllFit.toFixed(4)}]`);
console.log(`   Student-t NLL, best const${nllSigT < bc.v ? ' ' : ' '}${bc.v.toFixed(4)}`
  + `   (scale ${bc.s.toFixed(3)}px, ν ${bc.nu.toFixed(2)} — both fitted ON the test errors)`);
console.log(`   for the record — Gaussian NLL, σ(x) ${nllSigG.toFixed(4)}`
  + ` · best constant σ ${nllConstG.toFixed(4)} (σ = ${sConstG.toFixed(3)}px)`);

// Gneiting: maximise sharpness subject to calibration. Same split as phase 1,
// with the t's own entropy in place of ½(1 + log 2π) as the irreducible term —
// what a PERFECTLY calibrated t scores, so calibration is measured from a real
// zero rather than from a Gaussian's.
const hT = tEntropy(SHIP.nu), hC = tEntropy(bc.nu);
const calT = spT.meanNegLogStd - hT, calCn = spC.meanNegLogStd - hC;
console.log('\n   Gneiting decomposition        calibration    sharpness    irreducible    total');
const gline = (name, cal, shp, irr) =>
  console.log(`   ${name.padEnd(28)}${f2(cal, 4).padStart(11)}  ${f2(shp, 4).padStart(11)}`
    + `  ${irr.toFixed(4).padStart(13)}  ${(cal+shp+irr).toFixed(4).padStart(7)}`);
gline(`Student-t σ(x), ν ${SHIP.nu.toFixed(2)}`, calT, spT.meanLogSigma, hT);
gline(`Student-t constant, ν ${bc.nu.toFixed(2)}`, calCn, spC.meanLogSigma, hC);
gline('Gaussian σ(x)', 0.5*spT.meanZ2 - 0.5, spT.meanLogSigma, 0.5*(1+LOG2PI));
gline('Gaussian constant', 0, Math.log(sConstG), 0.5*(1+LOG2PI));

/* --------------------------------------------------- reliability by decile */

console.log('\n   reliability — vertices binned by PREDICTED scale, decile by decile');
console.log('     decile   predicted    realised rms |e|   isotonic   deviation');
const order = Array.from(sigTest.keys()).sort((a, b) => sigTest[a] - sigTest[b]);
const per = Math.floor(order.length / 10);
const rel = [];
for (let d = 0; d < 10; d++) {
  const lo = d*per, hi = d === 9 ? order.length : (d+1)*per;
  let sp = 0, sq = 0;
  for (let k = lo; k < hi; k++) { const i = order[k]; sp += sigTest[i]; sq += testSet.err[i]**2; }
  const nb = hi - lo;
  rel.push({ pred: sp/nb, real: Math.sqrt(sq/nb) });
}
const iso = isotonic(rel.map((r) => r.real));
let isoDev = 0;
for (let d = 0; d < 10; d++) {
  const dev = Math.abs(rel[d].real - iso[d]) / Math.max(1e-9, iso[d]);
  if (dev > isoDev) isoDev = dev;
  console.log(`     ${String(d+1).padStart(6)}   ${rel[d].pred.toFixed(3).padStart(9)}`
    + `   ${rel[d].real.toFixed(3).padStart(16)}   ${iso[d].toFixed(3).padStart(8)}`
    + `   ${(dev*100).toFixed(2).padStart(8)}%`);
}
const relSpear = spearman(rel.map((r) => r.pred), rel.map((r) => r.real));

// How much of that deviation is noise. The vertices inside a decile are NOT
// independent — they mostly come from a handful of subjects, and a subject's
// error is one scalar times a shape — so the naive 1∕√(2n) on 25,000 vertices
// is meaningless. A leave-one-SUBJECT-out jackknife is the right unit, and it is
// cheap: 22 recomputations of ten bins.
let isoSE = 0;
{
  const bounds = [], devs = [];
  let k = 0;
  for (const s of testSet.views) { bounds.push([k, k + s.err.length]); k += s.err.length; }
  for (const [lo0, hi0] of bounds) {
    const keep = order.filter((i) => i < lo0 || i >= hi0);
    const p2 = Math.floor(keep.length / 10);
    const rr = [];
    for (let d = 0; d < 10; d++) {
      const lo = d*p2, hi = d === 9 ? keep.length : (d+1)*p2;
      let sq = 0; for (let j = lo; j < hi; j++) sq += testSet.err[keep[j]]**2;
      rr.push(Math.sqrt(sq / (hi - lo)));
    }
    const iso2 = isotonic(rr);
    let dv = 0;
    for (let d = 0; d < 10; d++) dv = Math.max(dv, Math.abs(rr[d] - iso2[d]) / Math.max(1e-9, iso2[d]));
    devs.push(dv);
  }
  const m = devs.reduce((a, b) => a + b, 0) / devs.length;
  let v = 0; for (const d of devs) v += (d - m) ** 2;
  isoSE = Math.sqrt(v * (devs.length - 1) / devs.length);
}
console.log(`     Spearman ρ(predicted, realised) = ${relSpear.toFixed(3)}`
          + `   ·   max deviation from isotonic ${(isoDev*100).toFixed(2)}%`
          + ` ± ${(isoSE*100).toFixed(2)} (leave-one-subject-out)`);

/* ------------------------------------- can the per-subject scale be observed? */
// THE HARD CONSTRAINT. The t integrates the per-subject scale out, so nothing
// has to be estimated at inference time and there is no route for ground truth
// to leak into the calibration. That is a design choice and not a discovery, so
// what is measured here is whether the choice cost anything: if some quantity
// the pipeline already computes from the photograph alone predicted a subject's
// realised scale, integrating it out would be throwing away sharpness.
//
// Every observable below is available on a real photograph. None is derived from
// the fixture, the ground truth, or the error.
console.log('\n   THE PER-SUBJECT SCALE, against everything observable at inference time');
const subj = [];
{
  let k = 0;
  for (const key of [...TRAIN, ...TEST]) for (const s of sets[key]) {
    const sig = sigmaFor(s, SHIP.g, SHIP.s);
    let z2 = 0;
    for (let i = 0; i < s.err.length; i++) z2 += (s.err[i]/Math.max(1e-6, sig[i]))**2;
    const r = s.r;
    subj.push({
      key,
      scale: Math.sqrt(z2 / s.err.length),
      obs: {
        'symmetry IoU':      r.stats.sym,
        'τ_trunk':           r.stats.tauTrunk,
        'ρ mean':            r.stats.rho,
        'strip fraction':    r.stats.strip,
        'a_max (px)':        r.stats.amax,
        'σ_R (px)':          r.stats.sigmaR,
        'reg. shift (px)':   r.stats.regShift,
        'mesh shift (px)':   r.stats.meshShift,
        'median σ (px)':     r.sigStats.p50,
        'observed fraction': r.conf.observed,
        'watertight':        r.topo.watertight ? 1 : 0,
        'Lambertian R²':     r.pbr.r2,
        'joints':            r.rig.stats.joints,
        'background var':    s.seg.bgVar,
      },
    });
  }
}
const obsKeys = Object.keys(subj[0].obs);
const logScale = subj.map((s) => Math.log(s.scale));

// POOLED and WITHIN-SOLID, and the second is the one that decides.
//
// The eleven members of a solid differ only in TRUE DEPTH, which the front
// silhouette barely sees — that is the premise multiview3d's task 11 is built
// on — so an observable read off that silhouette is very nearly constant across
// them. A pooled correlation therefore mostly measures which of four solids this
// is, with an effective sample size of four, and it says nothing about the thing
// that actually has to be predicted: how far THIS subject's depth is from the
// prior, among subjects that look the same from the front. Within a solid, that
// is the only thing varying. So the within-solid correlation is the honest test
// of "could this have been estimated instead of integrated out".
function withinR(vals, ys) {
  let num = 0, da = 0, db = 0;
  for (const key of [...TRAIN, ...TEST]) {
    const idx = subj.map((s, i) => [s.key, i]).filter(([k]) => k === key).map(([, i]) => i);
    const ma = idx.reduce((a, i) => a + vals[i], 0) / idx.length;
    const mb = idx.reduce((a, i) => a + ys[i], 0) / idx.length;
    for (const i of idx) { const x = vals[i]-ma, y = ys[i]-mb; num += x*y; da += x*x; db += y*y; }
  }
  return (da > 1e-12 && db > 1e-12) ? num / Math.sqrt(da*db) : 0;
}
const cors = obsKeys.map((k) => {
  const v = subj.map((s) => s.obs[k]);
  return { k, r: pearson(v, logScale), rw: withinR(v, logScale) };
}).sort((a, b) => Math.abs(b.rw) - Math.abs(a.rw));
console.log(`     ${subj.length} subjects · realised scale`
  + ` ${Math.min(...subj.map((s)=>s.scale)).toFixed(2)}–${Math.max(...subj.map((s)=>s.scale)).toFixed(2)}`
  + `   (1.00 is what the model predicts for every one of them)`);
console.log('     observable            pooled r   within-solid r');
for (const c of cors) console.log(`     ${c.k.padEnd(20)}  ${f2(c.r, 3).padStart(8)}   ${f2(c.rw, 3).padStart(13)}`);
const strongest = cors[0];
console.log(`     strongest within-solid: ${strongest.k} at r = ${strongest.rw.toFixed(3)}`);
console.log(`     the pooled leader is ${[...cors].sort((a,b)=>Math.abs(b.r)-Math.abs(a.r))[0].k}`
  + ` at r = ${[...cors].sort((a,b)=>Math.abs(b.r)-Math.abs(a.r))[0].r.toFixed(3)},`
  + ` which is four solids and not 44 subjects.`);

/* ------------------------------- is the strongest correlate a depth signal? */
// THE HARD CONSTRAINT, tested rather than argued.
//
// Something has to carry the per-subject scale, and integrating it out is only
// the right answer if nothing could have estimated it. The table above says
// something can: within a solid, the Lambertian fit's R² tracks the depth
// mismatch at r = −0.9. R² is computed from the photograph alone, so using it
// would satisfy the constraint as written.
//
// It would also be wrong, and the reason is a property of the FIXTURE. Inside
// one solid the only thing varying is the true depth, so everything downstream
// of depth correlates with it — that is arithmetic, not evidence that the
// quantity carries depth information on a photograph. The way to tell them apart
// is to move the candidate WITHOUT moving the geometry: paint the subject.
// Albedo variation is what R² is really sensitive to, and it does not shift one
// millimetre of the solid.
let paintFinding = null;
{
  console.log('\n   THE CONFOUND TEST — same solid, same depth, different paint');
  console.log('     paint              depth   Lambert R²   rms error (px)');
  const PAINTS = [
    ['plain (as calibrated)', null],
    ['broad stripes', (p) => (Math.sin(p[1]*14) > 0 ? [0.72,0.60,0.50] : [0.30,0.24,0.20])],
    ['blotches', (p) => (Math.sin(p[0]*17)*Math.cos(p[1]*13) > 0 ? [0.70,0.58,0.48] : [0.34,0.27,0.22])],
  ];
  const rows = [];
  for (const dep of [1.00, 1.41]) {
    const parts = scaleDepth(FIGURE, dep);
    for (const [name, albedo] of PAINTS) {
      reseed(97);
      const im = render(camera(0, 0, DIST, FOC), W, H, { span: SPAN, parts, albedo });
      const r = reconstruct(im.px, W, H, 'balanced', () => {});
      const fr = r.frame, kwm = GPP*fr.S/fr.md, nV = r.positions.length/3;
      let s2 = 0, n = 0;
      for (let i = 0; i < nV; i += 9) {
        const p = [(r.positions[i*3]+fr.ccx)/kwm, (r.positions[i*3+1]+fr.ccy)/kwm,
                   (r.positions[i*3+2]+fr.ccz)/kwm];
        const nn = [r.normals[i*3], r.normals[i*3+1], r.normals[i*3+2]];
        const e = surfaceError(parts, p, nn, 0.40); if (e === null) continue;
        s2 += (e*GPP)**2; n++;
      }
      rows.push({ name, dep, r2: r.pbr.r2, rms: Math.sqrt(s2/n) });
      console.log(`     ${name.padEnd(20)} ${dep.toFixed(2)}   ${r.pbr.r2.toFixed(4).padStart(10)}`
        + `   ${Math.sqrt(s2/n).toFixed(3).padStart(14)}`);
    }
  }
  const at = (n, d) => rows.find((r) => r.name === n && r.dep === d);
  // paint moves R² by this much, at fixed geometry...
  const paintR2 = Math.abs(at('blotches', 1).r2 / at('plain (as calibrated)', 1).r2 - 1);
  const paintErr = Math.abs(at('blotches', 1).rms / at('plain (as calibrated)', 1).rms - 1);
  // ...and depth moves it by this much, at fixed paint
  const depthR2 = Math.abs(at('plain (as calibrated)', 1.41).r2 / at('plain (as calibrated)', 1).r2 - 1);
  const depthErr = Math.abs(at('plain (as calibrated)', 1.41).rms / at('plain (as calibrated)', 1).rms - 1);
  paintFinding = { paintR2, paintErr, depthR2, depthErr };
  console.log(`     paint alone moves R² by ${(paintR2*100).toFixed(0)}% and the error by`
    + ` ${(paintErr*100).toFixed(1)}%`);
  console.log(`     depth alone moves R² by ${(depthR2*100).toFixed(0)}% and the error by`
    + ` ${(depthErr*100).toFixed(1)}%`);
  console.log(`     R² is a measure of how clean the shading is, not of how deep the subject`);
  console.log(`     is. Keying σ to it would widen the envelope on a striped shirt and`);
  console.log(`     narrow it on a plain one, at identical geometry. The scale is`);
  console.log(`     integrated out, and this is why.`);
}

/* ------------------------------------ how heavy is one photograph, really? */
// The measurement that decides what family is right, and it is not the pooled
// one. A quantile tail index — q97.5 ∕ q84 of |e|∕σ — is 1.97 for a Gaussian and
// rises as the tail thickens, and unlike kurtosis no single vertex can move it.
console.log('\n   TAIL INDEX of |e|∕σ, pooled and within one photograph');
{
  const idx = (a) => { a.sort((x,y)=>x-y);
    const q = (p) => a[Math.min(a.length-1, Math.floor(p*a.length))];
    return q(0.975) / Math.max(1e-9, q(0.84)); };
  const pooled = idx(Array.from(sigTest.keys()).map((i) => Math.abs(testSet.err[i]/sigTest[i])));
  const per = [];
  let k = 0;
  for (const s of testSet.views) {
    const a = [];
    for (let i = 0; i < s.err.length; i++, k++) a.push(Math.abs(testSet.err[k]/sigTest[k]));
    per.push(idx(a));
  }
  per.sort((a,b)=>a-b);
  console.log(`     pooled over the held-out solids   ${pooled.toFixed(3)}`);
  console.log(`     within one photograph             median ${per[per.length>>1].toFixed(3)}`
    + `   range ${per[0].toFixed(3)}–${per[per.length-1].toFixed(3)}   (Gaussian 1.971)`);
  console.log(`     Within a single subject the error is LIGHTER-tailed than a Gaussian, not`);
  console.log(`     heavier. All of the pooled weight in the tail is the between-subject`);
  console.log(`     mixture — which is the mechanism the t is for, and also the reason a t`);
  console.log(`     cannot fix the CENTRE: its Gaussian kernel is too peaked for what one`);
  console.log(`     photograph actually produces.`);
}

/* ---------------------------------------------- why the Gaussian could not */
let covWithin = { p1: 0, p2: 0, kurt: 0 };
{
  const groups = [];
  let k = 0;
  for (const s of testSet.views) {
    const g = [];
    for (let i = 0; i < s.err.length; i++, k++) g.push(testSet.err[k] / Math.max(1e-6, sigTest[k]));
    groups.push(g);
  }
  let c1 = 0, c2 = 0, n = 0;
  const within = [], allT = [];
  for (const g of groups) {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    for (const t of g) {
      const r = t - m;
      if (Math.abs(r) <= 1) c1++;
      if (Math.abs(r) <= 2) c2++;
      n++; within.push(r); allT.push(t);
    }
  }
  const mAll = allT.reduce((a,b)=>a+b,0)/allT.length;
  let m2r = 0, m2s = 0, kurtRaw = 0, kurtRes = 0;
  for (const t of allT) m2r += (t-mAll)**2;
  for (const r of within) m2s += r*r;
  const vR = m2r/allT.length, vS = m2s/within.length;
  for (const t of allT) kurtRaw += ((t-mAll)**2/vR)**2;
  for (const r of within) kurtRes += (r*r/vS)**2;
  covWithin = { p1: c1/n, p2: c2/n, kurt: kurtRes/within.length };
  const gp1 = coverAt(testSet.err, sigTest, 1), gp2 = coverAt(testSet.err, sigTest, 2);
  console.log('\n   the mixture, which is why the predictive is a t and not a Gaussian');
  console.log(`     pooled, at ±1 and ±2 scales    ${(gp1*100).toFixed(1)}%  ${(gp2*100).toFixed(1)}%`
    + `   kurtosis ${(kurtRaw/allT.length).toFixed(2)}`);
  console.log(`     with each subject's own scalar removed  ${(covWithin.p1*100).toFixed(1)}%`
    + `  ${(covWithin.p2*100).toFixed(1)}%   kurtosis ${covWithin.kurt.toFixed(2)}   (Gaussian 68.3 / 95.4, kurtosis 3.00)`);
}

/* ------------------------------------------------------ observed vs inferred */

const obsRows = [], infRows = [];
{
  let k = 0;
  for (const s of testSet.views) for (let i = 0; i < s.err.length; i++, k++)
    (s.agen[i] < 0.5 ? obsRows : infRows).push({ e: testSet.err[k], s: sigTest[k] });
}
const covSplit = (rows) => LEVELS.map((L) => {
  const kk = intervalK(L, SHIP.nu);
  let c = 0; for (const r of rows) if (Math.abs(r.e) <= kk * Math.max(1e-6, r.s)) c++;
  return c / rows.length;
});
console.log('\n   coverage split by whether a camera saw the surface');
console.log(`     observed  n=${String(obsRows.length).padStart(6)}   `
  + covSplit(obsRows).map((v, i) => `${(LEVELS[i]*100).toFixed(0)}% → ${(v*100).toFixed(1)}%`).join('   '));
console.log(`     inferred  n=${String(infRows.length).padStart(6)}   `
  + covSplit(infRows).map((v, i) => `${(LEVELS[i]*100).toFixed(0)}% → ${(v*100).toFixed(1)}%`).join('   '));

/* ------------------------------ the alternative estimator, and why not it */
// Maximum likelihood optimises the whole density and is dominated by the bulk.
// If what has to be calibrated is two INTERVALS, the estimator that targets them
// is to fit the shape and scale by MATCHING those two levels on the training
// split — still a training-split fit, and a standard minimum-distance
// alternative to ML. It was tried. It does not transfer, and the reason it does
// not is the finding.
let qm = null;
{
  const sigTrain = sigmaOf(trainSet, SHIP.g, SHIP.s);
  const at = Array.from(trainSet.err, (e, i) => Math.abs(e / sigTrain[i])).sort((a, b) => a - b);
  const q = (p) => at[Math.min(at.length - 1, Math.floor(p * at.length))];
  const wantRatio = q(LEVELS[1]) / q(LEVELS[0]);
  // the ν whose own quantile ratio is that
  let lo = 1.02, hi = 400;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (tQuantile((1+LEVELS[1])/2, m) / tQuantile((1+LEVELS[0])/2, m) > wantRatio) lo = m; else hi = m;
  }
  const nu2 = (lo + hi) / 2, m2 = q(LEVELS[0]) / tQuantile((1+LEVELS[0])/2, nu2);
  const scaled = Float64Array.from(sigTest, (v) => v * m2);
  const cov2 = LEVELS.map((L) => coverAt(testSet.err, scaled, intervalK(L, nu2)));
  const covTr = LEVELS.map((L, i) => {
    const arr = Float64Array.from(sigTrain, (v) => v * m2);
    return coverAt(trainSet.err, arr, intervalK(L, nu2));
  });
  qm = { nu: nu2, m: m2, cov2, covTr, nll: nllT(testSet.err, scaled, nu2) };
  console.log('\n   THE ALTERNATIVE — (ν, scale) matched to the two levels on TRAIN, not by ML');
  console.log(`     fitted ν ${nu2.toFixed(2)}, scale ×${m2.toFixed(3)}`
    + `   · train needs a quantile ratio of ${wantRatio.toFixed(3)}, the held-out solids `
    + `${(() => { const a2 = Array.from(testSet.err, (e, i) => Math.abs(e / sigTest[i])).sort((x,y)=>x-y);
        const qq = (p) => a2[Math.min(a2.length-1, Math.floor(p*a2.length))];
        return (qq(LEVELS[1])/qq(LEVELS[0])).toFixed(3); })()}`);
  console.log(`     train  ${LEVELS.map((L,i)=>`${(L*100).toFixed(0)}% → ${(covTr[i]*100).toFixed(1)}%`).join('   ')}`
    + `   (exact, by construction)`);
  console.log(`     TEST   ${LEVELS.map((L,i)=>`${(L*100).toFixed(0)}% → ${(cov2[i]*100).toFixed(1)}%`).join('   ')}`
    + `   · NLL ${qm.nll.toFixed(4)}`);
  console.log(`     The 95% level transfers. The 68% one does not, and it is not the`);
  console.log(`     estimator's fault: the central quantile of |e|∕σ is itself different`);
  console.log(`     between the two populations, so no global shape carries it across.`);
  // WHICH ONE WINS IS READ OFF THE RUN, NOT ASSERTED. It used to be asserted —
  // "ML is kept: it is the better NLL and the better 68%" — and that sentence was
  // true of the fit's optimum and false of the σ the engine ships, which is what
  // is scored here. Both of these are FITS: minimum-distance rescales σ by m
  // above, ML rescales it by FITTED_OPTIMUM.sigmaRScale. Neither is the
  // declaration, and neither is what any file carries.
  const mlBetterNll = nllSigT < qm.nll, mlBetterCentre = Math.abs(covT[0] - LEVELS[0]) < Math.abs(qm.cov2[0] - LEVELS[0]);
  console.log(`     Against the SHIPPED σ scored above: NLL ${nllSigT.toFixed(4)} vs ${qm.nll.toFixed(4)}`
    + ` (${mlBetterNll ? 'ML' : 'minimum-distance'} ahead) · 68% ${(covT[0]*100).toFixed(1)}%`
    + ` vs ${(qm.cov2[0]*100).toFixed(1)}% (${mlBetterCentre ? 'ML' : 'minimum-distance'} ahead).`);
  console.log(`     Both rescale σ. The declaration is neither, and it is the one that ships,`);
  console.log(`     which is why the gates above are computed on it and not on either fit.`);
  qm.mlBetterNll = mlBetterNll; qm.mlBetterCentre = mlBetterCentre;
}

/* ------------------------------------------------------------- the verdict */

// The coverage bands and the reliability criterion, both fixed in advance and
// both pinned as literals so that changing one to make a phase pass would have
// to be done here, in the open, against a test that names the values.
//
// COVERAGE. Nominal 68% and 95%, ±2 points, measured on the t-quantile interval
// for the FITTED ν. The phase-1 bands (0.66–0.70 and 0.94–0.96) were Gaussian
// ±1σ and ±2σ and do not apply to a t: those multiples are not those levels
// under this distribution. This is a change of predictive, not a widening — the
// 68% band is the same width it was, and the 95% band is ±2 points where it was
// ±1, which is the tolerance the amended spec sets for both.
//
// RELIABILITY, corrected twice, both times for the same reason: a criterion that
// a perfectly calibrated forecast fails by sampling noise is not a criterion.
//
//   1. Strict pointwise monotonicity across empirical deciles was RETIRED. Ten
//      decile estimates from a finite sample will sometimes cross, and phase 1
//      failed it on a 0.3% dip at decile 9 with Spearman 0.988 — noise read as
//      miscalibration. Replaced by two criteria that separate ordering from
//      magnitude: Spearman ρ ≥ 0.95, and a maximum deviation from the diagram's
//      own isotonic regression of ≤ 1.5%.
//   2. The MAGNITUDE bound then inherited the same defect, and phase 1b found it:
//      1.60% against a bound of 1.5% is a miss of a tenth of a point, while the
//      leave-one-SUBJECT-out jackknife standard error of that same statistic is
//      ±2.18 points. So the bound now bites only when the deviation also exceeds
//      TWICE its own jackknife standard error. A deviation inside its own noise
//      is not evidence of anything.
//
// Applied retroactively, phase 1's Gaussian result passes both. Applied here, the
// magnitude criterion now passes as well — and it changes NOTHING about the
// verdict: the 68% coverage miss is real, it is 5.4 points, and it governs the
// flag on its own.
const COV_TOL = 0.02;
const SPEARMAN_MIN = 0.95, ISO_DEV_MAX = 0.015, ISO_SE_MULT = 2;

const metCov = LEVELS.map((L, i) => Math.abs(covT[i] - L) <= COV_TOL + 1e-12);
const metNll = nllSigT < bc.v;
const metRelOrder = relSpear >= SPEARMAN_MIN;
const metRelMag = isoDev <= ISO_DEV_MAX || isoDev <= ISO_SE_MULT * isoSE;
const calibrated = metCov.every(Boolean) && metNll && metRelOrder && metRelMag;

console.log('\nPHASE 1b ACCEPTANCE');
const crit = (name, met, detail) =>
  console.log(`  ${met ? 'MET    ' : 'NOT MET'}  ${name.padEnd(46)} ${detail}`);
LEVELS.forEach((L, i) => crit(
  `${(L*100).toFixed(0)}% interval within ±2 points`, metCov[i],
  `${(covT[i]*100).toFixed(1)}% vs ${(L*100).toFixed(0)}%`));
crit('NLL better than the best constant-scale t', metNll, `${nllSigT.toFixed(4)} vs ${bc.v.toFixed(4)}`);
crit(`reliability ordered (Spearman ≥ ${SPEARMAN_MIN})`, metRelOrder, `${relSpear.toFixed(3)}`);
crit(`reliability magnitude (≤ ${(ISO_DEV_MAX*100).toFixed(1)}% or ≤ ${ISO_SE_MULT}×SE)`, metRelMag,
     `${(isoDev*100).toFixed(2)}% ± ${(isoSE*100).toFixed(2)}`
     + (isoDev > ISO_DEV_MAX ? ` — over the bound, inside ${ISO_SE_MULT}×SE` : ''));
console.log(`  → σ is ${calibrated ? 'CALIBRATED' : 'NOT CALIBRATED'}`
  + `; it ships labelled ${SIGMA_CALIBRATED ? 'calibrated' : 'uncalibrated'}.`);
console.log(`  Calibrated against SYNTHETIC ANALYTIC FIXTURES. No real-photograph`
  + ` validation set exists,\n  and nothing here is evidence about one.`);

if (!calibrated) {
  console.log('\n  NOT MET, and the flag stays false. The bands were not widened and the fit');
  console.log('  saw only ' + TRAIN.join(' and ') + '. This was the one fix phase; per the');
  console.log('  directive we do not iterate past it chasing the flag.');
}

console.log('\nSUITE');

// The distribution functions are checked against CLOSED FORMS, not tables: the
// Cauchy and ν = 2 cases are exact at every x, so a transcription error in the
// incomplete beta cannot hide between tabulated points.
{
  let w1 = 0, w2 = 0;
  for (let x = -8; x <= 8; x += 0.013) {
    w1 = Math.max(w1, Math.abs(tCdf(x, 1) - (0.5 + Math.atan(x)/Math.PI)));
    w2 = Math.max(w2, Math.abs(tCdf(x, 2) - (0.5 + x/(2*Math.sqrt(2 + x*x)))));
  }
  ok('the t CDF matches the Cauchy closed form at ν = 1', w1 < 1e-12, w1.toExponential(2));
  ok('...and the ν = 2 closed form', w2 < 1e-12, w2.toExponential(2));
  let wq = 0;
  for (const nu of [1, 2, 2.6, 3, 5, 10, 30]) for (const p of [0.001, 0.05, 0.16, 0.5, 0.84, 0.95, 0.975, 0.999])
    wq = Math.max(wq, Math.abs(tCdf(tQuantile(p, nu), nu) - p));
  ok('the quantile inverts its own CDF', wq < 1e-10, wq.toExponential(2));
  const g = 0.5772156649015329;
  ok('lgamma and digamma hit their closed forms',
     Math.abs(lgamma(0.5) - 0.5*Math.log(Math.PI)) < 1e-12
     && Math.abs(lgamma(5) - Math.log(24)) < 1e-11
     && Math.abs(digamma(1) + g) < 1e-11
     && Math.abs(digamma(0.5) + g + 2*Math.log(2)) < 1e-11,
     'lgamma(½)=½logπ, lgamma(5)=log24, ψ(1)=−γ, ψ(½)=−γ−2log2');
  // the entropy is the irreducible term, so a wrong one silently moves the
  // calibration/sharpness split without changing the total
  let q = 0; const NQ = 200000;
  for (let i = 0; i < NQ; i++) q += -tLogPdf(tQuantile((i+0.5)/NQ, 3), 3);
  ok('the t entropy matches its own quadrature', Math.abs(tEntropy(3) - q/NQ) < 1e-4,
     `${tEntropy(3).toFixed(6)} vs ${(q/NQ).toFixed(6)}`);
}

ok('the coverage bands and reliability criteria are the ones fixed in advance',
   COV_TOL === 0.02 && SPEARMAN_MIN === 0.95 && ISO_DEV_MAX === 0.015 && ISO_SE_MULT === 2
   && LEVELS.length === 2 && LEVELS[0] === 0.68 && LEVELS[1] === 0.95,
   `±${COV_TOL*100} points at ${LEVELS.map((L)=>(L*100)+'%').join(' and ')},`
   + ` ρ ≥ ${SPEARMAN_MIN}, iso ≤ ${ISO_DEV_MAX*100}% or ${ISO_SE_MULT}×SE`);
// The correction must not become a way to pass by widening. It only ever relaxes
// the magnitude bound, and only up to the statistic's own noise — so it cannot
// rescue a coverage miss, which is the criterion that actually governs the flag.
ok('the SE allowance cannot rescue a coverage miss',
   calibrated === (metCov.every(Boolean) && metNll && metRelOrder && metRelMag)
   && !(metCov.every(Boolean) && !calibrated),
   `coverage ${metCov.map((m) => m ? 'met' : 'MISSED').join('/')} decides it`);
ok('the fit and the score share no solid',
   TRAIN.every((k) => !TEST.includes(k)) && TEST.length > 0 && TRAIN.length > 0,
   `train ${TRAIN.join('+')} · score ${TEST.join('+')}`);
ok('the same-family baseline was fitted on the test errors, not sandbagged',
   bc.v <= nllT(testSet.err, constArr, SHIP.nu) + 1e-9,
   `constant-t ν ${bc.nu.toFixed(2)} beats or ties ν ${SHIP.nu.toFixed(2)} on its own turf`);
ok('σ(x) beats the best constant-scale t on NLL', metNll,
   `${nllSigT.toFixed(4)} vs ${bc.v.toFixed(4)}, sharpness ${spT.meanLogSigma.toFixed(3)} vs ${spC.meanLogSigma.toFixed(3)}`);
// Not a coverage criterion — a check on the HARD CONSTRAINT. The per-subject
// scale is integrated out rather than estimated, and this is what says that
// choice cost nothing: among subjects that look alike from the front, no
// inference-time observable tracks how far this one's depth is from the prior.
// Not a coverage criterion — the check on the HARD CONSTRAINT. The per-subject
// scale is integrated out rather than estimated, and this is what licenses that:
// the one observable that appeared to predict it is moved four times as far by
// paint, at fixed geometry, as it is by the depth it appeared to be reading.
ok('the strongest correlate is a confound, not a depth signal',
   paintFinding.paintR2 > 3 * paintFinding.depthR2 && paintFinding.paintErr < 0.03,
   `paint moves R² ${(paintFinding.paintR2*100).toFixed(0)}% and the error`
   + ` ${(paintFinding.paintErr*100).toFixed(1)}%; depth moves R²`
   + ` ${(paintFinding.depthR2*100).toFixed(0)}%`);
ok('SIGMA_CALIBRATED matches this run\'s verdict', SIGMA_CALIBRATED === calibrated,
   `flag ${SIGMA_CALIBRATED}, measured ${calibrated}`);
ok('NU matches the fit', Math.abs(NU - best.nu) < 0.05, `shipped ${NU}, fitted ${best.nu.toFixed(2)}`);

/* ------------------------------------------ the record, against the run */
//
// CALIBRATION_REPORT says these are "the numbers the certificate quotes" and that
// this suite "re-derives every one of them on every run". Until this block existed
// that was a sentence, not a check: the constant was not imported here at all, and
// the eight certificate leaves that carry it were pinned to a value nothing
// re-measured. tools/test/atlas/certificate.mjs compares the certificate against the
// constant, which verifies the COPY; this compares the constant against the
// measurement, which is the link that was missing.
//
// The tolerances are the last place each number is written to, so re-rounding is
// not a failure and re-measuring is.
{
  const C = CALIBRATION_REPORT;
  const near = (a, b, t) => Math.abs(a - b) <= t;
  ok('the recorded levels are the levels this run scored',
     JSON.stringify(C.levels) === JSON.stringify(Array.from(LEVELS)),
     `${C.levels.join(' / ')}`);
  ok('the recorded held-out coverage is this run\'s, at the SHIPPED constants',
     C.heldOutCoverage.length === covT.length
     && C.heldOutCoverage.every((v, i) => near(v, covT[i], 5e-4)),
     `recorded ${C.heldOutCoverage.map((v) => (v*100).toFixed(1)+'%').join(' / ')}`
     + ` · measured ${covT.map((v) => (v*100).toFixed(1)+'%').join(' / ')}`);
  ok('the recorded NLL pair is this run\'s',
     near(C.nll.sigma, nllSigT, 5e-5) && near(C.nll.constantSameFamily, bc.v, 5e-5),
     `σ(x) ${C.nll.sigma} vs ${nllSigT.toFixed(4)}`
     + ` · constant ${C.nll.constantSameFamily} vs ${bc.v.toFixed(4)}`);
  ok('the recorded split and vertex count are this run\'s',
     JSON.stringify(C.trainSolids) === JSON.stringify(TRAIN)
     && JSON.stringify(C.testSolids) === JSON.stringify(TEST)
     && C.scoredVertices === spT.n,
     `${C.trainSolids.join('+')} → ${C.testSolids.join('+')}, ${C.scoredVertices} vertices`);

  // ...and the optimum, which is the other half of the finding. Recorded so that
  // "the shipped σ is narrower than the likelihood wants" stays a measurement.
  const F = FITTED_OPTIMUM;
  ok('the recorded fitted optimum is where this run\'s fit landed',
     near(F.sigmaRScale, best.g, 5e-4) && near(F.tauLogSd, best.s, 5e-4)
     && near(F.nu, best.nu, 5e-3),
     `×${F.sigmaRScale} on σ_R · τ log-sd ${F.tauLogSd} · ν ${F.nu}`
     + ` — measured ×${best.g.toFixed(3)} · ${best.s.toFixed(3)} · ${best.nu.toFixed(2)}`);
  ok('...and its held-out score, which is what the report used to carry',
     F.heldOutCoverage.every((v, i) => near(v, covFit[i], 5e-4)) && near(F.nll, nllFit, 5e-5),
     `optimum ${covFit.map((v) => (v*100).toFixed(1)+'%').join(' / ')} at NLL ${nllFit.toFixed(4)}`
     + ` · shipped ${covT.map((v) => (v*100).toFixed(1)+'%').join(' / ')} at NLL ${nllSigT.toFixed(4)}`);
  // The whole point of the correction, stated as a check so it cannot regress
  // into scoring the field the engine does not export.
  ok('what was scored is what reconstruct builds',
     SHIP.g === 1 && SHIP.s === TAU_LOG_SD && SHIP.nu === NU,
     `σ_R as shipped (SIGMA_R_GAIN ${SIGMA_R_GAIN}) · τ log-sd ${TAU_LOG_SD} · ν ${NU}`);
}

/* ------------------------------- the part-scale reference, in both coordinates */
//
// P_REF_SWING is applied by sigmaGrid as a relative error on the RAMP COORDINATE
// u = P∕pref, and the measurement it was recorded from is a swing in the ramp's
// OUTPUT τ. This sweep reads both, on one fixture, so the mismatch is a number in
// the suite's output rather than an argument in a comment.
//
// The fixture is a fixed 20px bar with a disk of growing radius welded to its
// end: nothing about the bar changes, and everything about the subject's 98th
// percentile part scale does. That is exactly the failure mode — the reference is
// global, so a companion part re-ranks every other part against it.
{
  const BW = 420, BH = 260, BAR_HALF = 10, PROBE_X = 60;
  const RADII = [0, 10, 20, 25, 30, 35, 40, 50, 60];
  const barDisk = (diskR) => {
    const mask = new Uint8Array(BW * BH), cy = BH >> 1;
    for (let y = cy - BAR_HALF; y <= cy + BAR_HALF; y++)
      for (let x = 20; x <= 200; x++) mask[y * BW + x] = 1;
    if (diskR > 0) {
      const cx = 200 + diskR - 4;
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++)
        if ((x - cx)**2 + (y - cy)**2 <= diskR*diskR) mask[y * BW + x] = 1;
    }
    const alpha = new Float32Array(BW * BH);
    for (let i = 0; i < BW * BH; i++) alpha[i] = mask[i];
    return { w: BW, h: BH, mask, alpha };
  };
  const us = [], taus = [];
  for (const R of RADII) {
    const v = buildVolume(barDisk(R), PRESETS.balanced);
    const i = (BH >> 1) * BW + PROBE_X;
    us.push(v.P[i] / v.stats.pref);
    taus.push(v.Zf[i] / v.A[i]);
  }
  const swing = (a) => Math.max(...a) / Math.min(...a) - 1;
  const sTau = swing(taus), sRamp = swing(us);
  console.log('\nTHE PART-SCALE REFERENCE, read on both sides of the ramp');
  console.log(`   disk radius   ${RADII.map((r) => String(r).padStart(6)).join('')}`);
  console.log(`   u = P∕pref    ${us.map((v) => v.toFixed(3).padStart(6)).join('')}`);
  console.log(`   τ = H∕A       ${taus.map((v) => v.toFixed(3).padStart(6)).join('')}`);
  console.log(`   ratio swing — τ ${sTau.toFixed(3)} · u ${sRamp.toFixed(3)}`
    + `   (P_REF_SWING is ${P_REF_SWING}, applied to u)`);
  ok('P_REF_BASIS records both readings of the sweep, as measured',
     Math.abs(P_REF_BASIS.tau - sTau) <= 5e-4 && Math.abs(P_REF_BASIS.ramp - sRamp) <= 5e-4
     && P_REF_BASIS.applied === 'ramp',
     `recorded τ ${P_REF_BASIS.tau} / u ${P_REF_BASIS.ramp}`
     + ` · measured τ ${sTau.toFixed(3)} / u ${sRamp.toFixed(3)}`);
  // The constant is the τ reading, and the propagation applies it to u. Naming
  // that here means the day someone re-derives the term for a bounded ramp, this
  // is the check that has to be revisited rather than a comment nobody re-reads.
  ok('P_REF_SWING is the τ-side reading, which is not the side it is applied to',
     Math.abs(P_REF_SWING - sTau) < 0.02 && sRamp > 5 * sTau,
     `τ ${sTau.toFixed(3)} ≈ ${P_REF_SWING} · u ${sRamp.toFixed(3)} is ${(sRamp/sTau).toFixed(1)}× larger`);
}

// The interval multipliers, which are the product's headline arithmetic and were
// the other number living in a comment.
ok('INTERVAL_K is what intervalK returns at the shipped ν',
   INTERVAL_K.levels === LEVELS
   && INTERVAL_K.t.every((k, i) => Math.abs(k - intervalK(LEVELS[i], NU)) <= 5e-5)
   && INTERVAL_K.gaussian.every((k, i) => Math.abs(k - intervalK(LEVELS[i], 1e9)) <= 5e-5),
   `t ±${INTERVAL_K.t.join(' / ±')} at ν ${NU}`
   + ` · gaussian ±${INTERVAL_K.gaussian.join(' / ±')}`);

let sMin = Infinity, sMax = -Infinity, sBad = 0;
for (const v of sigTest) { if (!(isFinite(v) && v > 0)) sBad++; if (v < sMin) sMin = v; if (v > sMax) sMax = v; }
ok('σ is finite and positive at every vertex', sBad === 0, `min ${sMin.toFixed(4)}px`);
ok('σ is bounded at the rim rather than divergent', sMax < 50, `max ${sMax.toFixed(2)}px`);
ok('the reliability diagram is ordered', metRelOrder,
   `Spearman ${relSpear.toFixed(3)} (criterion ≥ ${SPEARMAN_MIN})`);

/* -------------------------------------------------------------- the shell */
// The ±k envelope the viewer draws. Tested here rather than in the viewer,
// because the one thing it can get wrong is the UNIT CONVERSION — σ is in
// working-grid pixels and the vertices are in model space — and a shell built
// inside a WebGL context looks equally plausible whichever units it used.
{
  const s = sets[TEST[0]][0], r = s.r;
  const px2m = r.sigStats.pxToModel;
  const k68 = intervalK(0.68, NU);
  const outer = offsetShell(r.positions, r.normals, r.sigma, k68, px2m);
  const inner = offsetShell(r.positions, r.normals, r.sigma, -k68, px2m);

  let worst = 0, thickest = 0, anyZero = 0;
  for (let i = 0, v = 0; i < r.positions.length; i += 3, v++) {
    const d = Math.hypot(outer[i]-r.positions[i], outer[i+1]-r.positions[i+1], outer[i+2]-r.positions[i+2]);
    worst = Math.max(worst, Math.abs(d - r.sigma[v]*px2m*k68));
    const t = Math.hypot(outer[i]-inner[i], outer[i+1]-inner[i+1], outer[i+2]-inner[i+2]);
    thickest = Math.max(thickest, t);
    if (t === 0) anyZero++;
  }
  console.log('\nTHE ENVELOPE');
  console.log(`   68% interval = ±${k68.toFixed(3)} scales at ν ${NU}`
    + ` · widest ${thickest.toFixed(4)} model units, ${anyZero} vertices with no envelope`);
  ok('the shell is the t-interval, converted to model units', worst < 1e-6,
     `worst ${worst.toExponential(2)}`);
  ok('every vertex has an envelope', anyZero === 0, `${anyZero} degenerate`);
  const zero = offsetShell(r.positions, r.normals, r.sigma, 0, px2m);
  let z = 0; for (let i = 0; i < zero.length; i++) z = Math.max(z, Math.abs(zero[i] - r.positions[i]));
  ok('a zero-width interval reproduces the surface exactly', z === 0, `${z}`);
}

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
