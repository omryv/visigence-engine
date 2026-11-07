/* Next-best-view guidance: what this photograph failed to constrain, and where
 * to stand for a better one.
 *
 * WHAT THIS IS NOT. There is no multi-view reconstruction in this product and
 * this file does not add one. It reads a finished single-photograph solid and
 * ranks directions you could shoot from; nothing here fuses, intersects, blends
 * or re-solves anything, and adding a second photograph still does what it did
 * before (texture from a back view, depth from a profile). The recommendation is
 * RETAKE GUIDANCE. If that ever changes, it changes in a phase that says so.
 *
 * THE UTILITY, and why it is the right integral
 *
 *     U(v) = ∫_S σ(x)² · (1 − cos²θ(x,v)) · vis(x,v) dA
 *
 * Three factors, each carrying one fact:
 *
 *   σ(x)²   how uncertain this patch of surface is now. Squared because the
 *           quantity being reduced is a variance, not a length.
 *   sin²θ   how much a camera at v could do about it. A view along v measures
 *           position PERPENDICULAR to v, and the component of the surface normal
 *           perpendicular to v is sin θ — so a view looking straight down a
 *           normal learns nothing about where that surface is along it, and a
 *           view looking across it learns everything. This is the sin-a
 *           silhouette bound written per-vertex instead of per-subject.
 *   vis     whether that camera can see the patch at all.
 *
 * σ IS UNCALIBRATED, and the ranking survives that intact while the language
 * around it does not. Ordering candidates needs σ to be monotone in uncertainty;
 * quoting "this view removes 40% of the variance" needs σ to be calibrated, and
 * it is not. So this file returns an ORDER and a shape statistic, the UI speaks
 * qualitatively, and nothing anywhere converts a utility into a percentage.
 *
 * ONE VIEW IS RECOMMENDED, NOT K. The single top-ranked direction is validated
 * against ground truth and is what the UI shows. `greedyViews` returns a ranked
 * ORDER as well, and `GREEDY_SET_DOMINANCE` below records — with the measurement
 * that established it — that the set of K ≥ 2 it picks does NOT beat a uniform
 * turntable on true error. Nothing displayed or exported may say otherwise.
 *
 * FLAT LANDSCAPES ARE A REAL ANSWER. On a sphere no direction is much better
 * than another, and a recommender that points confidently anyway is the old
 * `planViews` ring of frusta reborn — the one regression this project cannot
 * afford. `flat` is computed against the subject's OWN utility quantiles rather
 * than an absolute cutoff, for the same reason the waist thresholds are: a
 * single view carries no absolute scale.
 *
 * CPU ONLY. There is no GL context in this project's test environment, so the
 * rasteriser below is the implementation rather than a fallback, and the core
 * path stays GPU-free per the global rules. No GPU path is provided: one that
 * could not be run here could not be checked against this one either, and two
 * visibility implementations that are never compared will differ.
 */

/* --------------------------------------------------------------- constants */

// Candidate directions over the hemisphere. 512 is the spec's number; on a
// Fibonacci lattice that is about 5.5° between neighbours, which is finer than
// anyone can stand to.
export const CANDIDATES = 512;

// Samples the integral is evaluated at. The mesh carries tens of thousands of
// vertices and the integrand is smooth over the surface, so it is decimated by a
// stride and the areas rescaled to the true total — the utility is an integral,
// not a sum over vertices, and its value must not depend on tessellation density.
export const SAMPLES = 6000;

// Visibility raster. Coarse on purpose: this is an occlusion test between PARTS
// — is the torso behind the arm — and not a rendering. At 40×40 over ~6,000
// samples a cell holds about four of them, which is what the splat radius below
// is for.
export const VIS_GRID = 32;
// No splat. Writing a sample's depth into its NEIGHBOURS' cells looks like it
// would fill the gaps in a sparse point cloud, and instead it poisons them: the
// nearest sample within a cell of you becomes the depth you are tested against,
// and on a sphere — where nothing occludes anything — that rejected 54% of the
// front-facing surface. Each sample is tested against its own cell, which always
// contains at least itself, so the test asks exactly "is something else in my
// cell substantially nearer than I am".
export const VIS_SPLAT = 0;

// How far behind the nearest surface in a cell a sample may sit and still count
// as visible. Two terms, and the second is the one that matters: a surface
// crossing a cell at angle θ to the view spans cell·tanθ of real depth inside it,
// and a constant tolerance therefore reports every oblique surface as
// self-occluding — worst exactly at the rim, where tanθ → ∞ and where the
// silhouette actually is. So the tolerance carries the sample's own slope.
export const VIS_DEPTH_TOL = 1.0;
export const VIS_SLOPE_TOL = 1.5;
// ...and the tolerance is capped at the subject's own depth span rather than at
// an arbitrary slope. At the contour the surface is TANGENT to the view, so the
// depth it spans inside one cell is the whole object and the depth test carries
// no information there — which is the honest answer, not a limit to be tuned
// around. Capping at the span says exactly that: nothing can be shown to occlude
// a tangent patch by a buffer this coarse. Without the cap, contour samples fail
// their own depth test and a view loses credit for the part of the surface it
// constrains best.
export const VIS_SLOPE_MAX = 60;

// THE OCCLUDING CONTOUR IS IMAGED FROM BOTH SIDES, and a test on the sign of n·v
// alone does not know that. Nor does a shifted test: moving the cut-off to
// −band leaves a step of the same size in a new place, and this quantity has to
// be CONTINUOUS or a recommender's answer turns on which side of a threshold a
// rounding error fell. So visibility is a WEIGHT across the contour, not a
// boolean, and the band below is its width.
//
// Where n·v = 0 the surface is edge-on: it is exactly the silhouette, and a
// silhouette is the one thing this whole pipeline measures well. A patch a
// hair's breadth on the far side of that curve is occluded only by an
// infinitesimal sliver of the near side, and it is imaged as the same contour.
// So a strict `n·v > 0` puts a STEP where the physics is continuous, and the
// step lands on the largest population there is: measured on a reconstructed
// sphere, the whole front face has n·v = ±1e-16 for a view at azimuth 270°, and
// which way that sign fell decided between gain 1 and gain 0 for a quarter of
// the surface. Two candidate views five degrees apart then scored 47× apart on
// the true error.
//
// The band is DERIVED, not chosen. It is one sample of normal-turning: a closed
// surface carrying `count` samples turns its normal by about √(4π ∕ count)
// between neighbours, so a patch within that of grazing is on the contour as far
// as this discretisation can tell.
export const contourBand = (count) => Math.min(0.2, Math.sqrt(4 * Math.PI / Math.max(1, count)));

// A landscape is FLAT when the best direction is not meaningfully better than a
// typical one: max ∕ median below FLAT_RATIO.
//
// The STATISTIC is a ratio of the subject's own quantiles and so carries no
// absolute scale — the same discipline as the waist thresholds. The CUTOFF is
// the one number here that is not read off the subject, and it is a judgement
// about actionability rather than a measurement: a view under a tenth better
// than a typical one is not worth walking around for. It is stated as a
// judgement instead of being tuned until the fixtures fall either side of it.
//
// What IS measured is that the statistic tracks the thing it claims to, and the
// measurements are in FLAT_REPORT below rather than in this sentence — see the
// note there for why they had to move.
export const FLAT_RATIO = 1.10;

/**
 * What FLAT_RATIO was set against. Numbers are measured, not asserted:
 * tools/test/atlas/nbv.mjs re-derives every one of them on every run and fails if any
 * disagrees with what it just measured, exactly as it does for GREEDY_REPORT.
 *
 * THEY ARE DATA AND NOT PROSE BECAUSE PROSE IS THE ONE MEDIUM HERE WITH NO GUARD
 * ON IT. Every number in this block used to be a sentence in the comment above,
 * and by the time anyone re-ran them eight of the nine had drifted: the isotropic
 * reading was written 1.0014 against a measured 1.0073, the whole squash ladder
 * was low by 1.0–13.6%, the photographed sphere was written 1.271 against a
 * measured 1.5517, and its oblateness 0.706 against 0.7083. Only τ = 0.725 still
 * held. Nothing was wrong with the code. The comment had simply
 * stopped being a quotation and nothing could tell, which is the same failure the
 * certificate registry exists to catch, in the medium that had no registry.
 *
 * `isotropic` and `squash` are the CONSTRUCTED sphere of tools/test/atlas/nbv.mjs TASK 5 — a
 * sphere carrying uniform σ, built rather than reconstructed, squashed in z by
 * the factor named. `photographed` is that same solid rendered and put through
 * `reconstruct`, in TASK 3.
 *
 * A FINDING THAT CORRECTS THE OBVIOUS FIXTURE, and the reason the flat branch is
 * exercised on a constructed solid at all: a PHOTOGRAPHED sphere does not land in
 * the flat regime. That is not a defect in the statistic, it is the anisotropy
 * prior — a frontal subject is flattened by τ = 1∕1.38 = 0.725, so the
 * reconstruction of a sphere is an oblate spheroid of measured extent Z∕X — and a
 * pancake genuinely IS better learned about edge-on. The recommendation there is
 * correct and the landscape is correctly not flat.
 */
export const FLAT_REPORT = {
  isotropic: 1.0073,
  squash: [[0.95, 1.0283], [0.90, 1.0512], [0.80, 1.1199], [0.725, 1.1913], [0.60, 1.3603]],
  photographed: { topOverMedian: 1.5517, extentZX: 0.7083, tauTrunk: 0.7246 },
};

/* ------------------------------------------- a recorded negative finding */

/**
 * THE K-VIEW SEQUENCE IS AN ORDER, NOT A SET WITH A DOMINANCE CLAIM.
 *
 * The single top-ranked view is validated: against ground truth on four solids
 * it removes 1.31× to 2.61× more true integrated squared error than a shot from
 * directly behind. That is the only recommendation this product displays.
 *
 * The GREEDY SET of K ≥ 2 views is not validated, and this flag records that
 * rather than the UI quietly implying otherwise. Measured against a uniform
 * turntable of the same K, greedy loses on true ISE at K = 2 on all four
 * fixtures and at K = 4 on the figure.
 *
 * IT IS NOT A SEARCH FAILURE, and the measurement that rules that out is the
 * one worth keeping. Greedy stays far inside its own (1 − 1∕e) guarantee on F
 * (worst ratio 0.9462), and an exhaustive local-exchange refinement of F —
 * replacing each selected view with every one of the 512 candidates until no
 * single swap improves — closes the F gap on the four K = 2 losses to within
 * 0.6% while the true-ISE gap stays at 3.7% to 32.9%. At figure K = 4 the two
 * diverge outright: greedy beats the turntable on F by 28.6% and loses to it on
 * true ISE by 67.1%.
 *
 * SO THE SURROGATE IS THE PROBLEM, not the search over it. F weights coverage by
 * σ², and Phase 1 established that σ's SHAPE is only partly right — it is
 * uncalibrated in scale and, per the confound finding, partly driven by things
 * that are not error. At K = 1 the best view's advantage is large enough to
 * survive that; by K = 2 the difference between good sets is a few percent of F,
 * which is smaller than σ's own shape error, and the ordering stops meaning
 * anything. Fixing this needs a better σ, not a better optimiser — which is the
 * physical validation set already filed as a future phase.
 *
 * Enforced bidirectionally in tools/test/atlas/nbv.mjs: false requires the loss to still be
 * measurable, true requires actual dominance at every K.
 */
export const GREEDY_SET_DOMINANCE = false;

/** What that flag was set from. Numbers are measured, not asserted. */
export const GREEDY_REPORT = {
  singleViewValidated: true,
  singleViewIseRatio: { sphere: 2.614, figure: 1.312, blob: 1.712, thin: 1.895 },
  setLossesOnIse: ['sphere K=2', 'figure K=2', 'figure K=4', 'blob K=2', 'thin K=2'],
  worstFRatio: 0.9462,
  submodularBound: 1 - 1 / Math.E,
  exchangeRefinedWorstFRatio: 0.9942,
  exchangeRefinedWorstIseRatio: 1.436,
  objectiveAndTruthInvert: 'figure K=4: F +28.6%, true ISE +67.1%',
  diagnosis: 'surrogate mismatch, not greedy myopia: local search closes the '
    + 'objective gap to 0.6% and the true-error gap remains, so the σ² weighting '
    + 'is what fails to track the truth once view sets differ by only a few percent',
};

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/* -------------------------------------------------------------- directions */

/**
 * Candidate view directions: a Fibonacci lattice over the UPPER hemisphere.
 *
 * Upper because the lower one is not a place a photographer stands. Fibonacci
 * because it is near-uniform without a pole cluster and is deterministic — a
 * random lattice would make the recommendation depend on the draw, and this
 * whole project is reproducible or it is nothing.
 *
 * Convention: a direction points FROM the subject TOWARD the camera, so the
 * photograph already taken is +Z. Azimuth is measured from +Z about +Y, which
 * makes "azimuth 90°" mean a quarter turn round the subject.
 */
export function viewCandidates(n = CANDIDATES) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN;
    const x = r * Math.sin(phi), z = r * Math.cos(phi);
    out.push({ x, y, z,
               azimuth: ((Math.atan2(x, z) * 360 / TAU) + 360) % 360,
               elevation: Math.asin(y) * 360 / TAU });
  }
  return out;
}

/* ------------------------------------------------------------- visibility */

/**
 * How much of each sample a camera at direction `v` sees: a weight in [0, 1].
 *
 * A weight and not a flag, and the shape of it is the point:
 *
 *   n·v > −band          weight 1. Imaged directly, or ON the contour — and a
 *                        patch on the contour is the silhouette, which is the
 *                        one thing this pipeline measures well. A smoothstep
 *                        CENTRED on n·v = 0 would give the contour itself ½,
 *                        which is exactly backwards.
 *   −2band < n·v < −band smoothly down to 0. The discretisation cannot place the
 *                        contour better than one sample of normal-turning, so
 *                        this is where the model runs out, and it says so by
 *                        fading rather than by stepping.
 *   n·v < −2band         0. The far side.
 *
 * No answer anywhere turns on a sign a rounding error can flip.
 *
 * Points and not triangles, and the reason is a budget rather than a shortcut:
 * 512 directions over 50,000 triangles is 26 million triangle setups, which is
 * minutes. The samples ARE the surface here — the integral is evaluated at them
 * — so a buffer built from them answers exactly the question being asked.
 *
 * Two rejections, and they are different: a sample facing away (n·v ≤ 0) is not
 * visible however clear the line of sight, and a sample behind another in its own
 * cell is occluded however square it faces the camera. A CONVEX SOLID HAS ONLY
 * THE FIRST, which is what makes a sphere a usable check on this function and
 * why tools/test/atlas/nbv.mjs runs one: measured against 64 directions on an analytic
 * sphere the two sets agree exactly, and a two-sphere solid where one really
 * does hide the other loses 162 of 2,099 front-facing samples from in front and
 * none at all from the side.
 *
 * The approximation that remains, stated rather than buried: occlusion is
 * detected where the OCCLUDER has samples. A cell covered by a nearer surface
 * that happens to contain none of that surface's samples reports the far one
 * visible. At the default density that is about six samples per cell, so it
 * costs a thin fringe around an occluder's silhouette and never a whole part.
 */
export function visibleFrom(P, N, v, opt = {}) {
  const G = opt.grid || VIS_GRID, SPL = opt.splat === undefined ? VIS_SPLAT : opt.splat;
  const n = P.length / 3;
  const band = opt.band === undefined ? contourBand(n) : opt.band;
  const vis = new Float32Array(n);

  // an orthonormal frame with `v` as the view axis
  const up = Math.abs(v.y) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let rx = up[1]*v.z - up[2]*v.y, ry = up[2]*v.x - up[0]*v.z, rz = up[0]*v.y - up[1]*v.x;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = v.y*rz - v.z*ry, uy = v.z*rx - v.x*rz, uz = v.x*ry - v.y*rx;

  const su = new Float32Array(n), sw = new Float32Array(n), sd = new Float32Array(n);
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i*3], y = P[i*3+1], z = P[i*3+2];
    const a = x*rx + y*ry + z*rz, b = x*ux + y*uy + z*uz;
    su[i] = a; sw[i] = b; sd[i] = x*v.x + y*v.y + z*v.z;
    if (a < u0) u0 = a; if (a > u1) u1 = a;
    if (b < w0) w0 = b; if (b > w1) w1 = b;
  }
  const spanU = Math.max(1e-9, u1 - u0), spanW = Math.max(1e-9, w1 - w0);
  const span = Math.max(spanU, spanW) * 1.0001;
  const cell = span / G;
  let d0 = Infinity, d1 = -Infinity;
  for (let i = 0; i < n; i++) { if (sd[i] < d0) d0 = sd[i]; if (sd[i] > d1) d1 = sd[i]; }
  const depthSpan = Math.max(1e-9, d1 - d0);

  const buf = new Float32Array(G * G).fill(-Infinity);
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = Math.max(0, Math.min(G - 1, ((su[i] - u0) / span * G) | 0));
    const gy = Math.max(0, Math.min(G - 1, ((sw[i] - w0) / span * G) | 0));
    const k = gy * G + gx;
    cellOf[i] = k;
    // The buffer is built from the FRONT-FACING samples only. A back-facing
    // sample is on the far wall of the solid and is never what occludes
    // anything; including it would let the far side of a thin limb shadow the
    // near side of the same limb.
    if (N[i*3]*v.x + N[i*3+1]*v.y + N[i*3+2]*v.z > 0) {
      for (let dy = -SPL; dy <= SPL; dy++) {
        const y2 = gy + dy; if (y2 < 0 || y2 >= G) continue;
        for (let dx = -SPL; dx <= SPL; dx++) {
          const x2 = gx + dx; if (x2 < 0 || x2 >= G) continue;
          const kk = y2 * G + x2;
          if (sd[i] > buf[kk]) buf[kk] = sd[i];
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const c = N[i*3]*v.x + N[i*3+1]*v.y + N[i*3+2]*v.z;
    if (c <= -2 * band) continue;                                  // the far side
    let face = 1;
    if (c < -band) { const t = (c + 2*band) / band; face = t * t * (3 - 2 * t); }
    const tanT = Math.min(VIS_SLOPE_MAX, Math.sqrt(Math.max(0, 1 - c*c)) / Math.max(1e-4, Math.abs(c)));
    const tol = Math.min(depthSpan, cell * (VIS_DEPTH_TOL + VIS_SLOPE_TOL * tanT));
    if (sd[i] >= buf[cellOf[i]] - tol) vis[i] = face;
  }
  return vis;
}

/* ---------------------------------------------------------------- sampling */

/**
 * Decimate the mesh to an area-weighted sample of the surface.
 *
 * Every sample carries the area it stands for — a third of each incident
 * triangle, summed — and the kept subset is rescaled so the areas still total the
 * mesh's own. Without that rescale the utility would be a sum over vertices, and
 * a denser tessellation of the same solid would report a larger utility for the
 * same view.
 */
export function surfaceSamples(positions, normals, indices, sigma, target = SAMPLES) {
  const n = positions.length / 3;
  const area = new Float64Array(n);
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t+1], c = indices[t+2];
    const e1x = positions[b*3]-positions[a*3], e1y = positions[b*3+1]-positions[a*3+1], e1z = positions[b*3+2]-positions[a*3+2];
    const e2x = positions[c*3]-positions[a*3], e2y = positions[c*3+1]-positions[a*3+1], e2z = positions[c*3+2]-positions[a*3+2];
    const px = e1y*e2z - e1z*e2y, py = e1z*e2x - e1x*e2z, pz = e1x*e2y - e1y*e2x;
    const ar = 0.5 * Math.hypot(px, py, pz);
    area[a] += ar/3; area[b] += ar/3; area[c] += ar/3;
    total += ar;
  }
  const stride = Math.max(1, Math.floor(n / Math.max(1, target)));
  const idx = [];
  for (let i = 0; i < n; i += stride) idx.push(i);
  const m = idx.length;
  const P = new Float32Array(m*3), N = new Float32Array(m*3);
  const A = new Float64Array(m), S = new Float64Array(m);
  let kept = 0;
  for (let k = 0; k < m; k++) { kept += area[idx[k]]; }
  const rescale = kept > 0 ? total / kept : 1;
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    P[k*3] = positions[i*3]; P[k*3+1] = positions[i*3+1]; P[k*3+2] = positions[i*3+2];
    N[k*3] = normals[i*3]; N[k*3+1] = normals[i*3+1]; N[k*3+2] = normals[i*3+2];
    A[k] = area[i] * rescale;
    S[k] = sigma ? sigma[i] : 1;
  }
  return { P, N, A, S, index: idx, count: m, totalArea: total, stride };
}

/* ----------------------------------------------------------------- utility */

/**
 * The per-sample gain a view at `v` offers: sin²θ where it can be seen, 0 where
 * it cannot. This is the whole physical content of the ranking, and it is also
 * exactly what the harness's view-update operator undoes — the two are the same
 * expression on purpose, so that "does the top-ranked view actually reduce the
 * error most" is a question about whether σ predicts where the error IS, and not
 * a question about whether two different formulas agree.
 */
export function viewGain(s, v, out) {
  const g = out || new Float64Array(s.count);
  const vis = visibleFrom(s.P, s.N, v);
  for (let i = 0; i < s.count; i++) {
    if (vis[i] <= 0) { g[i] = 0; continue; }
    const c = s.N[i*3]*v.x + s.N[i*3+1]*v.y + s.N[i*3+2]*v.z;
    g[i] = Math.max(0, 1 - c*c) * vis[i];
  }
  return g;
}

/** U(v) = Σ σ² · sin²θ · vis · dA, over the surface samples. */
export function utility(s, v) {
  const g = viewGain(s, v);
  let u = 0;
  for (let i = 0; i < s.count; i++) u += s.S[i]*s.S[i] * g[i] * s.A[i];
  return u;
}

const quantile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

/**
 * Is this landscape peaked enough to point at anything?
 *
 * `topOverMedian` is the gate, per the spec. `dynamicRange` is reported beside
 * it as the robust picture of the whole landscape — p95∕p05 rather than max∕min,
 * so one freak direction cannot make a flat landscape look structured — and it
 * is a diagnostic, not a second gate: two statistics that can disagree about the
 * same question are two chances to pick the answer you wanted.
 */
export function landscapeShape(U) {
  const s = Array.from(U).sort((a, b) => a - b);
  const p50 = quantile(s, 0.50), p05 = quantile(s, 0.05), p95 = quantile(s, 0.95);
  const max = s[s.length - 1], min = s[0];
  const topOverMedian = p50 > 0 ? max / p50 : 1;
  return { max, p95, p50, p05, min,
           topOverMedian,
           dynamicRange: p05 > 0 ? p95 / p05 : Infinity,
           flat: !(topOverMedian >= FLAT_RATIO) };
}

/* ------------------------------------------------------------------ greedy */

/**
 * Greedy selection of K views.
 *
 * The set function is
 *
 *     F(S) = Σ_i σ_i²·A_i · max_{v ∈ S} gain(i, v)
 *
 * a weighted coverage function: a max of non-negative terms, with non-negative
 * weights. That is monotone and submodular, so the greedy sequence is within
 * (1 − 1∕e) ≈ 63% of the best possible set of the same size. The guarantee is
 * about the SET FUNCTION and not about the reconstruction: it says the ranking
 * cannot be badly beaten by a cleverer search of the same candidates, and says
 * nothing about how good the underlying utility is. The UI states it in those
 * terms or not at all.
 *
 * The `max` is also what makes a second view worth less than the first where the
 * two overlap, which is the property that makes "K views" a sensible question.
 */
export function greedyViews(s, cands, K, gains) {
  const best = new Float64Array(s.count);
  const chosen = [];
  const w = new Float64Array(s.count);
  for (let i = 0; i < s.count; i++) w[i] = s.S[i]*s.S[i] * s.A[i];
  const taken = new Uint8Array(cands.length);
  for (let k = 0; k < K; k++) {
    let bi = -1, bg = -Infinity;
    for (let c = 0; c < cands.length; c++) {
      if (taken[c]) continue;
      const g = gains[c];
      let gain = 0;
      for (let i = 0; i < s.count; i++) { const d = g[i] - best[i]; if (d > 0) gain += w[i] * d; }
      if (gain > bg) { bg = gain; bi = c; }
    }
    if (bi < 0) break;
    taken[bi] = 1;
    const g = gains[bi];
    for (let i = 0; i < s.count; i++) if (g[i] > best[i]) best[i] = g[i];
    chosen.push({ index: bi, marginal: bg });
  }
  return chosen;
}

/* -------------------------------------------------------------------- API */

/**
 * Rank the candidate views for a finished reconstruction.
 *
 * @param {object} result  what `reconstruct` returned
 * @param {object} [opt]   {candidates, samples, K}
 * @returns {{candidates, utilities, shape, recommended, sequence, samples}}
 *   `recommended` is null when the landscape is flat — that is the answer, not a
 *   missing value, and the caller must render it as one.
 */
export function nextBestView(result, opt = {}) {
  const nC = opt.candidates || CANDIDATES;
  const cands = viewCandidates(nC);
  const s = surfaceSamples(result.positions, result.normals, result.indices,
                           result.sigma, opt.samples || SAMPLES);
  const gains = [], U = new Float64Array(nC);
  for (let c = 0; c < nC; c++) {
    const g = viewGain(s, cands[c]);
    gains.push(g);
    let u = 0;
    for (let i = 0; i < s.count; i++) u += s.S[i]*s.S[i] * g[i] * s.A[i];
    U[c] = u;
  }
  const shape = landscapeShape(U);
  let top = 0;
  for (let c = 1; c < nC; c++) if (U[c] > U[top]) top = c;
  const K = opt.K || 3;
  const sequence = greedyViews(s, cands, Math.min(K, nC), gains);
  return {
    candidates: cands,
    utilities: U,
    gains: opt.keepGains ? gains : null,
    shape,
    topIndex: top,
    recommended: shape.flat ? null : { ...cands[top], utility: U[top], index: top },
    sequence: sequence.map((e) => ({ ...cands[e.index], index: e.index, marginal: e.marginal })),
    samples: s.count,
    // Everything the certificate is allowed to say, gathered here so the caller
    // cannot assemble a different story out of the parts.
    report: {
      candidateCount: nC,
      sampleCount: s.count,
      flatLandscape: shape.flat,
      topOverMedian: +shape.topOverMedian.toFixed(4),
      dynamicRange: isFinite(shape.dynamicRange) ? +shape.dynamicRange.toFixed(4) : null,
      selectedAzimuthDeg: shape.flat ? null : +cands[top].azimuth.toFixed(2),
      selectedElevationDeg: shape.flat ? null : +cands[top].elevation.toFixed(2),
      qualitative: true,
      // The single recommendation is validated against ground truth; the K-view
      // sequence is a ranked order and is NOT. See GREEDY_SET_DOMINANCE.
      singleViewValidated: true,
      sequenceValidated: GREEDY_SET_DOMINANCE,
    },
  };
}
