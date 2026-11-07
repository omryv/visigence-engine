// Hand sculpting on top of the procedural terrain: the ordered list of brush
// strokes, and the two ways it is evaluated.
//
// The STROKES are what live in params (`params.terrain.sculpt`) — a few
// numbers each, not a 66k-cell grid — so an authored world still travels as
// one small params object into VSight and the exporters, and replaying them
// against the same base rebuilds the identical surface.
//
// ── WHY THIS IS NOT ONE RASTER ──
// It was, and the raster was the only thing anyone sampled: strokes in, a 257²
// offset grid out, bilinear reads for the terrain mesh, the grass, the props,
// collision and the water bake. On a 4 km world that grid is 16 m a cell,
// which is between two and thirty-two times coarser than the mesh reading it —
// and the brush UI offers radii from 10 m, i.e. BELOW ONE CELL. What that
// bought was a brush whose delivered depth depended on where between grid
// nodes the pointer landed: 8.00 m on a node, 0.83 m half a cell away, and
// nothing whatsoever at a cell centre, where the nearest node is 11.3 m off
// and a 10 m brush reaches none. The comment that used to sit here claimed
// "a brush smaller than one cell still writes its centre cell". It did not.
//
// The deeper cost was upstream. js/landform.js has to know the post-stroke
// height to decide slopes, water routing and where a moat sits — before any
// grid exists — so it carried its own analytic copy of this falloff, and every
// terrain decision a generated world makes was computed on the exact surface
// while the world rendered on the quantised one. That file narrowed what its
// own grammar was allowed to express to stay inside the gap.
//
// So the strokes are evaluated rather than sampled:
//
//     offsetAt = analyticAt   live raise/lower, exact, bucket-indexed
//              + rasterAt     retired strokes, and all smooth/flatten
//
// `raise` and `lower` are closed forms and need no grid. `smooth` and
// `flatten` genuinely do — one pulls toward the local average of the RESULT
// and the other targets it, so both need a surface to reason about — and they
// keep rasterising, now over an exact raise/lower field rather than a
// quantised one.
//
// ── AND IT STAYS BOUNDED ──
// A drag emits a stroke every 0.22·radius metres, so a long session can reach
// thousands, and an unbounded analytic sum is O(strokes) on the hot path. Past
// LIVE_CAP the oldest half is RETIRED: rasterised into the grid and dropped
// from the index. The grid stops being the representation and becomes the
// accumulator for strokes old enough that later ones are piled on top of them.
// Retirement depends only on stroke order, so replay is still bit-exact, and
// no world this product ships comes near the cap (farshore is 46 strokes).
//
// Measured on a 65² tile of samples: the bucketed analytic path is 15.9 ns a
// sample against farshore's strokes and ~22 ns at the cap, versus 22.6 ns for
// the bilinear read it replaces — four loads from a 257 KB array miss cache,
// a hot bucket list does not — and 422 ns for the noise sampler it is added
// to. Exactness here is free.
//
// Pure JS (no three.js) so it runs in JSC tests alongside the rest of the
// heightfield code.

const MODES = ["raise", "lower", "smooth", "flatten"];
const RAISE = 0, LOWER = 1;

/* How many strokes stay exact at once, and how wide a bucket is. The pair is
   chosen together: at 512 live strokes a sustained drag piles ~54 into the
   busiest 128 m bucket, which evaluates in the time the bilinear read used to
   take. Raising the cap costs sampling; lowering it costs fidelity on old
   strokes, which are the ones already buried. */
const LIVE_CAP = 512;
const BUCKET_M = 128;

/** The brush falloff, evaluated rather than sampled: 1 at the centre, 0 at the
    rim, smoothstepped between. THE one expression — js/landform.js imports it
    so the surface its grammar reasons about is the surface that renders.
    `limit` stops the sum early, which is how the landform reads the ground as
    it stood before a given stroke. Skips smooth/flatten, which are not closed
    forms; a caller that needs those needs a SculptLayer. */
export function strokeOffsetAt(strokes, x, z, limit = strokes.length) {
  let o = 0;
  for (let i = 0; i < limit; i++) {
    const s = strokes[i];
    if (s.m > LOWER) continue;
    const dx = x - s.x, dz = z - s.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= s.r * s.r) continue;
    const t = 1 - Math.sqrt(d2) / s.r;
    o += (s.m === LOWER ? -1 : 1) * s.a * t * t * (3 - 2 * t);
  }
  return o;
}

export class SculptLayer {
  constructor({ size, res = 257 }) {
    this.size = size;
    this.res = res;
    this.data = new Float32Array(res * res);
    this._rasterUsed = false;
    this.strokes = [];
    this._resetLive();
  }

  get empty() { return this.strokes.length === 0; }

  /* ── the live set ──
     Raise/lower strokes not yet retired, plus a uniform bucket index over
     their footprints. `_bn` is the grid width; a stroke is listed in every
     bucket its bounding box touches, so a lookup is one bucket and no
     neighbour walk. */
  _resetLive() {
    this._live = [];
    this._bn = Math.max(1, Math.ceil(this.size / BUCKET_M) + 1);
    this._buckets = new Array(this._bn * this._bn);
  }

  /* Whether anything has been written to the grid at all. A world sculpted
     only with raise and lower — which is most of them, and all of farshore's
     shaping — never touches it, and a bilinear read of four zeroes is four
     loads out of a 257 KB array that miss cache for nothing. Set by
     _rasterize, cleared by replay, and never a correctness term: it only
     decides whether to bother asking. */
  get _rastered() { return this._rasterUsed === true; }

  _index(s) {
    const { size, _bn: n } = this;
    const lo = (w) => Math.min(n - 1, Math.max(0, ((w + size / 2) / BUCKET_M) | 0));
    const i0 = lo(s.x - s.r), i1 = lo(s.x + s.r);
    const j0 = lo(s.z - s.r), j1 = lo(s.z + s.r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        (this._buckets[k] || (this._buckets[k] = [])).push(s);
      }
    }
  }

  /** The exact contribution of every live raise/lower stroke over this point.
      Clamped into the edge buckets with the SAME rule _index files under —
      not truncated: `|0` rounds toward zero, so a query just off the plate at
      x < -size/2 landed in bucket 0 as if it were ON the plate, while the
      i < 0 guard it wore could never fire. Since _index clamps rim strokes
      into buckets 0 and n-1, the clamp is also the correct read: a stroke
      whose radius reaches past the edge contributes past the edge, and
      strokeOffsetAt's falloff already answers 0 for everything farther. */
  analyticAt(x, z) {
    const { size, _bn: n } = this;
    const lo = (w) => Math.min(n - 1, Math.max(0, ((w + size / 2) / BUCKET_M) | 0));
    const list = this._buckets[lo(z) * n + lo(x)];
    return list ? strokeOffsetAt(list, x, z) : 0;
  }

  // Bilinear read of the rasterised field, in metres. Outside the grid = 0.
  rasterAt(x, z) {
    if (this._rasterUsed !== true) return 0;
    const { res, data } = this;
    let fx = this._cellOf(x), fz = this._cellOf(z);
    if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return 0;
    fx = Math.min(fx, res - 1.001); fz = Math.min(fz, res - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const a = data[iz * res + ix], b = data[iz * res + ix + 1];
    const c = data[(iz + 1) * res + ix], d = data[(iz + 1) * res + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** The whole offset field, in metres — what every consumer samples. */
  offsetAt(x, z) {
    return this.analyticAt(x, z) + this.rasterAt(x, z);
  }

  // grid index → world, and back
  _worldOf(i) { return (i / (this.res - 1) - 0.5) * this.size; }
  _cellOf(w) { return ((w / this.size) + 0.5) * (this.res - 1); }

  // Apply one stroke. `base(x, z)` is the un-sculpted height, needed by the
  // modes that reason about the resulting surface (smooth, flatten).
  // Returns the stroke record that was appended.
  apply({ x, z, r, amount, mode = "raise" }, base) {
    const rec = {
      x: round2(x), z: round2(z), r: round2(r),
      a: round3(amount), m: MODES.indexOf(mode) < 0 ? 0 : MODES.indexOf(mode),
    };
    this.strokes.push(rec);
    this._absorb(rec, base);
    return rec;
  }

  // Rebuild everything from a stroke list (VSight boot, undo, world reload).
  replay(strokes, base) {
    this.data.fill(0);
    this._rasterUsed = false;
    this.strokes = [];
    this._resetLive();
    for (const s of strokes || []) {
      this.strokes.push(s);
      this._absorb(s, base);
    }
    return this;
  }

  /* One stroke into whichever representation can hold it exactly. */
  _absorb(rec, base) {
    if (rec.m <= LOWER) {
      this._live.push(rec);
      this._index(rec);
      if (this._live.length > LIVE_CAP) this._retire(base);
      return;
    }
    this._rasterize(rec, base);
  }

  /* ── retirement ──
     The oldest half of the live set is rasterised and dropped, and the index
     is rebuilt from what is left. Half rather than one, so the cost is
     amortised instead of paid on every stroke past the cap; oldest rather
     than smallest, so the order is a pure function of the stroke list and
     replay reproduces the same field. */
  _retire(base) {
    const going = this._live.splice(0, this._live.length >> 1);
    const staying = this._live;
    this._resetLive();
    for (const s of going) this._rasterize(s, base);
    for (const s of staying) { this._live.push(s); this._index(s); }
  }

  _rasterize(rec, base) {
    const { res, data } = this;
    const mode = MODES[rec.m] || "raise";
    const i0 = Math.max(0, Math.floor(this._cellOf(rec.x - rec.r)));
    const i1 = Math.min(res - 1, Math.ceil(this._cellOf(rec.x + rec.r)));
    const j0 = Math.max(0, Math.floor(this._cellOf(rec.z - rec.r)));
    const j1 = Math.min(res - 1, Math.ceil(this._cellOf(rec.z + rec.r)));
    if (i1 < i0 || j1 < j0) return;
    this._rasterUsed = true;

    /* The surface as it stands, which for smooth and flatten is the whole
       point: the live analytic strokes are part of the ground they are
       reasoning about, and reading only `data` would have them average and
       target a surface with every raise missing from it. */
    const surface = (wx, wz, k) => (base ? base(wx, wz) : 0) + this.analyticAt(wx, wz) + data[k];

    // flatten aims at the surface height under the brush centre
    const target = mode === "flatten"
      ? (base ? base(rec.x, rec.z) : 0) + this.offsetAt(rec.x, rec.z)
      : 0;

    for (let j = j0; j <= j1; j++) {
      const wz = this._worldOf(j);
      for (let i = i0; i <= i1; i++) {
        const wx = this._worldOf(i);
        const d = Math.hypot(wx - rec.x, wz - rec.z);
        if (d > rec.r) continue;
        // smooth-edged brush: 1 at the centre, 0 at the rim
        const t = 1 - d / rec.r;
        const fall = t * t * (3 - 2 * t);
        const k = j * res + i;

        if (mode === "raise") data[k] += rec.a * fall;
        else if (mode === "lower") data[k] -= rec.a * fall;
        else if (mode === "flatten") {
          const here = surface(wx, wz, k);
          data[k] += (target - here) * Math.min(fall * Math.abs(rec.a) * 0.06, 1);
        } else { // smooth: pull toward the local average of the RESULT surface
          let sum = 0, n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const si = i + di * 2, sj = j + dj * 2;
              if (si < 0 || sj < 0 || si >= res || sj >= res) continue;
              sum += surface(this._worldOf(si), this._worldOf(sj), sj * res + si);
              n++;
            }
          }
          if (!n) continue;
          const here = surface(wx, wz, k);
          data[k] += (sum / n - here) * Math.min(fall * Math.abs(rec.a) * 0.05, 1);
        }
      }
    }
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
export { MODES as SCULPT_MODES, LIVE_CAP as SCULPT_LIVE_CAP };
