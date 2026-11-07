/* smartmesh — a mesh sized by the evidence.
 *
 * WHAT THIS IS. The reconstruction emits a surface-nets mesh of 80,000 to a
 * million triangles, one per grid cell on the shell, whether or not the
 * photograph could tell those cells apart. Every vertex also carries σ: the
 * scale of a predictive distribution of where the surface is along that
 * vertex's normal. Those two facts put together say how many triangles the
 * mesh is ENTITLED to. A triangle that can be replaced by its neighbours
 * without moving the surface by more than a small fraction of its own σ was
 * never resolved by the evidence — it was resolved by the grid.
 *
 * So this is a simplification whose budget is the uncertainty rather than a
 * number typed by the user. Each edge collapse is charged the area-weighted RMS
 * distance of the new vertex from the planes it now stands for (Garland &
 * Heckbert's quadric, normalised by the area it accumulated so that it is a
 * length and not a length² × area), and it is refused when that distance would
 * exceed κ·σ of the tighter endpoint. The triangle count is an OUTPUT. A caller
 * may still ask for a target, and gets it only as far as the budget allows; the
 * report says which of the two stopped the run.
 *
 * WHY κ AND NOT THE INTERVAL MULTIPLIER. Moving the surface by κσ adds an error
 * to a surface that already carries σ. Added in quadrature the exported scale
 * becomes σ·√(1+κ²): at κ = 0.25 that is 3.1%, which is less than the resolution
 * with which σ is known. The actual accumulated distance is kept per vertex and
 * folded into the σ the simplified mesh exports, so the attribute stays honest
 * about what was done to the surface rather than about what was allowed.
 *
 * WHAT THE QUADRIC MEASURES, AND WHAT IT DOES NOT. Distance to PLANES, extended
 * infinitely, not distance to the triangles that were removed. Near a fold the
 * two can differ. This is the classic weakness of the method and it is not
 * papered over: `meshDeviation` samples the simplified surface and measures its
 * true two-sided distance to the original, and that number — not the quadric —
 * is what the report and the tests quote as the deviation.
 *
 * WHAT "SMART" MEANS HERE AND WHAT IT DOES NOT. Detail goes where the evidence
 * is: on a sphere whose two hemispheres carry σ and 4σ, the tight hemisphere
 * comes out with about four times the triangle density, because at equal
 * curvature the admissible edge length scales as √σ. With ONE photograph the
 * far side carries the near side's σ — the mirror's own error is not measured by
 * anything, and the README says so — so it is simplified no more aggressively
 * than the front. Nothing here infers what the photograph could not.
 *
 * THE QUADS. The output is quad-dominant: adjacent triangles are paired where
 * the pair is planar and its four angles are near right angles, by a greedy
 * matching on the dual graph with one augmenting pass. That is a pairing of an
 * existing triangulation, not a retopology that follows curvature lines. It is
 * called what it is, and the fraction paired is reported. glTF has no quads, so
 * the GLB carries the triangles; the OBJ carries the quads.
 *
 * DETERMINISM. Same input → same output bytes. Ties in the priority queue are
 * broken by vertex index, and nothing here draws a random number.
 */

import { topology } from './topology.js';

export const SMART_MESH = {
  /** Fraction of σ one collapse may spend. σ·√(1+κ²) is the resulting inflation. */
  kappa: 0.25,
  /** Dihedral angle, degrees, above which an edge is a crease and is pinned. */
  featureDeg: 60,
  /** Weight on a crease or boundary constraint plane, relative to face area. */
  featureWeight: 100,
  /** Below this shape quality (1 = equilateral) a collapse's cost is penalised hard. */
  shapeFloor: 0.05,
  /** Fallback budget when nothing carries σ: this fraction of the bounding diagonal. */
  absoluteFraction: 0.005,
  /** Minimum score for two triangles to be written as a quad. */
  quadMinScore: 0.4,
  /** The same weld quantum topology() uses, so the two agree about what a vertex is. */
  weldQuantum: 16384,
};

/* ---------------------------------------------------------------- welding */

/**
 * Merge vertices that share a position, so a UV seam is not a boundary. The key
 * is the quantised position `topology()` uses, for the same reason it uses it:
 * exact and order-independent. Attributes come from the first duplicate met.
 */
export function weldMesh(positions, indices, quantum = SMART_MESH.weldQuantum) {
  const nV = positions.length / 3;
  const map = new Map(), rep = new Int32Array(nV), order = [];
  for (let i = 0; i < nV; i++) {
    const k = Math.round(positions[i*3] * quantum) + '_' + Math.round(positions[i*3+1] * quantum)
            + '_' + Math.round(positions[i*3+2] * quantum);
    let r = map.get(k);
    if (r === undefined) { r = order.length; map.set(k, r); order.push(i); }
    rep[i] = r;
  }
  const faces = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = rep[indices[t]], b = rep[indices[t+1]], c = rep[indices[t+2]];
    if (a === b || b === c || a === c) continue;
    faces.push(a, b, c);
  }
  return { rep, source: Int32Array.from(order), indices: Int32Array.from(faces) };
}

/* -------------------------------------------------------------- the heap */

// A binary heap that sifts a hole rather than swapping, so a push or a pop
// allocates nothing. Ties are broken on the vertex indices, for determinism.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  static less(x, y) { return x.c < y.c || (x.c === y.c && (x.u < y.u || (x.u === y.u && x.v < y.v))); }
  push(e) {
    const a = this.a;
    let i = a.length; a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(e, a[p])) break;
      a[i] = a[p]; i = p;
    }
    a[i] = e;
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop(), n = a.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2*i + 1; if (l >= n) break;
        const r = l + 1;
        const m = (r < n && Heap.less(a[r], a[l])) ? r : l;
        if (!Heap.less(a[m], last)) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

/* --------------------------------------------------------------- quadrics */
// A symmetric 4×4 stored as 10 numbers, plus the face area it accumulated as an
// 11th, so the error can be read back as an RMS distance.
const QN = 11;

function addPlane(Q, o, nx, ny, nz, d, w) {
  Q[o]   += w*nx*nx; Q[o+1] += w*nx*ny; Q[o+2] += w*nx*nz; Q[o+3] += w*nx*d;
  Q[o+4] += w*ny*ny; Q[o+5] += w*ny*nz; Q[o+6] += w*ny*d;
  Q[o+7] += w*nz*nz; Q[o+8] += w*nz*d;
  Q[o+9] += w*d*d;
}
// Dekker's splitting constant, 2²⁷ + 1: it cuts a double into two halves whose
// product is exact, which is what lets the error of a product be recovered.
const SPLIT = 134217729;

/**
 * The quadric at (x, y, z) — Σ w·(n·x + d)², evaluated with the bits the
 * expansion discards carried alongside the sum.
 *
 * WHY THIS IS NOT ONE EXPRESSION. The quantity is a sum of SQUARED plane
 * distances, so it is non-negative and it cannot cancel. The 10-coefficient
 * form above is the standard way to store it in constant space, and it buys
 * that space by turning the sum of squares into a sum of signed terms that are
 * individually enormous compared to the result. On a vertex whose planes nearly
 * pass through the evaluation point — which is every vertex a collapse is
 * actually a good idea at — those terms cancel to nothing.
 *
 * MEASURED, on `07_cube_beveled_highpoly` through this benchmark's own pipeline:
 * the cancellation ratio Σ|term| ∕ |Σ term| has a median of 9.1e9 and a maximum
 * of 3.5e16, so eps·ρ — the relative error a float64 evaluation is entitled to
 * — passes 1 at the top of that range. Of 5,344,452 evaluations, 35,334 (0.66%)
 * came out more than 1% away from the value exact rational arithmetic gives,
 * 8,501 came out NEGATIVE for a quantity that cannot be, and on 3,877 the
 * float64 result and the true value disagree on the sign. Adjudicated against
 * exact rationals on the 200 worst, the plain expression's worst relative error
 * is 5,654%; the version below is 6.3e-15 and never disagrees on the sign.
 *
 * THAT NUMBER IS NOT DECORATIVE. `candidate()` reads it back as
 * `rms = √(err2/w)` and `withinBudget` compares that to κ·σ, so it is the
 * quantity the whole "a mesh sized by the evidence" claim is enforced through.
 * A budget checked against a number that is sometimes noise is not a budget.
 *
 * The cost is one pass and two extra doubles. Per call this is 4.0× the single
 * expression it replaces (22.3M vs 117M calls/s here); end to end it does not
 * register, because even at five million calls per asset the evaluation is well
 * under a percent of SmartMesh's work — the measured corpus runtime is 0.99× of
 * what it was. The two scratch arrays are module scope rather than per call
 * because allocating them is what that 4.0× would otherwise become: the same
 * code with a closure per call runs at 6.4M. `qEval` never yields and is not
 * re-entrant, so reusing them is safe.
 *
 * The split recovers the error of A·B and the running sum recovers the error of
 * adding it on; `c` carries both and is added back at the end.
 */
const QA = new Float64Array(10), QB = new Float64Array(10);
const qEval = (Q, o, x, y, z) => {
  QA[0] = Q[o];       QB[0] = x*x;
  QA[1] = 2*Q[o+1];   QB[1] = x*y;
  QA[2] = 2*Q[o+2];   QB[2] = x*z;
  QA[3] = 2*Q[o+3];   QB[3] = x;
  QA[4] = Q[o+4];     QB[4] = y*y;
  QA[5] = 2*Q[o+5];   QB[5] = y*z;
  QA[6] = 2*Q[o+6];   QB[6] = y;
  QA[7] = Q[o+7];     QB[7] = z*z;
  QA[8] = 2*Q[o+8];   QB[8] = z;
  QA[9] = Q[o+9];     QB[9] = 1;
  let s = 0, c = 0;
  for (let i = 0; i < 10; i++) {
    const A = QA[i], B = QB[i], p = A * B;
    const ca = SPLIT*A, ah = ca - (ca - A), al = A - ah;
    const cb = SPLIT*B, bh = cb - (cb - B), bl = B - bh;
    c += ((ah*bh - p) + ah*bl + al*bh) + al*bl;   // the product's discarded bits
    const t = s + p, q = t - s;
    c += (s - (t - q)) + (p - q);                 // the sum's discarded bits
    s = t;
  }
  return s + c;
};

/** Solve the 3×3 normal equations into `out`; false when the quadric does not pin a point. */
function qOptimal(Q, o, out) {
  const a = Q[o], b = Q[o+1], c = Q[o+2], d = Q[o+4], e = Q[o+5], f = Q[o+7];
  const det = a*(d*f - e*e) - b*(b*f - c*e) + c*(b*e - c*d);
  const scale = Math.max(a, d, f, 1e-300);
  if (Math.abs(det) <= 1e-9 * scale * scale * scale) return false;
  const rx = -Q[o+3], ry = -Q[o+6], rz = -Q[o+8];
  const i00 = (d*f - e*e)/det, i01 = (c*e - b*f)/det, i02 = (b*e - c*d)/det;
  const i11 = (a*f - c*c)/det, i12 = (b*c - a*e)/det, i22 = (a*d - b*b)/det;
  out[0] = i00*rx + i01*ry + i02*rz; out[1] = i01*rx + i11*ry + i12*rz; out[2] = i02*rx + i12*ry + i22*rz;
  return true;
}

/* ------------------------------------------------------------- geometry */

function faceNormalArea(P, a, b, c, out) {
  const ax = P[a*3], ay = P[a*3+1], az = P[a*3+2];
  const ux = P[b*3]-ax, uy = P[b*3+1]-ay, uz = P[b*3+2]-az;
  const vx = P[c*3]-ax, vy = P[c*3+1]-ay, vz = P[c*3+2]-az;
  const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  const l = Math.hypot(nx, ny, nz);
  out[0] = nx; out[1] = ny; out[2] = nz; out[3] = l * 0.5;
  return l;
}

/** 4√3·area ∕ Σ edge², 1 for equilateral, 0 for a needle or a sliver. */
function triQuality(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx-ax, uy = by-ay, uz = bz-az, vx = cx-ax, vy = cy-ay, vz = cz-az;
  const wx = cx-bx, wy = cy-by, wz = cz-bz;
  const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  const area2 = Math.hypot(nx, ny, nz);
  const l2 = ux*ux+uy*uy+uz*uz + vx*vx+vy*vy+vz*vz + wx*wx+wy*wy+wz*wz;
  return l2 > 0 ? (2 * Math.sqrt(3) * area2) / l2 : 0;
}

/* ------------------------------------------------------------ simplify */

/**
 * Quadric edge-collapse simplification under a per-vertex error budget.
 *
 * @param {Float32Array|Float64Array} positions  welded, 3 per vertex
 * @param {Int32Array|Uint32Array} indices        3 per triangle, consistently wound
 * @param {object} o
 * @param {Float64Array|null} o.budget   per-vertex admissible RMS distance, model units
 * @param {number} [o.target]            stop when this many triangles remain
 * @param {Array<{data:Float32Array, k:number}>} [o.attrs]  linearly carried
 * @param {{joints:Uint16Array, weights:Float32Array}} [o.skin]  4 influences per vertex
 * @returns {{positions, indices, error, map, attrs, skin, stats}}  `error` is the
 *   per-vertex accumulated RMS distance; `map` sends each input vertex to its
 *   output vertex.
 */
export function simplify(positions, indices, o = {}) {
  validateInput(positions, indices);
  const budgetSource = o.budgetSource || (o.budget ? 'absolute' : 'none');
  const nV = positions.length / 3, nT0 = indices.length / 3;
  const P = Float64Array.from(positions);
  const F = Int32Array.from(indices);
  const alive = new Uint8Array(nT0).fill(1);
  const vAlive = new Uint8Array(nV).fill(1);
  const version = new Int32Array(nV);
  // Copied, because a survivor's budget is tightened to the smaller of the two
  // it merged: its exported σ is an interpolation of the two and so is never
  // below their minimum, which is what makes σ·√(1+κ²) a bound on the inflation
  // rather than a typical value.
  const budget = o.budget ? Float64Array.from(o.budget) : null;
  const target = o.target > 0 ? o.target : 0;
  const featCos = Math.cos((o.featureDeg ?? SMART_MESH.featureDeg) * Math.PI / 180);
  const featW = o.featureWeight ?? SMART_MESH.featureWeight;
  const shapeFloor = o.shapeFloor ?? SMART_MESH.shapeFloor;
  const attrs = (o.attrs || []).map((a) => ({ k: a.k, data: Float64Array.from(a.data) }));
  const skin = o.skin ? { joints: Float64Array.from(o.skin.joints), weights: Float64Array.from(o.skin.weights) } : null;

  // vertex → incident faces
  const vf = new Array(nV);
  for (let i = 0; i < nV; i++) vf[i] = [];
  for (let t = 0; t < nT0; t++) { vf[F[t*3]].push(t); vf[F[t*3+1]].push(t); vf[F[t*3+2]].push(t); }

  // ---- initial quadrics: every face, area-weighted
  const Q = new Float64Array(nV * QN);
  const tmp = new Float64Array(4);
  const fn = new Float64Array(nT0 * 3);
  for (let t = 0; t < nT0; t++) {
    const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
    const l = faceNormalArea(P, a, b, c, tmp);
    if (l <= 0) { alive[t] = 0; continue; }
    const nx = tmp[0]/l, ny = tmp[1]/l, nz = tmp[2]/l, area = tmp[3];
    fn[t*3] = nx; fn[t*3+1] = ny; fn[t*3+2] = nz;
    const d = -(nx*P[a*3] + ny*P[a*3+1] + nz*P[a*3+2]);
    addPlane(Q, a*QN, nx, ny, nz, d, area); Q[a*QN+10] += area;
    addPlane(Q, b*QN, nx, ny, nz, d, area); Q[b*QN+10] += area;
    addPlane(Q, c*QN, nx, ny, nz, d, area); Q[c*QN+10] += area;
  }

  // ---- creases and boundaries get a constraint plane, perpendicular to the
  // face through the edge, so their vertices can only slide along them
  const edgeFaces = new Map();
  const ekey = (a, b) => a < b ? a * nV + b : b * nV + a;
  for (let t = 0; t < nT0; t++) {
    if (!alive[t]) continue;
    for (let s = 0; s < 3; s++) {
      const k = ekey(F[t*3+s], F[t*3+(s+1)%3]);
      const arr = edgeFaces.get(k); if (arr) arr.push(t); else edgeFaces.set(k, [t]);
    }
  }
  let creases = 0, boundaries = 0;
  for (const [k, fs] of edgeFaces) {
    const a = Math.floor(k / nV), b = k % nV;
    let pin = false;
    if (fs.length === 1) { pin = true; boundaries++; }
    else if (fs.length === 2) {
      const t0 = fs[0], t1 = fs[1];
      const dot = fn[t0*3]*fn[t1*3] + fn[t0*3+1]*fn[t1*3+1] + fn[t0*3+2]*fn[t1*3+2];
      if (dot < featCos) { pin = true; creases++; }
    }
    if (!pin) continue;
    const ex = P[b*3]-P[a*3], ey = P[b*3+1]-P[a*3+1], ez = P[b*3+2]-P[a*3+2];
    const el2 = ex*ex + ey*ey + ez*ez;
    for (const t of fs) {
      // normal of the constraint plane = edge × face normal
      let nx = ey*fn[t*3+2] - ez*fn[t*3+1], ny = ez*fn[t*3] - ex*fn[t*3+2], nz = ex*fn[t*3+1] - ey*fn[t*3];
      const l = Math.hypot(nx, ny, nz); if (l <= 0) continue;
      nx /= l; ny /= l; nz /= l;
      const d = -(nx*P[a*3] + ny*P[a*3+1] + nz*P[a*3+2]);
      addPlane(Q, a*QN, nx, ny, nz, d, featW * el2);
      addPlane(Q, b*QN, nx, ny, nz, d, featW * el2);
    }
  }

  // ---- one-ring helpers. A ring is marked into `mark` with a fresh stamp and
  // listed into `ringBuf`, so building one allocates nothing — except that a
  // survivor's valence grows as it absorbs its neighbours, so the buffer is
  // regrown to the incident-face count before it is written, never truncated.
  const mark = new Int32Array(nV);
  let stamp = 0;
  let ringBuf = new Int32Array(64);
  const ring = (v) => {
    stamp++;
    let n = 0;
    if (ringBuf.length < 3 * vf[v].length) ringBuf = new Int32Array(3 * vf[v].length + 64);
    for (const t of vf[v]) {
      if (!alive[t]) continue;
      const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
      if (a !== v && mark[a] !== stamp) { mark[a] = stamp; ringBuf[n++] = a; }
      if (b !== v && mark[b] !== stamp) { mark[b] = stamp; ringBuf[n++] = b; }
      if (c !== v && mark[c] !== stamp) { mark[c] = stamp; ringBuf[n++] = c; }
    }
    return n;
  };
  const Qsum = new Float64Array(QN), opt = new Float64Array(3);

  // ---- cost of collapsing (u, v) to a point, or null when it must not happen
  // The worst shape among w0's faces once w0 sits at p, or −1 if one flips.
  const survivingQuality = (w0, other, px, py, pz) => {
    let qmin = 1;
    for (const t of vf[w0]) {
      if (!alive[t]) continue;
      const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
      if (a === other || b === other || c === other) continue;   // removed by the collapse
      const ax = a === w0 ? px : P[a*3], ay = a === w0 ? py : P[a*3+1], az = a === w0 ? pz : P[a*3+2];
      const bx = b === w0 ? px : P[b*3], by = b === w0 ? py : P[b*3+1], bz = b === w0 ? pz : P[b*3+2];
      const cx = c === w0 ? px : P[c*3], cy = c === w0 ? py : P[c*3+1], cz = c === w0 ? pz : P[c*3+2];
      const nx = (by-ay)*(cz-az) - (bz-az)*(cy-ay), ny = (bz-az)*(cx-ax) - (bx-ax)*(cz-az), nz = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
      const dot = nx*fn[t*3] + ny*fn[t*3+1] + nz*fn[t*3+2];
      if (!(dot > 0)) return -1;
      const q = triQuality(ax, ay, az, bx, by, bz, cx, cy, cz);
      if (q < qmin) qmin = q;
    }
    return qmin;
  };

  // The three tests a collapse must pass, each on its own so the census at the
  // end can say WHICH of them stands between the mesh and a smaller one.
  const cand = { px: 0, py: 0, pz: 0, rms: 0, err2: 0, elen: 0, t: 0 };
  // Candidate position and its cost: the quadric's optimum if it is well posed
  // and not absurd, else the best of the two ends and the midpoint.
  const candidate = (u, v) => {
    for (let i = 0; i < QN; i++) Qsum[i] = Q[u*QN+i] + Q[v*QN+i];
    const ux = P[u*3], uy = P[u*3+1], uz = P[u*3+2], vx = P[v*3], vy = P[v*3+1], vz = P[v*3+2];
    const elen = Math.hypot(vx-ux, vy-uy, vz-uz);
    const mx = (ux+vx)/2, my = (uy+vy)/2, mz = (uz+vz)/2;
    let px, py, pz;
    if (qOptimal(Qsum, 0, opt) && Math.hypot(opt[0] - mx, opt[1] - my, opt[2] - mz) <= 2 * elen) {
      px = opt[0]; py = opt[1]; pz = opt[2];
    } else {
      let best = qEval(Qsum, 0, ux, uy, uz); px = ux; py = uy; pz = uz;
      let c = qEval(Qsum, 0, vx, vy, vz); if (c < best) { best = c; px = vx; py = vy; pz = vz; }
      c = qEval(Qsum, 0, mx, my, mz); if (c < best) { best = c; px = mx; py = my; pz = mz; }
    }
    const err2 = Math.max(0, qEval(Qsum, 0, px, py, pz));
    const w = Qsum[10];
    cand.px = px; cand.py = py; cand.pz = pz; cand.err2 = err2; cand.elen = elen;
    cand.rms = w > 0 ? Math.sqrt(err2 / w) : 0;
    // where along the edge the new point landed, for the attributes
    let t = 0;
    if (elen > 0) {
      t = ((px-ux)*(vx-ux) + (py-uy)*(vy-uy) + (pz-uz)*(vz-uz)) / (elen*elen);
      t = Math.max(0, Math.min(1, t));
    }
    cand.t = t;
    return cand;
  };
  const withinBudget = (u, v, rms) => !budget || rms <= Math.min(budget[u], budget[v]);
  // The link condition (Dey et al.): the one-rings may meet only at the apexes
  // of the faces the edge belongs to, or the collapse pinches the surface into
  // something non-manifold. Also refuses an edge with more than two faces.
  const linkOK = (u, v) => {
    let nShared = 0;
    for (const t of vf[u]) {
      if (!alive[t]) continue;
      if (F[t*3] === v || F[t*3+1] === v || F[t*3+2] === v) nShared++;
    }
    if (nShared === 0 || nShared > 2) return false;
    ring(u);
    const stampU = stamp;
    let common = 0;
    for (const t of vf[v]) {
      if (!alive[t]) continue;
      // each neighbour of v once: unmark it as it is counted
      for (let s = 0; s < 3; s++) { const x = F[t*3+s]; if (x !== v && mark[x] === stampU) { mark[x] = 0; common++; } }
    }
    if (common !== nShared) return false;
    // The link condition alone admits one degenerate case: a face (u, x, y)
    // and a face (v, x, y) that are not the shared faces — on a tetrahedron
    // every edge is like this — and the collapse would fold them into two
    // coincident triangles of opposite winding, a closed surface with no
    // inside. Refuse it, so a closed mesh cannot be driven below four faces.
    for (const t of vf[u]) {
      if (!alive[t]) continue;
      const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
      if (a === v || b === v || c === v) continue;
      const x = a === u ? b : a, y = c === u ? b : c;
      for (const t2 of vf[v]) {
        if (!alive[t2]) continue;
        const a2 = F[t2*3], b2 = F[t2*3+1], c2 = F[t2*3+2];
        if (a2 === u || b2 === u || c2 === u) continue;
        const hasX = a2 === x || b2 === x || c2 === x, hasY = a2 === y || b2 === y || c2 === y;
        if (hasX && hasY) return false;
      }
    }
    return true;
  };
  // The faces that survive must not flip or degenerate; returns the worst shape.
  const flipOK = (u, v, px, py, pz) => Math.min(survivingQuality(u, v, px, py, pz), survivingQuality(v, u, px, py, pz));

  let refusedBudget = 0, refusedLink = 0, refusedFlip = 0;
  const evaluate = (u, v) => {
    // The budget first, because it is the cheapest test and refuses the most.
    const c = candidate(u, v);
    if (!withinBudget(u, v, c.rms)) { refusedBudget++; return null; }
    if (!linkOK(u, v)) { refusedLink++; return null; }
    const qmin = flipOK(u, v, c.px, c.py, c.pz);
    if (!(qmin >= 0)) { refusedFlip++; return null; }
    return { c: c.err2 / Math.max(shapeFloor, qmin), u, v, vu: version[u], vv: version[v],
             px: c.px, py: c.py, pz: c.pz, rms: c.rms, t: c.t };
  };

  // The queue holds a HINT, not a decision. An entry is stamped with its two
  // endpoints' versions, and an endpoint's version moves only when the vertex
  // itself moves; but the link condition and the flip test also depend on the
  // neighbours, which can move without touching either endpoint. So every entry
  // is re-evaluated when it surfaces, and collapses only if it is still legal
  // and still as cheap as it claimed — otherwise it is re-queued at its true
  // cost. `queued` remembers what is already in the heap at the current
  // versions, so a neighbourhood refresh does not pile up duplicates.
  // An edge refused for its BUDGET stays refused until one of its ends absorbs
  // something — the two quadrics are the only inputs to that test and each is
  // stamped by its vertex's version — so that refusal is remembered as −stamp
  // and not re-run on every nearby collapse. A refusal for the link or the flip
  // depends on the neighbours and is re-run.
  const heap = new Heap();
  const queued = new Map();
  let evaluations = 0, pops = 0, requeued = 0;
  const pushEdge = (u, v) => {
    const key = ekey(u, v), at = version[u] + version[v] + 1;
    const q = queued.get(key);
    if (q === at || q === -at) return;
    const before = refusedBudget;
    evaluations++;
    const e = evaluate(u, v);
    if (!e) { if (refusedBudget > before) queued.set(key, -at); return; }
    heap.push(e); queued.set(key, at);
  };
  for (const k of edgeFaces.keys()) pushEdge(Math.floor(k / nV), k % nV);

  // ---- the loop
  let nT = 0; for (let t = 0; t < nT0; t++) if (alive[t]) nT++;
  const errAcc = new Float64Array(nV);   // RMS distance the vertex has accumulated
  let collapses = 0;
  while (heap.size && (!target || nT > target)) {
    const hint = heap.pop(); pops++;
    const { u, v } = hint;
    if (!vAlive[u] || !vAlive[v] || version[u] !== hint.vu || version[v] !== hint.vv) continue;
    const e = evaluate(u, v);
    if (!e) continue;
    if (e.c > hint.c * (1 + 1e-9) + 1e-300) { heap.push(e); requeued++; continue; }
    // Collapse v into u.
    P[u*3] = e.px; P[u*3+1] = e.py; P[u*3+2] = e.pz;
    for (let i = 0; i < QN; i++) Q[u*QN+i] += Q[v*QN+i];
    errAcc[u] = e.rms;
    if (budget) budget[u] = Math.min(budget[u], budget[v]);
    for (const a of attrs) for (let k = 0; k < a.k; k++)
      a.data[u*a.k+k] = (1 - e.t) * a.data[u*a.k+k] + e.t * a.data[v*a.k+k];
    if (skin) mergeSkin(skin, u, v, e.t);
    for (const t of vf[v]) {
      if (!alive[t]) continue;
      const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
      if (a === u || b === u || c === u) { alive[t] = 0; nT--; continue; }
      if (a === v) F[t*3] = u; if (b === v) F[t*3+1] = u; if (c === v) F[t*3+2] = u;
      vf[u].push(t);
    }
    vf[v] = []; vAlive[v] = 0;
    version[u]++;
    // the surviving faces' normals moved with the vertex
    for (const t of vf[u]) {
      if (!alive[t]) continue;
      const l = faceNormalArea(P, F[t*3], F[t*3+1], F[t*3+2], tmp);
      if (l > 0) { fn[t*3] = tmp[0]/l; fn[t*3+1] = tmp[1]/l; fn[t*3+2] = tmp[2]/l; }
    }
    // every edge at u is a new edge, and every edge one ring out has a new
    // neighbourhood — an edge refused earlier for its link or its flip may be
    // legal now, so the two-ring is offered to the queue again
    const nAround = ring(u);
    const around = ringBuf.slice(0, nAround).sort();
    for (const x of around) pushEdge(u, x);
    for (const x of around) {
      for (const t of vf[x]) {
        if (!alive[t]) continue;
        const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
        if (a !== u && b !== u && c !== u) { pushEdge(a, b); pushEdge(b, c); pushEdge(c, a); }
      }
    }
    collapses++;
  }

  // ---- why it stopped: a census of the edges that remain, each put through
  // all three tests independently. `refused*` above count refusals over the
  // whole run and say what the queue met along the way; this says what stands
  // between the mesh as it is now and a smaller one, which is the question a
  // caller with an unmet target is asking.
  const census = { remainingEdges: 0, overBudget: 0, linkBlocked: 0, flipBlocked: 0, collapsible: 0 };
  {
    const seen = new Set();
    for (let t = 0; t < nT0; t++) {
      if (!alive[t]) continue;
      for (let s = 0; s < 3; s++) {
        const a = F[t*3+s], b = F[t*3+(s+1)%3];
        const k = ekey(a, b); if (seen.has(k)) continue; seen.add(k);
        census.remainingEdges++;
        const c = candidate(a, b);
        const ob = !withinBudget(a, b, c.rms), lb = !linkOK(a, b), fb = !(flipOK(a, b, c.px, c.py, c.pz) >= 0);
        if (ob) census.overBudget++;
        if (lb) census.linkBlocked++;
        if (fb) census.flipBlocked++;
        if (!ob && !lb && !fb) census.collapsible++;
      }
    }
  }
  const targetReached = !!target && nT <= target;
  // Precedence when several kinds of edge remain: the budget is the evidence
  // saying no, and outranks the two structural refusals; topology outranks
  // geometry because a link failure is permanent where a flip may not be.
  let stoppingReason;
  if (targetReached) stoppingReason = 'target-reached';
  else if (census.overBudget > 0) stoppingReason = budgetSource === 'sigma' ? 'uncertainty-budget' : 'absolute-budget';
  else if (nT === 4 && census.remainingEdges === 6) stoppingReason = 'minimum-topology';   // a closed tetrahedron
  else if (census.linkBlocked > 0) stoppingReason = 'topology-constraint';
  else if (census.flipBlocked > 0) stoppingReason = 'geometry-constraint';
  else stoppingReason = 'no-valid-collapse';

  // ---- compact
  const map = new Int32Array(nV).fill(-1);
  let nOut = 0;
  for (let i = 0; i < nV; i++) if (vAlive[i] && vf[i].some((t) => alive[t])) map[i] = nOut++;
  const outP = new Float64Array(nOut * 3), outE = new Float64Array(nOut);
  const outAttrs = attrs.map((a) => ({ k: a.k, data: new Float32Array(nOut * a.k) }));
  const outSkin = skin ? { joints: new Uint16Array(nOut * 4), weights: new Float32Array(nOut * 4) } : null;
  for (let i = 0; i < nV; i++) {
    const j = map[i]; if (j < 0) continue;
    outP[j*3] = P[i*3]; outP[j*3+1] = P[i*3+1]; outP[j*3+2] = P[i*3+2];
    outE[j] = errAcc[i];
    attrs.forEach((a, ai) => { for (let k = 0; k < a.k; k++) outAttrs[ai].data[j*a.k+k] = a.data[i*a.k+k]; });
    if (skin) for (let s = 0; s < 4; s++) { outSkin.joints[j*4+s] = skin.joints[i*4+s]; outSkin.weights[j*4+s] = skin.weights[i*4+s]; }
  }
  const outF = new Uint32Array(nT * 3);
  let p = 0;
  for (let t = 0; t < nT0; t++) {
    if (!alive[t]) continue;
    outF[p++] = map[F[t*3]]; outF[p++] = map[F[t*3+1]]; outF[p++] = map[F[t*3+2]];
  }
  return {
    positions: outP, indices: outF, error: outE, map, attrs: outAttrs, skin: outSkin,
    stats: { trianglesIn: nT0, trianglesOut: nT, verticesIn: nV, verticesOut: nOut, collapses, evaluations, pops, requeued,
             creases, boundaries, refusedBudget, refusedLink, refusedFlip,
             // the coarse verdict, kept for callers that read it; `stoppingReason` is the precise one
             stoppedBy: targetReached ? 'target' : stoppingReason.endsWith('-budget') ? 'budget' : 'topology',
             stoppingReason, targetReached, census },
  };
}

/** The stopping reasons `simplify` can report, as a stable enumeration. */
export const STOPPING_REASONS = Object.freeze([
  'target-reached',        // the requested triangle count was met
  'uncertainty-budget',    // every further collapse would exceed κ·σ somewhere
  'absolute-budget',       // same, against an absolute or diagonal-fraction budget (no σ)
  'minimum-topology',      // the mesh is a closed tetrahedron: the smallest closed manifold
  'topology-constraint',   // remaining collapses would pinch the surface (link condition)
  'geometry-constraint',   // remaining collapses would flip or flatten a triangle
  'no-valid-collapse',     // nothing left to collapse at all
  'invalid-input',         // thrown, not returned: the mesh could not be simplified as given
]);

/** Refuse a mesh the simplifier cannot honestly process, with a machine-readable code. */
function validateInput(positions, indices) {
  const fail = (msg) => { const e = new Error(`smartMesh: ${msg}`); e.code = 'invalid-input'; throw e; };
  if (!positions || !indices) fail('positions and indices are required');
  if (positions.length % 3 !== 0) fail(`positions has ${positions.length} values, not a multiple of 3`);
  if (indices.length % 3 !== 0) fail(`indices has ${indices.length} values, not a multiple of 3`);
  const nV = positions.length / 3;
  if (nV === 0 || indices.length === 0) fail('the mesh is empty');
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) fail(`position ${Math.floor(i / 3)} is not finite`);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!(v >= 0 && v < nV) || v !== Math.floor(v)) fail(`index ${i} (${v}) is out of range for ${nV} vertices`);
  }
}

/** Merge two 4-influence skins at (1−t, t), keep the four largest, renormalise. */
function mergeSkin(skin, u, v, t) {
  const acc = new Map();
  for (let s = 0; s < 4; s++) {
    const ju = skin.joints[u*4+s], wu = skin.weights[u*4+s] * (1 - t);
    if (wu > 0) acc.set(ju, (acc.get(ju) || 0) + wu);
    const jv = skin.joints[v*4+s], wv = skin.weights[v*4+s] * t;
    if (wv > 0) acc.set(jv, (acc.get(jv) || 0) + wv);
  }
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
  let sum = 0; for (const [, w] of top) sum += w;
  for (let s = 0; s < 4; s++) {
    skin.joints[u*4+s] = s < top.length ? top[s][0] : 0;
    skin.weights[u*4+s] = s < top.length && sum > 0 ? top[s][1] / sum : 0;
  }
}

/* ------------------------------------------------------------ normals */

export function areaNormals(P, F) {
  const n = P.length / 3, N = new Float32Array(n * 3), tmp = new Float64Array(4);
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t+1], c = F[t+2];
    faceNormalArea(P, a, b, c, tmp);
    for (const v of [a, b, c]) { N[v*3] += tmp[0]; N[v*3+1] += tmp[1]; N[v*3+2] += tmp[2]; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[i*3], N[i*3+1], N[i*3+2]) || 1;
    N[i*3] /= l; N[i*3+1] /= l; N[i*3+2] /= l;
  }
  return N;
}

/* -------------------------------------------------------------- quads */

/**
 * Pair adjacent triangles into quads where the pair is flat and square-ish.
 *
 * Score = planarity × angle regularity, each in [0, 1]: the cosine of the
 * dihedral angle, and 1 − max|θ − 90°|∕90° over the four corners. A concave
 * pair scores 0. Greedy on the dual graph by descending score, then one pass of
 * length-3 augmenting paths, which is where most of the remaining pairs are.
 *
 * @returns {{quads: Uint32Array, tris: Uint32Array, fraction, planarity: {max, p95}}}
 *   `quads` is 4 indices per face, wound like the triangles; `tris` the leftovers.
 */
export function pairQuads(positions, indices, minScore = SMART_MESH.quadMinScore) {
  const P = positions, F = indices, nT = F.length / 3;
  const fnrm = new Float64Array(nT * 3), tmp = new Float64Array(4);
  for (let t = 0; t < nT; t++) {
    const l = faceNormalArea(P, F[t*3], F[t*3+1], F[t*3+2], tmp);
    if (l > 0) { fnrm[t*3] = tmp[0]/l; fnrm[t*3+1] = tmp[1]/l; fnrm[t*3+2] = tmp[2]/l; }
  }
  // dual edges: (t0, t1) sharing directed edge a→b in t0 and b→a in t1
  const half = new Map();
  const nV = P.length / 3;
  for (let t = 0; t < nT; t++) for (let s = 0; s < 3; s++) half.set(F[t*3+s] * nV + F[t*3+(s+1)%3], t);
  const cand = [];
  const angleAt = (o, p, q) => {
    const ux = P[p*3]-P[o*3], uy = P[p*3+1]-P[o*3+1], uz = P[p*3+2]-P[o*3+2];
    const vx = P[q*3]-P[o*3], vy = P[q*3+1]-P[o*3+1], vz = P[q*3+2]-P[o*3+2];
    const c = (ux*vx + uy*vy + uz*vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  };
  for (let t0 = 0; t0 < nT; t0++) for (let s = 0; s < 3; s++) {
    const a = F[t0*3+s], b = F[t0*3+(s+1)%3], c = F[t0*3+(s+2)%3];
    const t1 = half.get(b * nV + a);
    if (t1 === undefined || t1 <= t0) continue;
    // the apex of t1 opposite the shared edge
    let d = -1;
    for (let k = 0; k < 3; k++) { const x = F[t1*3+k]; if (x !== a && x !== b) d = x; }
    if (d < 0) continue;
    const planar = fnrm[t0*3]*fnrm[t1*3] + fnrm[t0*3+1]*fnrm[t1*3+1] + fnrm[t0*3+2]*fnrm[t1*3+2];
    if (planar <= 0) continue;
    // quad a → d → b → c. Its corners at a and b are the SUMS of the two
    // triangles' angles there — measuring the angle c–a–d directly would fold a
    // reflex corner back under 180° — and it is convex iff both stay below it.
    const angs = [angleAt(a, c, b) + angleAt(a, b, d), angleAt(d, a, b),
                  angleAt(b, a, c) + angleAt(b, d, a), angleAt(c, a, b)];
    if (angs[0] >= 179 || angs[2] >= 179) continue;
    let dev = 0; for (const g of angs) dev = Math.max(dev, Math.abs(g - 90));
    const reg = Math.max(0, 1 - dev / 90);
    const score = planar * reg;
    if (score >= minScore) cand.push({ score, t0, t1, q: [a, d, b, c], planar });
  }
  cand.sort((x, y) => y.score - x.score || x.t0 - y.t0 || x.t1 - y.t1);
  const mate = new Int32Array(nT).fill(-1), pick = new Int32Array(nT).fill(-1);
  cand.forEach((c, i) => {
    if (mate[c.t0] >= 0 || mate[c.t1] >= 0) return;
    mate[c.t0] = c.t1; mate[c.t1] = c.t0; pick[c.t0] = i; pick[c.t1] = i;
  });
  // augmenting paths of length 3: free t — n, where n is mated to m, and m has
  // some other free partner o with acceptable score; swap n to t and m to o
  const byTri = new Array(nT); for (let t = 0; t < nT; t++) byTri[t] = [];
  cand.forEach((c, i) => { byTri[c.t0].push(i); byTri[c.t1].push(i); });
  for (let t = 0; t < nT; t++) {
    if (mate[t] >= 0) continue;
    let done = false;
    for (const i of byTri[t]) {
      if (done) break;
      const c = cand[i], n = c.t0 === t ? c.t1 : c.t0, m = mate[n];
      if (m < 0) continue;
      for (const j of byTri[m]) {
        const c2 = cand[j], o = c2.t0 === m ? c2.t1 : c2.t0;
        if (o === n || mate[o] >= 0) continue;
        mate[t] = n; mate[n] = t; pick[t] = i; pick[n] = i;
        mate[m] = o; mate[o] = m; pick[m] = j; pick[o] = j;
        done = true; break;
      }
    }
  }
  const quads = [], tris = [], plan = [];
  const seen = new Uint8Array(nT);
  for (let t = 0; t < nT; t++) {
    if (seen[t]) continue;
    if (mate[t] >= 0) {
      const c = cand[pick[t]];
      quads.push(...c.q); plan.push(Math.acos(Math.min(1, c.planar)) * 180 / Math.PI);
      seen[c.t0] = 1; seen[c.t1] = 1;
    } else { tris.push(F[t*3], F[t*3+1], F[t*3+2]); seen[t] = 1; }
  }
  plan.sort((a, b) => a - b);
  const nq = quads.length / 4;
  return {
    quads: Uint32Array.from(quads), tris: Uint32Array.from(tris),
    count: nq, fraction: nT ? (2 * nq) / nT : 0,
    planarity: { max: nq ? plan[nq - 1] : 0, p95: nq ? plan[Math.min(nq - 1, Math.floor(0.95 * nq))] : 0 },
  };
}

/* ------------------------------------------------------------ deviation */

// Ericson, Real-Time Collision Detection §5.1.5: closest point on a triangle.
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx-ax, aby = by-ay, abz = bz-az, acx = cx-ax, acy = cy-ay, acz = cz-az;
  const apx = px-ax, apy = py-ay, apz = pz-az;
  const d1 = abx*apx + aby*apy + abz*apz, d2 = acx*apx + acy*apy + acz*apz;
  if (d1 <= 0 && d2 <= 0) return apx*apx + apy*apy + apz*apz;
  const bpx = px-bx, bpy = py-by, bpz = pz-bz;
  const d3 = abx*bpx + aby*bpy + abz*bpz, d4 = acx*bpx + acy*bpy + acz*bpz;
  if (d3 >= 0 && d4 <= d3) return bpx*bpx + bpy*bpy + bpz*bpz;
  const vc = d1*d4 - d3*d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + v*abx - px, qy = ay + v*aby - py, qz = az + v*abz - pz;
    return qx*qx + qy*qy + qz*qz;
  }
  const cpx = px-cx, cpy = py-cy, cpz = pz-cz;
  const d5 = abx*cpx + aby*cpy + abz*cpz, d6 = acx*cpx + acy*cpy + acz*cpz;
  if (d6 >= 0 && d5 <= d6) return cpx*cpx + cpy*cpy + cpz*cpz;
  const vb = d5*d2 - d1*d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + w*acx - px, qy = ay + w*acy - py, qz = az + w*acz - pz;
    return qx*qx + qy*qy + qz*qz;
  }
  const va = d3*d6 - d5*d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + w*(cx-bx) - px, qy = by + w*(cy-by) - py, qz = bz + w*(cz-bz) - pz;
    return qx*qx + qy*qy + qz*qz;
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  const qx = ax + abx*v + acx*w - px, qy = ay + aby*v + acy*w - py, qz = az + abz*v + acz*w - pz;
  return qx*qx + qy*qy + qz*qz;
}

/** A uniform grid over a triangle soup, answering nearest-triangle distance. */
export function triangleGrid(P, F, cellsPerAxis = 48) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i+k]); mx[k] = Math.max(mx[k], P[i+k]); }
  const ext = Math.max(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2], 1e-9);
  const cell = ext / cellsPerAxis;
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((mx[k] - mn[k]) / cell) + 1));
  const cellOf = (x, k) => Math.max(0, Math.min(dims[k] - 1, Math.floor((x - mn[k]) / cell)));
  const buckets = new Map();
  const key = (i, j, k) => (i * dims[1] + j) * dims[2] + k;
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t+1], c = F[t+2];
    const lo = [0, 1, 2].map((k) => cellOf(Math.min(P[a*3+k], P[b*3+k], P[c*3+k]), k));
    const hi = [0, 1, 2].map((k) => cellOf(Math.max(P[a*3+k], P[b*3+k], P[c*3+k]), k));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const kk = key(i, j, k); const arr = buckets.get(kk); if (arr) arr.push(t / 3); else buckets.set(kk, [t / 3]);
    }
  }
  const dist = (x, y, z) => {
    const ci = cellOf(x, 0), cj = cellOf(y, 1), ck = cellOf(z, 2);
    let best = Infinity;
    const maxR = Math.max(...dims);
    for (let r = 0; r <= maxR; r++) {
      // everything in ring r is at least (r−1)·cell away
      if ((r - 1) * cell > Math.sqrt(best)) break;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i-ci), Math.abs(j-cj), Math.abs(k-ck)) !== r) continue;
        if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) continue;
        const arr = buckets.get(key(i, j, k)); if (!arr) continue;
        for (const ti of arr) {
          const a = F[ti*3], b = F[ti*3+1], c = F[ti*3+2];
          const d2 = pointTriDist2(x, y, z, P[a*3], P[a*3+1], P[a*3+2], P[b*3], P[b*3+1], P[b*3+2], P[c*3], P[c*3+1], P[c*3+2]);
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  };
  return { dist, cell, dims, diagonal: Math.hypot(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]) };
}

// Halton (2, 3), for a deterministic well-spread set of barycentric samples.
function halton(i, base) { let f = 1, r = 0; while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); } return r; }

/**
 * Points on a triangle mesh, spread by area: the vertices, plus interior
 * samples per triangle in proportion to its area, deterministic.
 */
export function surfacePoints(P, F, count) {
  const nT = F.length / 3, tmp = new Float64Array(4);
  const areas = new Float64Array(nT); let total = 0;
  for (let t = 0; t < nT; t++) { faceNormalArea(P, F[t*3], F[t*3+1], F[t*3+2], tmp); areas[t] = tmp[3]; total += tmp[3]; }
  const out = [];
  for (let i = 0; i < P.length; i += 3) out.push(P[i], P[i+1], P[i+2]);
  if (total <= 0) return { points: Float64Array.from(out), owner: null };
  const owner = [];
  for (let i = 0; i < P.length / 3; i++) owner.push(-1);
  let seq = 1;
  for (let t = 0; t < nT; t++) {
    const m = Math.min(64, Math.round(count * areas[t] / total));
    const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
    for (let s = 0; s < m; s++, seq++) {
      let r1 = Math.sqrt(halton(seq, 2)), r2 = halton(seq, 3);
      const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
      out.push(wa*P[a*3] + wb*P[b*3] + wc*P[c*3], wa*P[a*3+1] + wb*P[b*3+1] + wc*P[c*3+1], wa*P[a*3+2] + wb*P[b*3+2] + wc*P[c*3+2]);
      owner.push(t);
    }
  }
  return { points: Float64Array.from(out), owner: Int32Array.from(owner) };
}

/**
 * Two-sided sampled distance between two meshes: A's points to B's surface and
 * B's points to A's. `hausdorff` is the larger of the two maxima. Units are the
 * meshes' own; `relative` divides by A's bounding diagonal.
 */
export function meshDeviation(A, B, opts = {}) {
  const count = opts.samples || 20000;
  const side = (X, Y) => {
    const grid = triangleGrid(Y.positions, Y.indices);
    const { points } = surfacePoints(X.positions, X.indices, count);
    const d = new Float64Array(points.length / 3);
    for (let i = 0; i < d.length; i++) d[i] = grid.dist(points[i*3], points[i*3+1], points[i*3+2]);
    const s = Float64Array.from(d).sort();
    let sum = 0; for (const x of s) sum += x;
    return { n: s.length, mean: sum / s.length, p50: s[Math.floor(0.5 * (s.length-1))],
             p95: s[Math.floor(0.95 * (s.length-1))], max: s[s.length - 1], samples: d, diagonal: grid.diagonal };
  };
  const ab = side(A, B), ba = side(B, A);
  const diag = ba.diagonal;
  return { AtoB: ab, BtoA: ba, hausdorff: Math.max(ab.max, ba.max),
           relative: { AtoB: ab.max / diag, BtoA: ba.max / diag, hausdorff: Math.max(ab.max, ba.max) / diag },
           diagonal: diag };
}

/* -------------------------------------------------------------- quality */

/** Angle, shape and valence statistics of a triangle mesh. */
export function meshQuality(P, F) {
  const nT = F.length / 3, nV = P.length / 3;
  const minAng = new Float64Array(nT), q = new Float64Array(nT), area = new Float64Array(nT);
  const val = new Int32Array(nV), tmp = new Float64Array(4);
  const ang = (o, p, r) => {
    const ux = P[p*3]-P[o*3], uy = P[p*3+1]-P[o*3+1], uz = P[p*3+2]-P[o*3+2];
    const vx = P[r*3]-P[o*3], vy = P[r*3+1]-P[o*3+1], vz = P[r*3+2]-P[o*3+2];
    const c = (ux*vx + uy*vy + uz*vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  };
  const edges = new Set();
  for (let t = 0; t < nT; t++) {
    const a = F[t*3], b = F[t*3+1], c = F[t*3+2];
    minAng[t] = Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
    q[t] = triQuality(P[a*3], P[a*3+1], P[a*3+2], P[b*3], P[b*3+1], P[b*3+2], P[c*3], P[c*3+1], P[c*3+2]);
    faceNormalArea(P, a, b, c, tmp); area[t] = tmp[3];
    for (const [i, j] of [[a,b],[b,c],[c,a]]) edges.add(i < j ? i * nV + j : j * nV + i);
  }
  for (const e of edges) { val[Math.floor(e / nV)]++; val[e % nV]++; }
  const sorted = (x) => Float64Array.from(x).sort();
  const pct = (s, p) => s.length ? s[Math.floor(p * (s.length - 1))] : 0;
  const sa = sorted(minAng), sq = sorted(q), sv = sorted(val), sar = sorted(area);
  let vm = 0; for (const v of val) vm += v; vm /= Math.max(1, nV);
  let vs = 0; for (const v of val) vs += (v - vm) ** 2; vs = Math.sqrt(vs / Math.max(1, nV));
  let am = 0; for (const a of area) am += a; am /= Math.max(1, nT);
  let as = 0; for (const a of area) as += (a - am) ** 2; as = Math.sqrt(as / Math.max(1, nT));
  return {
    triangles: nT, vertices: nV, edges: edges.size,
    euler: nV - edges.size + nT,
    minAngle: { p5: pct(sa, 0.05), p50: pct(sa, 0.5), min: pct(sa, 0) },
    quality: { p5: pct(sq, 0.05), p50: pct(sq, 0.5) },
    valence: { mean: vm, sd: vs, p50: pct(sv, 0.5), max: pct(sv, 1) },
    area: { mean: am, cv: am > 0 ? as / am : 0, p50: pct(sar, 0.5) },
  };
}

/* ---------------------------------------------------------------- atlas */

/**
 * The atlas parameterisation IS the camera projection, so after the surface
 * has been simplified the UVs are not interpolated but re-derived: model
 * space → working grid through the frame `reconstruct` returned, then the
 * chart is chosen by which way the vertex faces and the seam re-split exactly
 * as the engine splits it. `frame` needs `w` and `h` of the working grid.
 */
export function reprojectAtlas(positions, normals, indices, frame, w, h) {
  const n = positions.length / 3;
  const { md, S, cx0, cy0, ccx, ccy, ccz, invD0 } = frame;
  const u0 = new Float32Array(n), v0 = new Float32Array(n), side = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const z = (positions[i*3+2] + ccz) * md / S;   // z_grid − zHalf
    const k = Math.max(1e-3, 1 - z * invD0);
    const x = (positions[i*3] + ccx) * md / S / k + cx0;
    const y = cy0 - (positions[i*3+1] + ccy) * md / S / k;
    u0[i] = Math.max(0, Math.min(1, x / w)); v0[i] = 1 - Math.max(0, Math.min(1, y / h));
    side[i] = normals[i*3+2] >= 0 ? 0 : 1;
  }
  return { u0, v0, side };
}

/* --------------------------------------------------------------- driver */

/**
 * Simplify a reconstruction (or any triangle mesh) to the resolution its
 * uncertainty supports, pair the result into quads, and measure what happened.
 *
 * `geo` may be what `reconstruct` returned — its `sigma`, `frame`, `stats.w/h`,
 * `sigStats.pxToModel`, per-vertex attributes and skin are picked up — or a
 * plain `{positions, indices, sigma?, ...}`.
 *
 * @param {object} [opts]
 * @param {number} [opts.kappa]        fraction of σ a collapse may spend (0.25)
 * @param {number} [opts.target]       a triangle count to stop at, if the budget allows
 * @param {number} [opts.maxError]     an absolute budget in model units, instead of σ
 * @param {number} [opts.sigmaScale]   σ units → model units (pxToModel)
 * @param {object} [opts.frame]        the engine's frame, for exact UVs
 * @param {number} [opts.w] [opts.h]   the working grid, for the same
 * @param {boolean} [opts.measure]     sample the true deviation (default true)
 */
export function smartMesh(geo, opts = {}) {
  const t0 = Date.now();
  if (!geo || !geo.positions || !geo.indices) {
    const e = new Error('smartMesh: geo.positions and geo.indices are required'); e.code = 'invalid-input'; throw e;
  }
  validateInput(geo.positions, geo.indices);
  const kappa = opts.kappa ?? SMART_MESH.kappa;
  const frame = opts.frame !== undefined ? opts.frame : (geo.frame || null);
  const w = opts.w || (geo.stats && geo.stats.w) || 0, h = opts.h || (geo.stats && geo.stats.h) || 0;
  const sigmaScale = opts.sigmaScale !== undefined ? opts.sigmaScale
    : (geo.sigStats && geo.sigStats.pxToModel) || 1;
  const nV0 = geo.positions.length / 3;

  // ---- weld the seam
  const weld = weldMesh(geo.positions, geo.indices);
  const nW = weld.source.length;
  const Pw = new Float64Array(nW * 3);
  for (let j = 0; j < nW; j++) { const i = weld.source[j]; Pw[j*3] = geo.positions[i*3]; Pw[j*3+1] = geo.positions[i*3+1]; Pw[j*3+2] = geo.positions[i*3+2]; }
  const pick = (arr, k) => {
    if (!(arr && arr.length === nV0 * k)) return null;
    const o = new Float32Array(nW * k);
    for (let j = 0; j < nW; j++) for (let c = 0; c < k; c++) o[j*k+c] = arr[weld.source[j]*k+c];
    return o;
  };
  const named = [['sigma', 1], ['agen', 1], ['aconf', 1], ['ao', 1], ['uvs', 2], ['baseColor', 3], ['confColor', 3]];
  const attrs = [], attrNames = [];
  for (const [name, k] of named) {
    const a = pick(opts[name] !== undefined ? opts[name] : geo[name], k);
    if (a) { attrs.push({ k, data: a }); attrNames.push(name); }
  }
  const rigIn = geo.rig && geo.rig.skinJoints ? geo.rig : (geo.skinJoints ? geo : null);
  const skin = rigIn && rigIn.skinJoints.length === nV0 * 4
    ? { joints: pick(rigIn.skinJoints, 4), weights: pick(rigIn.skinWeights, 4) } : null;

  // ---- the budget
  const sigmaIdx = attrNames.indexOf('sigma');
  let budget = null, budgetSource;
  let diag = 0;
  {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < Pw.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], Pw[i+k]); mx[k] = Math.max(mx[k], Pw[i+k]); }
    diag = Math.hypot(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]);
  }
  if (opts.maxError > 0) {
    budget = new Float64Array(nW).fill(opts.maxError); budgetSource = 'absolute';
  } else if (sigmaIdx >= 0) {
    budget = new Float64Array(nW);
    const s = attrs[sigmaIdx].data;
    for (let i = 0; i < nW; i++) budget[i] = kappa * s[i] * sigmaScale;
    budgetSource = 'sigma';
  } else {
    budget = new Float64Array(nW).fill(SMART_MESH.absoluteFraction * diag); budgetSource = 'diagonal';
  }
  const sigmaIn = sigmaIdx >= 0 ? Float32Array.from(attrs[sigmaIdx].data) : null;

  // ---- simplify
  const sim = simplify(Pw, weld.indices, { budget, budgetSource, target: opts.target, attrs, skin,
                                           featureDeg: opts.featureDeg, featureWeight: opts.featureWeight });
  const P = sim.positions, F = sim.indices, n = P.length / 3;
  const N = areaNormals(P, F);
  const out = {};
  attrNames.forEach((name, i) => { out[name] = sim.attrs[i].data; });

  // ---- σ carries what was done to it: the accumulated distance, in quadrature
  let inflation = null;
  const sigmaArrived = out.sigma ? Float32Array.from(out.sigma) : null;   // before inflation, for the allocation bins
  if (out.sigma) {
    const s = out.sigma, r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const before = s[i];
      s[i] = Math.hypot(before, sim.error[i] / sigmaScale);
      r[i] = before > 0 ? s[i] / before : 1;
    }
    const rs = r.sort();
    inflation = { p50: rs[Math.floor(0.5 * (n-1))], max: rs[n-1] };
  }

  // ---- UVs: exact from the frame, or carried
  let positions, normals, uvs, indices, dupCount = 0, uvMode;
  const attrsOut = { ...out };
  let skinOut = sim.skin;
  if (frame && w && h) {
    uvMode = 'reprojected';
    const { u0, v0, side } = reprojectAtlas(P, N, F, frame, w, h);
    const dup = new Map();
    const oP = [], oN = [], oUv = [], oA = {}, oSJ = [], oSW = [];
    for (const k of Object.keys(attrsOut)) if (k !== 'uvs') oA[k] = [];
    const kOf = (k) => named.find((x) => x[0] === k)[1];
    const emit = (v, want) => {
      oP.push(P[v*3], P[v*3+1], P[v*3+2]); oN.push(N[v*3], N[v*3+1], N[v*3+2]);
      oUv.push(want ? 0.5 + u0[v]*0.5 : u0[v]*0.5, v0[v]);
      for (const k of Object.keys(oA)) { const kk = kOf(k); for (let c = 0; c < kk; c++) oA[k].push(attrsOut[k][v*kk+c]); }
      if (skinOut) for (let s = 0; s < 4; s++) { oSJ.push(skinOut.joints[v*4+s]); oSW.push(skinOut.weights[v*4+s]); }
    };
    for (let v = 0; v < n; v++) emit(v, side[v]);
    let nOut = n;
    const remap = (v, want) => {
      if (side[v] === want) return v;
      const k = v*2 + want;
      const hit = dup.get(k); if (hit !== undefined) return hit;
      const r = nOut++; emit(v, want); dup.set(k, r); return r;
    };
    indices = new Uint32Array(F.length);
    for (let t = 0; t < F.length; t += 3) {
      const a = F[t], b = F[t+1], c = F[t+2];
      const want = (side[a] + side[b] + side[c]) >= 2 ? 1 : 0;
      indices[t] = remap(a, want); indices[t+1] = remap(b, want); indices[t+2] = remap(c, want);
    }
    dupCount = nOut - n;
    positions = new Float32Array(oP); normals = new Float32Array(oN); uvs = new Float32Array(oUv);
    for (const k of Object.keys(oA)) attrsOut[k] = new Float32Array(oA[k]);
    attrsOut.uvs = uvs;
    if (skinOut) skinOut = { joints: new Uint16Array(oSJ), weights: new Float32Array(oSW) };
  } else {
    uvMode = attrsOut.uvs ? 'interpolated' : 'none';
    positions = new Float32Array(P); normals = N; uvs = attrsOut.uvs || null; indices = F;
  }

  // ---- quads
  const quads = pairQuads(positions, indices);

  // ---- the report
  const topoIn = topology(geo.positions, geo.indices), topoOut = topology(positions, indices);
  const qualIn = meshQuality(Pw, weld.indices), qualOut = meshQuality(P, F);
  const errS = Float64Array.from(sim.error).sort();
  const pq = (s, p) => s.length ? s[Math.floor(p * (s.length - 1))] : 0;
  // budget use: the accumulated distance as a fraction of what was allowed
  let useMax = 0, useSum = 0;
  if (budget) {
    // sim.map: welded index → output index; walk survivors
    for (let i = 0; i < nW; i++) { const j = sim.map[i]; if (j < 0) continue; const u = budget[i] > 0 ? sim.error[j] / budget[i] : 0; if (u > useMax) useMax = u; useSum += u; }
  }
  const deviation = opts.measure === false ? null
    : meshDeviation({ positions: P, indices: F }, { positions: Pw, indices: weld.indices }, { samples: opts.samples || 20000 });
  // where the triangles went: area-weighted density by σ quartile and by
  // observed/completed, before and after
  const agenIdx = attrNames.indexOf('agen');
  const allocation = allocationReport(Pw, weld.indices, sigmaIn, agenIdx >= 0 ? attrs[agenIdx].data : null,
                                      P, F, sigmaArrived,
                                      agenIdx >= 0 ? sim.attrs[agenIdx].data : null);
  const report = {
    // The machine-readable verdict: what was asked, what was delivered, and
    // exactly what stopped it. `census` counts the edges that remain by which
    // test refuses them, so a mixed case is visible rather than summarised.
    stop: {
      requestedTriangles: opts.target > 0 ? opts.target : null,
      achievedTriangles: topoOut.triangles,
      targetReached: opts.target > 0 ? sim.stats.targetReached : null,
      stoppingReason: sim.stats.stoppingReason,
      census: sim.stats.census,
    },
    budget: { source: budgetSource, kappa: budgetSource === 'sigma' ? kappa : null,
              maxError: budgetSource === 'absolute' ? opts.maxError : budgetSource === 'diagonal' ? SMART_MESH.absoluteFraction * diag : null,
              target: opts.target || null, stoppedBy: sim.stats.stoppedBy,
              used: { max: useMax, mean: n ? useSum / n : 0 },
              refused: { budget: sim.stats.refusedBudget, link: sim.stats.refusedLink, flip: sim.stats.refusedFlip } },
    in: { vertices: nV0, welded: nW, triangles: topoIn.triangles, watertight: topoIn.watertight,
          boundary: topoIn.boundary, nonman: topoIn.nonman, shells: topoIn.shells, euler: qualIn.euler },
    out: { vertices: positions.length / 3, welded: n, triangles: topoOut.triangles, watertight: topoOut.watertight,
           boundary: topoOut.boundary, nonman: topoOut.nonman, shells: topoOut.shells, euler: qualOut.euler,
           seamDup: dupCount },
    ratio: topoIn.triangles ? topoOut.triangles / topoIn.triangles : 1,
    collapses: sim.stats.collapses, creases: sim.stats.creases, boundaries: sim.stats.boundaries,
    quadric: { p50: pq(errS, 0.5), p90: pq(errS, 0.9), max: pq(errS, 1), units: 'model' },
    deviation: deviation ? {
      simplifiedToOriginal: { mean: deviation.AtoB.mean, p95: deviation.AtoB.p95, max: deviation.AtoB.max },
      originalToSimplified: { mean: deviation.BtoA.mean, p95: deviation.BtoA.p95, max: deviation.BtoA.max },
      hausdorff: deviation.hausdorff, relative: deviation.relative.hausdorff, diagonal: deviation.diagonal,
      samples: deviation.AtoB.n + deviation.BtoA.n, units: 'model',
    } : null,
    sigma: out.sigma ? { inflation, scale: sigmaScale, units: 'as input' } : null,
    quality: { in: qualIn, out: qualOut },
    quads: { count: quads.count, fraction: quads.fraction, planarity: quads.planarity, leftoverTriangles: quads.tris.length / 3 },
    allocation,
    uv: uvMode,
    ms: Date.now() - t0,
  };
  return {
    positions, normals, uvs, indices,
    ...attrsOut,
    skinJoints: skinOut ? skinOut.joints : null, skinWeights: skinOut ? skinOut.weights : null,
    quads: quads.quads, tris: quads.tris,
    error: sim.error,
    report,
  };
}

/**
 * Triangle density before and after, split by σ quartile of the ORIGINAL mesh
 * and by observed/completed. Density is triangles per unit area; the ratio
 * "after ÷ before" per bucket is what shows detail being spent where the
 * evidence is. Output vertices are binned by the σ they arrived with.
 */
function allocationReport(P0, F0, sigma0, agen0, P1, F1, sigma1, agen1) {
  const tmp = new Float64Array(4);
  const bucketOf = (sigmaArr, thresholds) => (v) => {
    const s = sigmaArr[v];
    for (let b = 0; b < thresholds.length; b++) if (s <= thresholds[b]) return b;
    return thresholds.length;
  };
  const accum = (P, F, keyFn, nb) => {
    const area = new Float64Array(nb), tris = new Float64Array(nb);
    for (let t = 0; t < F.length; t += 3) {
      faceNormalArea(P, F[t], F[t+1], F[t+2], tmp);
      // a face is charged to each of its corners' buckets a third each
      for (const v of [F[t], F[t+1], F[t+2]]) { const b = keyFn(v); area[b] += tmp[3] / 3; tris[b] += 1 / 3; }
    }
    return { area, tris };
  };
  const out = {};
  if (sigma0 && sigma1) {
    const s = Float64Array.from(sigma0).sort();
    // quartile edges, deduplicated: a field with two values has two bins, not
    // four with two of them empty
    const th = [...new Set([0.25, 0.5, 0.75].map((p) => s[Math.floor(p * (s.length - 1))]))]
      .filter((x) => x < s[s.length - 1]);
    const before = accum(P0, F0, bucketOf(sigma0, th), th.length + 1);
    const after = accum(P1, F1, bucketOf(sigma1, th), th.length + 1);
    out.bySigma = th.concat([s[s.length - 1]]).map((sigmaMax, b) => ({
      sigmaMax, areaBefore: before.area[b], areaAfter: after.area[b],
      densityBefore: before.area[b] > 0 ? before.tris[b] / before.area[b] : 0,
      densityAfter: after.area[b] > 0 ? after.tris[b] / after.area[b] : 0,
    }));
  }
  if (agen0 && agen1) {
    const key = (arr) => (v) => arr[v] < 0.5 ? 0 : 1;
    const before = accum(P0, F0, key(agen0), 2), after = accum(P1, F1, key(agen1), 2);
    out.observed = { densityBefore: before.tris[0] / Math.max(1e-12, before.area[0]), densityAfter: after.tris[0] / Math.max(1e-12, after.area[0]), area: before.area[0] };
    out.completed = { densityBefore: before.tris[1] / Math.max(1e-12, before.area[1]), densityAfter: after.tris[1] / Math.max(1e-12, after.area[1]), area: before.area[1] };
  }
  return out;
}
