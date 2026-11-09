/* evidence.js — WORLDS FROM EVIDENCE: what was measured, as what a world says.
 *
 * ── the problem ──
 * terrain/condition.js makes statements about the ground true of a seed by
 * the least improbable change to its lattice: a height here, a waterline
 * along this line, the ground under this sightline. Until now somebody had to
 * WRITE those statements. But a great deal of what anybody knows about a
 * place arrives as evidence, not as statements: a table of surveyed spot
 * heights, a coastline traced off a chart, a photograph with mountains in it.
 * Each is a statement about the ground in disguise, and this module takes the
 * disguise off — evidence in, intent records out, records the existing solve
 * already knows how to meet. Nothing here changes the solve: a world
 * conditioned on evidence is a world conditioned on the records written
 * below, and once they are in a file it is those records, not this code,
 * that the ground depends on. (One function, refineRays, RUNS the solve —
 * to find where a ray needs holding — and what it returns is still only
 * records.)
 *
 * ── the three kinds of evidence ──
 *
 *   spot heights  [[x, z, h], …] → `point` records. One row each, so the cap
 *                 that binds is MAX_INTENT (48 records), not MAX_ROWS. A
 *                 survey with more points than that is THINNED, not cut: a
 *                 greedy farthest-point selection keeps the points that leave
 *                 the least of the plate far from any kept point, which is
 *                 what lets the least-norm solve say most about the whole of
 *                 it. Dropping the tail of the list would keep whichever
 *                 corner the survey happened to start in.
 *
 *   a coastline   [[x, z], …] → `shoreline` records. A traced line carries a
 *                 vertex every few metres, and every vertex of a shoreline is
 *                 a sample and every sample is one row (three with a side), so
 *                 a 1 000-vertex trace stated as written is a thousand rows of
 *                 detail the basis cannot draw (its finest cell is ~72 m on
 *                 the default world, condition.js). So the line is clipped to
 *                 the plate, decimated to vertices as far apart as SHORE_STEP allows —
 *                 the spacing the solver samples a line at anyway — and cut
 *                 into records of at most MAX_POLYLINE vertices and
 *                 SHORE_SAMPLES samples each, so every record is sampled at
 *                 SHORE_STEP exactly as the solver states it. Neighbouring
 *                 records share their joint vertex: a coast stated in pieces
 *                 must still be one coast.
 *
 *   a skyline     a photograph's sky/ground boundary, column by column →
 *                 `ray` records. A pixel above the skyline is sky, and sky
 *                 means the ray from the eye through that pixel met no ground
 *                 — as far as it went. So for each sampled column the ray
 *                 through the last sky pixel is a sightline the ground must
 *                 stay under, out to `maxDistance`: exactly condition.js's
 *                 `ray` with a stated far end. That is the SKY half of what
 *                 the photograph says, and the only half that is linear: the
 *                 ground half ("the ray just under the skyline is stopped
 *                 by ground SOMEWHERE along it") is a disjunction over every
 *                 distance, which no set of rows can state. When the distance
 *                 to the silhouette IS known — a depth estimate, a map, a
 *                 synthetic test — `ranges` says so per column, and that
 *                 column's ray ends there with `contact: true`: the ground at
 *                 the far end stands ON the line, which is a silhouette.
 *                 Without ranges no record carries contact, and that is the
 *                 honest default: a photograph alone does not know how far
 *                 away its mountains are. A fan of rays is also the one
 *                 statement here the solver needs help with: stated densely
 *                 its active set does not settle, so the rays are stated
 *                 sparsely and refineRays holds them between their samples
 *                 (SKYLINE_SAMPLES says what was measured).
 *
 * ── the focal length is evidence too, and it is never guessed ──
 * A pixel is a direction only through the lens: a column u pixels off the
 * centre is atan(u / f) off the optical axis, so a focal length wrong by 10 %
 * tilts every off-centre ray by up to 10 % of its angle and states sightlines
 * the photograph never showed. `focalPx` is therefore an INPUT, in pixels of
 * the image as given, and fromSkyline refuses (records: [], with a reason)
 * when it is missing or not positive rather than assuming a "typical" lens.
 * Where it comes from is the photograph's own EXIF: a reader such as
 * atlas-core's readLens(buf, w, h) (no longer in this repository) reads the declared focal length and
 * returns `fRel`, the focal length as a fraction of the image's long side,
 * so focalPx = fRel × max(width, height) — and `known: false` there means
 * there is no focal length to pass, not that one should be invented. A core
 * module imports only the core (tools/check-imports.mjs), so the caller reads
 * the lens and hands the number in.
 *
 * ── the registration gate ──
 * Evidence is measured with a tolerance — a survey's ±0.5 m, a chart's line
 * width — and a tolerance is a BAND, not a point: a world whose ground lies
 * anywhere inside it is not in error. bandResidual and registrationGate are
 * atlas-core's (register.js) band-aware residual and truth-band
 * gate, ported in spirit for held-out evidence (residual = what the world
 * says minus what was measured; see each function). The gate is the reason
 * the band can be trusted at all: widening a band can only make coverage look
 * better, so coverage measured on band-zeroed residuals is believed only when
 * the median band is at most a third of the median raw error — the ruler is
 * fine compared with what it measures — and an unmeasured gate never passes.
 *
 * ── determinism ──
 * Pure: no three.js, no DOM, no clock, no Math.random, no storage, and every
 * function returns fresh data. The selection and the cutting are floor, sqrt
 * and the four operations in a fixed order. fromSkyline turns yaw and pitch
 * into directions with Math.cos and Math.sin, which two engines may round a
 * bit apart; that is acceptable HERE and would not be in condition.js,
 * because the records are what a file stores — their doubles are the
 * statement, and the ground is a function of them, never of this conversion.
 *
 * Part of the procedural core (src/kernel/core/index.js, CORE_MODULES).
 */

import {
  MAX_INTENT, MAX_ROWS, MAX_POLYLINE, SHORE_STEP, SHORE_SAMPLES, INTENT_OPS,
  rowsFor, polylineSamples, normalizeIntent, intentErrors,
} from "../terrain/condition.js";
import { createHeightSampler } from "../terrain/heightfield.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/* ══ spot heights ═══════════════════════════════════════════════════════ */

/**
 * fromSpotHeights(points, { size, maxRecords = MAX_INTENT, op = "=" }) → {
 *   records   [{ type: "point", x, z, h, op }, …] in selection order
 *   kept      the input index of each record, in the same order
 *   dropped   valid points the record budget turned away (thinned)
 *   invalid   entries that were not three finite numbers, or (with `size`)
 *             lay off the plate, |x| or |z| over size/2 — a point off the
 *             plate is answered by bending ground ON it (condition.js)
 *   reason    null, or why there are no records at all
 * }
 * `op` is one of condition.js's INTENT_OPS ("=", ">=", "<="), the same for
 * every point. Anything else is refused — no records, with the reason —
 * rather than repaired: "<" read as "=" would state a height the survey
 * only bounded.
 * Thinning is greedy farthest-point selection, deterministic: the first point
 * kept is the one nearest the centroid of all valid points, and each next one
 * is the point farthest from every point kept so far; ties go to the lower
 * input index. Selection order is coarse-to-fine, so a caller who needs room
 * for other records can take a prefix and still have the spread. Two inputs
 * at the same (x, z) are a contradiction or a repeat; the second is the last
 * a farthest-point rule would choose, and under the budget both are kept —
 * the solve then meets them as nearly as one point can (its `miss` says).
 */
export function fromSpotHeights(points, { size, maxRecords = MAX_INTENT, op = "=" } = {}) {
  const half = finite(size) && size > 0 ? size / 2 : null;
  const cap = Math.max(0, Math.min(finite(maxRecords) ? Math.floor(maxRecords) : MAX_INTENT, MAX_INTENT));
  if (!INTENT_OPS.includes(op)) {
    return { records: [], kept: [], dropped: 0, invalid: 0, reason: `op ${JSON.stringify(op)} is not one of ${INTENT_OPS.join(" ")}` };
  }
  const valid = [];
  let invalid = 0;
  (Array.isArray(points) ? points : []).forEach((p, i) => {
    const okay = Array.isArray(p) && p.length >= 3 && finite(p[0]) && finite(p[1]) && finite(p[2])
      && (half === null || (Math.abs(p[0]) <= half && Math.abs(p[1]) <= half));
    if (okay) valid.push(i); else invalid++;
  });
  const n = valid.length;
  const take = Math.min(n, cap);
  const kept = [];
  if (take > 0) {
    const X = new Float64Array(n), Z = new Float64Array(n);
    let cx = 0, cz = 0;
    for (let k = 0; k < n; k++) { X[k] = points[valid[k]][0]; Z[k] = points[valid[k]][1]; cx += X[k]; cz += Z[k]; }
    cx /= n; cz /= n;
    // min squared distance to the kept set; −1 marks a kept point
    const near = new Float64Array(n);
    let first = 0, best = Infinity;
    for (let k = 0; k < n; k++) {
      const d = (X[k] - cx) * (X[k] - cx) + (Z[k] - cz) * (Z[k] - cz);
      if (d < best) { best = d; first = k; }
    }
    let pick = first;
    near.fill(Infinity);
    while (kept.length < take) {
      kept.push(pick);
      near[pick] = -1;
      let far = -1, at = -1;
      for (let k = 0; k < n; k++) {
        if (near[k] < 0) continue;
        const d = (X[k] - X[pick]) * (X[k] - X[pick]) + (Z[k] - Z[pick]) * (Z[k] - Z[pick]);
        if (d < near[k]) near[k] = d;
        if (near[k] > far) { far = near[k]; at = k; }
      }
      if (at < 0) break;
      pick = at;
    }
  }
  return {
    records: kept.map((k) => {
      const p = points[valid[k]];
      return { type: "point", x: p[0], z: p[1], h: p[2], op };
    }),
    kept: kept.map((k) => valid[k]),
    dropped: n - kept.length,
    invalid,
    reason: kept.length ? null : n ? "the record budget is zero" : "no valid [x, z, h] point to state",
  };
}

/* ══ a coastline ════════════════════════════════════════════════════════ */

/**
 * fromCoastline(polyline, { side, level, offset, size, maxRecords = MAX_INTENT,
 *                           maxRows = MAX_ROWS }) → {
 *   records    [{ type: "shoreline", points, side?, offset?, level? }, …]
 *   rows       the rows they state, by condition.js rowsFor — the solver's
 *              own count, so the budget below is the budget it enforces
 *   step       the mean distance between the samples the records state, m
 *   coarsened  true when the line at SHORE_STEP would not fit the budget
 *              and was stated more coarsely instead (below)
 *   vertices   { input, kept, deviation } — how many [x, z] pairs came in,
 *              how many the records carry (a shared joint counted once), and
 *              the farthest, in metres, that any vertex of the clipped line
 *              lies from the line the records state: what decimation and
 *              coarsening cost, so a caller can see it rather than trust it
 *   reason     null, or why there are no records
 * }
 * `side` and `offset` mean what they mean on a shoreline record (condition.js
 * vocabulary): walking the line from its first point, land is on `side`.
 * `offset` needs a side and is checked as the record will be (intentErrors:
 * a number, at least 12 m); a bad one is refused with the reason, not
 * dropped. `level` is the waterline in metres; give it — a record that
 * carries its level says everything its ground depends on (condition.js),
 * and without it the world's water.level is read at solve time.
 *
 * `size` is the world's plate. Give it: without it nothing is clipped, and a
 * line that runs off the plate comes back as records a world of that size
 * will refuse (js/worldfile.js validates with intentErrors and the size).
 * With it, every record returned has passed intentErrors for that size —
 * if the records would not, there are none, and `reason` says why.
 *
 * What is done to the line, in order:
 *   1. pairs that are not two finite numbers are skipped; consecutive
 *      repeats are merged.
 *   2. with `size`, the line is clipped to the plate (Liang–Barsky, per
 *      segment). A line that leaves the plate and comes back becomes two
 *      runs: they are two coasts, as far as this plate can say.
 *   3. each run is decimated: a vertex is kept when the next one would lie
 *      more than SHORE_STEP from the last one kept, and the run's ends
 *      always are — so consecutive kept vertices are as far apart as they
 *      can be without passing SHORE_STEP, which is the spacing the solver
 *      samples a line at anyway. Detail under SHORE_STEP is detail it
 *      samples past.
 *   4. each run is cut into records of at most MAX_POLYLINE vertices whose
 *      own samples (polylineSamples at SHORE_STEP) number at most
 *      SHORE_SAMPLES, so no record is sampled more coarsely than the step.
 *      Consecutive records share their joint vertex.
 * When that plan would exceed maxRows or maxRecords, every run is instead
 * re-decimated to the vertices nearest evenly spaced arc lengths and cut into
 * k equal records, for the largest k whose rows (rowsFor, as the solver
 * counts them) and records still fit — so the coast is stated whole and more
 * coarsely, never stated halfway (a coastline stated halfway is a different
 * coastline). If even one record a run cannot fit, there are no records, and
 * `reason` says so.
 *
 * Why k is searched rather than worked out. A record's rows are not its
 * share of the line: polylineSamples samples a record at SHORE_STEP until
 * that would pass SHORE_SAMPLES and then evenly at whatever spacing keeps it
 * there, and how many of a coarse record's segments that cuts depends on how
 * evenly its vertices fall. So the plan is costed by rowsFor, the solver's
 * own count, for each k from the at-step plan's record count (or maxRecords,
 * if less) down, and the first that fits is taken. Measured (tools/test/kernel/evidence.test.js, the 2 000-vertex spiral):
 * with a side, 2 records in 630 of 640 rows, the stated line at most 56 m
 * from the drawn one, and seed TMNR meets it (converged, nothing dropped);
 * without, 6 records in 583 rows, at most 10 m. Rows the
 * largest k leaves over are left: spending them would mean stating one piece
 * of the coast finer than the rest, and a coast detailed at one end and
 * coarse along the rest is not what was drawn either. `vertices.deviation`
 * is the price, reported.
 */
export function fromCoastline(polyline, { side, level, offset, size, maxRecords = MAX_INTENT, maxRows = MAX_ROWS } = {}) {
  const sided = side === "left" || side === "right";
  const recCap = Math.max(0, Math.min(finite(maxRecords) ? Math.floor(maxRecords) : MAX_INTENT, MAX_INTENT));
  const rowCap = Math.max(0, Math.min(finite(maxRows) ? Math.floor(maxRows) : MAX_ROWS, MAX_ROWS));
  const input = Array.isArray(polyline) ? polyline.length : 0;
  const none = (reason) => ({ records: [], rows: 0, step: null, coarsened: false, vertices: { input, kept: 0, deviation: null }, reason });

  if (side !== undefined && !sided) return none(`side ${JSON.stringify(side)} is not "left" or "right"`);
  if (offset !== undefined && !sided) return none("offset is a side's distance, and no side was given");
  if (level !== undefined && !finite(level)) return none(`level ${JSON.stringify(level)} is not a number`);
  if (sided && offset !== undefined) {
    const e = intentErrors([{ type: "shoreline", points: [[0, 0], [1, 0]], side, offset }]);
    if (e.length) return none(e[0].replace("terrain.intent[0].", ""));
  }

  const pts = [];
  for (const p of Array.isArray(polyline) ? polyline : []) {
    if (!(Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]))) continue;
    const last = pts[pts.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) return none("a coastline needs at least two distinct [x, z] points");

  const half = finite(size) && size > 0 ? size / 2 : null;
  const clipped = (half === null ? [pts] : clipToSquare(pts, half)).filter((r) => r.length >= 2);
  if (!clipped.length) return none("the coastline does not cross the plate");
  const runs = clipped.map(decimate);

  const make = (points) => {
    const rec = { type: "shoreline", points };
    if (sided) {
      rec.side = side;
      if (offset !== undefined) rec.offset = offset;
    }
    if (level !== undefined) rec.level = level;
    return rec;
  };
  /* rowsFor reads a NORMALISED record, whose sided offset is always present;
     the count does not depend on its value. */
  const rowsOf = (rec) => rowsFor(sided && rec.offset === undefined ? { ...rec, offset: 0 } : rec);

  // per run, its records; flattened at the end
  let plan = runs.map((run) => cutAtStep(run).map(make));
  const count = (p) => [sum(p, (rs) => sum(rs, rowsOf)), sum(p, (rs) => rs.length)];
  let coarsened = false;
  let [rows, nRec] = count(plan);
  if (rows > rowCap || nRec > recCap) {
    coarsened = true;
    const lens = runs.map(arcLength);
    const coarse = (k) => {
      /* k records shared among the runs by length, every run at least one:
         each extra record goes to the run whose records are longest. */
      const share = lens.map(() => 1);
      for (let left = k - runs.length; left > 0; left--) {
        let at = 0, most = -1;
        lens.forEach((l, i) => { const per = l / share[i]; if (per > most) { most = per; at = i; } });
        share[at]++;
      }
      return runs.map((run, i) => {
        const kk = Math.min(share[i], run.length - 1);
        const even = evenVertices(run, kk * (MAX_POLYLINE - 1) + 1);
        const per = Math.ceil((even.length - 1) / kk);
        const out = [];
        for (let a = 0; a < even.length - 1; a += per) out.push(make(even.slice(a, Math.min(a + per, even.length - 1) + 1)));
        return out;
      });
    };
    let found = null;
    for (let k = Math.min(recCap, nRec); k >= runs.length; k--) {
      const p = coarse(k);
      const [r, n] = count(p);
      if (r <= rowCap && n <= recCap) { found = p; rows = r; nRec = n; break; }
    }
    if (!found) {
      const [least] = count(coarse(runs.length));
      return none(`the coastline needs at least ${least} rows stated coarsely and ${runs.length} records; the budget is ${rowCap} rows and ${recCap} records`);
    }
    plan = found;
  }

  const records = plan.flat();
  if (half !== null) {
    const e = intentErrors(records, { size });
    if (e.length) return none(`the records would not be a valid intent list: ${e[0]}`);
  }
  let samples = 0, length = 0;
  for (const r of records) {
    samples += polylineSamples(r.points, SHORE_STEP, SHORE_SAMPLES).length - 1;
    length += arcLength(r.points);
  }
  const kept = records.reduce((a, r) => a + r.points.length, 0) - (records.length - runs.length);
  const deviation = Math.max(...clipped.map((run, i) => deviationOf(run, plan[i])));
  return { records, rows, step: samples ? length / samples : null, coarsened, vertices: { input, kept, deviation }, reason: null };
}

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const dist = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
function arcLength(run) {
  let s = 0;
  for (let i = 1; i < run.length; i++) s += dist(run[i - 1], run[i]);
  return s;
}

/* The farthest any vertex of a clipped run lies from the line its records
   state. Every stated vertex IS a vertex of the run (decimate, cutAtStep and
   evenVertices only ever choose among them, the same arrays), in order, so
   each run vertex is measured against the one stated segment that spans it. */
function deviationOf(run, recs) {
  const stated = [];
  for (const r of recs) for (const p of r.points) if (stated[stated.length - 1] !== p) stated.push(p);
  let j = 0, worst = 0;
  for (const p of run) {
    if (j + 1 < stated.length && p === stated[j + 1]) { j++; continue; }
    if (p === stated[j] || j + 1 >= stated.length) continue;
    worst = Math.max(worst, toSegment(p, stated[j], stated[j + 1]));
  }
  return worst;
}
function toSegment(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, [a[0] + dx * t, a[1] + dz * t]);
}

/* Liang–Barsky against [−h, h]², segment by segment; consecutive inside
   pieces join into one run, and a run is closed wherever the line leaves.
   A crossing point is x0 + dx·t, and rounding can put that a few ulps past
   the edge (2048.0000000000005 on a 4096 m plate), which intentErrors — and
   so a saved world — refuses; so each coordinate of a crossing is clamped
   onto [−h, h]. Input vertices already inside are kept exactly. */
function clipToSquare(pts, h) {
  const runs = [];
  let run = null;
  const push = (p) => {
    if (!run) { run = [p]; runs.push(run); return; }
    const last = run[run.length - 1];
    if (last[0] !== p[0] || last[1] !== p[1]) run.push(p);
  };
  const onPlate = (v) => (v < -h ? -h : v > h ? h : v);
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
    const dx = x1 - x0, dz = z1 - z0;
    let t0 = 0, t1 = 1, inside = true;
    for (const [p, q] of [[-dx, x0 + h], [dx, h - x0], [-dz, z0 + h], [dz, h - z0]]) {
      if (p === 0) { if (q < 0) { inside = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { inside = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { inside = false; break; } if (r < t1) t1 = r; }
    }
    if (!inside) { run = null; continue; }
    const a = t0 === 0 ? pts[i - 1] : [onPlate(x0 + dx * t0), onPlate(z0 + dz * t0)];
    const b = t1 === 1 ? pts[i] : [onPlate(x0 + dx * t1), onPlate(z0 + dz * t1)];
    if (t0 > 0) run = null;
    push(a); push(b);
    if (t1 < 1) run = null;
  }
  return runs;
}

/* Keep a vertex when the NEXT one would be more than SHORE_STEP from the
   last kept: the longest step that is still at most SHORE_STEP. Every vertex
   is a sample and polylineSamples cuts any segment longer than the step, so
   keeping vertices at least SHORE_STEP apart instead (50 m on a 5 m trace)
   would make each segment two 25 m samples — twice the rows the line needs.
   A segment of the input already longer than the step is kept as it is and
   left to the solver's own cutting. */
function decimate(run) {
  if (run.length < 3) return run;
  const out = [run[0]];
  for (let i = 1; i < run.length - 1; i++) if (dist(out[out.length - 1], run[i + 1]) > SHORE_STEP) out.push(run[i]);
  out.push(run[run.length - 1]);
  return out;
}

/* Records along one decimated run: grow each until one more vertex would
   pass MAX_POLYLINE or make polylineSamples cut it into more than
   SHORE_SAMPLES samples at the step. A single segment too long for one record
   at the step (over SHORE_SAMPLES × SHORE_STEP, ≈ 6 km — longer than the
   plate's diagonal on the default world) is left to the solver's own
   coarser sampling rather than broken. */
function cutAtStep(run) {
  const out = [];
  let start = 0;
  while (start < run.length - 1) {
    let end = start + 1;
    while (end + 1 < run.length && end + 1 - start + 1 <= MAX_POLYLINE
      && polylineSamples(run.slice(start, end + 2), SHORE_STEP).length <= SHORE_SAMPLES) end++;
    out.push(run.slice(start, end + 1));
    start = end;
  }
  return out;
}

/* At most `count` vertices of the run — its first, its last, and between
   them the vertex nearest each evenly spaced arc length, each used once.
   They are the line's own vertices, so the coarse line still lies on it. */
function evenVertices(run, count) {
  if (run.length <= count) return run.slice();
  const cum = [0];
  for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + dist(run[i - 1], run[i]));
  const total = cum[cum.length - 1];
  const out = [run[0]];
  let last = 0;
  for (let k = 1; k < count - 1; k++) {
    const want = (total * k) / (count - 1);
    let j = last + 1;
    while (j + 1 < run.length - 1 && Math.abs(cum[j + 1] - want) <= Math.abs(cum[j] - want)) j++;
    if (j >= run.length - 1) break;
    out.push(run[j]);
    last = j;
  }
  out.push(run[run.length - 1]);
  return out;
}

/* ══ a skyline ══════════════════════════════════════════════════════════ */

/* Default ray samples for a skyline ray: FOUR, a third of condition.js's
   RAY_SAMPLES (12) for a hand-written sightline — and that is not a saving,
   it is what makes a skyline solvable at all.

   A skyline is a FAN: sixteen long rays from one eye, and a seed that does
   not already say what the photograph says pierces nearly all of them, so
   the first round of the v2 active set (condition.js activeSetV2) finds
   almost every row broken and holds them all at once — hundreds of nearly
   parallel rows on one wedge of ground, which the basis cannot pass through
   cheaply, and the rounds run out before the multipliers settle. The cheap
   answer is the right one: the least improbable way to keep ground under a
   fan of rays is to lower the country a little, which holds one or two rows,
   and the dense fan hides it. tools/test/kernel/evidence.test.js states one fan both
   ways and prints both — world K7QN's skyline from 25 m over (−1200, −1200)
   looking west, on seed TMNR, 16 rays out to 1.5 km or the plate's edge: × 24 samples
   (400 rows) it did not converge and cost 41 836 nats; × 4 samples (80
   rows) it converged at 0.08 nats. The suite asserts only what this module
   promises (the sparse fan converges, and refined it is met); the dense
   number is printed, not asserted, because it is a property of the solver's
   active set and would rightly change if that got better.
   What four samples leave is the ground BETWEEN them — 41.7 m above a ray
   on that view. refineRays (below) takes that back by stating the same rays
   at the points where the solved ground breaks them, a few rows a round,
   which the active set holds without trouble: on that view 11 cuts in 2
   solves, ≤ 0.002 m above any ray at a 1 m walk, 0.41 nats. */
export const SKYLINE_SAMPLES = 4;
export const SKYLINE_COLUMNS = 16;
/* How far above the skyline the stated ray passes, in pixels. The skyline is
   the top edge of the first ground pixel; the ray through the centre of the
   last SKY pixel, half a pixel above it, is the one ray the image saw miss
   the ground. Pass 0 for a profile that is already a sub-pixel boundary. */
export const SKYLINE_MARGIN = 0.5;

/**
 * fromSkyline({ eye, yaw, pitch = 0, focalPx, width, height, profile,
 *               columns = 16, maxDistance, size, samples = 4,
 *               margin = 0.5, principal, ranges }) → {
 *   records   [{ type: "ray", eye, at, h, samples, contact? }, …]
 *   rays      per record { column, row, distance, slope } — the pixel it went
 *             through (row = profile − margin), the horizontal distance to
 *             its far end in metres, and its rise per metre
 *   skipped   sampled columns that stated nothing, with why
 *   rows      the rows the records state (condition.js rowsFor)
 *   reason    null, or why there are no records at all
 * }
 *
 * The camera is a pinhole at `eye` [x, y, z] (world metres, y up), the
 * three.js convention: yaw 0 looks along −z (north), positive yaw turns left
 * (counter-clockwise seen from above), so the view direction is
 * (−sin yaw, 0, −cos yaw); pitch is up from horizontal, radians. Image x runs
 * right and y runs DOWN from the top-left corner, in pixels, and `principal`
 * (default the image centre, [width/2, height/2]) is where the optical axis
 * meets it. `focalPx` is the focal length in pixels — see the header: read it
 * from EXIF, never guess it; without a positive one there are no records.
 *
 * `profile` is a Float32Array(width): for each image column, the image y of
 * the sky/ground boundary — the index of the first ground row, as
 * skylineFromPixels returns it; `height` when the column is sky to the
 * bottom; NaN when the column says nothing. `columns` columns are sampled,
 * evenly: column floor((k + ½)·width/columns) for k = 0 … columns−1.
 *
 * Each sampled column with a finite profile p becomes one ray record through
 * the pixel at (column + ½, p − margin), out to `maxDistance` metres of
 * horizontal distance — or to where it leaves the plate when `size` is given
 * and that comes first (a v2 record's every coordinate must be on the plate,
 * condition.js) — with h the ray's own height there, so the record says:
 * along that segment the ground stays at or under the ray. A column is
 * skipped when its p − margin is above the frame (that ray was never
 * observed), or when the ray is within 1e-9 of vertical. An eye off the
 * plate (with `size`) states nothing at all: no records, with the reason.
 *
 * `ranges`, optional, an array or Float32Array(width): the horizontal
 * distance in metres from the eye to the silhouette in each column. Where it
 * is finite, positive and inside the clipped maxDistance, that column's ray
 * ends there with contact: true — the ground at the far end stands at the
 * ray's height (with margin 0 this is the silhouette exactly; with the
 * default half pixel it is a silhouette half a pixel HIGH, because the ray passes over the boundary). Without ranges no
 * record carries contact: the image alone states only the sky half.
 *
 * What the solver promises about a ray is its rows: the ground at the eye's
 * foot and at `samples` evenly spaced points from it to the far end is at or
 * under the line. BETWEEN samples the ground may rise above it; how far is a
 * property of the world's relief at the sample spacing (maxDistance/samples),
 * and refineRays is what bounds it — see SKYLINE_SAMPLES for why the samples
 * are few and the refinement does the rest.
 */
export function fromSkyline({
  eye, yaw, pitch = 0, focalPx, width, height, profile, columns = SKYLINE_COLUMNS, maxDistance,
  size, samples = SKYLINE_SAMPLES, margin = SKYLINE_MARGIN, principal, ranges,
} = {}) {
  const none = (reason) => ({ records: [], rays: [], skipped: [], rows: 0, reason });
  if (!(finite(focalPx) && focalPx > 0)) {
    return none("no focal length: pass focalPx from the photograph's EXIF (atlas-core readLens fRel × long side); it is never guessed");
  }
  if (!(Array.isArray(eye) && eye.length === 3 && eye.every(finite))) return none("eye is not an [x, y, z] triple of numbers");
  if (!(finite(yaw) && finite(pitch))) return none("yaw and pitch must be numbers (radians)");
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) return none("width and height must be positive whole numbers");
  if (!profile || typeof profile.length !== "number" || profile.length !== width) return none(`profile must hold one value per image column (${width})`);
  if (!(finite(maxDistance) && maxDistance > 0)) return none("maxDistance must be a positive number of metres");
  const half = finite(size) && size > 0 ? size / 2 : null;
  const [ex, ey, ez] = eye;
  if (half !== null && (Math.abs(ex) > half || Math.abs(ez) > half)) return none(`the eye (${ex}, ${ez}) is off the plate`);
  const nCols = Math.max(1, Math.min(Number.isInteger(columns) ? columns : SKYLINE_COLUMNS, width));
  const nSamp = Math.max(2, Math.min(Number.isInteger(samples) ? samples : SKYLINE_SAMPLES, 64));
  const m = finite(margin) && margin >= 0 ? margin : SKYLINE_MARGIN;
  const cx = Array.isArray(principal) && finite(principal[0]) ? principal[0] : width / 2;
  const cy = Array.isArray(principal) && finite(principal[1]) ? principal[1] : height / 2;

  const sy = Math.sin(yaw), cyaw = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  // Camera frame in the world: right, up, forward (see the doc comment).
  const right = [cyaw, 0, -sy];
  const up = [-sy * -sp, cp, -cyaw * -sp];
  const fwd = [-sy * cp, sp, -cyaw * cp];

  const records = [], rays = [], skipped = [];
  for (let k = 0; k < nCols; k++) {
    const column = Math.floor(((k + 0.5) * width) / nCols);
    const p = profile[column];
    if (!finite(p)) { skipped.push({ column, why: "the profile says nothing here" }); continue; }
    const row = p - m;
    if (row < 0) { skipped.push({ column, why: "the ray above the skyline is above the frame, so it was never observed" }); continue; }
    const u = column + 0.5 - cx, v = cy - row;
    const dx = u * right[0] + v * up[0] + focalPx * fwd[0];
    const dy = u * right[1] + v * up[1] + focalPx * fwd[1];
    const dz = u * right[2] + v * up[2] + focalPx * fwd[2];
    const hl = Math.sqrt(dx * dx + dz * dz);
    const len = Math.sqrt(hl * hl + dy * dy);
    if (!(hl > 1e-9 * len)) { skipped.push({ column, why: "the ray is vertical" }); continue; }
    const hx = dx / hl, hz = dz / hl, slope = dy / hl;
    let reach = maxDistance;
    // A hair inside the edge, so rounding cannot put the far end off it.
    if (half !== null) reach = Math.min(reach, exitDistance(ex, ez, hx, hz, half) * (1 - 1e-9));
    if (!(reach > 0)) { skipped.push({ column, why: "the ray leaves the plate at the eye" }); continue; }
    const range = ranges && finite(ranges[column]) && ranges[column] > 0 && ranges[column] <= reach ? ranges[column] : null;
    const distance = range ?? reach;
    const rec = {
      type: "ray", eye: [ex, ey, ez], at: [ex + hx * distance, ez + hz * distance], h: ey + slope * distance, samples: nSamp,
    };
    if (range !== null) rec.contact = true;
    records.push(rec);
    rays.push({ column, row, distance, slope });
  }
  return {
    records, rays, skipped, rows: sum(records, (r) => rowsFor({ ...r, contact: r.contact === true })),
    reason: records.length ? null : "no sampled column stated a ray",
  };
}

/* How far along the unit horizontal direction (hx, hz) from (x, z) the ray
   stays inside [−h, h]² — the plate. */
function exitDistance(x, z, hx, hz, h) {
  let t = Infinity;
  if (hx > 0) t = Math.min(t, (h - x) / hx); else if (hx < 0) t = Math.min(t, (-h - x) / hx);
  if (hz > 0) t = Math.min(t, (h - z) / hz); else if (hz < 0) t = Math.min(t, (-h - z) / hz);
  return t;
}

/* ══ refinement: the same rays, held between their samples ═════════════ */

export const REFINE_TOLERANCE = 0.5;
export const REFINE_STEP = 2;

/**
 * refineRays(params, { tolerance = 0.5, step = 2, maxRecords = MAX_INTENT,
 *                      perRound = 16, rounds = 8 }) → {
 *   records    params.terrain.intent followed by the cuts — the list to save
 *   cuts       how many `point` records were added
 *   rounds     how many solves it took
 *   worst      the largest height, metres, by which the final ground stands
 *              above any refined ray at the `step` it was checked at
 *   rows       the rows the returned list states (rowsFor, as intentErrors
 *              counts them)
 *   dropped    the final solve's `dropped`: records MAX_ROWS turned away
 *   sampler    the final createHeightSampler, so a caller need not solve again
 *   converged  the final solve converged AND dropped nothing — a list the
 *              solver cut short is not a list that was met
 * }
 *
 * Cutting planes over a list that holds rays. Solve; walk every ray with a
 * stated far end (`h`) at `step` metres along its segment; where the solved
 * ground stands more than `tolerance` above the line, take the worst such
 * point of each ray, and add — most broken first, at most `perRound` a round,
 * never past `maxRecords` records and never past MAX_ROWS rows (a cut is one
 * row) — a `point` record there: op "<=",
 * h the line's own height at that point. Solve again, until no ray is broken
 * by more than the tolerance, no record or row is left, or `rounds` solves
 * have run. A list already over MAX_ROWS gets no cuts: the solver drops
 * whole records from its tail, and a cut stated after them would be the
 * first thing dropped; the one solve is run and its `dropped` returned.
 *
 * A cut states NOTHING NEW. A ray's row at a sample is exactly "the ground
 * here is at most the line's height here", built by the same plate inverse
 * as a `point` record with op "<=" (condition.js constraintsFor: both go
 * through `at`), so a cut is the ray's own statement at one more place. The
 * saved world is the same rays, held where they needed holding.
 *
 * Rays without `h` are left alone: their line ends on the CONDITIONED ground
 * at `at`, which moves with every cut, so a cut taken from one solve would
 * be a statement about a ground the next solve no longer has.
 *
 * What it costs: one full solve a round (a sampler is not cached, condition.js
 * says why), plus walking every ray at `step`. Deterministic: the order of
 * the rays, a fixed step, ties to the lower ray index.
 */
export function refineRays(params, {
  tolerance = REFINE_TOLERANCE, step = REFINE_STEP, maxRecords = MAX_INTENT, perRound = 16, rounds = 8,
} = {}) {
  const tol = finite(tolerance) && tolerance >= 0 ? tolerance : REFINE_TOLERANCE;
  const dt = finite(step) && step > 0 ? step : REFINE_STEP;
  const cap = Math.max(0, Math.min(finite(maxRecords) ? Math.floor(maxRecords) : MAX_INTENT, MAX_INTENT));
  const per = Math.max(1, finite(perRound) ? Math.floor(perRound) : 16);
  const most = Math.max(1, finite(rounds) ? Math.floor(rounds) : 8);
  const base = Array.isArray(params?.terrain?.intent) ? params.terrain.intent.slice() : [];
  const rays = base.filter((r) => r && r.type === "ray" && Array.isArray(r.eye) && r.eye.length === 3
    && r.eye.every(finite) && Array.isArray(r.at) && r.at.length === 2 && r.at.every(finite) && finite(r.h));
  const records = base.slice();
  let rows = sum(normalizeIntent(records) ?? [], rowsFor);
  let sampler = null, done = 0, worst = -Infinity, cuts = 0;
  while (done < most) {
    sampler = createHeightSampler({ ...params, terrain: { ...params.terrain, intent: records } });
    done++;
    worst = -Infinity;
    const broken = [];
    rays.forEach((r, i) => {
      const w = worstAbove(sampler, r, dt);
      if (w.excess > worst) worst = w.excess;
      if (w.excess > tol) broken.push({ ...w, i });
    });
    const room = Math.min(per, cap - records.length, MAX_ROWS - rows);
    if (!broken.length || room <= 0 || done >= most) break;
    broken.sort((a, b) => b.excess - a.excess || a.i - b.i);
    for (const c of broken.slice(0, room)) {
      records.push({ type: "point", x: c.x, z: c.z, h: c.h, op: "<=" });
      cuts++;
      rows++;
    }
  }
  const c = sampler?.conditioning;
  return {
    records, cuts, rounds: done, worst: rays.length ? worst : null, rows, dropped: c ? c.dropped : 0, sampler,
    converged: c ? c.converged && c.dropped === 0 : true,
  };
}

/* The worst point of one ray with a stated far end: walk the horizontal
   segment from the eye's foot at `dt` metres (and its far end), and return
   where the ground stands highest above the line. */
function worstAbove(sampler, r, dt) {
  const [ex, ey, ez] = r.eye, [ax, az] = r.at;
  const D = Math.sqrt((ax - ex) * (ax - ex) + (az - ez) * (az - ez));
  const n = Math.max(1, Math.ceil(D / dt));
  let best = { excess: -Infinity, x: ex, z: ez, h: ey };
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = ex + (ax - ex) * t, z = ez + (az - ez) * t, h = ey + (r.h - ey) * t;
    const e = sampler(x, z) - h;
    if (e > best.excess) best = { excess: e, x, z, h };
  }
  return best;
}

/* Default threshold for skylineFromPixels: the largest per-channel
   difference, in 8-bit levels, that still counts as the same sky. */
export const SKY_THRESHOLD = 40;

/**
 * skylineFromPixels(rgba, width, height, { threshold = 40, drift, skyRows })
 *   → Float32Array(width): per column, the index of the first ground row —
 *   the image y of the sky/ground boundary fromSkyline reads — `height`
 *   when the column is sky all the way down, NaN when it says nothing.
 *
 * `rgba` is width·height·4 bytes, row-major from the top-left, as an
 * ImageData's data is (any array-like of numbers; alpha is ignored). The
 * rule, deliberately simple enough to state in full:
 *
 *   1. The sky's colour is estimated from the top `skyRows` rows (default
 *      max(1, ⌊height/16⌋)): per column, the mean of those rows; for the
 *      image, the per-channel median of the column means.
 *   2. A column whose own top mean already departs from the image's sky —
 *      some channel more than `threshold` levels off — starts in ground (or
 *      cloud, or a branch) and says nothing: NaN. So does a column where a
 *      top row departs from that column's own mean.
 *   3. Otherwise walk down from the first row under the top rows. A row
 *      DEPARTS when some channel is more than `threshold` from the running
 *      sky colour, or more than `drift` (default 2 × threshold) from the
 *      column's top-rows colour; the first that departs is the boundary.
 *      A row that does not depart is sky, and the running colour moves
 *      min(1/4, 16/height) of the way toward it — an average over the last
 *      sixteenth of the frame or so — so a sky that brightens toward the
 *      horizon, as every clear sky does, is followed rather than mistaken
 *      for ground.
 *
 * Why both tests, and why the rate scales with the height. A running colour
 * alone FOLLOWS any edge that changes slowly enough per row — a blurred or
 * anti-aliased skyline — into the ground, and reports the column as sky to
 * the bottom; and with a fixed rate per row "slowly enough" is a number of
 * pixels, so the same edge photographed at four times the resolution is
 * never found. Scaling the rate by the height makes the running colour lag a
 * gradient across the FRAME by the same number of levels at any resolution
 * (a horizon glow is a property of the view, not of the pixel count), while a
 * blurred edge of a fixed number of pixels gets steeper relative to it as
 * the image grows. And `drift` is the bound that holds whatever the edge:
 * the column cannot be called sky once it is more than `drift` from the
 * colour the sky started as. Measured (tools/test/kernel/evidence.test.js): sky
 * (150, 180, 230) over ground (60, 80, 40), the edge spread over 1 to 200
 * rows, at 64 to 4 000 rows of image — the boundary is found inside the
 * edge's first half every time. At 64 rows the rate is the 1/4 the test
 * photograph is read with.
 *
 * What it is not: a segmenter, and it errs in both directions. Cloud above a
 * mountain, or a sky darker toward the horizon than the threshold allows,
 * makes it find the boundary too HIGH: the stated ray passes higher than
 * the skyline, which is a weaker statement, never a false one — information
 * lost, not truth. Haze, or any ground within `threshold` of the sky's
 * colour, makes it find the boundary too LOW: a distant ridge washed toward
 * the sky's colour is read as sky, the boundary lands on whatever nearer
 * ground does contrast, and the ray stated through the ridge's pixels is
 * FALSE — the real ridge pierces it. That is the failure that matters, the
 * threshold is the only guard against it, and the caller who has better
 * (atlas-core's own masks, a person with a brush) should pass that profile to
 * fromSkyline directly.
 */
export function skylineFromPixels(rgba, width, height, { threshold = SKY_THRESHOLD, drift, skyRows } = {}) {
  const out = new Float32Array(Number.isInteger(width) && width > 0 ? width : 0);
  if (!out.length || !(Number.isInteger(height) && height > 0) || !rgba || rgba.length < width * height * 4) return out.fill(NaN);
  const thr = finite(threshold) && threshold >= 0 ? threshold : SKY_THRESHOLD;
  const far = finite(drift) && drift >= 0 ? drift : 2 * thr;
  const rate = Math.min(1 / 4, 16 / height);
  const top = Math.max(1, Math.min(Number.isInteger(skyRows) && skyRows > 0 ? skyRows : Math.floor(height / 16), height));
  const at = (x, y, c) => rgba[(y * width + x) * 4 + c];

  const means = [];
  for (let x = 0; x < width; x++) {
    const m = [0, 0, 0];
    for (let y = 0; y < top; y++) for (let c = 0; c < 3; c++) m[c] += at(x, y, c);
    for (let c = 0; c < 3; c++) m[c] /= top;
    means.push(m);
  }
  const sky = [0, 1, 2].map((c) => {
    const v = means.map((m) => m[c]).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(0.5 * v.length))];
  });
  const departs = (x, y, ref, t) => {
    for (let c = 0; c < 3; c++) if (Math.abs(at(x, y, c) - ref[c]) > t) return true;
    return false;
  };
  for (let x = 0; x < width; x++) {
    const own = means[x];
    let bad = false;
    for (let c = 0; c < 3; c++) if (Math.abs(own[c] - sky[c]) > thr) bad = true;
    for (let y = 0; y < top && !bad; y++) if (departs(x, y, own, thr)) bad = true;
    if (bad) { out[x] = NaN; continue; }
    const run = own.slice();
    let y = top;
    for (; y < height; y++) {
      if (departs(x, y, run, thr) || departs(x, y, own, far)) break;
      for (let c = 0; c < 3; c++) run[c] += (at(x, y, c) - run[c]) * rate;
    }
    out[x] = y;
  }
  return out;
}

/* ══ the band and the gate ══════════════════════════════════════════════ */

/* The gate's ratio, the value atlas-core's REGISTER.gateRatio freezes. */
export const GATE_RATIO = 1 / 3;

/**
 * bandResidual(target, got, band) → number | null
 *
 * The residual of what a world says (`got`) against what was measured
 * (`target`), with the measurement's tolerance `band` (≥ 0, same units):
 * zero when |got − target| ≤ band, otherwise the signed excess outside it,
 * sign(got − target)·(|got − target| − band). A tolerance is a band, not a
 * point; a residual to the band's centre would manufacture error that is not
 * there. From the two branches: it is 0 exactly when the world is inside the
 * band; |result| ≤ |got − target|, equal only when band is 0; its sign is 0
 * or the raw residual's, so a world above the evidence is never reported
 * below it. Hence every coverage statistic over band residuals is at least
 * as good as over raw ones, and widening the band can only flatter — which
 * is why registrationGate exists.
 *
 * null when target or got is not a finite number (unmeasured, not zero). A
 * band that is negative or not finite is a RangeError, as in register.js: it
 * would make |result| > |got − target| and break the inequality everything
 * above rests on.
 */
export function bandResidual(target, got, band) {
  if (!(finite(band) && band >= 0)) throw new RangeError("band must be finite and >= 0");
  if (!finite(target) || !finite(got)) return null;
  const d = got - target, a = Math.abs(d);
  if (a <= band) return 0;
  return (d < 0 ? -1 : 1) * (a - band);
}

/**
 * registrationGate({ errors, bands, gateRatio = 1/3 }) → {
 *   pass, reason, medianBand, medianError, ratio, gateRatio, measured
 * }
 * Is the evidence's tolerance fine enough to judge a world against it? Only
 * when it is should coverage measured on band-zeroed residuals be trusted.
 *
 * `errors` are the RAW residuals got − target at held-out evidence (sign
 * ignored), `bands` the tolerance of each — an array the same length, or one
 * number for all. The gate passes when median band ≤ gateRatio × median
 * |error|. The median is the order statistic at index ⌊n/2⌋ of the ascending
 * values, register.js's convention. Like register.js it is taken over the
 * RAW error, not the band residual: the band residual is defined by the band,
 * so a band wide enough to swallow everything would zero it and the gate
 * would be a tautology, not a test.
 *
 * A band that is a number but negative or infinite is a RangeError, as in
 * bandResidual and register.js: it is a broken ruler, not a missing one. A
 * band that is absent (null, undefined, NaN) marks that pair unmeasured.
 *
 * It FAILS CLOSED. pass is false, with the reason, when nothing is measured
 * (no pair with a finite error and a band), when the two lists
 * differ in length, and when the median error is zero (a world that meets
 * its evidence exactly leaves no error for a band to be small against — read
 * its residuals directly instead). A failed gate is a result, not an
 * exception: it says the ruler is too coarse for what it is measuring.
 */
export function registrationGate({ errors, bands, gateRatio = GATE_RATIO } = {}) {
  const g = finite(gateRatio) && gateRatio > 0 ? gateRatio : GATE_RATIO;
  const fail = (reason, extra = {}) => ({ pass: false, reason, medianBand: null, medianError: null, ratio: null, gateRatio: g, measured: 0, ...extra });
  if (!errors || typeof errors.length !== "number") return fail("no errors were measured");
  const unmeasured = (v) => v === null || v === undefined || Number.isNaN(v);
  const broken = (v) => !unmeasured(v) && !(finite(v) && v >= 0);
  if (broken(bands) && typeof bands === "number") throw new RangeError("band must be finite and >= 0");
  const scalar = finite(bands);
  if (!scalar && !(bands && typeof bands.length === "number")) return fail("no bands were given");
  if (!scalar && bands.length !== errors.length) return fail(`${errors.length} errors and ${bands.length} bands: each error needs its own band`);
  const e = [], b = [];
  for (let i = 0; i < errors.length; i++) {
    const err = errors[i], band = scalar ? bands : bands[i];
    if (broken(band)) throw new RangeError(`band ${i} is ${band}; a band must be finite and >= 0`);
    if (!finite(err) || unmeasured(band)) continue;
    e.push(Math.abs(err)); b.push(band);
  }
  if (!e.length) return fail("nothing was measured");
  const medianError = median(e), medianBand = median(b);
  if (!(medianError > 0)) return fail("the median error is zero", { medianBand, medianError, measured: e.length });
  const ratio = medianBand / medianError;
  const pass = ratio <= g;
  return {
    pass, reason: pass ? null : "the band is not small compared to the error being measured",
    medianBand, medianError, ratio, gateRatio: g, measured: e.length,
  };
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(0.5 * v.length))];
}
