/* register — a reconstruction against independent truth.
 *
 * WHAT THIS IS. `docs/physical-validation-scope.md` §6.3 lists four objects this
 * repository does not have. Three of them are pure geometry and need no camera,
 * and this is those three: a similarity-only mesh-to-mesh registration with a
 * MEASURED error floor (§3), the band-aware residual (§1.3), and the truth-band
 * gate (§4.0). The fourth — capture logging and ingest — needs a person holding
 * an object, and is not here.
 *
 * `docs/registration-algorithm.md` is the algorithm: the pseudocode, the
 * invariant each procedure is argued from, the complexity with the operation it
 * counts named, and every degenerate input with a stated behaviour. This file
 * implements that document and does not deviate from it; §9 of that document
 * records the two places the implementation found it wrong, with both values.
 *
 * WHAT THIS DOES NOT DO. It calibrates nothing. No photograph is involved, no
 * held-out object exists, and `SIGMA_CALIBRATED` and `GREEDY_SET_DOMINANCE` are
 * not touched by it. This is the apparatus §4.1 and §4.3 of the scope document
 * would be measured WITH, built and tested against meshes whose geometry is
 * known in closed form. The phase that uses it still needs someone to stand in
 * front of a real object with a camera.
 *
 * SEVEN DEGREES OF FREEDOM, NOT MORE. Scale, rotation, translation. A fit
 * allowed to deform will deform to hide a real mismatch, which is the same
 * discipline the back-view registration already follows in `atlas-core.js`.
 * Scale is FITTED and never assumed: a single orthographic photograph carries no
 * absolute scale, so pinning scale from the truth would leak the truth into the
 * quantity under test (§3.2).
 *
 * NOTHING HERE LEAVES THE MACHINE, and nothing here is random in the sense that
 * matters. There is no network, no filesystem, no clock and no `Math.random`.
 * §3.3's trials need randomness, so this carries its own seeded generator and
 * REPORTS THE SEED: the run is reproducible from it and from nothing else. That
 * generator is `mulberry32` and it is NOT cryptographic — `certificate.js` uses
 * WebCrypto for the things that need to be, and the two must never be confused.
 *
 * ONE NAMING NOTE THAT MATTERS. The ICP step's log-scale increment is written
 * `gamma`, never `sigma`. σ in this repository is the per-vertex uncertainty
 * field, and a formula where the two could be read for each other is a formula
 * waiting to be misread.
 */

/* ------------------------------------------------------------- the dials */

export const REGISTER = {
  /** ICP iteration cap. Every probe counts, accepted or rejected. */
  maxIterations: 60,
  /** Relative rmse decrease below which an accepted step counts as no progress. */
  tolRel: 1e-5,
  /** Consecutive no-progress accepted steps before `stoppedBy: 'tolerance'`. */
  patience: 2,
  /** Fraction of correspondences kept, closest first. Affects the STEP only. */
  trimFraction: 0.9,
  /** Correspondences whose normals disagree by more than this are dropped. */
  maxNormalDeg: 60,
  /** 'plane' — linearised point-to-plane. 'point' — the closed form of §2.0. */
  solver: 'plane',
  /** Levenberg damping: start, floor, and the factor a reject multiplies by. */
  lambda0: 1e-4,
  lambdaMin: 1e-9,
  lambdaGrow: 10,
  /** Consecutive rejections before `stoppedBy: 'damping'`. */
  maxReject: 8,
  /** Triangles per BVH leaf. */
  bvhLeaf: 8,
  /** Source vertices scored per coarse candidate, taken at a fixed stride. */
  coarseSamples: 512,
  /** Relative eigenvalue gap below which a principal frame is called ambiguous. */
  axisGap: 1e-3,
  /** Cyclic Jacobi: sweep cap and the off-diagonal tolerance. */
  jacobiSweeps: 24,
  jacobiEps: 1e-14,
  /** §4.0's gate, frozen as a judgement by §8 of the scope document. */
  gateRatio: 1 / 3,
  /** Default normal-ray reach, as a fraction of the truth's bounding diagonal. */
  reachFraction: 0.25,
  /** §3.3 route 1 and route 2 sizes. 20 perturbations is the scope's target. */
  trials: 12,
  perturbations: 20,
  /** Route 1's draws: log-uniform scale, translation as a fraction of diagonal. */
  logScaleRange: Math.log(1.5),
  translateFraction: 0.25,
  /** Route 2's perturbation of the coarse initialisation. */
  perturbAngle: 0.15,
  perturbLogScale: 0.10,
  perturbTranslate: 0.05,
  /** The default PRNG seed. Always reported; never a hidden default. */
  seed: 0x9e3779b9,
};

const TINY = 1e-300;

/* ------------------------------------------------- small linear algebra */

/** Row-major 3×3 times a vector, into `out`. */
function mat3Apply(R, x, y, z, out) {
  out[0] = R[0] * x + R[1] * y + R[2] * z;
  out[1] = R[3] * x + R[4] * y + R[5] * z;
  out[2] = R[6] * x + R[7] * y + R[8] * z;
  return out;
}

/** Row-major 3×3 product `A·B`. */
function mat3Mul(A, B) {
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return C;
}

function mat3Det(R) {
  return R[0] * (R[4] * R[8] - R[5] * R[7])
       - R[1] * (R[3] * R[8] - R[5] * R[6])
       + R[2] * (R[3] * R[7] - R[4] * R[6]);
}

/**
 * Gram–Schmidt back onto SO(3).
 *
 * Composing sixty incremental rotations drifts off the manifold by a few ulp per
 * step, and the postcondition in `docs/registration-algorithm.md` §6.2 promises
 * orthonormality to 1e-6. Cheaper to enforce it every iteration than to argue
 * about how much drift is allowed.
 */
function orthonormalize(R) {
  const O = new Float64Array(9);
  let n0 = Math.hypot(R[0], R[3], R[6]);
  if (!(n0 > 0)) return null;
  O[0] = R[0] / n0; O[3] = R[3] / n0; O[6] = R[6] / n0;
  let d = O[0] * R[1] + O[3] * R[4] + O[6] * R[7];
  let c1 = [R[1] - d * O[0], R[4] - d * O[3], R[7] - d * O[6]];
  const n1 = Math.hypot(c1[0], c1[1], c1[2]);
  if (!(n1 > 0)) return null;
  O[1] = c1[0] / n1; O[4] = c1[1] / n1; O[7] = c1[2] / n1;
  // third column = first × second, which fixes the determinant at +1 by construction
  O[2] = O[3] * O[7] - O[6] * O[4];
  O[5] = O[6] * O[1] - O[0] * O[7];
  O[8] = O[0] * O[4] - O[3] * O[1];
  return O;
}

/** Unit quaternion (w, x, y, z) to a row-major 3×3 rotation. */
export function rotationFromQuaternion(w, x, y, z) {
  const n = Math.hypot(w, x, y, z);
  if (!(n > 0)) return null;
  w /= n; x /= n; y /= n; z /= n;
  return Float64Array.of(
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y),
    2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y),
  );
}

/** Rodrigues: an axis-angle vector to an EXACT rotation, series near zero. */
function rotationFromAxisAngle(wx, wy, wz) {
  const th = Math.hypot(wx, wy, wz);
  // sin θ/θ and (1 − cos θ)/θ² by series below the crossover, so θ = 0 is not a
  // special case bolted on afterwards but the limit the series already gives.
  const a = th < 1e-8 ? 1 - th * th / 6 : Math.sin(th) / th;
  const b = th < 1e-8 ? 0.5 - th * th / 24 : (1 - Math.cos(th)) / (th * th);
  return Float64Array.of(
    1 + b * (-wy * wy - wz * wz), -a * wz + b * wx * wy,        a * wy + b * wx * wz,
    a * wz + b * wx * wy,         1 + b * (-wx * wx - wz * wz), -a * wx + b * wy * wz,
    -a * wy + b * wx * wz,        a * wx + b * wy * wz,         1 + b * (-wx * wx - wy * wy),
  );
}

/**
 * Eigenvalues and eigenvectors of a symmetric n×n by cyclic Jacobi, descending.
 *
 * `n` is 3 (the surface moment) and 4 (the quaternion matrix) and nothing else,
 * so both uses share one routine and there is one place to be wrong rather than
 * two. Returns `vectors` row-major: eigenvector j is column j.
 */
export function jacobiEigenSym(A, n, sweeps = REGISTER.jacobiSweeps, eps = REGISTER.jacobiEps) {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0, diag = 0;
    for (let p = 0; p < n; p++) {
      diag += a[p * n + p] * a[p * n + p];
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off <= eps * eps * Math.max(diag, TINY)) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) <= TINY) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const kp = a[k * n + p], kq = a[k * n + q];
        a[k * n + p] = c * kp - s * kq; a[k * n + q] = s * kp + c * kq;
      }
      for (let k = 0; k < n; k++) {
        const pk = a[p * n + k], qk = a[q * n + k];
        a[p * n + k] = c * pk - s * qk; a[q * n + k] = s * pk + c * qk;
      }
      for (let k = 0; k < n; k++) {
        const kp = v[k * n + p], kq = v[k * n + q];
        v[k * n + p] = c * kp - s * kq; v[k * n + q] = s * kp + c * kq;
      }
    }
  }

  // Descending, ties broken by original column index so the order is a function
  // of the input alone — two runs on the same matrix pick the same frame.
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => (a[j * n + j] - a[i * n + i]) || (i - j));
  const values = new Float64Array(n), vectors = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    values[j] = a[order[j] * n + order[j]];
    for (let i = 0; i < n; i++) vectors[i * n + j] = v[i * n + order[j]];
  }
  return { values, vectors };
}

/** Cholesky solve of `(A + λ·diag(A)) z = b`, in place on a copy. Null if not PD. */
function choleskySolve(A, b, n, lambda) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) L[i * n + j] = A[i * n + j];
  for (let i = 0; i < n; i++) L[i * n + i] += lambda * A[i * n + i];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = L[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;           // not positive definite: rank-deficient
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
    for (let j = i + 1; j < n; j++) L[i * n + j] = 0;
  }
  const y = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * z[k];
    z[i] = s / L[i * n + i];
  }
  return z.every(Number.isFinite) ? z : null;
}

/* --------------------------------------------------- the similarity itself */

/** A similarity as this module passes it around. `x ↦ scale·rotation·x + translation`. */
function similarity(scale, rotation, translation) {
  return { scale, rotation, translation };
}

/** Apply a similarity to a point, into `out`. */
function applySim(T, x, y, z, out) {
  mat3Apply(T.rotation, x, y, z, out);
  out[0] = T.scale * out[0] + T.translation[0];
  out[1] = T.scale * out[1] + T.translation[1];
  out[2] = T.scale * out[2] + T.translation[2];
  return out;
}

/** `outer ∘ inner`, the similarity that applies `inner` first. */
function composeSim(outer, inner) {
  const R = orthonormalize(mat3Mul(outer.rotation, inner.rotation));
  if (!R) return null;
  const t = new Float64Array(3);
  mat3Apply(outer.rotation, inner.translation[0], inner.translation[1], inner.translation[2], t);
  return similarity(outer.scale * inner.scale, R, Float64Array.of(
    outer.scale * t[0] + outer.translation[0],
    outer.scale * t[1] + outer.translation[1],
    outer.scale * t[2] + outer.translation[2],
  ));
}

/** The identity similarity, fresh each call so a caller may not alias one. */
export function identitySimilarity() {
  return similarity(1, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), new Float64Array(3));
}

/** A plain-object copy, for a caller that wants to store or compare one. */
function reportSim(T) {
  return { scale: T.scale, rotation: Array.from(T.rotation), translation: Array.from(T.translation) };
}

/**
 * The closed-form least-squares similarity from point correspondences —
 * `docs/registration-algorithm.md` §2.0, argued in its §3.1.
 *
 * WHY A QUATERNION AND NOT AN SVD. A unit quaternion parameterises SO(3) and
 * nothing else, so a REFLECTION CANNOT BE RETURNED and the determinant-sign
 * correction an SVD needs never arises. A target that is a mirror of the source
 * comes back as the best PROPER rotation, which is the answer wanted: a mirrored
 * reconstruction is a real defect and absorbing it into the fit would hide
 * exactly what a registration is meant to expose.
 *
 * HOW A REFLECTION ACTUALLY SHOWS, which is not what §5 of the algorithm
 * document first said. It said a mirrored target drives `scale` negative and is
 * rejected on that. It does not: over 400 point sets mirrored in one plane, zero
 * produced `scale ≤ 0` (§9 of that document records the correction). What a
 * reflection produces is a fit that does not fit — on a generic 8-point set,
 * residual rms 0.62 against data of rms 0.93. So the detector is `rmse`, which
 * is returned for that purpose, and the `scale > 0` guard is kept for what it
 * genuinely catches: a configuration where the best proper rotation anti-aligns
 * with the target, which is not a similarity and must not be returned as one.
 *
 * `scale` divides the SOURCE variance because the map is source → target:
 * doubling the source's spread must halve it.
 */
export function similarityFromPairs(P, Q, W = null) {
  const n = P.length / 3;
  if (n < 3 || Q.length !== P.length) return { ok: false, reason: 'need at least 3 pairs' };

  let omega = 0;
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    if (!(w >= 0) || !Number.isFinite(w)) return { ok: false, reason: 'non-finite input' };
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(P[i * 3 + k]) || !Number.isFinite(Q[i * 3 + k])) {
        return { ok: false, reason: 'non-finite input' };
      }
    }
    omega += w;
  }
  if (!(omega > 0)) return { ok: false, reason: 'weights sum to zero' };

  const mp = new Float64Array(3), mq = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    for (let k = 0; k < 3; k++) { mp[k] += w * P[i * 3 + k]; mq[k] += w * Q[i * 3 + k]; }
  }
  for (let k = 0; k < 3; k++) { mp[k] /= omega; mq[k] /= omega; }

  // K = Σ wᵢ p'ᵢ q'ᵢᵀ / Ω, so that Σ wᵢ⟨q'ᵢ, R p'ᵢ⟩ / Ω = trace(R·K).
  let varP = 0;
  const K = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    const px = P[i * 3] - mp[0], py = P[i * 3 + 1] - mp[1], pz = P[i * 3 + 2] - mp[2];
    const qx = Q[i * 3] - mq[0], qy = Q[i * 3 + 1] - mq[1], qz = Q[i * 3 + 2] - mq[2];
    varP += w * (px * px + py * py + pz * pz);
    K[0] += w * px * qx; K[1] += w * px * qy; K[2] += w * px * qz;
    K[3] += w * py * qx; K[4] += w * py * qy; K[5] += w * py * qz;
    K[6] += w * pz * qx; K[7] += w * pz * qy; K[8] += w * pz * qz;
  }
  varP /= omega;
  for (let k = 0; k < 9; k++) K[k] /= omega;
  if (!(varP > 0)) return { ok: false, reason: 'source has no extent' };

  // Horn 1987 §4.A: max over SO(3) of trace(R·K) is the largest eigenvalue of N.
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = K;
  const N = Float64Array.of(
    xx + yy + zz, yz - zy,      zx - xz,       xy - yx,
    yz - zy,      xx - yy - zz, xy + yx,       zx + xz,
    zx - xz,      xy + yx,      -xx + yy - zz, yz + zy,
    xy - yx,      zx + xz,      yz + zy,       -xx - yy + zz,
  );
  const { vectors } = jacobiEigenSym(N, 4);
  const R = rotationFromQuaternion(vectors[0], vectors[4], vectors[8], vectors[12]);
  if (!R) return { ok: false, reason: 'degenerate quaternion' };

  // s = trace(R·K) / varP — the exact minimiser in s for this R (§3.1).
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += R[i * 3 + j] * K[j * 3 + i];
  const scale = tr / varP;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { ok: false, reason: 'the best proper rotation anti-aligns; no positive-scale similarity fits' };
  }

  const rm = new Float64Array(3);
  mat3Apply(R, mp[0], mp[1], mp[2], rm);
  const T = similarity(scale, R, Float64Array.of(
    mq[0] - scale * rm[0], mq[1] - scale * rm[1], mq[2] - scale * rm[2]));

  // The fit's own residual, measured at the returned transform. This is what
  // tells a caller a reflection was handed in: the fit comes back valid and
  // WRONG, and only `rmse` says so.
  let err = 0;
  const ap = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const w = W ? W[i] : 1;
    applySim(T, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], ap);
    err += w * ((ap[0] - Q[i * 3]) ** 2 + (ap[1] - Q[i * 3 + 1]) ** 2 + (ap[2] - Q[i * 3 + 2]) ** 2);
  }
  const rmse = Math.sqrt(err / omega);

  // rank(K) from the eigenvalues of KᵀK: at rank ≤ 1 the maximiser is not unique.
  //
  // THE THRESHOLD IS 1e-7 AND IT CANNOT BE TIGHTER. Reading singular values off
  // the normal equations squares them, which halves the available digits: a
  // singular value that is exactly zero in exact arithmetic comes back at up to
  // about √ε ≈ 1.5e-8 of the largest one. Measured on a coplanar set whose third
  // singular value IS zero, this route returns 2.4e-9 relative — so a 1e-9 cut
  // calls a rank-2 configuration rank 3, which is the wrong answer about the very
  // thing the field exists to report. 1e-7 sits above that floor and far below
  // any structure a real mesh has.
  const KtK = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += K[k * 3 + i] * K[k * 3 + j];
    KtK[i * 3 + j] = s;
  }
  const sv = jacobiEigenSym(KtK, 3).values;
  const top = Math.sqrt(Math.max(sv[0], 0));
  let rank = 0;
  for (let i = 0; i < 3; i++) if (Math.sqrt(Math.max(sv[i], 0)) > 1e-7 * Math.max(top, TINY)) rank++;

  return { ok: true, transform: T, rmse, varP, rank, degenerate: rank <= 1 ? 'rank' : null };
}

/* ------------------------------------------------------- surface moments */

/**
 * The area-weighted centroid and covariance of a triangulated SURFACE, in closed
 * form — `docs/registration-algorithm.md` §2.2.
 *
 * AREA WEIGHTING IS NOT A REFINEMENT, IT IS THE CORRECTNESS CONDITION. An
 * unweighted vertex covariance is a property of the TESSELLATION, not of the
 * shape: a reconstruction carries one vertex per occupied grid cell and a truth
 * mesh carries whatever its author emitted, so their vertex clouds have
 * different densities over the same surface and their unweighted principal
 * frames differ for a reason that has nothing to do with geometry.
 *
 * The per-triangle covariance is exact rather than sampled. For a uniform
 * density on a triangle with centroid g, `Cov = (1/12)·Σ(vᵢ − g)(vᵢ − g)ᵀ`,
 * which follows from Var(αᵢ) = 1/18 and Cov(αᵢ,αⱼ) = −1/36 on the barycentric
 * simplex together with Σ(vᵢ − g) = 0.
 *
 * A mesh with no area has no surface moment. The unweighted fallback is taken
 * and RECORDED in `momentSource`, because taking it silently would be inventing
 * one.
 */
export function surfaceMoments(positions, indices) {
  const nV = positions.length / 3;
  if (nV < 3) return { ok: false, reason: 'need at least 3 vertices' };
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) return { ok: false, reason: 'non-finite input' };
  }

  const nT = indices ? indices.length / 3 : 0;
  let area = 0;
  const G = new Float64Array(3), C = new Float64Array(9);
  const gt = new Float64Array(3);

  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const At = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(At > 0)) continue;                                  // no area, no contribution
    area += At;
    for (let k = 0; k < 3; k++) G[k] += At * (positions[a + k] + positions[b + k] + positions[c + k]) / 3;
  }

  if (!(area > 0)) {
    // No surface. Fall back to the vertex cloud and say so.
    const g = new Float64Array(3);
    for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) g[k] += positions[i * 3 + k];
    for (let k = 0; k < 3; k++) g[k] /= nV;
    for (let i = 0; i < nV; i++) {
      const d = [positions[i * 3] - g[0], positions[i * 3 + 1] - g[1], positions[i * 3 + 2] - g[2]];
      for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) C[p * 3 + q] += d[p] * d[q];
    }
    for (let k = 0; k < 9; k++) C[k] /= nV;
    return { ok: true, area: 0, centroid: g, covariance: C, momentSource: 'vertices' };
  }

  for (let k = 0; k < 3; k++) G[k] /= area;
  for (let t = 0; t < nT; t++) {
    const idx = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
    const [a, b, c] = idx;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const At = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(At > 0)) continue;
    for (let k = 0; k < 3; k++) gt[k] = (positions[a + k] + positions[b + k] + positions[c + k]) / 3;
    for (const v of idx) {
      const dx = positions[v] - gt[0], dy = positions[v + 1] - gt[1], dz = positions[v + 2] - gt[2];
      const d = [dx, dy, dz];
      for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) C[p * 3 + q] += (At / 12) * d[p] * d[q];
    }
    const ex = gt[0] - G[0], ey = gt[1] - G[1], ez = gt[2] - G[2];
    const e = [ex, ey, ez];
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) C[p * 3 + q] += At * e[p] * e[q];
  }
  for (let k = 0; k < 9; k++) C[k] /= area;
  return { ok: true, area, centroid: G, covariance: C, momentSource: 'area' };
}

/* ------------------------------------------------------------------ BVH */

function pointTriangleDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  // Ericson, Real-Time Collision Detection §5.1.5 — the barycentric region test.
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz);
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              out[0] = ax + abx * v + acx * w;
              out[1] = ay + aby * v + acy * w;
              out[2] = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - out[0], dy = py - out[1], dz = pz - out[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * A median-split axis-aligned BVH over triangles.
 *
 * SPLITTING AT THE MEDIAN OF CENTROIDS, not at the spatial midpoint, is what
 * makes the depth ⌈log₂(m / bvhLeaf)⌉ unconditionally: a midpoint split can put
 * every triangle on one side and degenerate the tree to a list. The median is
 * taken by sorting the sub-range, which costs Θ(m log² m) over the build rather
 * than the Θ(m log m) a linear-time selection would give — see §9 of
 * `docs/registration-algorithm.md`, where that difference is recorded.
 */
export function bvhBuild(positions, indices, leafSize = REGISTER.bvhLeaf) {
  const m = indices ? indices.length / 3 : 0;
  if (m < 1) return { ok: false, reason: 'target has no triangles' };

  const order = new Int32Array(m);
  const cen = new Float64Array(m * 3);
  for (let t = 0; t < m; t++) {
    order[t] = t;
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (positions[a + k] + positions[b + k] + positions[c + k]) / 3;
  }

  const nodes = [];
  const boxOf = (lo, hi) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (const vi of [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]) {
        for (let k = 0; k < 3; k++) {
          const x = positions[vi * 3 + k];
          if (x < b[k]) b[k] = x;
          if (x > b[3 + k]) b[3 + k] = x;
        }
      }
    }
    return b;
  };

  // Recursion is safe here precisely because the split is by median: the depth is
  // ⌈log₂(m / leafSize)⌉, which is 17 for a million triangles. A midpoint split
  // could not make that promise, and would need an explicit stack.
  const build = (lo, hi) => {
    const id = nodes.length;
    const box = boxOf(lo, hi);
    nodes.push({ box, lo, hi, left: -1, right: -1 });
    if (hi - lo <= leafSize) return id;
    let axis = 0, span = -1;
    for (let k = 0; k < 3; k++) { const s = box[3 + k] - box[k]; if (s > span) { span = s; axis = k; } }
    const sub = Array.from(order.subarray(lo, hi));
    sub.sort((p, q) => (cen[p * 3 + axis] - cen[q * 3 + axis]) || (p - q));
    for (let i = 0; i < sub.length; i++) order[lo + i] = sub[i];
    const mid = lo + (hi - lo >> 1);
    if (mid === lo || mid === hi) return id;                  // cannot split further
    nodes[id].left = build(lo, mid);
    nodes[id].right = build(mid, hi);
    return id;
  };
  build(0, m);

  return { ok: true, positions, indices, order, nodes, count: m, leafSize };
}

function boxDist2(b, x, y, z) {
  const dx = x < b[0] ? b[0] - x : (x > b[3] ? x - b[3] : 0);
  const dy = y < b[1] ? b[1] - y : (y > b[4] ? y - b[4] : 0);
  const dz = z < b[2] ? b[2] - z : (z > b[5] ? z - b[5] : 0);
  return dx * dx + dy * dy + dz * dz;
}

function triNormal(P, I, t, out) {
  const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 0; }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return l > 0;
}

/**
 * The nearest point on the triangle soup.
 *
 * THE WORST CASE IS REAL AND IT IS NAMEABLE. The prune fires when a node's box
 * is further than the best distance found so far; it never fires when every leaf
 * box is at the same distance from the query point. The clean instance is a
 * SPHERE QUERIED FROM ITS OWN CENTRE — every triangle is equidistant, nothing
 * can be pruned, and the query visits the whole tree. `tools/test/atlas/solids.mjs`'s
 * `icosphere` is exactly that shape, so this is not hypothetical. Expected
 * Θ(log m) node tests, worst Θ(m).
 */
export function bvhClosest(bvh, x, y, z, out) {
  const { positions: P, indices: I, order, nodes } = bvh;
  let best = Infinity, bestTri = -1;
  const cand = new Float64Array(3);
  const stack = [0];
  while (stack.length) {
    const node = nodes[stack.pop()];
    if (boxDist2(node.box, x, y, z) >= best) continue;
    if (node.left < 0) {
      for (let i = node.lo; i < node.hi; i++) {
        const t = order[i];
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const d2 = pointTriangleDist2(x, y, z,
          P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], cand);
        // Ties break to the lower triangle index so the pick is a function of the
        // input alone — a tie resolved by traversal order would not be.
        if (d2 < best || (d2 === best && t < bestTri)) {
          best = d2; bestTri = t;
          out[0] = cand[0]; out[1] = cand[1]; out[2] = cand[2];
        }
      }
    } else {
      // Nearer child pushed LAST so it is popped first and tightens `best` early.
      const dl = boxDist2(nodes[node.left].box, x, y, z);
      const dr = boxDist2(nodes[node.right].box, x, y, z);
      if (dl < dr) { stack.push(node.right); stack.push(node.left); }
      else { stack.push(node.left); stack.push(node.right); }
    }
  }
  return bestTri < 0 ? { distance: Infinity, triangle: -1 } : { distance: Math.sqrt(best), triangle: bestTri };
}

/**
 * The intersection of smallest |t| along a line through `o` in direction `dir`,
 * searched BOTH ways and bounded by `reach`.
 *
 * The prune is the same box-distance test the nearest-point query uses, which is
 * valid here because an intersection at parameter t lies exactly |t| from `o`:
 * a box further than the best |t| found cannot hold a better one.
 */
export function bvhRay(bvh, ox, oy, oz, dx, dy, dz, reach) {
  const { positions: P, indices: I, order, nodes } = bvh;
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl > 0) || !(reach > 0)) return null;
  dx /= dl; dy /= dl; dz /= dl;
  let bestT = Infinity, bestTri = -1;
  const stack = [0];
  while (stack.length) {
    const node = nodes[stack.pop()];
    const lim = Math.min(reach, Math.abs(bestT));
    if (boxDist2(node.box, ox, oy, oz) > lim * lim) continue;
    if (node.left < 0) {
      for (let i = node.lo; i < node.hi; i++) {
        const t = order[i];
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        // Möller–Trumbore, signed t kept.
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-18) continue;                  // the ray is parallel
        const inv = 1 / det;
        const sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2];
        const u = inv * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = inv * (dx * qx + dy * qy + dz * qz);
        if (v < 0 || u + v > 1) continue;
        const tt = inv * (e2x * qx + e2y * qy + e2z * qz);
        if (Math.abs(tt) > reach) continue;
        if (Math.abs(tt) < Math.abs(bestT) || (Math.abs(tt) === Math.abs(bestT) && t < bestTri)) {
          bestT = tt; bestTri = t;
        }
      }
    } else { stack.push(node.left); stack.push(node.right); }
  }
  if (bestTri < 0) return null;
  const n = new Float64Array(3);
  triNormal(P, I, bestTri, n);
  return { t: bestT, triangle: bestTri, normal: n };
}

/* -------------------------------------------------------- vertex normals */

/** Area-weighted vertex normals. A vertex with no incident area gets a zero normal. */
export function vertexNormals(positions, indices) {
  const nV = positions.length / 3;
  const N = new Float64Array(nV * 3);
  const nT = indices ? indices.length / 3 : 0;
  for (let t = 0; t < nT; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    // The unnormalised cross product IS twice the area times the unit normal, so
    // accumulating it raw is the area weighting — no separate weight is needed.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const vi of [ia, ib, ic]) { N[vi * 3] += nx; N[vi * 3 + 1] += ny; N[vi * 3 + 2] += nz; }
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    if (l > 0) { N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
  }
  return N;
}

function boundingDiagonal(positions) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const x = positions[i + k];
    if (x < lo[k]) lo[k] = x;
    if (x > hi[k]) hi[k] = x;
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/* ------------------------------------------------------- coarse alignment */

/**
 * The initialisation, from principal axes — §2.3 of the algorithm document.
 *
 * Eight sign assignments exist; exactly four have determinant +1 and the other
 * four are reflections, which the whole module has already ruled inadmissible.
 * So four, always four, and ALL FOUR ARE SCORED — none is guessed.
 *
 * Everything needed to reproduce the run comes back, because §3.1 of the scope
 * document requires the initialisation to be recorded: the four scores, the
 * winning sign triple, both eigenvalue triples, both `momentSource` values and
 * the resulting similarity.
 *
 * WHAT IT GUARANTEES is the best of four explicitly enumerated candidates under
 * a measured score. NOT global optimality: the principal frames correspond only
 * if the two meshes are of the same object, and nothing downstream may read this
 * as a global fit.
 */
export function coarseAlign(src, dst, dstBvh = null, opts = {}) {
  const o = { ...REGISTER, ...opts };
  const Ms = surfaceMoments(src.positions, src.indices);
  const Md = surfaceMoments(dst.positions, dst.indices);
  if (!Ms.ok) return { ok: false, reason: `source moments: ${Ms.reason}` };
  if (!Md.ok) return { ok: false, reason: `target moments: ${Md.reason}` };

  const bvh = dstBvh || bvhBuild(dst.positions, dst.indices, o.bvhLeaf);
  if (!bvh.ok) return { ok: false, reason: bvh.reason };

  const Es = jacobiEigenSym(Ms.covariance, 3), Ed = jacobiEigenSym(Md.covariance, 3);
  // Fix each eigenvector's sign by its largest-magnitude component, so the frame
  // is a function of the covariance rather than of the Jacobi sweep order.
  const fix = (V) => {
    for (let j = 0; j < 3; j++) {
      let k = 0;
      for (let i = 1; i < 3; i++) if (Math.abs(V[i * 3 + j]) > Math.abs(V[k * 3 + j])) k = i;
      if (V[k * 3 + j] < 0) for (let i = 0; i < 3; i++) V[i * 3 + j] = -V[i * 3 + j];
    }
    return V;
  };
  fix(Es.vectors); fix(Ed.vectors);

  let trS = 0, trD = 0;
  for (let k = 0; k < 3; k++) { trS += Ms.covariance[k * 3 + k]; trD += Md.covariance[k * 3 + k]; }
  if (!(trS > 0) || !(trD > 0)) return { ok: false, reason: 'a mesh has no extent' };
  const s0 = Math.sqrt(trD / trS);

  const gap = (v) => {
    const d = Math.max(Math.abs(v[0]), TINY);
    return Math.min((v[0] - v[1]) / d, (v[1] - v[2]) / d);
  };

  const stride = Math.max(1, Math.floor((src.positions.length / 3) / o.coarseSamples));
  const p = new Float64Array(3), q = new Float64Array(3);
  const score = (T) => {
    let sum = 0, n = 0;
    for (let i = 0; i < src.positions.length / 3; i += stride) {
      applySim(T, src.positions[i * 3], src.positions[i * 3 + 1], src.positions[i * 3 + 2], p);
      const r = bvhClosest(bvh, p[0], p[1], p[2], q);
      sum += r.distance * r.distance; n++;
    }
    return n ? Math.sqrt(sum / n) : Infinity;
  };

  const SIGNS = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];   // the four with det = +1
  const scores = [], candidates = [];
  let best = -1;
  for (let c = 0; c < SIGNS.length; c++) {
    const [e1, e2, e3] = SIGNS[c];
    // R = Ed · diag(ε) · Esᵀ
    const D = Float64Array.of(e1, 0, 0, 0, e2, 0, 0, 0, e3);
    const EsT = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) EsT[i * 3 + j] = Es.vectors[j * 3 + i];
    const R = orthonormalize(mat3Mul(mat3Mul(Ed.vectors, D), EsT));
    if (!R) { scores.push(Infinity); candidates.push(null); continue; }
    const rc = new Float64Array(3);
    mat3Apply(R, Ms.centroid[0], Ms.centroid[1], Ms.centroid[2], rc);
    const T = similarity(s0, R, Float64Array.of(
      Md.centroid[0] - s0 * rc[0], Md.centroid[1] - s0 * rc[1], Md.centroid[2] - s0 * rc[2]));
    const sc = score(T);
    scores.push(sc); candidates.push(T);
    if (best < 0 || sc < scores[best]) best = c;              // strict: ties keep the earlier
  }
  if (best < 0 || !candidates[best]) return { ok: false, reason: 'no admissible coarse candidate' };

  const gapS = gap(Es.values), gapD = gap(Ed.values);
  return {
    ok: true,
    transform: candidates[best],
    signs: SIGNS[best],
    scores,
    coarseScore: scores[best],
    eigenvaluesSrc: Array.from(Es.values),
    eigenvaluesDst: Array.from(Ed.values),
    axisGapSrc: gapS,
    axisGapDst: gapD,
    ambiguous: Math.min(gapS, gapD) < o.axisGap,
    momentSourceSrc: Ms.momentSource,
    momentSourceDst: Md.momentSource,
    initialScale: s0,
  };
}

/* ---------------------------------------------------------------- the ICP */

/**
 * Register `src` onto `dst` with a 7-degree-of-freedom similarity.
 *
 * THE INVARIANT, which is the whole of this procedure's correctness argument.
 * Let F(T) = Σᵢ dist²(T(xᵢ), surface(dst)), summed over EVERY source vertex.
 * After iteration k, `Fbest = F(Tbest) = min_{j ≤ k} F(T_j)` and `Fbest` is
 * non-increasing. At entry that is a statement about a one-element set. Each
 * iteration computes one candidate and takes one of exactly two branches —
 * accept, which lowers `Fbest` to the measured `F'`, or reject, which changes
 * neither — so the invariant survives both, AND IT DOES NOT DEPEND ON THE STEP
 * BEING A GOOD ONE. That is what buys a guarantee from a linearised solve which
 * has none of its own.
 *
 * POSTCONDITION: the returned transform is the lowest-F transform the run ever
 * visited, so `F(returned) ≤ F(T₀)` — registration never returns something worse
 * than its own initialisation. `rmse` is measured at that transform, not
 * extrapolated from the linearised solve's residual. `trace` carries `Fbest`'s
 * rmse after each iteration so the invariant is testable rather than asserted.
 *
 * THREE DECISIONS CARRY THAT ARGUMENT.
 *
 * (1) The STEP is point-to-plane, the TEST is point-to-point. The plane
 * linearisation converges in a handful of iterations on a smooth surface where
 * point-to-point crawls. But the plane objective is NOT continuous in T — where
 * the nearest triangle switches, the point distance agrees across the switch and
 * the plane distances do not — and a descent test on a discontinuous function
 * would make the damping argument false. F is distance to a closed set, which is
 * 1-Lipschitz in the point, so F is continuous in T. Fast step, honest test.
 *
 * (2) Rejection and trimming touch the STEP only. F is summed over every source
 * vertex with no trimming, so the accept test never compares two different
 * functions — which is exactly the hazard that lets trimmed ICP report a falling
 * objective while the fit gets worse.
 *
 * (3) The step is guarded because a first-order solve is not a descent method.
 * Accept-or-reject with Levenberg damping is what converts it into one. Where no
 * damping helps — possible, since the direction comes from the plane objective
 * and no theorem says a descent direction for that is one for F — the rejection
 * counter fires and `stoppedBy` is `'damping'`. A stated outcome, not an
 * unhandled one.
 *
 * WHAT IS NOT CLAIMED: not a global minimum, not convergence to the right
 * answer, not a stationary point. ICP is local.
 *
 * WHAT `converged` MEANS, and why it is not what §3.3 of the algorithm document
 * first said. It said `converged` is true only for `stoppedBy === 'tolerance'`.
 * That mislabels the common case: a registration that reaches machine precision
 * stops making accepted steps at all, so the tolerance counter — which only
 * advances on an accepted step — never fires, and the loop leaves by `'damping'`
 * instead. Measured on a torus, an exact recovery reported `rmse` 2.3e-8 and
 * `converged: false`. Both exits mean the loop SETTLED: `'damping'` fires after
 * `maxReject` consecutive rejections, by which point the damping has shrunk the
 * step by 10^maxReject and nothing is left to find. So `converged` is true for
 * both, and false for `'iterations'` and `'correspondences'`, which mean the run
 * hit its budget or ran out of data — a distinction a caller can act on.
 * `stoppedBy` still separates all four. §9 of that document records the change.
 */
export function registerSimilarity7(src, dst, opts = {}) {
  const o = { ...REGISTER, ...opts };
  const n = src.positions.length / 3;
  if (n < 3) return { ok: false, reason: 'need at least 3 source vertices' };
  for (let i = 0; i < src.positions.length; i++) {
    if (!Number.isFinite(src.positions[i])) return { ok: false, reason: 'non-finite input' };
  }
  const bvh = opts.bvh || bvhBuild(dst.positions, dst.indices, o.bvhLeaf);
  if (!bvh.ok) return { ok: false, reason: bvh.reason };

  let coarse = null, T0;
  if (opts.initial) {
    const R = orthonormalize(Float64Array.from(opts.initial.rotation));
    if (!R || !(opts.initial.scale > 0)) return { ok: false, reason: 'initial transform is not a similarity' };
    T0 = similarity(opts.initial.scale, R, Float64Array.from(opts.initial.translation));
  } else {
    coarse = coarseAlign(src, dst, bvh, o);
    if (!coarse.ok) return { ok: false, reason: coarse.reason };
    T0 = coarse.transform;
  }

  const srcN = vertexNormals(src.positions, src.indices);
  // Two buffer sets, not one: `cur` holds the correspondences of the transform
  // the loop is stepping FROM, `scr` receives the candidate's. A rejection then
  // costs nothing to undo — with a single set it would cost a whole extra pass
  // over every vertex to restore, which is the kind of hidden factor the
  // complexity table in `docs/registration-algorithm.md` would be wrong about.
  const mkBuf = () => ({ px: new Float64Array(n * 3), qx: new Float64Array(n * 3),
                         qn: new Float64Array(n * 3), dd: new Float64Array(n) });
  let cur = mkBuf(), scr = mkBuf();
  const p = new Float64Array(3), cp = new Float64Array(3), nb = new Float64Array(3);

  /** One pass over every source vertex: F(T) and the correspondences that gave it. */
  const probe = (T, buf) => {
    let F = 0;
    for (let i = 0; i < n; i++) {
      applySim(T, src.positions[i * 3], src.positions[i * 3 + 1], src.positions[i * 3 + 2], p);
      buf.px[i * 3] = p[0]; buf.px[i * 3 + 1] = p[1]; buf.px[i * 3 + 2] = p[2];
      const r = bvhClosest(bvh, p[0], p[1], p[2], cp);
      buf.qx[i * 3] = cp[0]; buf.qx[i * 3 + 1] = cp[1]; buf.qx[i * 3 + 2] = cp[2];
      if (r.triangle >= 0) triNormal(bvh.positions, bvh.indices, r.triangle, nb);
      else { nb[0] = 0; nb[1] = 0; nb[2] = 0; }
      buf.qn[i * 3] = nb[0]; buf.qn[i * 3 + 1] = nb[1]; buf.qn[i * 3 + 2] = nb[2];
      buf.dd[i] = r.distance;
      F += r.distance * r.distance;
    }
    return F;
  };

  let T = T0, Fbest = probe(T0, cur), Tbest = T0;
  if (!Number.isFinite(Fbest)) return { ok: false, reason: 'the initialisation has no finite objective' };
  let lambda = o.lambda0, iterations = 0, accepted = 0, rejected = 0, consecutiveReject = 0;
  let stale = 0, stoppedBy = 'iterations', lastCorr = 0;
  const trace = [Math.sqrt(Fbest / n)];
  const cosLimit = Math.cos(o.maxNormalDeg * Math.PI / 180);
  const keep = new Int32Array(n);
  const sn = new Float64Array(3);

  if (Fbest <= TINY) {
    stoppedBy = 'tolerance';
  } else for (let k = 0; k < o.maxIterations; k++) {
    iterations++;

    // --- correspondences: normal compatibility, then the closest trimFraction ---
    const { px, qx, qn, dd } = cur;
    let kept = 0;
    for (let i = 0; i < n; i++) {
      if (!(dd[i] < Infinity)) continue;
      mat3Apply(T.rotation, srcN[i * 3], srcN[i * 3 + 1], srcN[i * 3 + 2], sn);
      const nl = Math.hypot(sn[0], sn[1], sn[2]);
      const ql = Math.hypot(qn[i * 3], qn[i * 3 + 1], qn[i * 3 + 2]);
      if (nl > 0 && ql > 0) {
        const c = (sn[0] * qn[i * 3] + sn[1] * qn[i * 3 + 1] + sn[2] * qn[i * 3 + 2]) / (nl * ql);
        if (c < cosLimit) continue;
      }
      keep[kept++] = i;
    }
    if (o.trimFraction < 1 && kept > 3) {
      const sub = Array.from(keep.subarray(0, kept));
      sub.sort((a, b) => (dd[a] - dd[b]) || (a - b));
      kept = Math.max(3, Math.floor(kept * o.trimFraction));
      for (let i = 0; i < kept; i++) keep[i] = sub[i];
    }
    lastCorr = kept;
    if (kept < 3) { stoppedBy = 'correspondences'; break; }

    // --- the incremental transform, which acts on the CURRENT transformed points ---
    let step = null;
    if (o.solver === 'point') {
      // `similarityFromPairs(px, qx)` is exactly the increment: px is already
      // T(src), so the transform it fits maps the current points onto their
      // correspondences, and `step ∘ T` is the candidate — the same composition
      // the plane branch uses, from a closed form instead of a linearisation.
      const A = new Float64Array(kept * 3), B = new Float64Array(kept * 3);
      for (let j = 0; j < kept; j++) {
        const i = keep[j];
        for (let c = 0; c < 3; c++) { A[j * 3 + c] = px[i * 3 + c]; B[j * 3 + c] = qx[i * 3 + c]; }
      }
      const fit = similarityFromPairs(A, B);
      if (!fit.ok) { stoppedBy = 'damping'; break; }
      step = fit.transform;
    } else {
      // The 7×7 point-to-plane normal equations, in the SOURCE-CENTROID frame.
      // Measured from the origin instead, the rotation and scale columns scale
      // with the object's distance from it and the condition number goes with
      // the square of that.
      const c0 = new Float64Array(3);
      for (let j = 0; j < kept; j++) { const i = keep[j]; for (let c = 0; c < 3; c++) c0[c] += px[i * 3 + c]; }
      for (let c = 0; c < 3; c++) c0[c] /= kept;
      const A = new Float64Array(49), b = new Float64Array(7), a = new Float64Array(7);
      for (let j = 0; j < kept; j++) {
        const i = keep[j];
        const yx = px[i * 3] - c0[0], yy = px[i * 3 + 1] - c0[1], yz = px[i * 3 + 2] - c0[2];
        const nx = qn[i * 3], ny = qn[i * 3 + 1], nz = qn[i * 3 + 2];
        a[0] = yy * nz - yz * ny; a[1] = yz * nx - yx * nz; a[2] = yx * ny - yy * nx;
        a[3] = nx; a[4] = ny; a[5] = nz;
        a[6] = yx * nx + yy * ny + yz * nz;
        const r0 = (px[i * 3] - qx[i * 3]) * nx + (px[i * 3 + 1] - qx[i * 3 + 1]) * ny + (px[i * 3 + 2] - qx[i * 3 + 2]) * nz;
        // The upper triangle only — 28 multiply-adds per correspondence, not 49.
        // aᵢaᵢᵀ is symmetric, and the lower half is mirrored once at the end
        // rather than accumulated n times.
        for (let u = 0; u < 7; u++) {
          b[u] -= r0 * a[u];
          for (let v = u; v < 7; v++) A[u * 7 + v] += a[u] * a[v];
        }
      }
      for (let u = 1; u < 7; u++) for (let v = 0; v < u; v++) A[u * 7 + v] = A[v * 7 + u];
      const z = choleskySolve(A, b, 7, lambda);
      if (!z) {
        // Rank-deficient normal equations: damp harder and try again. The loop
        // above is unchanged, so `cur` still describes T and nothing is undone.
        lambda *= o.lambdaGrow; rejected++;
        if (++consecutiveReject > o.maxReject) { stoppedBy = 'damping'; break; }
        trace.push(Math.sqrt(Fbest / n));
        continue;
      }
      // γ is the LOG-scale increment: exp(γ) keeps the scale positive for any γ,
      // and agrees with the linearisation (1 + γ) to first order. It is never
      // written σ — σ is the uncertainty field and the two must not be confused.
      const gamma = z[6], eg = Math.exp(gamma);
      const Rw = rotationFromAxisAngle(z[0], z[1], z[2]);
      const rc = new Float64Array(3);
      mat3Apply(Rw, c0[0], c0[1], c0[2], rc);
      step = similarity(eg, Rw, Float64Array.of(
        c0[0] + z[3] - eg * rc[0], c0[1] + z[4] - eg * rc[1], c0[2] + z[5] - eg * rc[2]));
    }

    const Tcand = composeSim(step, T);
    if (!Tcand || !(Tcand.scale > 0) || !Number.isFinite(Tcand.scale)) {
      lambda *= o.lambdaGrow; rejected++;
      if (++consecutiveReject > o.maxReject) { stoppedBy = 'damping'; break; }
      trace.push(Math.sqrt(Fbest / n));
      continue;
    }
    const Fp = probe(Tcand, scr);

    // THE INVARIANT LIVES HERE. Exactly two branches, and `Fbest` cannot rise in
    // either — which is why the returned transform is the best the run ever saw
    // whatever the linearised solve did.
    if (Number.isFinite(Fp) && Fp <= Fbest) {
      const before = Fbest;
      accepted++; consecutiveReject = 0;
      T = Tcand; Tbest = Tcand; Fbest = Fp;
      const t = cur; cur = scr; scr = t;                      // the candidate's pass becomes current
      lambda = Math.max(lambda / o.lambdaGrow, o.lambdaMin);
      const rel = before > TINY ? (before - Fp) / before : 0;
      stale = rel < o.tolRel ? stale + 1 : 0;
      trace.push(Math.sqrt(Fbest / n));
      if (stale >= o.patience) { stoppedBy = 'tolerance'; break; }
    } else {
      rejected++; lambda *= o.lambdaGrow;
      trace.push(Math.sqrt(Fbest / n));
      if (++consecutiveReject > o.maxReject) { stoppedBy = 'damping'; break; }
    }
  }

  return {
    ok: true,
    scale: Tbest.scale,
    rotation: Array.from(Tbest.rotation),
    translation: Array.from(Tbest.translation),
    transform: reportSim(Tbest),
    rmse: Math.sqrt(Fbest / n),
    initialRmse: trace[0],
    trace,
    iterations, accepted, rejected,
    correspondences: lastCorr,
    stoppedBy,
    // Both of these mean the loop settled; the other two mean it ran out.
    converged: stoppedBy === 'tolerance' || stoppedBy === 'damping',
    solver: o.solver,
    coarse,
  };
}

/** Apply a registration result to a position array, returning a NEW array. */
export function applyTransform(T, positions) {
  const out = new Float64Array(positions.length);
  const S = similarity(T.scale, Float64Array.from(T.rotation), Float64Array.from(T.translation));
  const p = new Float64Array(3);
  for (let i = 0; i < positions.length; i += 3) {
    applySim(S, positions[i], positions[i + 1], positions[i + 2], p);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  return out;
}

/* ----------------------------------------------- the band-aware residual */

/**
 * §1.3 of `docs/physical-validation-scope.md`, verbatim: zero inside the band,
 * the signed outward excess outside it.
 *
 * GROUND TRUTH WITH A TOLERANCE IS A CONSTRAINT BAND, NOT A POINT. A
 * reconstruction whose surface lies anywhere inside the band is not in error,
 * and recording a signed residual to the band's centre would manufacture error
 * that is not there.
 *
 * The properties the gate depends on, all immediate from the two branches:
 * e = 0 ⟺ |d| ≤ τ; |e| ≤ |d| with equality iff τ = 0; sign(e) ∈ {0, sign(d)},
 * so a reconstruction outside the truth is never reported as inside it; and e is
 * non-decreasing in d and continuous at the join, where both branches give 0.
 *
 * THE CONSEQUENCE §4.0 EXISTS FOR: since |e| ≤ |d| pointwise, every coverage
 * statistic computed on e is ≥ the same statistic on d. Widening the band can
 * only make measured coverage look BETTER — which is why the gate runs first.
 *
 * A negative τ is a `RangeError` rather than a clamp: it would make |e| > |d|
 * and break that inequality, which everything above rests on.
 */
export function bandResidual(d, tau) {
  if (!(tau >= 0) || !Number.isFinite(tau)) throw new RangeError('tau must be finite and >= 0');
  if (d === null || d === undefined || !Number.isFinite(d)) return null;
  const a = Math.abs(d);
  if (a <= tau) return 0;
  return (d < 0 ? -1 : 1) * (a - tau);
}

/**
 * d(x), τ(x) and e(x) over a registered mesh against a truth mesh.
 *
 * d IS MEASURED ALONG THE VERTEX NORMAL, as §1.3 specifies, not as the nearest
 * point on the truth surface. The two differ: the nearest point is always
 * defined and can slide along the surface, while the normal ray is the direction
 * the σ field is stated along and can miss the truth entirely. A miss is
 * REPORTED AS NULL and counted in `missed`; substituting the nearest-point
 * distance there would be quietly answering a different question. The
 * nearest-point RMS is reported too, under its own name, as its own quantity.
 *
 * SIGN: d = −t where t is the ray parameter. A hit ahead of the vertex along its
 * outward normal means the truth is further out, so the reconstruction is INSIDE
 * it and d is negative. A reconstruction sphere of radius 1.1 against a truth
 * sphere of radius 1.0 gives d = +0.1 everywhere.
 *
 * τ COMBINES IN QUADRATURE because the truth's own bound and the registration
 * floor are independent.
 */
export function residualField(positions, normals, truth, opts = {}) {
  const o = { ...REGISTER, ...opts };
  const n = positions.length / 3;
  const bvh = opts.bvh || bvhBuild(truth.positions, truth.indices, o.bvhLeaf);
  if (!bvh.ok) return { ok: false, reason: bvh.reason };

  const floor = opts.floor === undefined || opts.floor === null ? 0 : opts.floor;
  if (!(floor >= 0) || !Number.isFinite(floor)) throw new RangeError('floor must be finite and >= 0');
  const bound = opts.truthBound === undefined ? 0 : opts.truthBound;
  const boundAt = typeof bound === 'number'
    ? () => bound
    : (i) => bound[i];
  if (typeof bound === 'number' && (!(bound >= 0) || !Number.isFinite(bound))) {
    throw new RangeError('truthBound must be finite and >= 0');
  }
  const reach = opts.reach !== undefined ? opts.reach
    : o.reachFraction * Math.max(boundingDiagonal(truth.positions), TINY);
  if (!(reach > 0)) throw new RangeError('reach must be > 0');

  const d = new Array(n).fill(null), e = new Array(n).fill(null);
  const tau = new Float64Array(n);
  let missed = 0, nearSum = 0, nearN = 0;
  const cp = new Float64Array(3);

  for (let i = 0; i < n; i++) {
    const b = boundAt(i);
    if (!(b >= 0) || !Number.isFinite(b)) throw new RangeError('truthBound must be finite and >= 0');
    tau[i] = Math.sqrt(b * b + floor * floor);
    const hit = bvhRay(bvh, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
      normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], reach);
    // `surfaceRms` is measured over EVERY vertex, including the ones whose normal
    // ray missed — it is a different quantity from d and it has no reason to
    // inherit d's coverage.
    const r = bvhClosest(bvh, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], cp);
    if (r.distance < Infinity) { nearSum += r.distance * r.distance; nearN++; }
    if (hit === null) { missed++; continue; }
    d[i] = -hit.t;
    e[i] = bandResidual(d[i], tau[i]);
  }

  return {
    ok: true, n, d, tau, e, missed, reach, floor,
    measured: n - missed,
    // A DIFFERENT QUANTITY from d, named as itself so nobody reads one for the other.
    surfaceRms: nearN ? Math.sqrt(nearSum / nearN) : null,
  };
}

/** The repository's median: the order statistic at index ⌊n/2⌋ of the ascending
 *  finite values — the same convention `sigmaSummary` uses in `uncertainty.js`,
 *  so two medians here never mean two different things. */
function medianOf(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(0.5 * v.length))];
}

/**
 * §4.0's gate: is the truth good enough to measure against?
 *
 * Checked FIRST, before any calibration claim, because §1.3's band rule makes
 * generous truth flattering — `bandResidual` proves that above.
 *
 * WHICH ERROR THE MEDIAN IS TAKEN OVER. §4.0 says "the median reconstruction
 * error" without saying whether that is the raw distance or the band-zeroed
 * residual. This uses median |d|, the raw normal-ray distance, for three
 * reasons in order of weight. |e| would make the gate a TAUTOLOGY rather than a
 * test: e is defined by τ, so a band wide enough to swallow every vertex gives
 * median|e| = 0 and τ ≤ 0 fails for arithmetic reasons rather than measurement
 * ones. §1.2 already fixes the referent, calling the compared quantity "the
 * reconstruction errors being measured — currently an rms of 3.87–4.32 px",
 * which carries no band. And the gate's question is about the instrument: is the
 * ruler fine enough for this object, not for this object after the ruler's own
 * coarseness has been taken off it. `medianAbsE` is reported alongside, named as
 * itself, so nobody has to guess which was used.
 *
 * A FAILED GATE IS A RESULT, not an exception: "the phase reports that the
 * measurement apparatus is not sharp enough to test the hypothesis, and neither
 * flag moves." An unmeasured gate is likewise `pass: false` — never a pass by
 * default.
 */
export function truthBandGate(field, opts = {}) {
  const o = { ...REGISTER, ...opts };
  // A field that failed to build is not an unmeasured gate, it is a broken one,
  // and it keeps its own reason rather than inheriting a vaguer downstream copy.
  if (!field || field.ok === false) {
    return { pass: false, reason: field && field.reason ? field.reason : 'no residual field',
             medianBand: null, medianAbsD: null, medianAbsE: null, ratio: null,
             gateRatio: o.gateRatio, measured: 0 };
  }
  const pairs = [];
  for (let i = 0; i < field.n; i++) {
    if (field.d[i] === null || !Number.isFinite(field.d[i])) continue;
    pairs.push([Math.abs(field.d[i]), field.tau[i], field.e[i] === null ? null : Math.abs(field.e[i])]);
  }
  if (!pairs.length) {
    return { pass: false, reason: 'no measurable vertices', medianBand: null, medianAbsD: null,
             medianAbsE: null, ratio: null, gateRatio: o.gateRatio, measured: 0 };
  }
  const medianAbsD = medianOf(pairs.map((x) => x[0]));
  const medianBand = medianOf(pairs.map((x) => x[1]));
  const medianAbsE = medianOf(pairs.map((x) => x[2]));
  if (!(medianAbsD > 0)) {
    return { pass: false, reason: 'median error is zero', medianBand, medianAbsD, medianAbsE,
             ratio: null, gateRatio: o.gateRatio, measured: pairs.length };
  }
  const ratio = medianBand / medianAbsD;
  return {
    pass: ratio <= o.gateRatio,
    reason: ratio <= o.gateRatio ? null : 'the truth band is not small compared to the error being measured',
    medianBand, medianAbsD, medianAbsE, ratio, gateRatio: o.gateRatio, measured: pairs.length,
  };
}

/* ------------------------------------------------------------- randomness */

/**
 * mulberry32 — one 32-bit word of engineering state, period 2³².
 *
 * It exists so that §3.3's trials are reproducible from a recorded seed, which
 * `Math.random` cannot be. It is NOT CRYPTOGRAPHIC and must never be reached for
 * where `certificate.js` uses WebCrypto; the two live in the same package and
 * confusing them would be a security defect, not a style one.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rotation uniform on SO(3) by Shoemake's subgroup construction.
 *
 * A UNIFORM EULER TRIPLE IS NOT A UNIFORM ROTATION: the Haar measure carries a
 * cos(pitch) Jacobian, so uniform angles concentrate near the poles and a floor
 * measured over them would be an average over the wrong distribution of
 * rotations. This costs three variates and gets the right measure.
 */
export function uniformRotation(rng) {
  const u1 = rng(), u2 = rng(), u3 = rng();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return rotationFromQuaternion(
    a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2),
    b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3));
}

/* ----------------------------------------------- the registration's floor */

/**
 * §3.3 of the scope document: the registration's own error, MEASURED by both of
 * its routes rather than assumed. This is the number that enters τ in quadrature.
 *
 * ROUTE 1, the known-truth floor: apply a known random similarity to a mesh,
 * register it back to itself, and score the recovery. ROUTE 2, repeatability:
 * re-register from perturbed initialisations and report the spread.
 *
 * WHY THE FLOOR IS A SURFACE DISAGREEMENT AND NOT A PARAMETER ERROR. Rotation
 * error is radians, scale error is a ratio and translation error is model units;
 * three units that cannot be summed, where §1.3 needs ONE number in model units
 * to put into τ. The tempting scalar is `displacementRms` — how far the mesh's
 * own points move under the composed error transform — and an icosphere shows
 * why it is wrong: recover a rotation of a sphere about its centre and the
 * recovery is PERFECT, the registered mesh coincides with the target exactly,
 * while `displacementRms` reports a large number because the points slid along a
 * surface they never left. What matters to anyone measuring a reconstruction is
 * how far the registered surface sits from the truth surface. So the floor is
 * `surfaceRms`. `displacementRms` is reported too, with
 * `symmetryGap = median(displacementRms) / median(surfaceRms)` beside it: ≈ 1 for
 * an asymmetric object, large for a symmetric one. What it measures is the
 * object's own symmetry, NOT an error.
 *
 * WHY max AND NOT QUADRATURE. Route 1 measures accuracy against a known answer,
 * so it already contains the noise route 2 measures; adding them in quadrature
 * would count that noise twice. Route 2 is a lower bound that catches the case
 * where route 1's draws happened to be easy. `max` is the conservative reading
 * and IT IS A JUDGEMENT, labelled as one — `dominant` records which route
 * supplied the floor on any given run.
 *
 * THE ACCUMULATOR'S INVARIANT: each trial either pushes exactly one finite
 * non-negative value or increments `skipped`, never both and never neither, so
 * `|values| + skipped == trials` exactly and the count of failed trials is
 * measured rather than inferred. An empty accumulator reports `null` with a
 * reason — never 0, which would read as a perfect floor.
 */
export function registrationFloor(mesh, opts = {}) {
  const o = { ...REGISTER, ...opts };
  const nV = mesh.positions.length / 3;
  if (nV < 3) return { ok: false, reason: 'need at least 3 vertices', floor: null };
  if (!(o.logScaleRange > 0)) throw new RangeError('logScaleRange must be > 0');

  const bvh = bvhBuild(mesh.positions, mesh.indices, o.bvhLeaf);
  if (!bvh.ok) return { ok: false, reason: bvh.reason, floor: null };
  const diag = boundingDiagonal(mesh.positions);
  const rng = mulberry32(o.seed);
  const cp = new Float64Array(3);

  const surfaceRmsOf = (P) => {
    let s = 0, c = 0;
    for (let i = 0; i < P.length; i += 3) {
      const r = bvhClosest(bvh, P[i], P[i + 1], P[i + 2], cp);
      if (r.distance < Infinity) { s += r.distance * r.distance; c++; }
    }
    return c ? Math.sqrt(s / c) : null;
  };

  /* ----- route 1: known-truth recovery ----- */
  const recovery = [], displacement = [];
  let skipped = 0;
  const draws = [];
  for (let trial = 0; trial < o.trials; trial++) {
    const sStar = Math.exp((2 * rng() - 1) * o.logScaleRange);
    const Rstar = uniformRotation(rng);
    const tStar = Float64Array.of(
      (2 * rng() - 1) * o.translateFraction * diag,
      (2 * rng() - 1) * o.translateFraction * diag,
      (2 * rng() - 1) * o.translateFraction * diag);
    const G = similarity(sStar, Rstar, tStar);
    draws.push({ scale: sStar, translation: Array.from(tStar) });

    const moved = applyTransform(reportSim(G), mesh.positions);
    const res = registerSimilarity7({ positions: moved, indices: mesh.indices }, mesh, { ...o, bvh });
    if (!res.ok) { skipped++; continue; }
    const back = applyTransform(res, moved);
    const srms = surfaceRmsOf(back);
    if (srms === null || !Number.isFinite(srms)) { skipped++; continue; }
    recovery.push(srms);
    let s = 0;
    for (let i = 0; i < back.length; i += 3) {
      s += (back[i] - mesh.positions[i]) ** 2 + (back[i + 1] - mesh.positions[i + 1]) ** 2
         + (back[i + 2] - mesh.positions[i + 2]) ** 2;
    }
    displacement.push(Math.sqrt(s / nV));
  }

  /* ----- route 2: repeatability under perturbed initialisations ----- */
  // The source is the mesh displaced by one fixed similarity, so the run has
  // something to register rather than starting at the answer.
  const fixed = similarity(1.3, uniformRotation(mulberry32(o.seed ^ 0x5bf03635)),
    Float64Array.of(0.17 * diag, -0.11 * diag, 0.09 * diag));
  const movedFixed = applyTransform(reportSim(fixed), mesh.positions);
  const srcFixed = { positions: movedFixed, indices: mesh.indices };
  const base = registerSimilarity7(srcFixed, mesh, { ...o, bvh });
  const spread = [];
  let perturbSkipped = 0;
  if (base.ok) {
    const ref = applyTransform(base, movedFixed);
    const refBvh = bvhBuild(ref, mesh.indices, o.bvhLeaf);
    for (let j = 0; j < o.perturbations; j++) {
      const dR = rotationFromAxisAngle(
        (2 * rng() - 1) * o.perturbAngle, (2 * rng() - 1) * o.perturbAngle, (2 * rng() - 1) * o.perturbAngle);
      const init = composeSim(
        similarity(Math.exp((2 * rng() - 1) * o.perturbLogScale), dR, Float64Array.of(
          (2 * rng() - 1) * o.perturbTranslate * diag,
          (2 * rng() - 1) * o.perturbTranslate * diag,
          (2 * rng() - 1) * o.perturbTranslate * diag)),
        similarity(base.scale, Float64Array.from(base.rotation), Float64Array.from(base.translation)));
      const res = registerSimilarity7(srcFixed, mesh, { ...o, bvh, initial: reportSim(init) });
      if (!res.ok || !refBvh.ok) { perturbSkipped++; continue; }
      const got = applyTransform(res, movedFixed);
      let s = 0, c = 0;
      for (let i = 0; i < got.length; i += 3) {
        const r = bvhClosest(refBvh, got[i], got[i + 1], got[i + 2], cp);
        if (r.distance < Infinity) { s += r.distance * r.distance; c++; }
      }
      if (c) spread.push(Math.sqrt(s / c));
      else perturbSkipped++;
    }
  }

  const route1 = medianOf(recovery);
  const route2 = medianOf(spread);
  const medDisp = medianOf(displacement);
  const floor = route1 === null && route2 === null ? null
    : Math.max(route1 === null ? -Infinity : route1, route2 === null ? -Infinity : route2);

  return {
    ok: true,
    floor,
    floorRule: 'max(recovery, repeatability) — a JUDGEMENT, not a derivation; quadrature would double-count route 2\'s noise, which route 1 already contains',
    route1, route2,
    dominant: floor === null ? null : (route1 !== null && floor === route1 ? 'recovery' : 'repeatability'),
    reason: floor === null ? (o.trials === 0 ? 'no trials' : 'every trial failed to register') : null,
    recovery: { values: recovery, median: route1, max: recovery.length ? Math.max(...recovery) : null,
                trials: o.trials, skipped },
    repeatability: { values: spread, median: route2, max: spread.length ? Math.max(...spread) : null,
                     perturbations: o.perturbations, skipped: perturbSkipped, baseOk: base.ok },
    displacementRms: { median: medDisp, values: displacement },
    // A property of the OBJECT'S SYMMETRY, not an error. ≈1 asymmetric, large symmetric.
    symmetryGap: medDisp !== null && route1 !== null && route1 > TINY ? medDisp / route1 : null,
    seed: o.seed,
    diagonal: diag,
  };
}
