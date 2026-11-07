/* survey.js — reading a world before anyone has looked at it.
 *
 * Pure JS: no three.js, no DOM, no canvas. It takes height samplers and
 * returns numbers, which is what lets it run under the test suite — and
 * conditioning, the one job that has to try intent on a seed, builds its own
 * samplers from params through heightfield.js, which is core like this file.
 *
 * Two jobs.
 *
 * SCREENING measures candidate seeds, in the order a caller's `mint` hands
 * them over, and issues the first with a workable land fraction and some
 * relief. Nothing in it draws a seed: the engine never rolls one (the editor
 * opens on src/kernel/seed.js DEFAULT_SEED, or on the seed somebody names),
 * so a caller that screens decides the candidates, deterministically.
 *
 * READING answers the questions a composer asks of ground it did not choose:
 * where is the high broad shoulder a citadel would stand on, where does the
 * land meet the sea with country behind it, where is the water shallow enough
 * to raise an island in. Those are the questions a world GRAMMAR asks — put a
 * castle on a prominence, put a village on a coast — and the answers have to
 * come from the terrain, or the grammar degenerates into fixed coordinates and
 * every seed builds the same map.
 *
 * They live here, in the core, because none of them knows what a castle is.
 * `surveyField` samples a coarse grid once and `pickSites` walks it with
 * whatever scorer the caller brings; the scorers themselves are content and
 * live with the thing that means them.
 */

import { createHeightSampler, SEA_FLOOR } from "../terrain/heightfield.js";
import { levelPoints } from "../terrain/condition.js";

/* ── screening a seed ──
   A minted seed is a real seed and it is also a first impression: the terrain
   these params span runs from an unbroken massif to an atoll with two rocks
   on it, and a world that comes up 95 % open water is a poor thing to hand
   somebody who asked for another one.

   So candidates are screened on a coarse analytic pass and the first one
   with a workable land fraction and some relief in it is issued. Nothing is
   faked and nothing is substituted afterwards: the seed that passed is the
   seed the editor is handed, and the terrain it grows is the terrain the
   engine would have grown from it anyway.

   `mint()` returns a candidate; `samplerFor(seed)` returns {height, size}
   and optionally `level` — the world's waterline in metres. The coastline
   used to be hardcoded at y > 0, which measured a raised-flood world's
   drowned ground as land; 0 stays the default so existing callers are
   untouched and the core stays pure. */
export function screenSeed({ mint, samplerFor, attempts = 24, res = 40 }) {
  let best = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seed = mint();
    const { height, size, level = 0 } = samplerFor(seed);
    // Inside the edge falloff: the outer margin is submerged by construction
    // (heightfield.js, EDGE_START) and would drag every candidate down by the
    // same amount, which tells us nothing about the world inside it.
    const { land, relief } = measureGround({ height, size, level, res });
    if (land > 0.38 && land < 0.82 && relief > 180) return { seed, land, relief, attempt, screened: true };
    const score = -Math.abs(land - 0.56) + Math.min(relief / 260, 1) * 0.3;
    if (!best || score > best.score) best = { seed, land, relief, attempt, score, screened: false };
  }
  // Nothing cleared the bar: issue the closest thing to it rather than looping
  // forever on a page the visitor is already looking at.
  return best;
}

/** The screen's measurement, on its own: a res² grid over the middle `inset`
    of the world. Land is the share of samples above the waterline, relief the
    span from the deepest to the highest. `heights` and `at` (the highest
    sample) and `deep` (the lowest) come back too, because conditioning
    reasons about them. */
export function measureGround({ height, size, level = 0, res = 40, inset = 0.76 }) {
  const span = size * inset;
  const heights = new Float64Array(res * res), points = [];
  let dry = 0, lo = Infinity, hi = -Infinity, top = 0, bottom = 0;
  for (let j = 0; j < res; j++) {
    const z = (j / (res - 1) - 0.5) * span;
    for (let i = 0; i < res; i++) {
      const x = (i / (res - 1) - 0.5) * span;
      const y = height(x, z);
      const k = j * res + i;
      heights[k] = y; points.push([x, z]);
      if (y > level) dry++;
      if (y < lo) { lo = y; bottom = k; }
      if (y > hi) { hi = y; top = k; }
    }
  }
  return { land: dry / (res * res), relief: hi - lo, lo, hi, at: points[top], deep: points[bottom], heights, points };
}

/* ══════════════════════════════════════════════════════════════════════════
   CONDITIONING A SEED — the screen without the rejections

   screenSeed above draws seeds until one happens to clear a bar, and on the
   default terrain four in five do not. This takes the seed it is given and
   CARRIES it onto the bar instead: it returns the intent (terrain/condition.js)
   that, added to the seed's params, makes the world clear it — with the least
   improbable change to the seed's own lattice that does.

   Two statements are enough for every bar this engine has:

     level    the interior's mean datum height. Land fraction is decided by it
              almost entirely, and the least-surprise way to move it is the
              broad one: the continent swells or sinks.
     summit   only when relief is short: the seed's OWN highest ground, raised
              to a crest. The level is held in the same solve, so the summit
              is built of the fine octaves instead of lifting the country.
              Or, when a crest would break the surface and cost the land bar
              — an ocean world whose whole floor is shallow — the seed's own
              DEEPEST ground is dug down instead. Relief is a span; either
              end of it will do, and the one that fits is the one taken.

   ── why there is no search ──
   With the summit fixed, the datum at every measured point is AFFINE in the
   level target h: the solve is linear and only one right-hand side moves. So
   two samplers give the slope at all 1 600 points, each point's shoreline
   crossing is a single division, and one sweep over the sorted crossings
   gives the land fraction for every h at once. The h chosen is the one
   nearest the seed's own level whose land falls inside the bar — least
   surprise, exactly, rather than a bisection's approximation of it.

   A seed that already clears the bar is returned with no intent at all, so a
   world that never needed conditioning is bit-identical to the one it was.

   Deterministic: a pure function of (params, bar). The same seed and the same
   grammar always come back with the same intent, which is what lets a world
   rebuilt from its seed come back as the same world.
   ══════════════════════════════════════════════════════════════════════════ */
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;

export function conditionSeed({ params, bar, res = 40, inset = 0.76 }) {
  const size = params.terrain.size, level = params.water?.level || 0;
  const withIntent = (intent) => ({ ...params, terrain: { ...params.terrain, intent } });
  const meets = (m) => m.land >= bar.land[0] && m.land <= bar.land[1] && m.relief > bar.relief;

  const raw = createHeightSampler(withIntent([]));
  const m0 = measureGround({ height: raw, size, level, res, inset });
  if (meets(m0)) return { intent: [], land: m0.land, relief: m0.relief, met: true, conditioned: false, nats: 0 };

  // Aim inside the bar, not at its edge: a margin of a quarter of its width,
  // at most five points of land, so rounding cannot tip the answer back out.
  // Unless the land is already right and only the relief is short — then the
  // seed's own level is the least surprise there is, and the margin would
  // move it for nothing (an ocean world at 0 % land, in a 0–2 % bar, was
  // being pushed to grow land it did not need).
  const width = bar.land[1] - bar.land[0];
  const margin = Math.min(0.05, width * 0.25);
  const landOk = m0.land >= bar.land[0] && m0.land <= bar.land[1];
  const want = landOk ? [bar.land[0], bar.land[1]] : [bar.land[0] + margin, bar.land[1] - margin];
  const pts = m0.points, N = pts.length;
  // A sample is land when its height clears the waterline; in datum terms the
  // waterline below zero sits lower, because the sea floor is compressed.
  const shore = level < 0 ? level / SEA_FLOOR : level;
  const toHeight = (D) => (D < 0 ? D * SEA_FLOOR : D);
  const lvl = levelPoints(size);
  const hRaw = lvl.reduce((a, [x, z]) => a + raw.datum(x, z), 0) / lvl.length;
  const step = params.terrain.height * 0.25;

  /* The one extra statement relief may need: a crest on the seed's highest
     sample, or — once a crest has been tried and no level could keep the land
     inside the bar around it — a hollow on its deepest. */
  let extra = null, mode = "raise", lowest = m0.lo, highest = m0.hi, chosen = null;
  for (let pass = 0; pass < 6 && !chosen; pass++) {
    const records = (h) => [{ type: "level", h }, ...(extra ? [extra] : [])];
    // At h = hRaw with nothing else asked, the level is already met: the raw world.
    const A = extra ? createHeightSampler(withIntent(records(hRaw))) : raw;
    const B = createHeightSampler(withIntent(records(hRaw + step)));
    const dA = pts.map(([x, z]) => A.datum(x, z));
    const g = pts.map(([x, z], i) => (B.datum(x, z) - dA[i]) / step);
    const pick = chooseLevel({ dA, g, hRaw, shore, want, N, relief: bar.relief, toHeight, span: params.terrain.height * 3 });
    if (pick?.reliefOk) {
      chosen = records(pick.h);
      break;
    }
    if (pick) { lowest = pick.lo; highest = pick.hi; }
    else if (extra && mode === "raise") { mode = "deepen"; lowest = m0.lo; highest = m0.hi; }
    const need = bar.relief * 1.25 + 1;
    if (mode === "raise") {
      const [x, z] = m0.at;
      extra = { type: "summit", x: r2(x), z: r2(z), h: r3(Math.max(m0.hi, lowest + need)) };
    } else {
      const [x, z] = m0.deep;
      extra = { type: "point", x: r2(x), z: r2(z), h: r3(Math.min(m0.lo, highest - need)), op: "=" };
    }
  }
  if (!chosen) return { intent: [], land: m0.land, relief: m0.relief, met: false, conditioned: false, nats: 0 };

  // Rounded for the file; verified as rounded, and kept exact if rounding
  // ever tips a knife-edge case back out of the bar.
  for (const intent of [chosen.map((r) => (r.type === "level" ? { ...r, h: r3(r.h) } : r)), chosen]) {
    const sampler = createHeightSampler(withIntent(intent));
    const m = measureGround({ height: sampler, size, level, res, inset });
    if (meets(m)) {
      return { intent, land: m.land, relief: m.relief, met: true, conditioned: true, nats: sampler.conditioning?.nats ?? 0 };
    }
  }
  return { intent: [], land: m0.land, relief: m0.relief, met: false, conditioned: false, nats: 0 };
}

/* Sweep the shoreline crossings. Each sample's datum is dA + (h − hRaw)·g; it
   is land while that clears `shore`. Returns the h nearest hRaw whose land
   share falls in `want` and whose relief clears the bar — or, failing relief,
   the nearest one that gets the land right, with its deepest and highest
   heights, so the caller can size a crest or a hollow against them. */
function chooseLevel({ dA, g, hRaw, shore, want, N, relief, toHeight, span }) {
  const cross = [];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (g[i] > 0) cross.push({ h: hRaw + (shore - dA[i]) / g[i], d: 1 });
    else if (g[i] < 0) { cross.push({ h: hRaw + (shore - dA[i]) / g[i], d: -1 }); count++; }
    else if (dA[i] > shore) count++;
  }
  cross.sort((a, b) => a.h - b.h);
  // Intervals of constant land, bounded to a sane span either side of the seed.
  const lo = hRaw - span, hi = hRaw + span;
  const intervals = [];
  let from = lo;
  for (const c of cross) {
    const to = Math.min(Math.max(c.h, lo), hi);
    if (to > from) intervals.push({ from, to, land: count / N });
    from = Math.max(from, to);
    count += c.d;
  }
  if (hi > from) intervals.push({ from, to: hi, land: count / N });

  const inside = intervals
    .filter((iv) => iv.land >= want[0] && iv.land <= want[1] && iv.to - iv.from > 0.004)
    .map((iv) => {
      const q = Math.min((iv.to - iv.from) / 4, 0.5);
      return Math.min(Math.max(hRaw, iv.from + q), iv.to - q);
    })
    .sort((a, b) => Math.abs(a - hRaw) - Math.abs(b - hRaw));
  let first = null;
  for (const h of inside.slice(0, 64)) {
    let top = -Infinity, bottom = Infinity;
    for (let i = 0; i < N; i++) {
      const y = toHeight(dA[i] + (h - hRaw) * g[i]);
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
    if (!first) first = { h, lo: bottom, hi: top };
    if (top - bottom > relief) return { h, lo: bottom, hi: top, reliefOk: true };
  }
  return first ? { ...first, reliefOk: false } : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   READING A WORLD

   One coarse grid, sampled once, and every question answered off it.

   THE SAMPLE IS THE EXPENSIVE PART and it is easy to forget: a height sample
   is three fBm evaluations plus a domain warp, and a composer that asks "is
   this flat", "how much land is around it" and "how far is the sea" for every
   candidate re-samples the same square metre dozens of times. At 64² that is
   the difference between four thousand samples and a quarter of a million.

   `inset` keeps the scan inside the world's edge falloff (heightfield.js,
   EDGE_START sinks the outer margin by construction), so the answers describe
   the world rather than the rim it ends at.
   ══════════════════════════════════════════════════════════════════════════ */
export function surveyField({ sampler, size, res = 64, inset = 0.9, level = 0 }) {
  const span = size * inset;
  const step = span / (res - 1);
  const h = new Float32Array(res * res);
  const wet = new Uint8Array(res * res);
  const xOf = (i) => (i / (res - 1) - 0.5) * span;
  const zOf = (j) => (j / (res - 1) - 0.5) * span;
  let land = 0, hi = -Infinity, lo = Infinity;
  for (let j = 0; j < res; j++) {
    const z = zOf(j);
    for (let i = 0; i < res; i++) {
      const y = sampler(xOf(i), z);
      const k = j * res + i;
      h[k] = y;
      if (y > level) { land++; } else { wet[k] = 1; }
      if (y > hi) hi = y;
      if (y < lo) lo = y;
    }
  }

  const clamp = (v, n) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const at = (i, j) => h[clamp(j, res) * res + clamp(i, res)];

  /* ── which land is joined to which ──
     Built on demand, because most callers never ask. It answers the one
     question that decides whether a composition is possible at all: are these
     two places on the same piece of ground. Without it a grammar happily puts
     a citadel on one island and the roads that are supposed to converge on it
     on another, and the router then spends its whole budget discovering that
     there is no way there — which looks like a routing bug and is a placement
     one. Four-connected, because a road cannot cross a diagonal pinch. */
  let comp = null;
  function components() {
    if (comp) return comp;
    const labels = new Int32Array(res * res).fill(-1);
    const sizes = [];
    const q = new Int32Array(res * res);
    for (let p = 0; p < res * res; p++) {
      if (wet[p] || labels[p] >= 0) continue;
      const id = sizes.length;
      let qh = 0, qt = 0, n = 0;
      q[qt++] = p; labels[p] = id;
      while (qh < qt) {
        const c = q[qh++]; n++;
        const i = c % res, j = (c - i) / res;
        const push = (ni, nj) => {
          if (ni < 0 || nj < 0 || ni >= res || nj >= res) return;
          const k = nj * res + ni;
          if (wet[k] || labels[k] >= 0) return;
          labels[k] = id; q[qt++] = k;
        };
        push(i - 1, j); push(i + 1, j); push(i, j - 1); push(i, j + 1);
      }
      sizes.push(n);
    }
    comp = { labels, sizes, dry: land };
    return comp;
  }

  const cellOf = (x, z) => ({
    i: clamp(Math.round((x / span + 0.5) * (res - 1)), res),
    j: clamp(Math.round((z / span + 0.5) * (res - 1)), res),
  });

  return {
    res, size, span, step, level, h, wet, xOf, zOf, at, cellOf,
    hi, lo, landFraction: land / (res * res),

    // Which connected piece of dry ground a cell belongs to, or -1 for water.
    landmassAt(i, j) { return components().labels[clamp(j, res) * res + clamp(i, res)]; },
    landmassAtWorld(x, z) { const c = cellOf(x, z); return this.landmassAt(c.i, c.j); },
    // That piece's share of all the dry ground there is, 0..1.
    landmassShare(id) {
      const c = components();
      return id < 0 || !c.dry ? 0 : c.sizes[id] / c.dry;
    },

    /* Metres of rise per metre of run, from central differences on the grid.
       Coarse by construction: this is "could a town sit here", not "is this
       tile walkable". */
    slope(i, j) {
      return Math.max(Math.abs(at(i + 1, j) - at(i - 1, j)),
                      Math.abs(at(i, j + 1) - at(i, j - 1))) / (2 * step);
    },

    /* How much of the disc of radius `r` cells is dry / wet. Both, because a
       coast is the place where BOTH are near a half and a plain is the place
       where the first is near one. */
    landAround(i, j, r = 3) {
      let n = 0, dry = 0;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (di * di + dj * dj > r * r) continue;
          n++;
          if (at(i + di, j + dj) > level) dry++;
        }
      }
      return n ? dry / n : 0;
    },

    /* Cells to the nearest water, capped at `max`. Rings outward, so the
       common answer (there is sea right there) costs almost nothing. */
    seaDistance(i, j, max = 10) {
      if (at(i, j) <= level) return 0;
      for (let r = 1; r <= max; r++) {
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            if (at(i + di, j + dj) <= level) return r;
          }
        }
      }
      return max + 1;
    },

    /* The bearing that walks OUT to sea from a coastal cell: the average
       direction of the wet cells around it. Returns null inland — a village
       that faces the water needs to know which way that is, and guessing is
       how a jetty ends up pointing at a hill. */
    seaBearing(i, j, r = 5) {
      let sx = 0, sz = 0, n = 0;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if ((di || dj) && di * di + dj * dj <= r * r && at(i + di, j + dj) <= level) {
            const w = 1 / Math.hypot(di, dj);
            sx += di * w; sz += dj * w; n++;
          }
        }
      }
      if (!n) return null;
      const m = Math.hypot(sx, sz);
      return m < 1e-6 ? null : { x: sx / m, z: sz / m };
    },

    // Distance from the world's middle, 0 at the centre and 1 at the scan's rim.
    radius01(i, j) {
      return Math.min(1, Math.hypot(xOf(i), zOf(j)) / (span / 2));
    },
  };
}

/* ── greedy separated peaks ──
   `score(field, i, j)` returns a number, or ≤ 0 for "not a candidate". The
   best cell wins, everything within `minSep` metres of it is struck out, and
   the next best wins — which is the only picking rule that gives three
   settlements rather than one settlement with a bulge on each side.

   Deterministic. `rng`, when given, adds a bounded wobble to each score, so a
   caller can reroll a layout on a new stream without the terrain's own
   ranking being thrown away. */
export function pickSites(field, score, { count = 1, minSep = 0, rng = null, wobble = 0.18 } = {}) {
  const { res, xOf, zOf } = field;
  const cands = [];
  for (let j = 1; j < res - 1; j++) {
    for (let i = 1; i < res - 1; i++) {
      let s = score(field, i, j);
      if (!(s > 0)) continue;
      if (rng) s *= 1 - wobble + rng() * wobble * 2;
      cands.push({ x: xOf(i), z: zOf(j), i, j, score: s });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) {
    if (out.length >= count) break;
    if (out.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= minSep)) out.push(c);
  }
  return out;
}
