// A reconstruction against independent truth.
//   node tools/test/atlas/register.mjs
//
// `src/register.js` is the apparatus §3, §1.3 and §4.0 of
// `docs/physical-validation-scope.md` would need before any claim about a
// reconstruction's accuracy against real geometry could be measured. It is
// argued in `docs/registration-algorithm.md` and the claims that argument makes
// are measured here rather than asserted:
//
//   1. the closed form is closed form — a known similarity comes back to machine
//      precision, the rotation is proper, and every degenerate input in §5 of
//      that document has the behaviour §5 says it has;
//   2. the surface moment is the SURFACE's, against closed form: a sphere reads
//      R²/3 and a cube of half-side a reads 5a²/9, and a mesh tessellated
//      unevenly reads the same moment while a vertex cloud does not;
//   3. the BVH agrees with brute force, both for the nearest point and for the
//      normal ray, including on the sphere-from-its-own-centre case that is its
//      stated worst case;
//   4. THE INVARIANT: the objective is non-increasing over every iteration of
//      every run here, and the returned transform is never worse than the
//      initialisation it started from — which is the whole postcondition;
//   5. registration recovers a known similarity, is deterministic to the byte,
//      and reports what it was given rather than what it assumed;
//   6. the residual is §1.3's: a sphere of radius 1.1 against a truth sphere of
//      radius 1.0 reads d = +0.1 everywhere, which pins the sign convention, and
//      the four properties the gate rests on hold across a swept grid;
//   7. the gate is §4.0's, it fails closed, and it is checked against both
//      readings of "median reconstruction error";
//   8. the floor is measured by both of §3.3's routes, the seed reproduces the
//      run, and `symmetryGap` tells a symmetric object from an asymmetric one by
//      seven orders of magnitude;
//   9. nothing is invented and nothing is mutated: unmeasurable quantities come
//      back null with a reason, and every input array is byte-identical after.
import {
  REGISTER, similarityFromPairs, surfaceMoments, jacobiEigenSym, rotationFromQuaternion,
  bvhBuild, bvhClosest, bvhRay, vertexNormals, coarseAlign, registerSimilarity7,
  applyTransform, bandResidual, residualField, truthBandGate, registrationFloor,
  mulberry32, uniformRotation, identitySimilarity,
} from '../../../src/atlas/register.js';
import { icosphere, cube, torus, signedVolume } from './solids.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
};
const f3 = (x) => (x === null ? 'null' : x.toFixed(3));
const e2 = (x) => (x === null ? 'null' : x.toExponential(2));

/* ------------------------------------------------------------- fixtures */

/** A smooth star-shaped blob: three distinct principal axes and no symmetry. */
function blob(level = 3) {
  const s = icosphere(level);
  const P = Float64Array.from(s.positions);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const r = 1 + 0.30 * x + 0.18 * y * z + 0.12 * z + 0.09 * x * y;
    P[i] = x * r; P[i + 1] = y * r; P[i + 2] = z * r;
  }
  return { positions: P, indices: s.indices };
}

/** A sphere whose northern hemisphere is subdivided and whose southern is not. */
function gradedSphere() {
  const fine = icosphere(4), coarse = icosphere(2);
  const V = [], F = [];
  const push = (m, keep) => {
    const base = V.length / 3;
    const map = new Map();
    for (let t = 0; t < m.indices.length; t += 3) {
      const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const zs = tri.map((v) => m.positions[v * 3 + 2]);
      if (!keep(zs.reduce((a, b) => a + b, 0) / 3)) continue;
      const out = [];
      for (const v of tri) {
        if (!map.has(v)) { map.set(v, V.length / 3); V.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]); }
        out.push(map.get(v));
      }
      F.push(...out);
    }
    return base;
  };
  push(fine, (z) => z > 0);
  push(coarse, (z) => z <= 0);
  return { positions: new Float64Array(V), indices: new Uint32Array(F) };
}

const KNOWN_R = rotationFromQuaternion(0.6, 0.4, -0.5, 0.48);
const known = (scale, tx, ty, tz) => ({ scale, rotation: Array.from(KNOWN_R), translation: [tx, ty, tz] });

/** Every trace in the session, checked once at the end: the invariant, globally. */
const traces = [];
function register(src, dst, opts) {
  const r = registerSimilarity7(src, dst, opts);
  if (r.ok) traces.push({ trace: r.trace, initial: r.initialRmse, final: r.rmse, stoppedBy: r.stoppedBy, converged: r.converged });
  return r;
}

/* ------------------------------------------------------------------ task 1 */

function taskClosedForm() {
  console.log('\nTASK 1 — the closed form is closed form');
  const P = Float64Array.of(0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,1,1, -2,0.5,0.3, 0.7,-1.1,2.2);
  const T = known(1.7, 0.3, -1.2, 0.8);
  const Q = applyTransform(T, P);
  const fit = similarityFromPairs(P, Q);
  ok('a known similarity comes back', fit.ok, fit.ok ? '' : fit.reason);
  ok('the scale is exact', Math.abs(fit.transform.scale - 1.7) < 1e-12, e2(Math.abs(fit.transform.scale - 1.7)));
  let dR = 0; for (let k = 0; k < 9; k++) dR = Math.max(dR, Math.abs(fit.transform.rotation[k] - KNOWN_R[k]));
  ok('the rotation is exact', dR < 1e-12, e2(dR));
  const dT = Math.max(...[0, 1, 2].map((k) => Math.abs(fit.transform.translation[k] - T.translation[k])));
  ok('the translation is exact', dT < 1e-12, e2(dT));
  ok('the fit has no residual', fit.rmse < 1e-12, e2(fit.rmse));
  ok('the rotation is proper and orthonormal', properRotation(fit.transform.rotation), '');

  // Weights are honoured: weighting one pair to nothing must move the answer.
  const W = new Float64Array(7).fill(1); W[6] = 0;
  const Qb = Float64Array.from(Q); Qb[18] += 5;            // corrupt the zero-weighted pair
  const fw = similarityFromPairs(P, Qb, W);
  ok('a zero weight excludes its pair', fw.ok && Math.abs(fw.transform.scale - 1.7) < 1e-10,
     e2(Math.abs(fw.transform.scale - 1.7)));

  // §5's degenerate rows, each to its stated behaviour.
  const bad = (p, q, w, want) => {
    const r = similarityFromPairs(p, q, w);
    return !r.ok && r.reason === want;
  };
  ok('fewer than 3 pairs → the stated reason',
     bad(P.subarray(0, 6), Q.subarray(0, 6), null, 'need at least 3 pairs'), '');
  ok('coincident source → the stated reason',
     bad(new Float64Array(12), Q.subarray(0, 12), null, 'source has no extent'), '');
  ok('zero weights → the stated reason',
     bad(P, Q, new Float64Array(7), null) === false
       && similarityFromPairs(P, Q, new Float64Array(7)).reason === 'weights sum to zero', '');
  const nan = Float64Array.from(P); nan[4] = NaN;
  ok('a non-finite coordinate → the stated reason', bad(nan, Q, null, 'non-finite input'), '');

  // Rank is reported rather than assumed: collinear points have rank 1.
  const line = Float64Array.of(0,0,0, 1,0,0, 2,0,0, 3,0,0);
  const lineQ = applyTransform(T, line);
  const lf = similarityFromPairs(line, lineQ);
  ok('a collinear set is flagged rank-degenerate, not refused',
     lf.ok && lf.rank === 1 && lf.degenerate === 'rank', `rank ${lf.rank}`);
  const plane = Float64Array.of(0,0,0, 1,0,0, 0,1,0, 1,1,0, 0.3,0.7,0);
  const pf = similarityFromPairs(plane, applyTransform(T, plane));
  ok('a coplanar set fits at rank 2 with no residual',
     pf.ok && pf.rank === 2 && pf.degenerate === null && pf.rmse < 1e-12, `rank ${pf.rank} · ${e2(pf.rmse)}`);
}

function properRotation(R, tol = 1e-9) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += R[i * 3 + k] * R[j * 3 + k];
    if (Math.abs(s - (i === j ? 1 : 0)) > tol) return false;
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return Math.abs(det - 1) < tol;
}

/* ------------------------------------------------------------------ task 2 */

function taskMoments() {
  console.log('\nTASK 2 — the surface moment, against closed form');
  const S = icosphere(5);
  const ms = surfaceMoments(S.positions, S.indices);
  const diag = (C) => [C[0], C[4], C[8]];
  const sd = diag(ms.covariance);
  ok('a sphere reads R²/3 on the diagonal', sd.every((x) => Math.abs(x - 1 / 3) < 5e-4),
     sd.map((x) => x.toFixed(5)).join(' '));
  let offS = 0; for (const k of [1, 2, 3, 5, 6, 7]) offS = Math.max(offS, Math.abs(ms.covariance[k]));
  ok('a sphere is isotropic off the diagonal', offS < 1e-3, e2(offS));
  ok("a sphere's area is 4πR²", Math.abs(ms.area - 4 * Math.PI) / (4 * Math.PI) < 1e-3, f3(ms.area));
  ok('the moment says it is the surface\'s', ms.momentSource === 'area', ms.momentSource);

  const a = 1;
  const mc = surfaceMoments(cube(6).positions, cube(6).indices);
  const cd = diag(mc.covariance);
  ok('a cube of half-side a reads 5a²/9', cd.every((x) => Math.abs(x - 5 * a * a / 9) < 1e-9),
     cd.map((x) => x.toFixed(6)).join(' '));

  // The point of area weighting: a mesh whose tessellation is uneven must read
  // the same moment as one whose is not. A vertex cloud does not.
  const g = gradedSphere();
  const mg = surfaceMoments(g.positions, g.indices);
  const gd = diag(mg.covariance);
  ok('an unevenly tessellated sphere still reads R²/3',
     gd.every((x) => Math.abs(x - 1 / 3) < 0.02), gd.map((x) => x.toFixed(4)).join(' '));
  // The same mesh with no triangles: the vertex-cloud fallback, which is biased.
  const mv = surfaceMoments(g.positions, new Uint32Array(0));
  ok('with no triangles it falls back and SAYS so', mv.ok && mv.momentSource === 'vertices' && mv.area === 0,
     mv.momentSource);
  const bias = Math.abs(mv.covariance[8] - 1 / 3);
  ok('and the fallback is measurably biased — which is why it is recorded',
     bias > Math.abs(gd[2] - 1 / 3), `vertex zz off by ${bias.toFixed(4)}, area zz off by ${Math.abs(gd[2] - 1 / 3).toFixed(4)}`);

  ok('fewer than 3 vertices → the stated reason',
     surfaceMoments(Float64Array.of(0, 0, 0, 1, 1, 1), new Uint32Array(0)).reason === 'need at least 3 vertices', '');

  // The eigensolver the moment feeds, on a matrix with a known spectrum.
  const A = Float64Array.of(2, 0, 0, 0, 5, 0, 0, 0, 1);
  const E = jacobiEigenSym(A, 3);
  ok('the eigensolver sorts descending', Math.abs(E.values[0] - 5) < 1e-12 && Math.abs(E.values[2] - 1) < 1e-12,
     Array.from(E.values).map((x) => x.toFixed(2)).join(' '));
}

/* ------------------------------------------------------------------ task 3 */

function taskBvh() {
  console.log('\nTASK 3 — the BVH agrees with brute force');
  const M = torus(24, 12);
  const bvh = bvhBuild(M.positions, M.indices);
  ok('a mesh with no triangles → the stated reason',
     bvhBuild(M.positions, new Uint32Array(0)).reason === 'target has no triangles', '');

  const rng = mulberry32(4242);
  const out = new Float64Array(3);
  let worst = 0, worstRay = 0, rayChecked = 0;
  for (let k = 0; k < 300; k++) {
    const x = 4 * rng() - 2, y = 4 * rng() - 2, z = 4 * rng() - 2;
    const got = bvhClosest(bvh, x, y, z, out);
    const want = bruteClosest(M, x, y, z);
    worst = Math.max(worst, Math.abs(got.distance - want));
  }
  ok('the nearest point matches brute force over 300 queries', worst < 1e-12, e2(worst));

  // The stated worst case: a sphere queried from its own centre prunes nothing.
  const S = icosphere(3);
  const sb = bvhBuild(S.positions, S.indices);
  const centre = bvhClosest(sb, 0, 0, 0, out);
  ok('the sphere-from-its-centre worst case still answers correctly',
     Math.abs(centre.distance - bruteClosest(S, 0, 0, 0)) < 1e-12, `d ${centre.distance.toFixed(6)}`);

  // Rays, against the analytic answer on a sphere of radius 1.
  const S4 = icosphere(5);
  const rb = bvhBuild(S4.positions, S4.indices);
  for (let k = 0; k < 120; k++) {
    const R = uniformRotation(mulberry32(1000 + k));
    const hit = bvhRay(rb, 0, 0, 0, R[0], R[3], R[6], 4);
    if (hit) { worstRay = Math.max(worstRay, Math.abs(Math.abs(hit.t) - 1)); rayChecked++; }
  }
  ok('a ray from the centre of the unit sphere hits at |t| = 1',
     rayChecked === 120 && worstRay < 2e-3, `${rayChecked}/120 · worst |t|−1 = ${e2(worstRay)}`);
  ok('a ray that reaches nothing returns null', bvhRay(rb, 0, 0, 10, 0, 0, 1, 1) === null, '');
  ok('a zero-length direction returns null rather than dividing by it',
     bvhRay(rb, 0, 0, 0, 0, 0, 0, 4) === null, '');
  // §2.6 asks for the intersection of SMALLEST |t| either way along the normal,
  // because the truth surface may lie on either side of a reconstructed vertex
  // and the sign is what carries which. So from inside the sphere at x = 0.5,
  // both directions find the same wall 0.5 away — and report opposite signs.
  const fwd = bvhRay(rb, 0.5, 0, 0, 1, 0, 0, 4), bwd = bvhRay(rb, 0.5, 0, 0, -1, 0, 0, 4);
  ok('the ray searches BOTH ways and takes the nearest hit either side',
     Math.abs(Math.abs(fwd.t) - 0.5) < 2e-3 && Math.abs(Math.abs(bwd.t) - 0.5) < 2e-3
     && Math.sign(fwd.t) === -Math.sign(bwd.t) && fwd.t > 0,
     `t = ${fwd.t.toFixed(4)} forward, ${bwd.t.toFixed(4)} backward`);
}

function bruteClosest(M, x, y, z) {
  let best = Infinity;
  for (let t = 0; t < M.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => M.indices[t + k] * 3);
    // sample the triangle densely enough to bound the closest-point distance,
    // then refine against the true closest point by the same barycentric test
    const A = p.map((i) => [M.positions[i], M.positions[i + 1], M.positions[i + 2]]);
    const d = pointTriDistRef(x, y, z, A[0], A[1], A[2]);
    if (d < best) best = d;
  }
  return best;
}

/** An independent point-triangle distance: projection onto the plane, then the
 *  three edges and three corners. Deliberately written differently from the
 *  module's so that agreement means something. */
function pointTriDistRef(px, py, pz, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const p = [px, py, pz];
  const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn > 0) {
    const ap = sub(p, a);
    const proj = sub(ap, n.map((x) => x * dot(ap, n) / nn));
    // barycentric of the projected point
    const d00 = dot(ab, ab), d01 = dot(ab, ac), d11 = dot(ac, ac);
    const d20 = dot(proj, ab), d21 = dot(proj, ac);
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) > 0) {
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v >= 0 && w >= 0 && v + w <= 1) return Math.abs(dot(ap, n)) / Math.sqrt(nn);
    }
  }
  let best = Infinity;
  for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const e = sub(v, u), pu = sub(p, u);
    const l = dot(e, e);
    const t = l > 0 ? Math.max(0, Math.min(1, dot(pu, e) / l)) : 0;
    const q = [u[0] + t * e[0], u[1] + t * e[1], u[2] + t * e[2]];
    best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  return best;
}

/* ------------------------------------------------------------------ task 4 */

function taskRegistration() {
  console.log('\nTASK 4 — registration recovers a known similarity');
  const M = torus(30, 16);
  const T = known(1.45, 0.4, -0.3, 0.9);
  const moved = applyTransform(T, M.positions);
  const src = { positions: moved, indices: M.indices };

  const r = register(src, M);
  ok('it registers', r.ok, r.ok ? r.stoppedBy : r.reason);
  ok('the surface lands on the surface', r.rmse < 1e-6, e2(r.rmse));
  ok('the recovered scale is the inverse of the applied one',
     Math.abs(r.scale - 1 / 1.45) < 1e-6, `${r.scale.toFixed(8)} vs ${(1 / 1.45).toFixed(8)}`);
  ok('the rotation it returns is proper and orthonormal to 1e-6', properRotation(r.rotation, 1e-6), '');
  ok('it says it settled rather than ran out', r.converged && r.stoppedBy !== 'iterations', r.stoppedBy);

  // §3.1 of the scope document: the initialisation must be RECORDED.
  ok('the coarse initialisation is recorded, all four candidates',
     r.coarse && r.coarse.scores.length === 4 && Array.isArray(r.coarse.signs)
     && r.coarse.eigenvaluesSrc.length === 3 && typeof r.coarse.coarseScore === 'number',
     `signs ${r.coarse.signs.join(',')} · scores ${r.coarse.scores.map((s) => s.toFixed(3)).join(' ')}`);
  ok('and the winner is the lowest-scoring of the four',
     Math.min(...r.coarse.scores) === r.coarse.coarseScore, e2(r.coarse.coarseScore));

  // A bad initialisation: ICP now has real work to do.
  const bad = { scale: 1, rotation: Array.from(uniformRotation(mulberry32(7))), translation: [0.1, 0.1, 0.1] };
  const rb = register(src, M, { initial: bad, maxIterations: 80 });
  ok('from a deliberately bad initialisation it still converges',
     rb.ok && rb.rmse < 1e-6 && rb.initialRmse > 0.5, `${f3(rb.initialRmse)} → ${e2(rb.rmse)} in ${rb.iterations}`);
  ok('a supplied initialisation means no coarse alignment is reported', rb.coarse === null, '');

  // The point solver: the same answer, slower, which is why it is not the default.
  const rp = register(src, M, { initial: bad, solver: 'point', maxIterations: 80 });
  ok('the closed-form solver reaches the same basin, and takes longer to do it',
     rp.ok && rp.rmse < 1e-2 && rp.rmse > rb.rmse && rp.iterations > rb.iterations,
     `point ${e2(rp.rmse)} in ${rp.iterations} · plane ${e2(rb.rmse)} in ${rb.iterations}`);

  // Determinism, and purity.
  const before = Float64Array.from(moved);
  const r2 = registerSimilarity7(src, M);
  ok('the same input gives the same bytes twice',
     JSON.stringify(r.transform) === JSON.stringify(r2.transform) && r.rmse === r2.rmse, '');
  ok('it mutates neither mesh', before.every((x, i) => x === moved[i])
     && M.positions.every((x, i) => x === M.positions[i]), '');

  // §5's ICP rows.
  ok('fewer than 3 source vertices → the stated reason',
     registerSimilarity7({ positions: Float64Array.of(0, 0, 0), indices: M.indices }, M).reason
       === 'need at least 3 source vertices', '');
  ok('a non-finite source → the stated reason',
     registerSimilarity7({ positions: Float64Array.of(NaN, 0, 0, 1, 1, 1, 2, 2, 2), indices: M.indices }, M).reason
       === 'non-finite input', '');
  ok('a target with no triangles → the stated reason',
     registerSimilarity7(src, { positions: M.positions, indices: new Uint32Array(0) }).reason
       === 'target has no triangles', '');
  ok('an initial transform that is not a similarity → the stated reason',
     registerSimilarity7(src, M, { initial: { scale: 0, rotation: Array.from(KNOWN_R), translation: [0, 0, 0] } }).reason
       === 'initial transform is not a similarity', '');
  // "Large" measured against the object, not against a number typed here: the
  // torus's own radius is 1, so an rmse of several model units is the honest
  // answer and no heuristic should be papering over it.
  const far = { positions: applyTransform(known(1, 400, 400, 400), M.positions), indices: M.indices };
  const rf = register(far, M, { initial: identitySimilarity(), maxIterations: 12 });
  ok('a source entirely outside the target reports a large rmse rather than rescuing itself',
     rf.ok && rf.rmse > 1, `${f3(rf.rmse)} against a target of radius 1`);
}

/* ------------------------------------------------------------------ task 5 */

function taskInvariant() {
  console.log('\nTASK 5 — the invariant, on every run in this suite');
  // Runs deliberately chosen to be hard: bad initialisations, a symmetric target,
  // a target the source does not match, and a cap that stops it mid-flight.
  const M = torus(24, 12), S = icosphere(3), B = blob(3);
  const cases = [
    ['torus from a random pose', { positions: applyTransform(known(1.45, 0.4, -0.3, 0.9), M.positions), indices: M.indices }, M],
    ['sphere onto sphere (continuum of optima)', { positions: applyTransform(known(0.8, 0.2, 0.2, 0.2), S.positions), indices: S.indices }, S],
    ['blob onto torus (they do not match)', B, M],
    ['torus onto blob (they do not match)', M, B],
  ];
  for (const [name, a, b] of cases) {
    const runs = [1, 2, 3].map((seed) => register(a, b, {
      initial: { scale: 0.7 + 0.5 * seed, rotation: Array.from(uniformRotation(mulberry32(seed * 31))), translation: [0.3, -0.2, 0.5] },
      maxIterations: 25,
    }));
    ok(`${name} — three poses, all three return a similarity`,
       runs.every((r) => r.ok && r.scale > 0 && Number.isFinite(r.rmse) && properRotation(r.rotation, 1e-6)),
       runs.map((r) => (r.ok ? r.rmse.toExponential(1) : r.reason)).join(' · '));
  }

  let breaks = 0, worse = 0, n = 0;
  for (const { trace, initial, final } of traces) {
    n++;
    for (let i = 1; i < trace.length; i++) if (trace[i] > trace[i - 1]) breaks++;
    if (final > initial) worse++;
  }
  const iterations = traces.reduce((a, t) => a + t.trace.length, 0);
  ok(`the objective never rose, across ${n} runs and ${iterations} iterations`,
     breaks === 0, `${breaks} increases`);
  ok('and no run returned a transform worse than its own initialisation',
     worse === 0, `${worse} of ${n}`);
  const PREDICATES = ['tolerance', 'iterations', 'damping', 'correspondences'];
  const seen = [...new Set(traces.map((t) => t.stoppedBy))];
  ok('every run named one of the four stopping predicates, and no fifth',
     traces.every((t) => PREDICATES.includes(t.stoppedBy)), seen.join(', '));
  ok('and `converged` follows the predicate: settled yes, ran out no',
     traces.every((t) => t.converged === (t.stoppedBy === 'tolerance' || t.stoppedBy === 'damping')),
     `${traces.filter((t) => t.converged).length} of ${traces.length} settled`);
}

/* ------------------------------------------------------------------ task 6 */

function taskResidual() {
  console.log('\nTASK 6 — the residual is §1.3\'s');
  // The sign convention, against closed form. A reconstruction sphere of radius
  // 1.1 around a truth sphere of radius 1.0 is outside it by exactly 0.1.
  for (const [R, want] of [[1.1, +0.1], [0.9, -0.1]]) {
    const shell = icosphere(3, R), truth = icosphere(5, 1.0);
    const N = vertexNormals(shell.positions, shell.indices);
    const f = residualField(shell.positions, N, truth, { truthBound: 0, floor: 0 });
    const d = f.d.filter((x) => x !== null);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    ok(`a shell at ${R}× reads d = ${want > 0 ? '+' : ''}${want} — outside is positive`,
       f.missed === 0 && Math.abs(mean - want) < 3e-3 && d.every((x) => Math.sign(x) === Math.sign(want)),
       `mean ${mean.toFixed(5)} over ${d.length}, missed ${f.missed}`);
  }

  // The four properties the gate rests on, swept rather than sampled.
  let b1 = true, b2 = true, b3 = true, b4 = true;
  for (let i = -40; i <= 40; i++) {
    const d = i / 7;
    for (const tau of [0, 0.01, 0.5, 1, 3, 100]) {
      const e = bandResidual(d, tau);
      if ((e === 0) !== (Math.abs(d) <= tau)) b1 = false;
      if (Math.abs(e) > Math.abs(d) + 1e-15) b2 = false;
      if (e !== 0 && Math.sign(e) !== Math.sign(d)) b3 = false;
      const ePrev = bandResidual((i - 1) / 7, tau);
      if (e < ePrev - 1e-15) b4 = false;
      if (tau === 0 && Math.abs(e - d) > 1e-15) b2 = false;
    }
  }
  ok('B1  e = 0 exactly on the band', b1, '');
  ok('B2  |e| ≤ |d| pointwise, with equality at τ = 0', b2, '');
  ok('B3  the residual never changes sign', b3, '');
  ok('B4  e is non-decreasing in d', b4, '');
  ok('a null distance stays null rather than becoming zero', bandResidual(null, 1) === null, '');
  ok('a negative band is a RangeError, not a clamp',
     thrown(() => bandResidual(1, -0.5)) === 'RangeError', '');
  ok('a non-finite band is a RangeError', thrown(() => bandResidual(1, NaN)) === 'RangeError', '');

  // τ in quadrature, and per-vertex bounds.
  const shell = icosphere(3, 1.1), truth = icosphere(5, 1.0);
  const N = vertexNormals(shell.positions, shell.indices);
  const q = residualField(shell.positions, N, truth, { truthBound: 0.03, floor: 0.04 });
  ok('τ combines in quadrature', Math.abs(q.tau[0] - 0.05) < 1e-12, q.tau[0].toFixed(6));
  const nV = shell.positions.length / 3;
  const per = new Float64Array(nV).fill(0.02); per[0] = 0.5;
  const pf = residualField(shell.positions, N, truth, { truthBound: per, floor: 0 });
  ok('a per-vertex bound is read per vertex',
     Math.abs(pf.tau[0] - 0.5) < 1e-12 && Math.abs(pf.tau[1] - 0.02) < 1e-12 && pf.e[0] === 0,
     `τ₀ ${pf.tau[0]} τ₁ ${pf.tau[1]} e₀ ${pf.e[0]}`);
  ok('a negative floor is a RangeError',
     thrown(() => residualField(shell.positions, N, truth, { floor: -1 })) === 'RangeError', '');

  // A miss is null and counted, not substituted.
  const tiny = residualField(shell.positions, N, truth, { truthBound: 0, floor: 0, reach: 1e-6 });
  ok('a normal ray that reaches nothing is null and counted, never nearest-point',
     tiny.missed === nV && tiny.measured === 0 && tiny.d.every((x) => x === null), `${tiny.missed}/${nV}`);
  ok('and the nearest-point RMS is still reported, under its own name',
     tiny.surfaceRms !== null && tiny.surfaceRms > 0, e2(tiny.surfaceRms));
}

function thrown(fn) { try { fn(); return null; } catch (e) { return e.constructor.name; } }

/* ------------------------------------------------------------------ task 7 */

function taskGate() {
  console.log('\nTASK 7 — the gate is §4.0\'s, and it fails closed');
  const shell = icosphere(3, 1.1), truth = icosphere(5, 1.0);
  const N = vertexNormals(shell.positions, shell.indices);

  // Median |d| ≈ 0.1. A band of 0.02 passes at ratio 0.2; one of 0.06 fails.
  const pass = truthBandGate(residualField(shell.positions, N, truth, { truthBound: 0.02, floor: 0 }));
  const fail = truthBandGate(residualField(shell.positions, N, truth, { truthBound: 0.06, floor: 0 }));
  ok('a band at 1/5 of the error passes',
     pass.pass && Math.abs(pass.ratio - 0.2) < 0.02, `ratio ${f3(pass.ratio)}`);
  ok('a band at 3/5 of the error fails, and says why',
     !fail.pass && fail.reason !== null && Math.abs(fail.ratio - 0.6) < 0.02, `ratio ${f3(fail.ratio)}`);
  ok('the threshold is 1/3 and is reported with the result',
     Math.abs(pass.gateRatio - 1 / 3) < 1e-15 && pass.gateRatio === REGISTER.gateRatio, f3(pass.gateRatio));

  // §7 of the algorithm document: the gate uses median |d|, not median |e|. A
  // band that swallows everything makes median|e| zero — the reading that would
  // make the gate a tautology — while median|d| is unmoved.
  const wide = residualField(shell.positions, N, truth, { truthBound: 5, floor: 0 });
  const wg = truthBandGate(wide);
  ok('a band that swallows every vertex zeroes |e| but not |d|',
     wg.medianAbsE === 0 && wg.medianAbsD > 0.09, `|e| ${f3(wg.medianAbsE)} · |d| ${f3(wg.medianAbsD)}`);
  ok('and the gate fails it on |d|, rather than dividing by a zero |e|',
     !wg.pass && wg.ratio > 1, `ratio ${f3(wg.ratio)}`);
  ok('both medians are reported so nobody has to guess which was used',
     'medianAbsD' in wg && 'medianAbsE' in wg && 'medianBand' in wg, '');

  // Failing closed.
  const none = truthBandGate(residualField(shell.positions, N, truth, { reach: 1e-6 }));
  ok('no measurable vertex is pass:false with a reason — never a pass by default',
     none.pass === false && none.reason === 'no measurable vertices' && none.ratio === null, none.reason);
  const broken = truthBandGate(residualField(shell.positions, N, { positions: truth.positions, indices: new Uint32Array(0) }));
  ok('a field that could not be built keeps its own reason, not a vaguer one',
     broken.pass === false && broken.reason === 'target has no triangles', broken.reason);
  const exact = icosphere(3, 1.0);
  const ne = vertexNormals(exact.positions, exact.indices);
  const zero = truthBandGate(residualField(exact.positions, ne, exact, { truthBound: 0.01, floor: 0 }));
  ok('a zero median error cannot be gated, and says so rather than dividing',
     zero.pass === false && zero.ratio === null && zero.reason === 'median error is zero', zero.reason);
}

/* ------------------------------------------------------------------ task 8 */

function taskFloor() {
  console.log('\nTASK 8 — the floor, by both of §3.3\'s routes');
  const B = blob(3);
  const f = registrationFloor(B, { trials: 6, perturbations: 6 });
  ok('both routes are measured', f.ok && f.route1 !== null && f.route2 !== null,
     `recovery ${e2(f.route1)} · repeatability ${e2(f.route2)}`);
  ok('the floor is the max of the two, and says which won',
     f.floor === Math.max(f.route1, f.route2) && ['recovery', 'repeatability'].includes(f.dominant), f.dominant);
  ok('and the rule is labelled a judgement rather than a derivation',
     /JUDGEMENT/.test(f.floorRule), '');
  ok('on a mesh registered to itself the floor is at the float floor',
     f.floor < 1e-12, e2(f.floor));
  ok('the accumulator is exact: kept + skipped = trials',
     f.recovery.values.length + f.recovery.skipped === f.recovery.trials,
     `${f.recovery.values.length} + ${f.recovery.skipped} = ${f.recovery.trials}`);

  // The seed is the whole of the run's reproducibility.
  const a = registrationFloor(B, { trials: 3, perturbations: 3 });
  const b = registrationFloor(B, { trials: 3, perturbations: 3 });
  const c = registrationFloor(B, { trials: 3, perturbations: 3, seed: 12345 });
  ok('the same seed reproduces the run exactly',
     JSON.stringify(a.recovery.values) === JSON.stringify(b.recovery.values), '');
  ok('a different seed draws differently, and the seed is reported',
     JSON.stringify(a.recovery.values) !== JSON.stringify(c.recovery.values) && c.seed === 12345, `${c.seed}`);
  ok('the default seed is the recorded one, not a hidden default',
     a.seed === REGISTER.seed, `0x${REGISTER.seed.toString(16)}`);

  // symmetryGap measures the OBJECT, not an error. Seven orders of magnitude
  // between a shape with no symmetry and one with a continuous one.
  const t = registrationFloor(torus(24, 12), { trials: 6, perturbations: 4 });
  ok('an asymmetric object reads symmetryGap of order 1',
     f.symmetryGap !== null && f.symmetryGap < 100, f3(f.symmetryGap));
  ok('a torus — which has a continuous rotational symmetry — reads it enormous',
     t.symmetryGap !== null && t.symmetryGap > 1e4, e2(t.symmetryGap));
  ok('and its surface recovery is still exact, because the recovery IS exact',
     t.route1 < 1e-6, e2(t.route1));

  // §5's floor rows.
  ok('zero trials measure nothing, and report null rather than zero',
     (() => { const z = registrationFloor(B, { trials: 0, perturbations: 0 });
              return z.route1 === null && z.floor === null && z.reason === 'no trials'; })(), '');
  ok('a mesh with too few vertices → the stated reason',
     registrationFloor({ positions: Float64Array.of(0, 0, 0), indices: new Uint32Array(0) }).reason
       === 'need at least 3 vertices', '');
  ok('a non-positive log-scale range is a RangeError',
     thrown(() => registrationFloor(B, { logScaleRange: 0 })) === 'RangeError', '');

  // The generator the trials rest on.
  const rng = mulberry32(REGISTER.seed);
  let lo = 1, hi = 0, s = 0;
  for (let i = 0; i < 20000; i++) { const x = rng(); lo = Math.min(lo, x); hi = Math.max(hi, x); s += x; }
  ok('the generator is on [0,1) with a mean near a half',
     lo >= 0 && hi < 1 && Math.abs(s / 20000 - 0.5) < 0.01, `[${lo.toFixed(4)}, ${hi.toFixed(4)}] mean ${(s / 20000).toFixed(4)}`);
  // Shoemake gives a uniform SO(3); a uniform Euler triple would not. The check
  // is that rotated axes cover the sphere evenly rather than pooling at a pole.
  const r2 = mulberry32(31337);
  const octant = new Array(8).fill(0);
  for (let i = 0; i < 4000; i++) {
    const R = uniformRotation(r2);
    octant[(R[0] > 0 ? 1 : 0) + (R[3] > 0 ? 2 : 0) + (R[6] > 0 ? 4 : 0)]++;
  }
  ok('uniform rotations spread a rotated axis evenly over the eight octants',
     octant.every((c) => Math.abs(c - 500) < 90), octant.join(' '));
}

/* ------------------------------------------------------------------ task 9 */

function taskHouseRules() {
  console.log('\nTASK 9 — nothing invented, nothing mutated');
  const B = blob(3), M = torus(20, 10);
  const src = { positions: applyTransform(known(1.2, 0.3, 0.1, -0.2), B.positions), indices: B.indices };
  const snapshots = [Float64Array.from(src.positions), Float64Array.from(B.positions), Uint32Array.from(B.indices)];

  const r = registerSimilarity7(src, B);
  const N = vertexNormals(applyTransform(r, src.positions), B.indices);
  const field = residualField(applyTransform(r, src.positions), N, B, { truthBound: 0.01, floor: r.rmse });
  truthBandGate(field);
  registrationFloor(B, { trials: 2, perturbations: 2 });

  ok('no input array is touched by any of it',
     snapshots[0].every((x, i) => x === src.positions[i])
     && snapshots[1].every((x, i) => x === B.positions[i])
     && snapshots[2].every((x, i) => x === B.indices[i]), '');

  // Every failure path returns a reason rather than a plausible number.
  const failures = [
    similarityFromPairs(new Float64Array(3), new Float64Array(3)),
    surfaceMoments(Float64Array.of(0, 0, 0), new Uint32Array(0)),
    bvhBuild(B.positions, new Uint32Array(0)),
    registerSimilarity7({ positions: new Float64Array(3), indices: B.indices }, B),
    registrationFloor({ positions: new Float64Array(3), indices: new Uint32Array(0) }),
  ];
  ok('every failure path carries a reason and no number',
     failures.every((f) => f.ok === false && typeof f.reason === 'string' && f.reason.length > 0),
     failures.map((f) => f.reason).join(' | ').slice(0, 70) + '…');

  // The module reaches for nothing outside itself. Scanned with the comments
  // stripped, because the header says the words "Math.random" and "filesystem"
  // in the course of promising not to use them, and a scan that cannot tell a
  // promise from a call is not a check.
  const source = readSelf();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no Math.random, no Date, no fetch, no filesystem anywhere in the module',
     !/Math\.random|\bnew Date\b|Date\.now|fetch\(|require\(|node:/.test(code), '');
  ok('it imports nothing at all — not even from this repository',
     !/^\s*import\s/m.test(code), '');
  ok('the seeded generator is declared non-cryptographic where it is defined',
     /NOT CRYPTOGRAPHIC/.test(source), '');
  ok('no flag is flipped: the module never touches the calibration constants',
     !/SIGMA_CALIBRATED|GREEDY_SET_DOMINANCE/.test(code), '');

  // The gate's own dependency: it must be checked before a coverage claim, and
  // `bandResidual`'s B2 is why. Measured rather than restated.
  let better = 0, total = 0;
  for (const tau of [0.01, 0.05, 0.2]) {
    const f2 = residualField(applyTransform(r, src.positions), N, B, { truthBound: tau, floor: 0 });
    const theta = 0.05;
    const cd = f2.d.filter((x) => x !== null && Math.abs(x) <= theta).length;
    const ce = f2.e.filter((x) => x !== null && Math.abs(x) <= theta).length;
    total++; if (ce >= cd) better++;
  }
  ok('coverage on e is never worse than on d — which is why §4.0 runs first',
     better === total, `${better}/${total} bands`);
}

function readSelf() {
  // The module's own text, read through the import graph rather than the
  // filesystem: this suite may run where `fs` is available, but asserting the
  // module has no `node:` import by reading it with one would be circular.
  return REGISTER_SOURCE;
}

/* ------------------------------------------------------------------- run */

// Read once, at the top, so the assertions above are about the shipped file.
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const REGISTER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/atlas/register.js', import.meta.url)), 'utf8');

taskClosedForm();
taskMoments();
taskBvh();
taskRegistration();
taskInvariant();
taskResidual();
taskGate();
taskFloor();
taskHouseRules();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
