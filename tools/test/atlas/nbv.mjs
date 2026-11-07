// Next-best-view guidance: does the ranking point anywhere useful?
//   node tools/test/atlas/nbv.mjs
//
// The question this suite exists to answer is not "does the utility integral
// evaluate". It is: WHEN THE RANKING SAYS A VIEW IS BEST, IS IT? That is a
// question about whether σ — which is uncalibrated — nonetheless predicts WHERE
// the true error lives, and it is answerable only against ground truth.
//
// ┌────────────────────────────────────────────────────────────────────────────┐
// │ HARNESS ONLY — THE SIMULATED VIEW-UPDATE OPERATOR                          │
// │                                                                            │
// │ There is no multi-view reconstruction in this product. Phase 3 was not     │
// │ chosen and nothing in src/ fuses anything. So that "adding a view" can     │
// │ mean something to a test, `applyViews` below defines it in closed form on  │
// │ the fixtures alone: a view at direction v removes, from each sample it can │
// │ see, the component of the error it constrains —                            │
// │                                                                            │
// │     e′ᵢ = eᵢ · (1 − maxᵥ [ vis(i,v) · sin²θ(i,v) ])                        │
// │                                                                            │
// │ — the sin-a silhouette bound written per-vertex. It is a SCORING RULE, not │
// │ a reconstruction: no silhouette cone is intersected, no hull is fused, no  │
// │ seam is blended, and nothing here is reachable from product code. If a     │
// │ future change needs any of those, that change is Phase 3 and it needs to   │
// │ say so out loud.                                                           │
// │                                                                            │
// │ Note what this makes the acceptance test NON-trivial. The operator uses    │
// │ the same sin²θ·vis the utility does — but the utility weights it by σ²     │
// │ (the PREDICTION) while the operator acts on e² (the TRUTH). σ ≠ |e|. So    │
// │ "the top-ranked view reduces the true error most" is a claim about σ's     │
// │ spatial shape, and it can fail.                                           │
// └────────────────────────────────────────────────────────────────────────────┘
import fs from 'fs';
import { reconstruct } from '../../../src/atlas/atlas-core.js';
import * as nbv from '../../../src/atlas/nbv.js';
import { camera, render, FIGURE, insideSolid, reseed } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
};
const f2 = (v, n = 3) => (v >= 0 ? ' ' : '') + v.toFixed(n);

const W = 200, H = 260, FOC = 6.0, DIST = 4.0, SPAN = 0.95;
const GPP = (W / 2) * FOC / (DIST * SPAN);

const SOLIDS = {
  sphere: [[0, 0, 0, 0.42, 0.42, 0.42]],
  figure: FIGURE,
  blob: [[0,0,0,0.34,0.40,0.20],[0,0.30,0.05,0.24,0.22,0.16]],
  thin: [[0,0.06,0,0.26,0.32,0.17],[0,0.50,0,0.13,0.15,0.13],
         [-0.34,0.04,0,0.055,0.30,0.055],[0.34,0.04,0,0.055,0.30,0.055],
         [-0.12,-0.44,0,0.065,0.32,0.065],[0.12,-0.44,0,0.065,0.32,0.065]],
};

/* -------------------------------------------------- HARNESS ONLY, see above */

/** Residual after a set of views, per the closed-form operator. */
function applyViews(e, gains, chosen) {
  const out = new Float64Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let g = 0;
    for (const c of chosen) { const v = gains[c][i]; if (v > g) g = v; }
    out[i] = e[i] * (1 - g);
  }
  return out;
}
/** Integrated true squared error over the surface. */
const ise = (e, A) => { let s = 0; for (let i = 0; i < e.length; i++) s += A[i] * e[i] * e[i]; return s; };

/* -------------------------------------------------------------- the truth */

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

function prepare(parts) {
  reseed(97);
  const im = render(camera(0, 0, DIST, FOC), W, H, { span: SPAN, parts });
  const r = reconstruct(im.px, W, H, 'balanced', () => {});
  const res = nbv.nextBestView(r, { keepGains: true, K: 6 });
  const s = nbv.surfaceSamples(r.positions, r.normals, r.indices, r.sigma, nbv.SAMPLES);

  // the true error at each SAMPLE, along its own normal, in working-grid pixels
  const fr = r.frame, kwm = GPP * fr.S / fr.md;
  const e = new Float64Array(s.count), keep = [];
  for (let i = 0; i < s.count; i++) {
    const p = [(s.P[i*3] + fr.ccx)/kwm, (s.P[i*3+1] + fr.ccy)/kwm, (s.P[i*3+2] + fr.ccz)/kwm];
    const n = [s.N[i*3], s.N[i*3+1], s.N[i*3+2]];
    const d = surfaceError(parts, p, n, 0.40);
    if (d === null) { e[i] = 0; continue; }
    e[i] = d * GPP; keep.push(i);
  }
  return { r, res, s, e, coverage: keep.length / s.count };
}

/* ------------------------------------------------------------------ task 1 */

function taskVisibility() {
  console.log('\nTASK 1 — the visibility rasteriser, against a case with a known answer');
  const n = 6000, P = new Float32Array(n*3), N = new Float32Array(n*3);
  for (let i = 0; i < n; i++) {
    const y = 1 - 2*(i+0.5)/n, r = Math.sqrt(Math.max(0, 1-y*y)), p = i*Math.PI*(3-Math.sqrt(5));
    const x = r*Math.cos(p), z = r*Math.sin(p);
    P[i*3]=x; P[i*3+1]=y; P[i*3+2]=z; N[i*3]=x; N[i*3+1]=y; N[i*3+2]=z;
  }
  // On a CONVEX solid nothing occludes anything, so the weight is decided by the
  // contour band alone: 1 everywhere front-facing, 0 beyond two bands past the
  // contour, and monotone between. That is a closed-form answer, and it is the
  // only kind worth checking a rasteriser against.
  const band = nbv.contourBand(n);
  let wrongFront = 0, wrongBack = 0, nonMono = 0, checked = 0;
  for (const v of nbv.viewCandidates(64)) {
    const vis = nbv.visibleFrom(P, N, v);
    for (let i = 0; i < n; i++) {
      const c = N[i*3]*v.x + N[i*3+1]*v.y + N[i*3+2]*v.z;
      checked++;
      if (c > 0 && vis[i] !== 1) wrongFront++;
      if (c < -2*band && vis[i] !== 0) wrongBack++;
      if (vis[i] < 0 || vis[i] > 1) nonMono++;
    }
  }
  console.log(`   convex sphere, 64 directions, ${checked} sample-views:`
    + ` front-facing not fully visible ${wrongFront}, far side not hidden ${wrongBack}`);
  ok('on a convex solid every front-facing sample is fully visible', wrongFront === 0, `${wrongFront}`);
  ok('...and everything past the contour band is hidden', wrongBack === 0, `${wrongBack}`);
  ok('the weight is a weight', nonMono === 0, `band ${band.toFixed(4)} = one sample of normal-turning`);

  // ...and something must actually occlude, or the test above is satisfied by a
  // function that returns "front-facing" and nothing else.
  const m = 6000, nb = Math.floor(m*0.7);
  const P2 = new Float32Array(m*3), N2 = new Float32Array(m*3);
  for (let i = 0; i < m; i++) {
    const big = i < nb, k = big ? i : i-nb, c = big ? nb : m-nb, R = big ? 1 : 0.35, cz = big ? 0 : 1.6;
    const y = 1 - 2*(k+0.5)/c, r = Math.sqrt(Math.max(0, 1-y*y)), p = k*Math.PI*(3-Math.sqrt(5));
    P2[i*3] = R*r*Math.cos(p); P2[i*3+1] = R*y; P2[i*3+2] = R*r*Math.sin(p) + cz;
    N2[i*3] = r*Math.cos(p); N2[i*3+1] = y; N2[i*3+2] = r*Math.sin(p);
  }
  const ff = (v) => { let c = 0; for (let i = 0; i < nb; i++)
    if (N2[i*3]*v.x + N2[i*3+1]*v.y + N2[i*3+2]*v.z > 0) c++; return c; };
  const seen = (v) => { const vis = nbv.visibleFrom(P2, N2, v);
    let c = 0; for (let i = 0; i < nb; i++)
      if (vis[i] > 0.5 && N2[i*3]*v.x + N2[i*3+1]*v.y + N2[i*3+2]*v.z > 0) c++; return c; };
  const front = { x: 0, y: 0, z: 1 }, side = { x: 1, y: 0, z: 0 };
  const hidF = ff(front) - seen(front), hidS = ff(side) - seen(side);
  console.log(`   a small sphere at z = +1.6 in front of a large one:`);
  console.log(`     from +Z (behind the small one) ${hidF} of ${ff(front)} front-facing samples hidden`);
  console.log(`     from +X (clear line of sight)  ${hidS} of ${ff(side)} hidden`);
  ok('an occluder occludes', hidF > 50, `${hidF} samples hidden from in front`);
  ok('...and only where it is in the way', hidS === 0, `${hidS} hidden from the side`);
}

/* ------------------------------------------------------------------ task 2 */

function taskRanking(prepared) {
  console.log('\nTASK 3 — does the top-ranked view actually reduce the true error most?');
  console.log('   (σ weights the utility; the operator acts on the TRUE error. σ ≠ |e|.)');
  console.log('   solid    max/p50  flat   top view        ΔISE top    ΔISE median   ratio   corr');
  const rows = [];
  for (const [name, p] of Object.entries(prepared)) {
    const { res, s, e } = p;
    const base = ise(e, s.A);
    const gains = res.gains;
    const red = new Float64Array(gains.length);
    for (let c = 0; c < gains.length; c++) red[c] = base - ise(applyViews(e, gains, [c]), s.A);
    const sorted = Array.from(red).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const top = red[res.topIndex];
    // Pearson between the PREDICTED utility and the REALISED reduction.
    const U = res.utilities;
    let mu = 0, mr = 0; for (let c = 0; c < U.length; c++) { mu += U[c]; mr += red[c]; }
    mu /= U.length; mr /= red.length;
    let su = 0, sr = 0, sur = 0;
    for (let c = 0; c < U.length; c++) { const a = U[c]-mu, b = red[c]-mr; sur += a*b; su += a*a; sr += b*b; }
    const corr = (su > 0 && sr > 0) ? sur / Math.sqrt(su*sr) : 0;
    const v = res.candidates[res.topIndex];
    rows.push({ name, res, top, med, corr, beats: top > med });
    console.log(`   ${name.padEnd(8)} ${res.shape.topOverMedian.toFixed(3).padStart(7)}`
      + `  ${(res.shape.flat ? 'yes' : 'no ').padStart(4)}`
      + `   az ${v.azimuth.toFixed(0).padStart(3)}° el ${v.elevation.toFixed(0).padStart(2)}°`
      + `  ${top.toFixed(2).padStart(10)}  ${med.toFixed(2).padStart(12)}`
      + `  ${(top/Math.max(1e-9, med)).toFixed(2).padStart(6)}  ${f2(corr, 3).padStart(6)}`);
  }
  const nonFlat = rows.filter((r) => !r.res.shape.flat);
  ok('the top-ranked view beats the median candidate on every non-flat fixture',
     nonFlat.every((r) => r.beats), `${nonFlat.filter((r) => r.beats).length}/${nonFlat.length}`);

  // REPORTED, NOT GATED: σ is uncalibrated, so the strength of this correlation
  // is a fact about the run and not a criterion the phase turns on.
  const cs = rows.map((r) => r.corr);
  console.log(`   correlation(predicted utility, realised ΔISE): `
    + rows.map((r) => `${r.name} ${r.corr.toFixed(3)}`).join(' · '));
  console.log(`   reported, not gated — σ is uncalibrated.`);
  ok('the correlation is computed and finite for every fixture',
     cs.every((c) => isFinite(c)), `${cs.map((c) => c.toFixed(2)).join(', ')}`);
  return rows;
}

/* ------------------------------------------------------------------ task 3 */

function taskGreedy(prepared) {
  console.log('\nTASK 4 — greedy K views against a uniform turntable of K');
  // TWO comparisons, because they answer different questions and running them
  // together would hide which one failed.
  //
  //   F   the set function greedy actually maximises, Σ σ²A·max gain. This is
  //       where the (1 − 1∕e) guarantee lives, and a loss here larger than 37%
  //       would mean the implementation is wrong rather than merely greedy.
  //   ISE the integrated TRUE squared error after the harness operator. This is
  //       what the user cares about, and greedy has no guarantee on it at all —
  //       it optimises σ, and σ is not |e|.
  //
  // The uniform baseline is offset by half a station so that K = 1 is a shot
  // from DIRECTLY BEHIND rather than a repeat of the photograph already taken.
  // Starting at 0° would make it lose K = 1 by construction, which is a strawman.
  console.log('   solid    K    greedy F   uniform F   F ratio |   greedy ISE  uniform ISE   ISE win');
  const rows = [];
  for (const [name, p] of Object.entries(prepared)) {
    if (p.res.shape.flat) continue;
    const { res, s, e } = p;
    const w = new Float64Array(s.count);
    for (let i = 0; i < s.count; i++) w[i] = s.S[i]*s.S[i]*s.A[i];
    const F = (gl) => { let f = 0;
      for (let i = 0; i < s.count; i++) { let g = 0; for (const gg of gl) if (gg[i] > g) g = gg[i]; f += w[i]*g; }
      return f; };
    for (let K = 1; K <= 5; K++) {
      const g = res.sequence.slice(0, K).map((x) => res.gains[x.index]);
      const uni = [];
      for (let k = 0; k < K; k++) {
        const a = 2*Math.PI*(k + 0.5)/K;
        uni.push(nbv.viewGain(s, { x: Math.sin(a), y: 0, z: Math.cos(a) }));
      }
      const fg = F(g), fu = F(uni);
      const gI = ise(applyViews(e, res.gains, res.sequence.slice(0, K).map((x) => x.index)), s.A);
      const uI = ise(applyViews(e, uni, uni.map((_, i) => i)), s.A);
      rows.push({ name, K, fg, fu, gI, uI, fWin: fg >= fu, iWin: gI <= uI });
      console.log(`   ${name.padEnd(8)} ${K}  ${fg.toFixed(2).padStart(10)}  ${fu.toFixed(2).padStart(10)}`
        + `  ${(fg/Math.max(1e-9,fu)).toFixed(3).padStart(7)} |  ${gI.toFixed(3).padStart(11)}`
        + `  ${uI.toFixed(3).padStart(11)}   ${gI <= uI ? 'yes' : 'NO'}`);
    }
  }
  const fLoss = rows.filter((r) => !r.fWin);
  const iLoss = rows.filter((r) => !r.iWin);
  // The guarantee is about F, and it is a bound of 1 − 1∕e ≈ 0.632. Anything
  // above that on F is greedy behaving; below it would be an implementation bug.
  const worstF = Math.min(...rows.map((r) => r.fg / Math.max(1e-9, r.fu)));
  console.log(`   worst F ratio ${worstF.toFixed(4)} against the (1 − 1∕e) = 0.6321 bound`);
  ok('greedy stays inside its own (1 − 1∕e) guarantee on F', worstF >= 1 - 1/Math.E,
     `${worstF.toFixed(4)} ≥ 0.6321`);
  if (fLoss.length) console.log(`   greedy is beaten on F at: `
    + fLoss.map((r) => `${r.name} K=${r.K} (${((1-r.fg/r.fu)*100).toFixed(1)}% short)`).join(', '));

  // THE CLAIM THE PRODUCT ACTUALLY MAKES is about ONE view — the arrow the UI
  // draws — and it is gated here, hard.
  const single = rows.filter((r) => r.K === 1);
  console.log(`   K = 1, the only recommendation displayed: `
    + single.map((r) => `${r.name} ${(r.uI/Math.max(1e-9,r.gI)).toFixed(2)}×`).join(' · ')
    + `  (true ISE removed, against a shot from directly behind)`);
  ok('the single recommended view beats the turntable on true ISE, every fixture',
     single.every((r) => r.iWin),
     `${single.filter((r) => r.iWin).length}/${single.length}, worst margin `
     + `${Math.min(...single.map((r) => r.uI/Math.max(1e-9,r.gI))).toFixed(2)}×`);
  return { rows, fLoss, iLoss, worstF };
}

/* ---------------------------------------- task 4b: is the loss a search bug? */

/**
 * The K ≥ 2 loss above is either greedy being myopic — in which case a better
 * search fixes it and the utility is fine — or the surrogate F failing to track
 * the truth, in which case no search fixes it and the finding is about σ. Those
 * have opposite consequences, so the suite distinguishes them rather than
 * guessing, by running the search greedy is an approximation TO.
 *
 * `exchange` is exhaustive local search on F: replace each selected view with
 * every one of the 512 candidates, keep any improvement, repeat to a fixed
 * point. It is HARNESS ONLY, like `applyViews` — nothing in src/ optimises a
 * view set beyond the greedy order, and this exists to interrogate that order,
 * not to become it.
 */
function taskSurrogate(prepared, greedyReport) {
  console.log('\nTASK 4b — is that loss a search failure or a surrogate failure?');
  const losses = greedyReport.iLoss;
  if (!losses.length) { ok('no ISE losses to diagnose', true, 'greedy dominated everywhere'); return null; }

  console.log('   solid    K |  greedy F  +exch F   uniform F  ratio |  greedy ISE  +exch ISE  uniform ISE  ratio');
  const diag = [];
  for (const L of losses) {
    const p = prepared[L.name], { res, s, e } = p;
    const w = new Float64Array(s.count);
    for (let i = 0; i < s.count; i++) w[i] = s.S[i]*s.S[i]*s.A[i];
    const F = (idx) => { let f = 0;
      for (let i = 0; i < s.count; i++) { let g = 0;
        for (const c of idx) { const v = res.gains[c][i]; if (v > g) g = v; } f += w[i]*g; }
      return f; };
    let cur = res.sequence.slice(0, L.K).map((x) => x.index);
    let best = F(cur);
    for (let round = 0, moved = true; moved && round < 3; round++) {
      moved = false;
      for (let k = 0; k < cur.length; k++) {
        for (let c = 0; c < res.candidates.length; c++) {
          if (cur.includes(c)) continue;
          const trial = cur.slice(); trial[k] = c;
          const f = F(trial);
          if (f > best + 1e-12) { best = f; cur = trial; moved = true; }
        }
      }
    }
    const xI = ise(applyViews(e, res.gains, cur), s.A);
    const fRatio = best / Math.max(1e-9, L.fu), iRatio = xI / Math.max(1e-9, L.uI);
    diag.push({ ...L, xF: best, xI, fRatio, iRatio });
    console.log(`   ${L.name.padEnd(8)} ${L.K} | ${L.fg.toFixed(2).padStart(9)} ${best.toFixed(2).padStart(8)}`
      + ` ${L.fu.toFixed(2).padStart(10)} ${fRatio.toFixed(4).padStart(6)} |`
      + ` ${L.gI.toFixed(3).padStart(11)} ${xI.toFixed(3).padStart(9)} ${L.uI.toFixed(3).padStart(12)}`
      + ` ${iRatio.toFixed(3).padStart(6)}`);
  }
  const worstF = Math.min(...diag.map((d) => d.fRatio));
  const worstI = Math.max(...diag.map((d) => d.iRatio));
  console.log(`   exhaustive local search on F closes the objective gap to `
    + `${((1-worstF)*100).toFixed(1)}% at worst, and the true-error gap stays at `
    + `${((worstI-1)*100).toFixed(1)}%.`);

  // The decisive case: somewhere greedy WINS the objective and LOSES the truth.
  // If that happens, no amount of better searching can help — F is the problem.
  const inverted = diag.filter((d) => d.fg > d.fu && d.gI > d.uI);
  if (inverted.length) console.log(`   objective and truth point OPPOSITE ways at: `
    + inverted.map((d) => `${d.name} K=${d.K} (F +${((d.fg/d.fu-1)*100).toFixed(1)}%, `
      + `ISE +${((d.gI/d.uI-1)*100).toFixed(1)}%)`).join(', '));
  ok('the loss survives an exhaustive search of the same objective',
     worstF > 0.98 && worstI > 1.02,
     `F within ${((1-worstF)*100).toFixed(1)}%, ISE still ${((worstI-1)*100).toFixed(1)}% worse`);
  ok('...so it is the σ² surrogate that fails, not the greedy order',
     inverted.length > 0 || worstF > 0.99,
     inverted.length ? `${inverted.length} case(s) where F and true ISE disagree in sign`
                     : `F matched to ${((1-worstF)*100).toFixed(2)}% with no ISE recovery`);
  return diag;
}

/* ------------------------------------------------------------------ task 4c */

/**
 * The flag is enforced in BOTH directions, exactly as `SIGMA_CALIBRATED` is.
 * False must mean the loss is still there; true must mean it is gone. Neither
 * direction can be satisfied by editing one line.
 */
function taskFlag(greedyReport, prepared) {
  console.log('\nTASK 4c — the recorded finding matches the measurement, in both directions');
  const dominates = greedyReport.iLoss.length === 0;
  console.log(`   measured: greedy dominates on true ISE at every K — ${dominates ? 'yes' : 'no'}`
    + (dominates ? '' : `, losing at ${greedyReport.iLoss.map((r) => `${r.name} K=${r.K}`).join(', ')}`));
  console.log(`   recorded: GREEDY_SET_DOMINANCE = ${nbv.GREEDY_SET_DOMINANCE}`);
  ok('GREEDY_SET_DOMINANCE says what the fixtures say',
     nbv.GREEDY_SET_DOMINANCE === dominates,
     `${nbv.GREEDY_SET_DOMINANCE} = ${dominates}`);

  // ...and the report the certificate reads carries it, so no exported document
  // can present the K-view order as something it is not.
  const rep = Object.values(prepared)[0].res.report;
  ok('the exported report carries the flag rather than restating it',
     rep.sequenceValidated === nbv.GREEDY_SET_DOMINANCE && rep.singleViewValidated === true,
     `sequenceValidated ${rep.sequenceValidated}, singleViewValidated ${rep.singleViewValidated}`);

  const listed = new Set(nbv.GREEDY_REPORT.setLossesOnIse);
  const measured = new Set(greedyReport.iLoss.map((r) => `${r.name} K=${r.K}`));
  const same = listed.size === measured.size && [...measured].every((k) => listed.has(k));
  ok('GREEDY_REPORT lists exactly the losses that were measured', same,
     same ? `${measured.size} losses` : `recorded [${[...listed].join(', ')}] vs measured [${[...measured].join(', ')}]`);
}

/* ------------------------------------------------------------------ task 5 */

function taskFlat() {
  console.log('\nTASK 5 — a landscape with no answer, and the system saying so');

  // A sphere with uniform σ, CONSTRUCTED rather than reconstructed. It has to be
  // constructed, and that is the finding: a photographed sphere does not land
  // here, because the anisotropy prior flattens it into an oblate spheroid and a
  // pancake genuinely IS better learned about edge-on.
  const mk = (kz) => {
    const nu = 64, nv = 32, P = [], N = [], I = [];
    for (let j = 0; j <= nv; j++) {
      const th = Math.PI*j/nv;
      for (let i = 0; i <= nu; i++) {
        const ph = 2*Math.PI*i/nu;
        const x = Math.sin(th)*Math.cos(ph), y = Math.cos(th), z = Math.sin(th)*Math.sin(ph);
        P.push(x, y, z*kz);
        let nz = z/(kz*kz);
        const l = Math.hypot(x, y, nz) || 1;
        N.push(x/l, y/l, nz/l);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j*(nu+1)+i, b = a+1, c = a+nu+1, d = c+1;
      I.push(a, c, b, b, c, d);
    }
    return { positions: new Float32Array(P), normals: new Float32Array(N),
             indices: new Uint32Array(I), sigma: new Float32Array(P.length/3).fill(1) };
  };

  console.log('   squash in z   max/p50   dynamic range   flat   recommendation');
  const ladder = [];
  for (const kz of [1.0, 0.95, 0.9, 0.8, 0.725, 0.6]) {
    const res = nbv.nextBestView(mk(kz));
    ladder.push({ kz, r: res.report.topOverMedian, flat: res.report.flatLandscape });
    console.log(`   ${kz.toFixed(3).padStart(11)}   ${res.report.topOverMedian.toFixed(4).padStart(7)}`
      + `   ${String(res.report.dynamicRange).padStart(13)}   ${(res.report.flatLandscape?'yes':'no ').padStart(4)}`
      + `   ${res.recommended ? 'az ' + res.recommended.azimuth.toFixed(0) + '°' : 'none — no view is much better'}`);
  }
  ok('an isotropic solid is reported flat, with no recommendation',
     ladder[0].flat === true && nbv.nextBestView(mk(1)).recommended === null,
     `max/p50 ${ladder[0].r.toFixed(4)} against a cutoff of ${nbv.FLAT_RATIO}`);
  ok('the statistic rises monotonically as the solid is squashed',
     ladder.every((l, i) => i === 0 || l.r > ladder[i-1].r),
     ladder.map((l) => l.r.toFixed(3)).join(' < '));
  ok('a clearly anisotropic solid is NOT reported flat',
     ladder[ladder.length-1].flat === false,
     `×0.6 reads ${ladder[ladder.length-1].r.toFixed(3)}`);
  return ladder;
}

/* ---------------------------------------------------------------- task 5b */

/**
 * FLAT_REPORT says what this suite measured. This is where that stops being a
 * promise.
 *
 * Every entry is compared against the run that just happened, so rewording is
 * free and re-measuring is not: change what the statistic does and this fails
 * naming the entry, rather than leaving a comment quoting last month's number.
 * That is not hypothetical — six of the seven entries were wrong when this check
 * was written, having sat in a prose comment that nothing re-ran.
 *
 * The tolerance is 5e-4, half a unit in the last decimal the record carries but
 * one place looser, so re-rounding is not a failure and re-measuring is. The
 * drifts it was written against were 6e-3 and larger.
 */
function taskRecorded(prepared, ladder) {
  console.log('\nTASK 5b — FLAT_REPORT is what this run measured, not what it remembers');
  const R = nbv.FLAT_REPORT, TOL = 5e-4;
  const near = (a, b) => Math.abs(a - b) <= TOL;

  ok('the recorded isotropic reading is this run\'s',
     near(R.isotropic, ladder[0].r),
     `recorded ${R.isotropic}, measured ${ladder[0].r.toFixed(4)}`);

  // The ladder is compared entry by entry AND as a shape: a record listing the
  // wrong squash factors would otherwise pass by comparing the wrong pairs.
  const rung = ladder.slice(1);
  const badKz = R.squash.filter((e, i) => !rung[i] || Math.abs(e[0] - rung[i].kz) > 1e-9);
  const badR = R.squash.filter((e, i) => rung[i] && !near(e[1], rung[i].r));
  ok('the recorded squash ladder is this run\'s',
     R.squash.length === rung.length && badKz.length === 0 && badR.length === 0,
     badKz.length ? `squash factors differ: ${badKz.map((e) => e[0]).join(', ')}`
     : badR.length ? badR.map((e, i) => `×${e[0]} recorded ${e[1]}`).join(', ')
     : R.squash.map((e, i) => `×${e[0]}→${rung[i].r.toFixed(4)}`).join(' '));

  // ...and the photographed sphere, which is a different fixture in a different
  // task and is exactly the entry that had never been re-measured.
  const p = prepared.sphere;
  const ext = (k) => { let lo = Infinity, hi = -Infinity;
    for (let i = k; i < p.r.positions.length; i += 3) {
      const v = p.r.positions[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo; };
  const zx = ext(2) / ext(0);
  console.log(`   photographed sphere: max/p50 ${p.res.shape.topOverMedian.toFixed(4)}`
    + ` · extent Z∕X ${zx.toFixed(4)} · τ_trunk ${p.r.stats.tauTrunk.toFixed(4)}`);
  ok('the recorded photographed-sphere reading is this run\'s',
     near(R.photographed.topOverMedian, p.res.shape.topOverMedian),
     `recorded ${R.photographed.topOverMedian}, measured ${p.res.shape.topOverMedian.toFixed(4)}`);
  // The oblateness and the τ that causes it, together: the finding is that the
  // two are the same fact, so a record carrying one without the other would let
  // half of it rot.
  ok('...and so is the oblateness the anisotropy prior produces',
     near(R.photographed.extentZX, zx) && near(R.photographed.tauTrunk, p.r.stats.tauTrunk),
     `Z∕X recorded ${R.photographed.extentZX} measured ${zx.toFixed(4)}`
     + ` · τ recorded ${R.photographed.tauTrunk} measured ${p.r.stats.tauTrunk.toFixed(4)}`);
}

/* ------------------------------------------------------------------ task 6 */
// The quarantine, checked rather than promised.

function taskQuarantine() {
  console.log('\nTASK 6 — the product does not gain a reconstruction it does not have');
  const src = fs.readFileSync(new URL('../../../src/atlas/nbv.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Phase 3 was not chosen. These are the shapes it would take, and none of them
  // may appear in product code without a phase that says so.
  const forbidden = [/carve/i, /\bhull\b/i, /silhouetteCone/i, /fuse/i, /blendSeam/i,
                     /applyView/i, /intersectCone/i];
  const hits = forbidden.filter((re) => re.test(code)).map((re) => String(re));
  ok('src/nbv.js contains no fusion, carving or hull construction', hits.length === 0,
     hits.length ? hits.join(', ') : `${forbidden.length} patterns checked`);

  // ...and it exports nothing that applies a view to a reconstruction.
  const exported = Object.keys(nbv);
  console.log(`   exports: ${exported.join(', ')}`);
  ok('nothing exported applies a view to anything',
     !exported.some((k) => /apply|fuse|carve|update|refine/i.test(k)),
     `${exported.length} exports, none of them an update operator`);

  // The operator this suite uses is defined HERE and nowhere else.
  ok('the view-update operator lives only in the harness',
     typeof applyViews === 'function' && !('applyViews' in nbv),
     'applyViews is local to tools/test/atlas/nbv.mjs');
}

/* --------------------------------------------------------------------- run */

taskVisibility();
console.log('\n   preparing fixtures (reconstruct + 512 candidate gains + ground truth)…');
const prepared = {};
for (const [name, parts] of Object.entries(SOLIDS)) {
  prepared[name] = prepare(parts);
  console.log(`     ${name.padEnd(8)} ${prepared[name].s.count} samples`
    + ` · ground truth found for ${(prepared[name].coverage*100).toFixed(1)}%`);
}
taskRanking(prepared);
const greedyReport = taskGreedy(prepared);
taskSurrogate(prepared, greedyReport);
taskFlag(greedyReport, prepared);
const ladder = taskFlat();
taskRecorded(prepared, ladder);
taskQuarantine();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
