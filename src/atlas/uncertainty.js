/* Per-vertex uncertainty: the scale of a predictive distribution of the surface
 * position, along the vertex normal, in pixels of the working grid.
 *
 * NOT a standard deviation, and the distinction is load-bearing. The predictive
 * is a Student-t, so ±1 of this number is not 68% of anything; the multipliers
 * for the two named levels are `intervalK(level)` and they travel with the
 * export. Everything the file computes below is nonetheless a propagated
 * standard deviation of the underlying error sources — the t enters at the end,
 * as the shape the pooled error actually has. See "the predictive family".
 *
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS A DIFFERENT KIND OF NUMBER
 *
 * `aconf` is a product of hand-tuned smoothsteps clamped to [0.12, 1]. It is
 * monotone in the right things and that is the whole of its content: an ordering,
 * not a probability, and `aconf = 0.62` does not mean the surface is within any
 * distance of the truth with any probability. The README removed its median from
 * the panel for exactly that reason. σ is the other thing — a length, with units,
 * that a coverage test can falsify. It is kept beside `aconf` rather than
 * replacing it in the data, because the two answer different questions (how well
 * did a camera sample this surface, versus how far might it be from the truth),
 * but σ is what the viewer and the certificate report.
 *
 * THE WELL-CONDITIONED COORDINATE
 *
 * Everything downstream of the silhouette is a function of D, and near the rim
 * the half-thickness behaves as A ≈ √(2RD), so ∂A/∂D = R/A → ∞. A variance
 * written in A is unbounded exactly where the surface is largest, which makes it
 * useless as a per-vertex number. Written in the reconstructed radius
 *
 *     R = √(A² + G²)
 *
 * — the radius of the maximal inscribed ball that won at this pixel, with G the
 * in-plane offset to its centre — the Jacobian is bounded and the input variance
 * is what it physically is: the localisation error of one boundary, a fraction of
 * a pixel, roughly constant over the silhouette. `ballUnionField` returns R and G
 * exactly, from the same transform that produces A, so the identity A² + G² = R²
 * holds by construction.
 *
 * The transform back is where the divergence is spent, once, in closed form. The
 * surface is z = t·A(x, y) for the anisotropy t actually applied, so a
 * perturbation δR moves it vertically by t·(R/A)·δR, and the component of that
 * along the surface normal carries the factor
 *
 *     n·ẑ = 1 / √(1 + t²|∇A|²) = A / √(A² + t²G²)
 *
 * using |∇A| = G/A, which is exact for the ball union: ∇(A²) = −2(x − m) for the
 * winning seed m. The two divergences cancel:
 *
 *     σ_boundary = t·R·σ_R / √(A² + t²G²)
 *
 * with no A in the numerator at all. At the centre of a ball this is t·σ_R — the
 * thickness is t·R, so its error is t·σ_R. At the rim, where A → 0 and G → R, it
 * is σ_R exactly. Both limits are right and nothing blows up in between. That is
 * the whole reason to propagate in R.
 *
 * The same n·ẑ factor carries every other source, so all of them share one
 * denominator and the file has one place to get it wrong.
 *
 * WHAT IS CALIBRATED AND WHAT IS DECLARED
 *
 * σ_R is DERIVED from what the segmentation measured — the background's own MAD,
 * through the matte's slope, divided by the measured coverage gradient, in
 * quadrature with the measured mask-regularisation shift — and then carries a
 * gain, which is DECLARED at 1. TAU_LOG_SD is DECLARED too: a single photograph
 * cannot measure how much subjects' depth-to-width ratios vary, so its spread is
 * a prior. ν is the one of the three that ships AT its fitted value.
 *
 * WHICH MEANS THE SCORE IS OF THE DECLARATION, NOT OF THE FIT, and getting that
 * backwards is what this file's calibration figures did for one phase. All three
 * scalars are fitted on a training split of the analytic fixtures, because where
 * the likelihood's optimum sits is worth knowing; then the field built from the
 * DECLARATIONS — the one every export carries — is what is scored on the disjoint
 * split. tools/test/atlas/uncertainty.mjs prints the fit, the score, and the gap between
 * them, and CALIBRATION_REPORT and FITTED_OPTIMUM record both.
 *
 * Three consequences worth stating, because they bound what the number is worth:
 *
 *   * The coverage test validates the PROPAGATION, not the prior. The fixture
 *     population is drawn from the same declared τ spread σ uses, so if that
 *     spread is wrong for a real subject, σ is wrong for it by the same factor
 *     and nothing here can tell.
 *   * It is calibrated on SYNTHETIC fixtures. No real-photograph validation set
 *     exists, and the certificate says so rather than letting "calibrated" imply
 *     one. The fixture is also where the temptation to over-fit lives: inside one
 *     synthetic solid the only thing varying is the true depth, so EVERY quantity
 *     downstream of depth correlates with the depth error. tools/test/atlas/uncertainty.mjs
 *     finds the Lambertian R² doing exactly that at r = −0.9 and then shows it is
 *     a confound by painting the subject — which moves R² by 54% and the error by
 *     0.2%. That is why the per-subject scale is integrated out rather than
 *     estimated from an observable.
 *   * What the test does establish independently is that σ's spatial shape
 *     carries information: the NLL against the best constant-scale predictive OF
 *     THE SAME FAMILY is a comparison the propagation can fail, and it is the
 *     number to read.
 */

/* --------------------------------------------------- the predictive family */

// σ is the SCALE of a Student-t, not a standard deviation, and the difference is
// the whole of what this file learned from failing its first calibration.
//
// A Gaussian per-vertex predictive cannot be calibrated against this pipeline's
// errors, and the reason is structural rather than a matter of fit. The
// anisotropy prior's error is ONE SCALAR PER SUBJECT — this subject is 20%
// deeper than the prior assumed — multiplied by the local thickness at every
// vertex. Pooled over subjects that makes the standardised error a SCALE
// MIXTURE of Gaussians, which is leptokurtic by construction: a taller peak AND
// heavier tails than any single Gaussian, so the 1σ and 2σ coverage levels pull
// in opposite directions and no scaling can satisfy both. Measured: 70.0% at 1σ
// against a nominal 68.3% while 2σ reached only 91.8% against 95.4%, and
// removing each subject's own scalar took the second to 96.9%. Those four are a
// record of phase 1's Gaussian, against phase 1's σ; the suite no longer computes
// them and prints its own mixture figures instead. The mechanism is what carried
// forward, not the arithmetic.
//
// A scale mixture of Gaussians over an inverse-gamma scale IS a Student-t. So
// writing the predictive as t_ν is not a heavier-tailed distribution chosen
// because it fits better; it is the distribution the mechanism produces, with ν
// carrying how heavy the per-subject scatter is.
//
// WHY THE PER-SUBJECT SCALE IS INTEGRATED OUT RATHER THAN ESTIMATED. It could in
// principle be predicted from something the pipeline measures about this
// photograph — the symmetry IoU that decides frontal from profile is the
// obvious candidate, since a subject near that decision boundary has a far more
// uncertain τ than one well clear of it. It is not, because on the fixture
// population nothing available at inference time predicts it: tests/
// uncertainty.mjs regresses each subject's realised scale against every
// observable the pipeline produces without ground truth and reports the
// correlations. Integrating the scale out needs no such observable — ν is a
// global constant like TAU_LOG_SD — which is what keeps the calibration free of
// ground-truth leakage.
export const PREDICTIVE = 'student-t';

// Degrees of freedom. Fitted by maximum likelihood on the TRAINING solids of
// tools/test/atlas/uncertainty.mjs, alongside the two scale parameters; that suite prints
// the fit and re-derives this number on every run.
export const NU = 3.20;

// The two nominal levels the calibration is scored at, and the levels the viewer
// and the export name. Not "±1σ" and "±2σ": under a t those multiples are not
// 68% and 95%, and a shell labelled in σ would be quoting a Gaussian's coverage
// for a distribution that is not one.
export const LEVELS = [0.68, 0.95];

/* ------------------------------------------------------------- calibration */

// Whether the coverage test in tools/test/atlas/uncertainty.mjs passes on the held-out
// split. This is a RECORD OF A MEASUREMENT, set by hand from what that suite
// reports and re-checked by it on every run — the suite fails if this constant
// and its own verdict disagree, so it cannot drift into being an assertion.
//
// When false, σ still ships: it is monotone in the right things and the
// next-best-view ranking only needs that. But the panel, the export and the
// certificate all say "uncalibrated", and no coverage percentage is quoted
// anywhere.
export const SIGMA_CALIBRATED = false;

/**
 * What the calibration suite actually measured, on the held-out split, FOR THE σ
 * THIS FILE SHIPS.
 *
 * These are the numbers the certificate quotes, and they are here — beside the
 * flag, under the same rule — so that they cannot go stale independently of it.
 * tools/test/atlas/uncertainty.mjs imports this object and re-derives every measured field
 * on every run, failing if any disagrees with what it just measured. A
 * certificate is worth its weakest number; a certificate quoting a coverage
 * figure from a calibration that has since changed is worse than one that says
 * nothing.
 *
 * THAT LAST SENTENCE WAS A PROMISE AND NOT A CHECK, AND IT WAS BOTH STALE AND
 * WRONG. Nothing imported this object into the calibration suite, so nothing
 * compared it against a measurement — and the numbers it carried were not the
 * held-out score of the shipped σ at all. They were the score at the FIT'S
 * OPTIMUM: the suite fitted three scalars and then evaluated the field built from
 * the fitted pair, while `reconstruct` builds σ from the declarations below —
 * SIGMA_R_GAIN and TAU_LOG_SD. The optimum wants 1.70× the scale and a τ prior
 * 30% wider than the declaration, so the two fields are not the same field, and
 * the coverage it reported was the better one's. Scored at the declaration, which
 * is what every `_SIGMA` attribute actually carries:
 *
 *     68% level    62.6% at the optimum → 49.0% as shipped
 *     95% level    93.3% at the optimum → 86.8% as shipped
 *     NLL          3.0249  →  3.1217   (the same-family baseline is unchanged)
 *
 * The flag was already false and stays false; what changes is that the number
 * beside it now describes the artefact it travels with. FITTED_OPTIMUM below keeps
 * the other measurement, because the gap between the two IS the finding: the shipped
 * σ is under-dispersed by a factor the fit can name, and that is worth carrying
 * where it can be read rather than deleting because it is unflattering.
 *
 * `validation` is not decoration either. The calibration is against synthetic
 * analytic fixtures, there is no physical validation set, and the certificate
 * must not let the word "calibrated" imply one. `caveat` records why an
 * apparently excellent per-photograph estimator was not used — see the confound
 * test in the suite.
 */
export const CALIBRATION_REPORT = {
  levels: [0.68, 0.95],
  heldOutCoverage: [0.490, 0.868],
  nll: { sigma: 3.1217, constantSameFamily: 3.3121 },
  trainSolids: ['figure', 'blob'],
  testSolids: ['asym', 'thin'],
  scoredVertices: 255432,
  scoredAt: 'the declared constants — the σ the engine exports, not the fit\'s optimum',
  validation: 'validated against synthetic analytic fixtures only',
  caveat: 'photograph-derived confidence observables (e.g. Lambertian R²) are '
        + 'confounded with depth on synthetic fixtures and are not used',
};

/**
 * Where the maximum-likelihood optimum sits, against the declaration above.
 *
 * `sigmaRScale` is a multiplier ON the shipping σ_R — the one this file's
 * SIGMA_R_GAIN has already been applied to — and not a value SIGMA_R_GAIN could
 * be set to: that constant scales the matte term BEFORE the quantisation floor
 * and the quadrature with the regularisation shift, and this scales the total
 * after both. So 1.70 says the shipped predictive is too narrow by about that
 * factor on this fixture population, and says nothing about which term is short.
 *
 * Re-derived by tools/test/atlas/uncertainty.mjs on every run, like everything else here.
 */
export const FITTED_OPTIMUM = {
  sigmaRScale: 1.700,
  tauLogSd: 0.389,
  nu: 3.20,
  heldOutCoverage: [0.626, 0.933],
  nll: 3.0249,
};

// Boundary localisation, as a multiple of what the matte's own noise implies.
// DECLARED at 1: once the regularisation shift is carried as its own term there
// is nothing left for a gain on the matte's noise to stand for, and a fit with
// nowhere else to put its residual invents one. It is not what the likelihood
// wants — see FITTED_OPTIMUM, which measures how far off 1 that residual is and
// in what units.
export const SIGMA_R_GAIN = 1.0;

// A rasterised boundary cannot be localised better than the pixel it falls in.
// With no sub-pixel information at all the offset is uniform over ±½px, whose
// standard deviation is 1/√12 — so that is the floor, including for a PNG whose
// alpha channel is exact, because the mask is still regularised (opened to two
// cells) before the transform runs.
export const SIGMA_R_FLOOR = Math.sqrt(1 / 12);

// ...and a ceiling. A boundary uncertain by more than a pixel is not a noisy
// boundary, it is a wrong one — a subject sharing a value with a textured
// background — and that is a segmentation failure the notes already raise rather
// than something to express as a smooth variance.
export const SIGMA_R_CEIL = 1.5;

// The anisotropy prior's spread, as a lognormal log-standard-deviation on the τ
// actually applied. DECLARED, not measured: see the header. At 0.30 the true
// anisotropy is within ×1.35 of the prior about two thirds of the time and
// within ×1.81 about 95% of the time.
export const TAU_LOG_SD = 0.30;

// The measured swing in the part-scale reference. buildVolume decides how
// trunk-like a location is by comparing P against the subject's own 98th
// percentile, which is global: measured on a fixed 20px bar joined by a disk of
// growing radius, the bar's half-thickness moves from 0.72·A to 1.01·A as the
// disk passes ~35px. That is 39%, it is a property of the reference and not of
// the bar, and it propagates through the same smoothstep.
//
// IT IS A SWING IN THE WRONG COORDINATE, AND THAT IS RECORDED RATHER THAN
// QUIETLY CORRECTED. `sigmaGrid` uses this number as δu∕u, a relative error on
// the RAMP COORDINATE u = P∕pref, and propagates it first-order through the
// ramp: |∂τ∕∂u|·u·P_REF_SWING. But 0.39 is the swing in τ, the ramp's OUTPUT —
// tools/test/atlas/uncertainty.mjs reproduces that sweep and reads 0.380 on τ and 5.132 on
// u. Those are the same experiment measured on opposite sides of the smoothstep,
// and they differ by a factor of thirteen.
//
// The correction is NOT to write 5.132 here. τ is bounded by [tauLimb, tauTrunk],
// so a first-order propagation of a perturbation that large returns a dτ several
// times the whole range of the quantity it is a spread on — the linearisation is
// what breaks first, before the constant is even reached. What that needs is a
// term derived for a bounded ramp under a large input perturbation, refitted and
// re-scored on the held-out split, which is a phase and not an edit. Until then
// the number stays as it is, measured, named, and known to be measured in the
// wrong space. P_REF_BASIS below carries both readings so neither can be quoted
// without the other.
export const P_REF_SWING = 0.39;

/**
 * The two readings of the same sweep, in the two coordinates, re-derived by
 * tools/test/atlas/uncertainty.mjs on every run. Both are ratio swings (max∕min − 1) over a
 * disk of radius 0–60px joined to a fixed 20px bar, read at a point on the bar.
 *
 * `tau` is what P_REF_SWING is: the reference moving under the bar drags the
 * bar's own half-thickness across most of the trunk-to-limb range.
 * `ramp` is what P_REF_SWING is USED as.
 */
export const P_REF_BASIS = { tau: 0.380, ramp: 5.132, applied: 'ramp' };

// The profile's row-attribution error, as a relative error on the row's depth.
// A profile silhouette reports how deep the DEEPEST part of each row is and
// cannot say which part that is, so the row is rescaled and the depth is
// attributed to the widest part. README's *Known limitations* measures the
// consequence on the test solid: median 5–8%, 90th percentile 60–70%. These two
// endpoints are those, and `rowAmbiguity` below is what interpolates between
// them per row.
export const ROW_ERR_LO = 0.065;
export const ROW_ERR_HI = 0.65;

/* ----------------------------------------------------- Student-t, by hand */
// No dependency is available and none is wanted, so the three functions the
// predictive needs are written out. What makes that safe is that all three can
// be checked against CLOSED FORMS rather than against remembered tables:
//
//   ν = 1 (Cauchy):  F(x) = ½ + atan(x)∕π
//   ν = 2:           F(x) = ½ + x ∕ (2·√(2 + x²))
//   ν → ∞:           F(x) → Φ(x)
//
// and lgamma against lgamma(½) = ½·log π, lgamma(1) = lgamma(2) = 0,
// lgamma(5) = log 24. tools/test/atlas/uncertainty.mjs checks every one of those, which is
// a stronger guarantee than a table copied out of a book: two of them are exact
// at every x, not at a handful of tabulated points.

// Lanczos, g = 7, n = 9. Accurate to ~1e-13 over the range this uses.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lgamma(x) {
  if (x < 0.5) {
    // reflection, so the series is only ever evaluated where it converges well
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta, by the modified Lentz method.
function betacf(a, b, x) {
  const TINY = 1e-300, EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betainc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lb = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lb);
  // The fraction converges fast only on one side of the symmetry point, so the
  // other side is reached through I_x(a,b) = 1 − I_{1−x}(b,a).
  return x < (a + 1) / (a + b + 2)
    ? front * betacf(a, b, x) / a
    : 1 - Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + b * Math.log(1 - x) + a * Math.log(x))
          * betacf(b, a, 1 - x) / b;
}

/** log density of the standard Student-t with ν degrees of freedom. */
export function tLogPdf(x, nu) {
  return lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI)
       - ((nu + 1) / 2) * Math.log1p(x * x / nu);
}

/** CDF of the standard Student-t. */
export function tCdf(x, nu) {
  if (!isFinite(x)) return x > 0 ? 1 : 0;
  const p = 0.5 * betainc(nu / 2, 0.5, nu / (nu + x * x));
  return x > 0 ? 1 - p : p;
}

/**
 * Quantile of the standard Student-t, by bisection on its own CDF.
 *
 * Bisection rather than a series because the series for a t quantile is only
 * accurate over part of the (p, ν) plane and this is called a few dozen times
 * per run — the CDF above is exact to ~1e-14, and 200 halvings of a bracket take
 * it as far as double precision goes. Correctness here is worth more than speed:
 * this number IS the interval the product quotes.
 */
export function tQuantile(p, nu) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  let lo = -1, hi = 1;
  while (tCdf(lo, nu) > p) lo *= 2;
  while (tCdf(hi, nu) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (tCdf(m, nu) < p) lo = m; else hi = m;
    if (hi - lo < 1e-13 * Math.max(1, Math.abs(hi))) break;
  }
  return (lo + hi) / 2;
}

/**
 * How many scales wide the predictive interval at `level` is, either side.
 *
 * This is the number the export has to quote, and it is the reason nothing may
 * say "±1σ": under a t those multiples are not those levels. The values at the
 * shipped ν, and a Gaussian's beside them, are in INTERVAL_K — written down there
 * as data rather than here as a sentence, because the sentence that used to be
 * here quoted a ν this file does not use and multipliers that ν does not give.
 */
export function intervalK(level, nu = NU) { return tQuantile((1 + level) / 2, nu); }

/**
 * What `intervalK` returns at NU, and what a Gaussian would return, aligned with
 * LEVELS. Re-derived by tools/test/atlas/uncertainty.mjs against the functions above.
 *
 * WHY THIS IS DATA. It was prose, and the prose said "at ν = 2.6 the 68% interval
 * is 1.12 scales and the 95% interval is 3.42". Three things were wrong with one
 * sentence: ν is 3.20 and not 2.6, the multipliers at 3.20 are 1.1749 and 3.0728,
 * and 1.12 and 3.42 are not the multipliers at 2.6 either — those are 1.2247 and
 * 3.4782. A number in a comment is unfalsifiable until something re-runs it, and
 * this is the one place in the file where being out by 11% on the 95% interval's
 * width would misstate the product's headline claim.
 */
export const INTERVAL_K = {
  levels: LEVELS,
  t: [1.1749, 3.0728],
  gaussian: [0.9945, 1.9600],
};

// ψ(x), by the standard asymptotic series after recurring up out of the range
// where it is poor. Checked against ψ(1) = −γ and ψ(½) = −γ − 2·log 2.
export function digamma(x) {
  let r = 0;
  while (x < 6) { r -= 1 / x; x += 1; }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x
       + f * (-1/12 + f * (1/120 + f * (-1/252 + f * (1/240 + f * (-1/132 + f * (691/32760))))));
}

/**
 * Differential entropy of the standard Student-t.
 *
 * This is the irreducible term of the Gneiting decomposition — what a PERFECTLY
 * calibrated t predictive scores, the way ½(1 + log 2π) is for a Gaussian — so
 * without it the calibration and sharpness terms have no zero to be measured
 * from. Closed form, from E[log(1 + Z²/ν)] = ψ((ν+1)/2) − ψ(ν/2).
 */
export function tEntropy(nu) {
  const C = lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI);
  return -C + ((nu + 1) / 2) * (digamma((nu + 1) / 2) - digamma(nu / 2));
}

/* ------------------------------------------------------------------ pieces */

const ss = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// d/dx of the same smoothstep. Zero outside the ramp, which is what makes the
// reference-swing term vanish on a part that is unambiguously trunk or limb.
const dss = (e0, e1, x) => {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0 || t >= 1) return 0;
  return 6 * t * (1 - t) / (e1 - e0);
};

/**
 * σ_R — how well the silhouette's own position is known, in pixels.
 *
 * The chain is the segmentation's, run backwards. `segment` builds the matte as
 * a smoothstep of the colour distance between 0.35·thr and 1.65·thr, so
 *
 *     dα/dd = ss'(t) / (1.30·thr),   ss'(½) = 3/2 at the crossing
 *
 * and `subpixelSignedDistance` reads the boundary off that matte as
 * (α − ½)∕|∇α|, so a perturbation δα moves it by δα∕|∇α|. The perturbation
 * itself is the background's own spread: `backgroundModel` reports the MAD of
 * the border pixels' colour distance, and 1.4826·MAD is the Gaussian-equivalent
 * standard deviation.
 *
 * Two things about that last step are approximations and are worth naming rather
 * than burying. The colour distance is a norm of a three-vector difference, so
 * it is chi-distributed rather than Gaussian and 1.4826 is the wrong constant for
 * it by some amount; and the MAD is measured on the BACKGROUND, while the
 * relevant noise is at the boundary, where the subject's own texture also
 * contributes. Both are why there is a fitted gain.
 *
 * @returns {{sigmaR:number, grad:number, sigmaAlpha:number, n:number, floored:boolean}}
 */
export function boundarySigma(seg, w, h, blurredAlpha) {
  const { mask, thr, bgMad } = seg;
  const N = w * h;
  const a = blurredAlpha;

  const sigD = 1.4826 * Math.max(0, bgMad || 0);
  const sigmaAlpha = 1.5 * sigD / Math.max(1e-6, 1.30 * thr);

  // |∇α| at boundary pixels, measured exactly as subpixelSignedDistance does, so
  // σ is divided by the same gradient the offset was divided by.
  const grads = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mask[i];
    if (mask[i-1] === m && mask[i+1] === m && mask[i-w] === m && mask[i+w] === m) continue;
    const gx = (a[i+1] - a[i-1]) * 0.5, gy = (a[i+w] - a[i-w]) * 0.5;
    const g = Math.hypot(gx, gy);
    if (g > 1e-4) grads.push(g);
  }
  grads.sort((p, q) => p - q);
  const grad = grads.length ? grads[grads.length >> 1] : 1;

  const raw = SIGMA_R_GAIN * sigmaAlpha / Math.max(1e-4, grad);
  const matte = Math.min(SIGMA_R_CEIL, Math.max(SIGMA_R_FLOOR, raw));

  // ...and the silhouette the pipeline actually used is not the one the matte
  // localised. `segment` blurs the committed mask at radius 2, re-thresholds and
  // opens to two cells, and it measures how far that moved the boundary. On the
  // analytic fixtures the matte term sits at its 1∕√12 quantisation floor while
  // the regularisation moves the silhouette by around a pixel, so leaving it out
  // is not a rounding decision — it is most of the boundary's real uncertainty,
  // and a fit with nowhere else to put it has to invent a gain on the matte's
  // noise instead. Added in quadrature: they are independent, one being sensor
  // noise and the other a morphological operation.
  const reg = Math.max(0, seg.regShift || 0);
  const sigmaR = Math.hypot(matte, reg);
  return { sigmaR, matte, reg, grad, sigmaAlpha, n: grads.length,
           floored: raw < SIGMA_R_FLOOR, ceiled: raw > SIGMA_R_CEIL };
}

/**
 * Per-row ambiguity of the profile's depth attribution, in [0, 1].
 *
 * 0 where the row is a single span — the deepest part is then almost certainly
 * also the widest, and the rescale attributes the depth correctly. Toward 1 as
 * the row's thickness spreads across spans the profile cannot tell apart: a
 * torso with two arms beside it is the case the limitation is written about.
 * Weighted by A rather than by pixel count, because it is thickness the profile
 * is attributing, not width.
 */
export function rowAmbiguity(mask, A, w, h) {
  const amb = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let total = 0, best = 0, run = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && mask[row + x];
      if (on) { run += A[row + x]; total += A[row + x]; }
      else { if (run > best) best = run; run = 0; }
    }
    amb[y] = total > 1e-6 ? 1 - best / total : 0;
  }
  return amb;
}

/**
 * The σ field, per sheet, on the working grid.
 *
 * Two sheets and not one: once a profile view has rescaled a row the front and
 * back surfaces sit at different distances from z = 0, so the anisotropy each
 * one was built with — and therefore its Jacobian — differ. With one photograph
 * `Zf = −Zb` and the two grids come out identical, which is the check that the
 * generalisation costs the single-view path nothing.
 *
 * @param {object} v  the volume: {mask, A, R, G, Zf, Zb, P, w, h, stats}
 * @param {object} o  {sigmaR, profileK, tauLogSd}  profileK is the per-row scale
 *                    applyProfile returned, or null; where it is non-zero the
 *                    row's depth was MEASURED and the τ prior does not apply to
 *                    it. `tauLogSd` overrides the declared prior spread and
 *                    exists so the calibration suite can sweep it against ground
 *                    truth through this function rather than around it.
 */
export function sigmaGrid(v, o) {
  const { mask, A, R, G, Zf, Zb, P, w, h } = v;
  const N = w * h;
  const tt = v.stats.tauTrunk, tl = v.stats.tauLimb, pref = v.stats.pref || 1;
  const sigmaR = o.sigmaR;
  const tauSd = o.tauLogSd === undefined ? TAU_LOG_SD : o.tauLogSd;
  const profileK = o.profileK || null;
  const amb = profileK ? rowAmbiguity(mask, A, w, h) : null;

  const front = new Float32Array(N), back = new Float32Array(N);
  const dtauF = new Float32Array(N);
  const bndF = new Float32Array(N), tauF = new Float32Array(N), rowF = new Float32Array(N);
  // The SHARED FRACTION: how much of this pixel's variance comes from the source
  // that is one scalar for the whole subject rather than independent noise per
  // vertex. The anisotropy prior is shared — a subject is deeper than assumed
  // everywhere at once — and so is the profile's row attribution; the boundary's
  // localisation is not, its sign turning over around the silhouette, and neither
  // is the mesh displacement. That distinction is what decides how heavy the
  // predictive's tail should be HERE, so it is carried per pixel rather than
  // being a property of the whole field. See the mix note in sigmaMix.
  const wFront = new Float32Array(N), wBack = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const a = A[i], g = G[i], r = R[i];
    const y = (i - i % w) / w;
    const measured = profileK ? profileK[y] > 0 : false;

    // The reference-swing term is a property of the pixel, not of the sheet: it
    // is the ramp's own sensitivity to a reference that moves under it.
    const u = P[i] / pref;
    const swing = Math.abs(tt - tl) * dss(0.45, 0.95, u) * u * P_REF_SWING;
    const eRow = measured ? ROW_ERR_LO + (ROW_ERR_HI - ROW_ERR_LO) * amb[y] : 0;

    for (let s = 0; s < 2; s++) {
      // The anisotropy this sheet was actually built with, read off the sheet
      // rather than recomputed: it already carries whatever a profile did to the
      // row, so the Jacobian is the one the surface really has.
      const z = s ? -Zb[i] : Zf[i];
      const t = a > 1e-6 ? z / a : tt;
      const den = Math.sqrt(a * a + t * t * g * g);
      if (!(den > 1e-9)) continue;

      // (a) the boundary, propagated in R and transformed back here
      const sb = t * r * sigmaR / den;
      // (b) the anisotropy prior — lognormal on the τ actually applied, plus the
      //     reference swing through the ramp. Dropped where a profile MEASURED
      //     the row's depth: there the prior is not what put the surface where
      //     it is, and (c) takes over.
      const dtau = measured ? 0 : Math.hypot(Math.abs(t) * tauSd, swing);
      const st = a * a * dtau / den;
      // (c) the profile's row attribution, as a relative error on the depth
      const sr = a * a * Math.abs(t) * eRow / den;

      const shared = st * st + sr * sr;
      const tot2 = sb * sb + shared;
      const tot = Math.sqrt(tot2);
      const w = tot2 > 1e-12 ? shared / tot2 : 0;
      if (s) { back[i] = tot; wBack[i] = w; }
      else { front[i] = tot; wFront[i] = w;
             bndF[i] = sb; tauF[i] = st; rowF[i] = sr; dtauF[i] = dtau; }
    }
  }
  return { front, back, wFront, wBack, bnd: bndF, tau: tauF, row: rowF, dtau: dtauF };
}

/**
 * The ±kσ envelope: the surface displaced along its own normals.
 *
 * Pure, and separate from the viewer, because it is the one place σ's UNITS get
 * used. σ is in working-grid pixels and the vertices are in model space, so the
 * offset is σ·pxToModel·k and getting that conversion wrong produces a shell
 * that looks plausible at every scale and means nothing at any of them. A test
 * can check this; a shell built inside a WebGL context cannot be.
 *
 * @param {Float32Array} base    vertex positions, model space
 * @param {Float32Array} dir     unit vertex normals
 * @param {Float32Array} sigma   per-vertex σ, in working-grid pixels
 * @param {number} k             multiples of σ; negative gives the inner shell
 * @param {number} pxToModel     model units per working-grid pixel
 * @param {Float32Array} [out]   written in place when given
 */
export function offsetShell(base, dir, sigma, k, pxToModel, out) {
  const o = out || new Float32Array(base.length);
  const s = k * pxToModel;
  for (let i = 0, v = 0; i < base.length; i += 3, v++) {
    const d = sigma[v] * s;
    o[i] = base[i] + dir[i] * d;
    o[i+1] = base[i+1] + dir[i+1] * d;
    o[i+2] = base[i+2] + dir[i+2] * d;
  }
  return o;
}

/**
 * A summary of a finished σ field, for the panel and the certificate.
 * Area-weighted would be better and is not available here — the caller has the
 * mesh and this has the vertices — so it says which it is.
 */
export function sigmaSummary(sigma) {
  const v = Array.from(sigma).filter((x) => isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: 0, p50: 0, p90: 0, max: 0, mean: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))];
  let s = 0; for (const x of v) s += x;
  return { n: v.length, min: v[0], p50: q(0.5), p90: q(0.9), max: v[v.length - 1], mean: s / v.length };
}
