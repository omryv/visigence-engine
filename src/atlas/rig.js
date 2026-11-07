/* Atlas — a skeleton, for free, out of fields the reconstruction already needs.
 *
 * The pipeline computes a feature transform (`nearestSeedD`) so the texture fill
 * can be an exact Voronoi extension, and a regime diagnostic ρ = √u∕D that is
 * unbounded exactly at a waist. Between them those two already contain a
 * skeleton and its joints; this file reads it out rather than adding a
 * skeletonisation algorithm on the side.
 *
 * WHY THE MEDIAL TEST IS A SEPARATION AND NOT AN ANGLE
 *
 * atlas-core carries a hard-won note about this. An earlier pipeline declared a
 * pixel medial by comparing the DIRECTION to its own nearest boundary point
 * against a neighbour's, and one to two pixels in from any curved boundary those
 * two lattice directions disagree by more than any usable threshold from
 * rasterisation alone. On a disk of radius 60 it found 56 spurious medial pixels
 * carrying r ≈ 1.5 against 12 real ones carrying r ≈ 59, and the model came out
 * a puck with a 1.5px flange.
 *
 * The fix is to measure the SEPARATION of the nearest boundary points, not the
 * angle between them:
 *
 *     sep(x) = max over 8-neighbours y of  |seed(x) − seed(y)|
 *
 * A pixel is medial when two of its neighbours are served by boundary points
 * that are far apart — which is the "argmax attained by ≥2 seeds" condition,
 * made numerical. The margin is enormous rather than marginal: rasterisation
 * jitter moves a nearest seed by about a pixel, so a false positive scores
 * sep ≈ 1–2, while the centre of that same disk of radius 60 scores sep ≈ 120.
 * A threshold at 3px sits two orders of magnitude away from the noise it has to
 * reject, where the angle test had no such gap to sit in.
 *
 * WHAT THIS IS NOT
 *
 * It is a curve skeleton for skinning, not a topologically certified medial
 * axis. It is a tree by construction — every branch is traced back to one that
 * already exists — so it cannot contain a cycle even where the silhouette does
 * (a figure with a hand on a hip has a hole; the skeleton spans it and does not
 * encircle it). For rigging that is the right answer and it should not be read
 * as a claim about the homotopy type of the shape.
 */

/* --------------------------------------------------------------- constants */

// Medial threshold, in pixels of the working grid. Absolute rather than
// relative: it is rejecting rasterisation noise, whose scale is one pixel
// whatever the subject's size.
const LAMBDA = 3.0;
// Separation at which a pixel counts as fully medial for path cost.
const SEP_FULL = 6.0;
// How much more a path pays to leave the axis. High enough that a detour is
// never worth it, low enough that the search can still cross a gap where the
// medial set is broken by noise — which is why this is a soft cost and not a
// restriction of the domain.
const OFFAXIS = 12;
// A branch claims the tube of radius CAPTURE·A around itself. This is what
// prunes: anything inside a limb's own tube is that limb, not a new one.
const CAPTURE = 1.0;
// A branch survives if it is longer than BOTH a fraction of the subject's own
// largest ball radius and a fraction of the radius where it attaches.
//
// The attachment-relative test alone is not enough, and the failure is
// specific: where two limbs meet, the medial axis grows short spurs into the
// crotch, and there the attachment radius is the LIMB's (small), so the bar
// they have to clear is small too. On the test figure that left 9 branches for
// a 5-limbed subject — two 9px spurs at the hips clearing an 8.8px bar. The
// subject-scale term is the stable one: a bone shorter than half the largest
// ball radius is not a part, whatever it happens to be attached to.
const PRUNE_FRAC_AMAX = 0.55;
const PRUNE_FRAC_LOCAL = 0.55;
const PRUNE_MIN_PX = 5;
const MAX_BRANCHES = 24;
// Douglas–Peucker tolerance and minimum bone length, both as a fraction of the
// subject's own largest ball radius, so the joint count does not depend on how
// many pixels the subject happens to occupy.
//
// Both are deliberately COARSE, and the reason is a limit rather than a taste.
// A joint spacing finer than the part is thick does not describe the shape: you
// cannot resolve a bend shorter than the local ball radius, because the medial
// axis under that bend is not determined to better than that radius by the
// silhouette. Fitting to it fits noise. Measured at 0.055·amax the joint count
// on the test figure moved between 9 and 12 under a ±1.5° camera nudge — a
// change in the photograph, not in the subject — while the branch count did not
// move at all. The extra joints were Douglas–Peucker resolving wobble in the
// axis of a limb. At 0.20·amax the count holds.
const DP_TOL_FRAC = 0.20;
const MIN_BONE_FRAC = 0.55;
const MIN_BONE_PX = 4;
// ρ is unbounded exactly at a waist, so a waist is a local maximum in ρ along
// the branch. Both a floor and a prominence are required: the floor keeps a
// smooth limb from being split where ρ merely drifts, the prominence keeps a
// broad plateau from splitting at whichever sample happens to be highest.
//
// BOTH ARE QUANTILES OF THE SUBJECT'S OWN ρ, not absolute numbers. The textbook
// values — 1 for a disk, √2 for a strip — describe the field, not what a
// photographed subject reads: on the test figure ρ runs 1.37 to 1.89 over the
// whole medial axis, so an absolute floor at 1.30 sits below the entire range
// and gates nothing at all. This is the same fact buildVolume's `pmax` quantile
// exists for. A single view carries no absolute scale, so the reference has to
// come from the subject.
const RHO_FLOOR_Q = 0.55;        // quantile of ρ over the medial set
const RHO_PROM_FRAC = 0.15;      // × the subject's own ρ spread (p90 − p25)
const RHO_PROM_MIN = 0.04;
// SECOND WAIST CRITERION — a local minimum of A.
//
// ρ misses a whole family of waists, and the miss is structural rather than a
// matter of tuning. ρ = √u∕D comes out of a masked blur of radius 6 run four
// times on a coarse grid, so across a neck it is a PLATEAU, not a peak: measured
// on a dumbbell of two 46px lobes joined by a 9px neck, ρ reads 2.17 flat from
// the neck's left shoulder to its right one and then falls away to 1.07 over the
// far lobe. The prominence test — deliberately, and correctly — scores a ridge
// against its SHALLOWER flank, so a plateau whose left flank is level scores 0
// and is rejected. Worse, on that subject the neck sits at the FOOT of the
// branch: the root's own ball claims the near lobe out to the junction, so the
// branch begins at the neck and ρ's left flank is not on the branch at all.
//
// A has neither problem there. It is the full-resolution ball radius, it is not
// blurred, and it dips sharply and locally at exactly the pinch — 45px on the
// lobes, 8.5px through the neck. So a candidate fires if EITHER criterion passes
// ITS OWN prominence test. This is an addition and not a replacement: ρ is the
// better detector at an anatomical waist, where the silhouette narrows without
// the inscribed ball getting much smaller, and A is the better one at a pinch.
//
// Thresholds are quantiles of the subject's own A over the medial set, for the
// same reason ρ's are: a single view carries no absolute scale.
const A_CEIL_Q = 0.45;           // a waist must be thinner than this quantile of A
const A_PROM_FRAC = 0.15;        // × the subject's own A spread (p90 − p25)
const A_PROM_MIN_FRAC = 0.04;    // × amax, the floor RHO_PROM_MIN is to ρ
// How close to a run's extremum another sample has to be to count as tied with
// it, as a fraction of that run's own prominence. See the run-merge in
// waistSplits for why this cannot be a rounding epsilon.
const TIE_FRAC = 0.02;
// Skin falloff width, as a fraction of the bone's own ball radius. The brief is
// "normalised by ball radius": a limb 8px thick and a torso 50px thick get the
// same weight profile in units of their own thickness.
const SKIN_BETA = 0.75;
const MAX_INFLUENCES = 4;

/* ------------------------------------------------------------ medial axis */

/**
 * Separation of nearest boundary points, per pixel.
 * @param {Uint8Array} mask
 * @param {Int32Array} near  from nearestSeedD, seeded on the BACKGROUND
 */
export function medialSeparation(mask, near, w, h) {
  const N = w * h, sep = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const s = near[i]; if (s < 0 || s >= N) continue;
    const sx = s % w, sy = (s - sx) / w;
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx; if (!mask[j]) continue;
        const t = near[j]; if (t < 0 || t >= N) continue;
        const tx = t % w, ty = (t - tx) / w;
        const d = Math.hypot(tx - sx, ty - sy);
        if (d > best) best = d;
      }
    }
    sep[i] = best;
  }
  return sep;
}

/* ------------------------------------------------------------------ heap */
// Binary heap over (cost, pixel). Small and local so the module stays
// dependency-free; Dijkstra on a 360×360 grid never holds more than a few
// thousand entries.
function Heap() {
  const c = [], k = [];
  return {
    get size() { return k.length; },
    push(cost, key) {
      c.push(cost); k.push(key);
      let i = k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1; if (c[p] <= c[i]) break;
        [c[p], c[i]] = [c[i], c[p]]; [k[p], k[i]] = [k[i], k[p]]; i = p;
      }
    },
    pop() {
      const top = k[0], cost = c[0], last = k.length - 1;
      k[0] = k[last]; c[0] = c[last]; k.pop(); c.pop();
      let i = 0;
      for (;;) {
        const l = 2*i + 1, r = l + 1; let m = i;
        if (l < k.length && c[l] < c[m]) m = l;
        if (r < k.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]]; [k[m], k[i]] = [k[i], k[m]]; i = m;
      }
      return { key: top, cost };
    },
  };
}

/**
 * Geodesic distance inside the silhouette, with a cost that makes leaving the
 * medial axis expensive. Restricting the domain to the medial set instead would
 * be cheaper and much more brittle — the set is broken wherever noise dips sep
 * below threshold, and a broken domain silently disconnects a limb. A soft cost
 * always has a path.
 */
function geodesic(mask, sep, w, h, root) {
  const N = w * h, INF = Infinity;
  const g = new Float64Array(N).fill(INF);
  // Arclength along the tree — the true geometric length of the path Dijkstra
  // chose, accumulated alongside its cost.
  //
  // This exists because tips must NOT be picked by cost. Cost is 1 off-axis and
  // up to 13 on the rim, so the cost-farthest pixel is whichever rim pixel the
  // search reached most expensively — on the test figure that was a point on the
  // outside of the hip, 9px off the leg's own axis. Every leg branch therefore
  // stopped at the hip, the rest of the leg was traced as a sequence of 5–11px
  // fragments, and every one of those was pruned: the rig lost both feet and had
  // 24 traced branches for a 5-limbed figure. Cost decides where a path GOES;
  // arclength decides how far along it we are.
  const arc = new Float64Array(N).fill(INF);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const cost = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const m = Math.min(1, sep[i] / SEP_FULL);
    cost[i] = 1 + OFFAXIS * (1 - m);
  }
  const heap = Heap();
  g[root] = 0; arc[root] = 0; heap.push(0, root);
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
  while (heap.size) {
    const { key: i } = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    const x = i % w, y = (i - x) / w;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const j = yy * w + xx; if (!mask[j] || done[j]) continue;
      const len = (DX[d] && DY[d]) ? Math.SQRT2 : 1;
      const nd = g[i] + len * 0.5 * (cost[i] + cost[j]);
      if (nd < g[j]) { g[j] = nd; arc[j] = arc[i] + len; prev[j] = i; heap.push(nd, j); }
    }
  }
  return { g, arc, prev };
}

/* --------------------------------------------------------- branch tracing */

// Stamp the tube of radius CAPTURE·A around a path as claimed.
function claim(covered, path, A, mask, w, h) {
  for (const p of path) {
    const px = p % w, py = (p - px) / w;
    const r = Math.max(2, CAPTURE * A[p]), r2 = r * r, ri = Math.ceil(r);
    const y0 = Math.max(0, py - ri), y1 = Math.min(h - 1, py + ri);
    const x0 = Math.max(0, px - ri), x1 = Math.min(w - 1, px + ri);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - px, dy = y - py;
      if (dx*dx + dy*dy <= r2) { const j = y*w+x; if (mask[j]) covered[j] = 1; }
    }
  }
}

const plen = (path, w) => {
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i-1], b = path[i];
    L += Math.hypot((b % w) - (a % w), ((b - b % w) / w) - ((a - a % w) / w));
  }
  return L;
};

/**
 * Farthest-point tracing. Take the geodesically most distant pixel nothing has
 * claimed, walk the predecessor chain back until it meets something already
 * claimed, and that walk IS a branch — it runs along the axis because the cost
 * put it there. Repeat. Every branch after the first therefore attaches to one
 * that exists, which is what makes the result a tree rather than a set of
 * curves that have to be stitched afterwards.
 */
function traceBranches(mask, A, arc, prev, covered, w, h, root, amax) {
  const N = w * h, branches = [];
  const floor = Math.max(PRUNE_MIN_PX, PRUNE_FRAC_AMAX * amax);
  claim(covered, [root], A, mask, w, h);
  for (let iter = 0; iter < MAX_BRANCHES; iter++) {
    let far = -1, fg = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i] || covered[i] || !isFinite(arc[i])) continue;
      if (arc[i] > fg) { fg = arc[i]; far = i; }
    }
    if (far < 0) break;

    const path = [];
    let p = far, guard = 0;
    while (p >= 0 && !covered[p] && guard++ < N) { path.push(p); p = prev[p]; }
    const attach = p >= 0 ? p : root;
    path.reverse();                                   // attachment → tip
    path.unshift(attach);

    // The rest of the predecessor chain, attachment back to the root. It is not
    // part of the branch — every pixel on it is already claimed, and joints get
    // placed on it by whichever branch owns it — but it IS the branch's own
    // shape continuing backwards, and the waist detectors need it. A branch
    // begins wherever the claimed tube ran out, which for the first branch off a
    // thick root is at the far side of the root's ball: on a dumbbell of two
    // 46px lobes the root claims its whole lobe, so the branch starts AT the
    // neck and the neck's near flank is not on the branch at all. A dip with one
    // flank missing scores its prominence against nothing and is rejected. With
    // the stem the same dip scores 36.5px instead of 2.7px.
    const stem = [];
    let s = attach, sguard = 0;
    while (s >= 0 && sguard++ < N) { stem.push(s); if (s === root) break; s = prev[s]; }
    stem.reverse();                                   // root → attachment
    stem.pop();                                       // attach is path[0] already

    // Claim it either way: a spur that is not worth a bone is still explained
    // by the part it grows from, and leaving it unclaimed would make the search
    // return to it forever.
    claim(covered, path, A, mask, w, h);
    const need = Math.max(floor, PRUNE_FRAC_LOCAL * A[attach]);
    const len = plen(path, w);
    // Pruned branches are recorded too. A rig that silently drops a limb and a
    // rig that never saw one look identical from the outside, and only one of
    // them is a tuning problem.
    branches.push({ path, stem, attach, len, need, kept: len >= need && path.length >= 2 });
  }
  return branches;
}

/* ------------------------------------------------------- polyline → joints */

// Douglas–Peucker, iterative so a long limb cannot blow the stack.
function simplify(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n); keep[0] = 1; keep[n-1] = 1;
  const stack = [[0, n-1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const ux = bx - ax, uy = by - ay, uu = ux*ux + uy*uy;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d;
      if (uu < 1e-12) d = Math.hypot(px, py);
      else { const t = Math.max(0, Math.min(1, (px*ux + py*uy) / uu));
             d = Math.hypot(px - t*ux, py - t*uy); }
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Waists, from ρ. medialRatio is unbounded exactly at a waist and is already
 * computed and already smooth (it is built through a masked blur), so a waist is
 * a local maximum of ρ read along the branch. The prominence test is what stops
 * a slowly drifting ρ from being chopped at every sample above the floor.
 */
function waistSplits(rhoAlong, floor, prom) {
  const n = rhoAlong.length, out = [];
  if (n < 5) return out;
  const win = Math.max(2, Math.min(10, Math.round(n * 0.10)));
  // ρ comes through a masked blur of radius 6 run four times, so a real ridge
  // is flat to within rounding across several samples. A strict `>` test breaks
  // on that flatness and finds nothing; EPS lets a plateau count as a maximum,
  // and the run-merge below then returns one joint for it rather than a row.
  const EPS = 1e-4;
  for (let k = win; k < n - win; k++) {
    const v = rhoAlong[k];
    if (v < floor) continue;
    let isMax = true;
    for (let d = 1; d <= win; d++) {
      if (rhoAlong[k-d] > v + EPS || rhoAlong[k+d] > v + EPS) { isMax = false; break; }
    }
    if (!isMax) continue;
    // Topographic prominence: walk out along each flank until the profile rises
    // above this peak again (or the branch ends), and take the deepest point
    // reached. Then score against the SHALLOWER of the two flanks — a ridge that
    // only falls away on one side is a slope, not a waist.
    //
    // This has to walk rather than look inside the local-max window. Measuring
    // the flanks over the window alone compares the peak against its own
    // shoulders, which for anything smooth is the peak again: the first version
    // of this took `Math.max` of the right flank instead of `Math.min`, scored
    // every candidate at a prominence of ~0, and so could never return a waist
    // at all, on any input.
    let loL = v, loR = v;
    for (let i = k - 1; i >= 0 && rhoAlong[i] <= v + EPS; i--) loL = Math.min(loL, rhoAlong[i]);
    for (let i = k + 1; i < n && rhoAlong[i] <= v + EPS; i++) loR = Math.min(loR, rhoAlong[i]);
    const p = v - Math.max(loL, loR);
    if (p >= prom) out.push({ k, v, p });
  }
  // One joint per ridge, not a row of them. Candidates are grouped into RUNS —
  // consecutive candidates closer together than the window, transitively — and
  // each run yields a single index.
  //
  // Grouping transitively matters, because the alternative measures each new
  // candidate against the run's current representative rather than against its
  // neighbour. A ridge broader than the window then gets chopped into a
  // representative every `win` samples: on the dumbbell the neck is a 30-sample
  // plateau against a window of 10, so it returned three candidates for one
  // neck, and which of them survived the minimum-bone thinning was decided by
  // where the branch happened to start.
  //
  // Within a run the strongest sample wins, and where several tie the joint goes
  // at the MIDDLE of the tied stretch rather than at its first sample. A neck's
  // joint belongs at the neck, not at whichever shoulder the scan reached first.
  //
  // "Tie" has to be measured against the RUN'S OWN PROMINENCE, not against a
  // rounding epsilon, because on a plateau the argmax is decided by noise well
  // below anything the field can be said to resolve. Measured on the dumbbell:
  // A reads exactly 8.5000 across 26 samples of the neck and 8.4961 at the two
  // shoulders where the lobe arcs meet the bar — a 0.0039px sub-pixel
  // discretisation artefact, against a prominence of 36.5px. At a rounding
  // epsilon those two shoulders are the only "minima" and the joint lands 13px
  // off the neck's centre; at 2% of the prominence the whole flat stretch ties
  // and the joint lands in the middle of it.
  const kept = [];
  for (let i = 0; i < out.length; ) {
    let j = i + 1;
    while (j < out.length && out[j].k - out[j-1].k < win) j++;
    let best = -Infinity, bestP = 0;
    for (let t = i; t < j; t++) if (out[t].v > best) { best = out[t].v; bestP = out[t].p; }
    const band = Math.max(EPS, TIE_FRAC * bestP);
    const tied = [];
    for (let t = i; t < j; t++) if (out[t].v >= best - band) tied.push(out[t].k);
    kept.push(tied[tied.length >> 1]);
    i = j;
  }
  return kept;
}

/**
 * Waists, from A: the local MINIMA of the half-thickness along the branch.
 *
 * The same routine with the signal negated, rather than a second copy of the
 * peak-finder with every comparison flipped. `waistSplits` is the piece of this
 * file with the most history in it — a plateau test that has to admit ties, a
 * prominence walk that has to leave the window, a run-merge that has to keep the
 * strongest of a flat run — and a mirrored transcription of it would be a second
 * place for all three to be got wrong. Negating is exactly the same function:
 * a minimum of A below `ceil` with prominence p IS a maximum of −A above −ceil
 * with prominence p.
 */
function waistDips(aAlong, ceil, prom) {
  const neg = new Array(aAlong.length);
  for (let i = 0; i < aAlong.length; i++) neg[i] = -aAlong[i];
  return waistSplits(neg, -ceil, prom);
}

/* -------------------------------------------------------------- the rig */

/**
 * Build the skeleton and the skinning function.
 *
 * @param {object} f
 * @param {Uint8Array}   f.mask
 * @param {Float32Array} f.A     half-thickness (ball radius) — from buildVolume
 * @param {Float32Array} f.rho   regime diagnostic — from medialRatio
 * @param {Int32Array}   f.near  feature transform seeded on the background
 * @returns {{joints, bones, sep, stats, skinAt}}
 *
 * `joints[j] = {x, y, r, parent}` in working-grid pixels; `parent` is -1 at the
 * root. `bones[b] = {a, c, r, ...}` joins joint a to joint c.
 */
export function buildRig({ mask, A, rho, near, w, h }) {
  const N = w * h;
  const empty = { joints: [], bones: [], sep: new Float32Array(N),
                  stats: { joints: 0, bones: 0, branches: 0, medialPx: 0, rootR: 0, waists: 0 },
                  skinAt: () => ({ idx: [0,0,0,0], wt: [1,0,0,0] }) };

  const sep = medialSeparation(mask, near, w, h);

  // Root: the thickest genuinely medial pixel — the centre of the largest part,
  // which for a figure is the trunk. Falling back to the thickest pixel at all
  // keeps a subject too small to have a medial axis from returning nothing.
  let root = -1, rootA = -1, medialPx = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (sep[i] >= LAMBDA) {
      medialPx++;
      if (A[i] > rootA) { rootA = A[i]; root = i; }
    }
  }
  if (root < 0) for (let i = 0; i < N; i++) if (mask[i] && A[i] > rootA) { rootA = A[i]; root = i; }
  if (root < 0) return empty;

  let amax = 0;
  for (let i = 0; i < N; i++) if (mask[i] && A[i] > amax) amax = A[i];
  if (!(amax > 0)) return empty;

  const { g, arc, prev } = geodesic(mask, sep, w, h, root);
  const covered = new Uint8Array(N);
  const traced = traceBranches(mask, A, arc, prev, covered, w, h, root, amax);
  const branches = traced.filter((b) => b.kept);

  const dpTol = Math.max(0.8, DP_TOL_FRAC * amax);
  const minBone = Math.max(MIN_BONE_PX, MIN_BONE_FRAC * amax);

  // The waist thresholds, read off the subject's own ρ and A over the medial set.
  const rv = [], av = [];
  for (let i = 0; i < N; i++) if (mask[i] && sep[i] >= LAMBDA) { rv.push(rho[i] || 1); av.push(A[i]); }
  rv.sort((a, b) => a - b);
  av.sort((a, b) => a - b);
  const qOf = (arr, dflt) => (p) =>
    (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))] : dflt);
  const q = qOf(rv, 1), qa = qOf(av, amax);
  const rhoFloor = q(RHO_FLOOR_Q);
  const rhoProm = Math.max(RHO_PROM_MIN, RHO_PROM_FRAC * (q(0.90) - q(0.25)));
  const aCeil = qa(A_CEIL_Q);
  const aProm = Math.max(A_PROM_MIN_FRAC * amax, A_PROM_FRAC * (qa(0.90) - qa(0.25)));

  const joints = [];
  const bones = [];
  const addJoint = (px, py, r, parent) => {
    joints.push({ x: px, y: py, r: Math.max(0.75, r), parent });
    return joints.length - 1;
  };
  // Joints already placed, so a new branch can attach to one instead of
  // duplicating it. Linear scan: there are tens of joints, not thousands.
  const nearestJoint = (px, py) => {
    let bi = 0, bd = Infinity;
    for (let j = 0; j < joints.length; j++) {
      const d = Math.hypot(joints[j].x - px, joints[j].y - py);
      if (d < bd) { bd = d; bi = j; }
    }
    return bi;
  };

  addJoint(root % w, (root - root % w) / w, A[root], -1);
  let waistCount = 0, waistsRho = 0, waistsA = 0;

  for (const br of branches) {
    const pts = br.path.map((p) => [p % w, (p - p % w) / w]);

    // The waist detectors run over the branch WITH its stem in front of it, so
    // both flanks of a waist at the branch's foot are present; the joints are
    // placed on the branch alone, so a candidate that lands in the stem is
    // dropped rather than duplicating a joint the owning branch already made.
    const ctx = br.stem.concat(br.path);
    const off = br.stem.length;
    const rhoAlong = ctx.map((p) => rho[p] || 1);
    const aAlong = ctx.map((p) => A[p]);

    // Joint positions along the branch: the shape's own corners (Douglas–
    // Peucker) together with its waists, merged and ordered by arclength. A
    // waist fires if EITHER criterion passes its own prominence test — a ridge
    // in ρ, or a dip in A — so the two are a union and neither can veto the
    // other. Where both fire on the same sample the Set keeps one joint, and
    // the per-criterion counts below record that they agreed.
    const idxSet = new Set(simplify(pts, dpTol));
    const onBranch = (k) => k - off;
    const kRho = waistSplits(rhoAlong, rhoFloor, rhoProm).map(onBranch).filter((k) => k > 0);
    const kA = waistDips(aAlong, aCeil, aProm).map(onBranch).filter((k) => k > 0);
    waistsRho += kRho.length; waistsA += kA.length;
    for (const k of [...kRho, ...kA]) {
      if (!idxSet.has(k)) { idxSet.add(k); waistCount++; }
    }
    let ks = Array.from(idxSet).sort((a, b) => a - b);

    // Drop joints closer together than one bone length, keeping the ends.
    //
    // The anchor is ks[0] — the branch's ATTACHMENT POINT, which is never itself
    // made a joint. The joint it stands in for is `nearestJoint` below and can
    // sit a whole ball radius further back, so measuring the first bone from the
    // joint that will actually exist looks like the obvious correction. It was
    // tried, with the stem context above already in place, and it is worse:
    // relaxing the bar at the foot of a branch admits Douglas–Peucker corners
    // there, and a DP corner at a branch foot is axis wobble at a junction —
    // exactly the thing DP_TOL_FRAC was raised to 0.20·amax to stop resolving.
    // Measured on the test figure it took the joint count from a stable 8 to
    // 10, 9, 11, 9, 10, 10, 11 across the ±1.5° suite, and on the dumbbell it
    // did not move the neck joint at all — it only added a second joint 2px from
    // the attachment. So the anchor stays where it is.
    //
    // What it costs is honest and small: on the dumbbell the A-waist is found at
    // the centre of the neck and then thinned away against the attachment 18px
    // back, and the joint that survives is the ρ-waist at the neck's far
    // shoulder, 13–17px off centre. The neck splits either way; the split is not
    // centred on it. The real cause is that minBone is 0.55 of the subject's
    // GLOBAL largest ball radius — 24.8px here — while the neck's own radius is
    // 8.5px, so a bone five times the local thickness is being called too short.
    // A local bar would fix it and is a larger change than this addendum.
    const thinned = [ks[0]];
    for (let t = 1; t < ks.length - 1; t++) {
      const last = thinned[thinned.length - 1];
      if (Math.hypot(pts[ks[t]][0] - pts[last][0], pts[ks[t]][1] - pts[last][1]) >= minBone) thinned.push(ks[t]);
    }
    const endK = ks[ks.length - 1];
    if (thinned[thinned.length - 1] !== endK) {
      const last = thinned[thinned.length - 1];
      const d = Math.hypot(pts[endK][0] - pts[last][0], pts[endK][1] - pts[last][1]);
      // The tip always survives; if it landed too close to the previous joint,
      // it replaces it rather than adding a stub bone.
      if (d < minBone && thinned.length > 1) thinned[thinned.length - 1] = endK;
      else thinned.push(endK);
    }
    ks = thinned;
    if (ks.length < 2) continue;

    // The branch attaches to whatever joint is already nearest its foot.
    let parent = nearestJoint(pts[ks[0]][0], pts[ks[0]][1]);
    for (let t = 1; t < ks.length; t++) {
      const k = ks[t], p = br.path[k];
      const j = addJoint(pts[k][0], pts[k][1], A[p], parent);
      bones.push({ a: parent, c: j, r: Math.max(0.75, (joints[parent].r + joints[j].r) / 2) });
      parent = j;
    }
  }

  if (!bones.length) {
    // A subject with no extent worth a bone — a disk, or a blob smaller than
    // one joint spacing. One bone from the root to the farthest covered pixel
    // keeps the rig well-formed rather than absent.
    let far = root, fg = -1;
    for (let i = 0; i < N; i++) if (mask[i] && isFinite(arc[i]) && arc[i] > fg) { fg = arc[i]; far = i; }
    const j = addJoint(far % w, (far - far % w) / w, Math.max(0.75, A[far]), 0);
    bones.push({ a: 0, c: j, r: Math.max(0.75, (joints[0].r + joints[j].r) / 2) });
  }

  // Per-bone bounds, so skinning can reject a distant bone without a distance.
  for (const b of bones) {
    const p = joints[b.a], q = joints[b.c];
    const reach = 3 * SKIN_BETA * b.r;
    b.x0 = Math.min(p.x, q.x) - reach; b.x1 = Math.max(p.x, q.x) + reach;
    b.y0 = Math.min(p.y, q.y) - reach; b.y1 = Math.max(p.y, q.y) + reach;
    b.inv = 1 / (SKIN_BETA * b.r);
  }

  /**
   * Linear-blend skinning weights for a point on the working grid.
   *
   * A bone's influence falls off as a Gaussian in the point's distance from the
   * bone segment, measured in units of THAT BONE'S ball radius — so an 8px limb
   * and a 50px torso get the same weight profile in their own terms, which is
   * what "normalised by ball radius" has to mean for a subject that contains
   * both. The bone's share is then split between its two joints by where the
   * point projects along it, which is what makes the surface bend at a joint
   * instead of shearing across it.
   */
  const skinAt = (px, py) => {
    const acc = new Float64Array(joints.length);
    let any = 0;
    for (let bi = 0; bi < bones.length; bi++) {
      const b = bones[bi];
      if (px < b.x0 || px > b.x1 || py < b.y0 || py > b.y1) continue;
      const p = joints[b.a], q = joints[b.c];
      const ux = q.x - p.x, uy = q.y - p.y, uu = ux*ux + uy*uy;
      const vx = px - p.x, vy = py - p.y;
      const t = uu < 1e-9 ? 0 : Math.max(0, Math.min(1, (vx*ux + vy*uy) / uu));
      const d = Math.hypot(vx - t*ux, vy - t*uy);
      const z = d * b.inv;
      if (z > 3) continue;
      const wgt = Math.exp(-z * z);
      acc[b.a] += wgt * (1 - t); acc[b.c] += wgt * t;
      any = 1;
    }
    if (!any) {
      // Outside every bone's reach — take the nearest joint outright rather
      // than leaving the vertex unweighted.
      return { idx: [nearestJoint(px, py), 0, 0, 0], wt: [1, 0, 0, 0] };
    }
    // Top MAX_INFLUENCES by weight. glTF carries four, and four is also as many
    // as linear blending is well behaved with.
    const idx = [0, 0, 0, 0], wt = [0, 0, 0, 0];
    for (let j = 0; j < acc.length; j++) {
      const v = acc[j]; if (v <= 0) continue;
      for (let s = 0; s < MAX_INFLUENCES; s++) {
        if (v > wt[s]) { for (let t2 = MAX_INFLUENCES - 1; t2 > s; t2--) { wt[t2] = wt[t2-1]; idx[t2] = idx[t2-1]; }
                         wt[s] = v; idx[s] = j; break; }
      }
    }
    const sum = wt[0] + wt[1] + wt[2] + wt[3];
    if (sum > 0) for (let s = 0; s < MAX_INFLUENCES; s++) wt[s] /= sum;
    else { wt[0] = 1; idx[0] = nearestJoint(px, py); }
    return { idx, wt };
  };

  return { joints, bones, sep,
           // Kept so a test can assert on the structure that produced the
           // joints, not only on the count that came out of it.
           branches: traced.map((b) => ({
             attach: b.attach, len: b.len, need: b.need, kept: b.kept,
             tip: b.path[b.path.length - 1],
             tipX: b.path[b.path.length - 1] % w,
             tipY: (b.path[b.path.length - 1] - b.path[b.path.length - 1] % w) / w,
             rhoAlong: b.path.map((p) => rho[p] || 1),
             stem: b.stem.length,
             aAlong: b.path.map((p) => A[p]),
           })),
           stats: { joints: joints.length, bones: bones.length, branches: branches.length,
                    medialPx, rootR: rootA, waists: waistCount, amax,
                    // Per-criterion counts, so "which detector found it" is a
                    // measurement rather than an inference from the total. They
                    // overlap where both fired on the same sample, so they sum
                    // to at least `waists` and not to exactly it.
                    waistsRho, waistsA,
                    rhoFloor, rhoProm, aCeil, aProm },
           skinAt };
}

/**
 * Normalise four float weights so their FLOAT32 sum is 1.
 *
 * glTF requires the weights of a vertex to sum to 1, and validators check it on
 * the stored float32 values, not on the float64 the exporter divided in. Fixing
 * the residue up into the largest component keeps the error under one ulp of
 * that component instead of letting it land wherever rounding put it.
 */
export function normalizeWeightsF32(out, o) {
  let sum = Math.fround(0), big = 0;
  for (let s = 0; s < 4; s++) { sum = Math.fround(sum + out[o+s]); if (out[o+s] > out[o+big]) big = s; }
  if (sum === 0) { out[o] = 1; out[o+1] = out[o+2] = out[o+3] = 0; return; }
  if (sum !== 1) {
    for (let s = 0; s < 4; s++) out[o+s] = Math.fround(out[o+s] / sum);
    let s2 = Math.fround(0);
    for (let s = 0; s < 4; s++) s2 = Math.fround(s2 + out[o+s]);
    out[o+big] = Math.fround(out[o+big] + (1 - s2));
  }
}
