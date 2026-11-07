/* roadnet.js — the roads BETWEEN places.
 *
 * A composer lays the streets inside a settlement (compose.js). This lays the
 * road that gets you from one settlement to the next, which is the piece that
 * turns three villages into a country.
 *
 * IT IS A ROUTE, NOT A LINE. Drawing a straight road between two towns is the
 * one thing that reliably destroys the illusion the rest of this engine is
 * building: it climbs a ridge it should have gone round, it runs across a bay,
 * and it arrives at a gradient no cart could take. So the road is SEARCHED for
 * — an A* over a coarse grid sampled off the live height field, where the cost
 * of a step is its length multiplied by how steep it is, and water is either a
 * wall or, where a deck would fit, a very expensive kind of ground.
 *
 * That is also why it is worth having: the route a road takes is evidence
 * about the terrain. A road that swings wide round a headland is telling you
 * there is a headland, and it is telling you because there is.
 *
 * BELOW SEA LEVEL IS NOT THE SAME AS WET, and this module believed it was for
 * a long time. engine/water/flood.js exists because a pit dug into a mountain
 * is under the waterline and holds no sea: water is only where there is a path
 * to the open edge. Reading height alone, the router treated every closed
 * basin in a world as an impassable lake — which on a five-kilometre map with
 * real relief is most of the low ground, and the symptom was settlements that
 * silently arrived with no road to them. Callers that have the flood mask pass
 * `wetAt`; callers that do not get the old height rule, which is right for a
 * gentle world and only ever over-cautious.
 *
 * Pure JS — no three.js, no DOM. The caller owns placement and sculpting; this
 * owns the geometry and the decision.
 */
/* ── the search ──
   `cell` is the grid pitch in metres. 14 is a compromise found by looking at
   the results: coarser and the road cuts corners it should not, finer and a
   1500 m route is a hundred thousand nodes for no visible gain.

   The slope term is squared on purpose. A road does not mind a gentle rise
   and cannot take a cliff, and a linear penalty models neither — it trades a
   long detour for a steep climb at exactly the wrong exchange rate. */
const SQRT2 = Math.SQRT2;

/**
 * Route between two points, easing the gradient rule until something gets
 * through.
 *
 * The escalation is the honest part. A road SHOULD refuse a 19° step, but a
 * generated world is under no obligation to contain a gentle way across
 * itself — an alpine seed can put a town on each side of a wall — and a
 * template that silently shipped no road at all would be worse than one that
 * shipped a steep one. So it asks three times, gets less fussy each time, and
 * tells the caller which answer it got: `grade` is the rule the route
 * actually met, and a caller can say "mountain road" when it is the third.
 */
export function planRoute(opts = {}) {
  /* Four rungs, and the last one is not a gradient a cart would take.
     A generated world is under no obligation to contain a gentle way across
     itself: on a five-kilometre map with real relief, two places on the same
     landmass are routinely separated by ground no rule under about fifty
     degrees will cross, and the choice there is a mountain road or a
     settlement nobody can reach. The cost function still punishes steepness
     quadratically, so even at the top rung the route takes the gentlest line
     that exists — it is the REFUSAL that is relaxed, not the preference. The
     caller is told (`strained`, and the grade it actually met) and says so in
     the log. */
  const ladder = opts.maxGrade ? [opts.maxGrade] : [0.3, 0.46, 0.72, 1.15];
  const straight = Math.hypot(opts.to.x - opts.from.x, opts.to.z - opts.from.z);
  /* A ROAD MAY GO ROUND SOMETHING; IT MAY NOT GO ROUND EVERYTHING. A search
     that has to reach the far side of a bay will happily return a nine-
     kilometre coast road between two towns a kilometre apart, and that is not
     evidence about the terrain, it is a line nobody would ever have surveyed.
     Past the cap the honest answer is that these two places are not joined —
     the caller says so and the world is a world with an unroaded settlement in
     it, which is a real kind of place. */
  const cap = (opts.maxDetour ?? 2.6) * straight + 400;
  let over = null;
  for (let i = 0; i < ladder.length; i++) {
    const points = search({ ...opts, maxGrade: ladder[i] });
    if (!points) continue;
    const run = pathLength(points);
    if (run <= cap) return { points, grade: ladder[i], strained: i > 0, length: Math.round(run) };
    if (!over || run < over.length) over = { points, grade: ladder[i], strained: true, length: Math.round(run) };
  }
  if (over) console.info(`[roadnet] no sane route: the shortest way round is ${over.length} m `
    + `for ${Math.round(straight)} m as the crow flies`);
  return null;
}

function pathLength(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return n;
}

/**
 * A route that does NOT go round things.
 *
 * The A* above is the right answer for a road between two towns, and the
 * wrong one for a ceremonial approach: an avenue laid to a palace is a
 * statement that the ground was made to suit the building, and a statement
 * that switchbacks round a hillock is not one. So this returns the straight
 * line, subdivided, and the caller levels what it crosses — which is what
 * whoever built the palace did.
 *
 * It still reports a grade, because a caller that finds it is being asked for
 * a mile of cutting through a mountain should be able to know.
 */
export function planAvenue({ sampler, from, to, steps = 0 } = {}) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const run = Math.hypot(dx, dz);
  if (!(run > 1)) return null;
  const n = Math.max(2, steps || Math.ceil(run / 40));
  const points = [];
  let grade = 0;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = { x: from.x + dx * t, z: from.z + dz * t };
    if (sampler && prev) {
      const d = run / n;
      grade = Math.max(grade, Math.abs(sampler(p.x, p.z) - sampler(prev.x, prev.z)) / d);
    }
    points.push(p);
    prev = p;
  }
  return { points, grade: Math.round(grade * 100) / 100, strained: false, straight: true };
}

function search({
  sampler, from, to,
  waterLevel = 0,
  cell = 0,
  /* How far outside the straight line the search may wander. Scaled with the
     distance rather than fixed: a fixed corridor is generous over 400 m and a
     straitjacket over three kilometres, and the case that needs the room —
     a bay between two towns — is always the long one. */
  margin = 0,
  maxGrade = 0.3,        // ~17°: a step steeper than this is not a road
  gradeCost = 26,        // how many metres of detour a full-grade step is worth
  /* How much open water the road may be carried over on a deck. Zero is the
     old rule and it is the wrong one now that layRoad can bridge: with water
     as an absolute wall, a stream forty metres wide between two settlements
     is a road that does not exist, and a five-kilometre kingdom with a river
     down the middle has no network at all. */
  bridgeSpan = 0,
  wetCost = 7,           // a metre of deck is worth this many of road
  /* `wetAt(x, z)` — is there actually water here. Optional; see the header. */
  wetAt = null,
  budget = 260000,       // node expansions before giving up
} = {}) {
  if (!sampler || !from || !to) return null;
  const straight = Math.hypot(to.x - from.x, to.z - from.z);
  if (!margin) margin = Math.max(240, straight * 0.5);
  /* THE GRID PITCH SCALES WITH THE JOB. Fourteen metres is the right cell for
     a four-hundred-metre road and a disaster for a three-kilometre one: the
     search box grows as the square, so the same pitch that costs three
     thousand nodes over a short leg costs a quarter of a million over a long
     one, and the router quietly returned "no road" on the biggest world in
     the set. Coarser cells over longer routes keep the node count roughly
     constant, and at that distance nobody can see the difference between a
     fourteen-metre and a twenty-eight-metre decision. */
  if (!cell) cell = Math.min(40, Math.max(14, Math.round(straight / 90 / 2) * 2));

  const x0 = Math.min(from.x, to.x) - margin, x1 = Math.max(from.x, to.x) + margin;
  const z0 = Math.min(from.z, to.z) - margin, z1 = Math.max(from.z, to.z) + margin;
  const nx = Math.max(2, Math.ceil((x1 - x0) / cell) + 1);
  const nz = Math.max(2, Math.ceil((z1 - z0) / cell) + 1);
  if (nx * nz > 260000) return null;   // absurd distance; the caller falls back

  const wx = (i) => x0 + i * cell;
  const wz = (j) => z0 + j * cell;
  const idx = (i, j) => j * nx + i;

  // One height sample per node, taken once. The sampler is the expensive call
  // in this whole routine and the search revisits nodes constantly.
  const h = new Float32Array(nx * nz);
  const wet = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = wx(i), z = wz(j);
      const y = sampler(x, z);
      h[idx(i, j)] = y;
      // Low AND wet. Either alone is wrong: dry ground above the line is
      // never water, and a hollow below it is water only when the sea can
      // reach it.
      wet[idx(i, j)] = y < waterLevel + 1.2 && (!wetAt || wetAt(x, z)) ? 1 : 0;
    }
  }

  /* ── which water a bridge could actually cross ──
     Not "is this cell wet" but "how far is this wet cell from dry land",
     which is the question a deck asks. One breadth-first pass out from every
     shore cell labels the whole sea with its distance to land, so a stream is
     crossable along its entire length and the middle of a bay is not — and
     the router then chooses the narrows on its own, because a wide crossing
     costs more steps than a narrow one. */
  const reach = bridgeSpan > 0 ? Math.max(1, Math.ceil(bridgeSpan / cell / 2)) : 0;
  const crossable = new Uint8Array(nx * nz);
  if (reach > 0) {
    const dist = new Int32Array(nx * nz).fill(-1);
    const q = new Int32Array(nx * nz);
    let qh = 0, qt = 0;
    for (let p = 0; p < nx * nz; p++) if (!wet[p]) { dist[p] = 0; q[qt++] = p; }
    while (qh < qt) {
      const p = q[qh++];
      if (dist[p] >= reach) continue;
      const i = p % nx, j = (p - i) / nx;
      const step = (ni, nj) => {
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) return;
        const n = nj * nx + ni;
        if (dist[n] >= 0) return;
        dist[n] = dist[p] + 1; crossable[n] = 1; q[qt++] = n;
      };
      step(i - 1, j); step(i + 1, j); step(i, j - 1); step(i, j + 1);
    }
  }

  const clampI = (v, n) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  /* An endpoint may land in the water — a settlement scored on a shoreline
     rounds to a wet cell often enough to matter — and a search that starts on
     a blocked node finds nothing at all while looking exactly like a world
     with no route in it. So an endpoint walks outward to the nearest dry
     ground, and the run is stitched back to the true coordinate afterwards. */
  const anchor = (px, pz) => {
    let i = clampI(Math.round((px - x0) / cell), nx);
    let j = clampI(Math.round((pz - z0) / cell), nz);
    if (!wet[idx(i, j)]) return idx(i, j);
    for (let r = 1; r <= 8; r++) {
      let best = -1, bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
          const n = idx(ni, nj);
          if (wet[n]) continue;
          const d = Math.hypot(wx(ni) - px, wz(nj) - pz);
          if (d < bestD) { bestD = d; best = n; }
        }
      }
      if (best >= 0) return best;
    }
    return idx(i, j);
  };
  const start = anchor(from.x, from.z), goal = anchor(to.x, to.z);
  if (start === goal) return [{ x: from.x, z: from.z }, { x: to.x, z: to.z }];

  const g = new Float32Array(nx * nz).fill(Infinity);
  const f = new Float32Array(nx * nz).fill(Infinity);
  const came = new Int32Array(nx * nz).fill(-1);
  const closed = new Uint8Array(nx * nz);

  const heur = (n) => {
    const i = n % nx, j = (n - i) / nx;
    return Math.hypot(wx(i) - to.x, wz(j) - to.z);
  };
  g[start] = 0; f[start] = heur(start);

  /* A binary heap, hand-rolled. A sorted array re-sorted per push is what
     turns a 30 ms search into a 4 s one, and this module has to be able to
     run four routes inside one click without the frame ever noticing. */
  const heap = [start];
  const push = (n) => {
    heap.push(n);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (f[heap[p]] <= f[heap[c]]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1, r = l + 1;
        let m = p;
        if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
        if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]];
        p = m;
      }
    }
    return top;
  };

  let spent = 0;
  while (heap.length && spent++ < budget) {
    const cur = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % nx, cj = (cur - ci) / nx;

    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const n = idx(ni, nj);
        if (closed[n]) continue;
        const bridged = wet[n] && crossable[n];
        if (wet[n] && !bridged) continue;
        const run = (di && dj ? SQRT2 : 1) * cell;
        // A deck is level, so the grade rule does not apply to it — and it
        // would fail against a riverbed anyway.
        let step;
        if (bridged) {
          step = run * wetCost;
        } else {
          const grade = Math.abs(h[n] - h[cur]) / run;
          if (grade > maxGrade) continue;
          step = run * (1 + gradeCost * (grade / maxGrade) ** 2);
        }
        const t = g[cur] + step;
        if (t >= g[n]) continue;
        came[n] = cur; g[n] = t; f[n] = t + heur(n);
        push(n);
      }
    }
  }
  if (!isFinite(g[goal])) return null;

  const path = [];
  for (let n = goal; n !== -1; n = came[n]) {
    const i = n % nx;
    path.push({ x: wx(i), z: wz((n - i) / nx) });
  }
  path.reverse();
  // The true endpoints, not the nodes nearest them: a road that stops seven
  // metres short of the gate is a road with a gap in it.
  path[0] = { x: from.x, z: from.z };
  path[path.length - 1] = { x: to.x, z: to.z };
  return simplify(path, cell * 0.55);
}

/* Ramer–Douglas–Peucker. The grid gives a staircase; this gives the line a
   surveyor would have drawn through the same country. */
export function simplify(points, tolerance = 8) {
  if (points.length < 3) return points.slice();
  let worst = 0, at = 0;
  const [a, b] = [points[0], points[points.length - 1]];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const d = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tolerance) return [a, b];
  return [
    ...simplify(points.slice(0, at + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(at), tolerance),
  ];
}

/* ── laying it ──
   Road modules are 6 m long and 9 m kerb-to-kerb, so a run is walked in 6 m
   steps and each step gets one tile turned to face along it.

   A BEND GETS A JUNCTION. Two rectangular slabs meeting at an angle leave a
   wedge of bare ground on the outside of the turn and overlap on the inside,
   and overlapping coplanar slabs is a shimmering seam that follows the
   camera. A junction tile is square, so it covers the corner from every
   direction and the two runs simply abut it — the same trick the street grid
   uses at its crossings, for the same reason.

   Pads are emitted every few tiles rather than under each: one flatten per
   6 m would be four hundred sculpt strokes on a long route, and the terrain
   replays every stroke it has ever been given on each rebuild. */
export function layRoad({
  route, road, junction, bridge, sampler, uidAt, index = 0, wetAt = null,
  waterLevel = 0, padEvery = 4, padRadius = 13, padAmount = 3.2, bridgeSpan = 26,
} = {}) {
  const records = [], pads = [];
  if (!route || route.length < 2 || !road) return { records, pads, length: 0, bridges: 0 };
  const TILE = road.meta?.tile || 6;
  const BEND = 0.24;            // radians of turn that earns a junction
  let n = index, total = 0, sinceLastPad = 0, spans = 0;
  /* ── the rhythm carries across the joint ──
     Every leg used to lay its own tiles from scratch, at (i + ½)/steps of
     itself, which leaves half a spacing bare at each end of every leg. On
     level ground nothing shows: the tiles are six metres long and a gap of
     three is still covered by the tiles either side of it. On a slope it is
     the whole problem. The tiles of a run overlap, so a walk climbs them like
     stairs whose riser is the spacing times the grade — a stride at most,
     which is what the ladder below is for — but ONLY while the overlap is
     unbroken. At every leg boundary the chain parted, and what a walk met
     there was not the next tread but the bare downhill EDGE of a slab, half a
     tile of grade above the ground: 0.6 m and more, thirteen times on one
     road. The faults were at the corners because the corners were the joins.

     So the spacing is a rhythm the whole route keeps, and `carry` is where the
     next tile falls measured into the leg now being laid. A leg shorter than
     the spacing lays nothing and passes the debt on. The phase still starts at
     half a spacing, so a road begins where it always began. */
  let carry = null;

  const place = (spec, x, z, rot, y = null) => {
    const rec = {
      uid: uidAt(n++), ref: spec.ref, url: null, label: spec.label, proc: spec.proc,
      position: [r2(x), r2(y != null ? y : (sampler ? sampler(x, z) : 0)), r2(z)],
      rotationY: r3(rot), scale: 1, autoFit: false,
    };
    if (y != null) rec.seat = "point";
    records.push(rec);
    return rec;
  };
  const alongTo = (dx, dz) => Math.atan2(-dz, dx);

  for (let s = 0; s < route.length - 1; s++) {
    const a = route[s], b = route[s + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const run = Math.hypot(dx, dz);
    if (run < 1) continue;
    const ux = dx / run, uz = dz / run;
    const rot = alongTo(ux, uz);
    /* ── how many pieces this leg takes, and why it is not just its length ──
       A tile is a FLAT slab seated on the ground under its own centre, so a
       run of them up a hill is a flight of steps whose riser is the grade
       times the tile. At the 6 m module that makes anything steeper than
       about one in eleven a stair the walk controller cannot climb: it stops
       at 0.55 m (engine/player/collide.js), and the router will happily
       accept a 0.3 grade — 1.8 m a tile. Every hill road in the four worlds
       was a wall you could see over.

       So a steep leg is laid in CLOSER pieces. The tiles overlap, which on a
       slope is what paving does anyway, and the riser between one and the
       next stays inside a stride. Flat ground is untouched: the spacing only
       tightens where the ground makes it. */
    let steps = Math.max(1, Math.round(run / TILE));
    if (sampler) {
      // The worst riser this spacing would actually build, measured on the
      // ground rather than inferred from the leg's average grade: a leg that
      // is level end to end can still cross a bank in the middle of itself.
      const worstRise = (n) => {
        let worst = 0, prev = null;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const h = sampler(a.x + dx * t, a.z + dz * t);
          if (prev != null) worst = Math.max(worst, Math.abs(h - prev));
          prev = h;
        }
        return worst;
      };
      const most = Math.max(steps, Math.ceil(run / MIN_TILE));
      while (steps < most && worstRise(steps) > STEP_RISE) steps = Math.min(most, steps * 2);
      /* THE LADDER CAN RUN OUT, and past the spacing floor there is nothing
         left for it to tighten. What gets laid there is a flight of six-metre
         slabs across ground too steep to hold them, and the router has
         already passed the leg — it measures grade between grid nodes
         fourteen metres apart, and the bank that stops a walker is six.
         `tools/walk-world.mjs` still finds the survivors of exactly that on
         one road out of one seed: ground running at 0.41 where the route was
         surveyed at 0.3.

         Two things do NOT fix it, both tried and both measured. Padding the
         leg harder does nothing, because a flatten stroke aims at the ground
         under its own centre: a pad under every tile levels the shelf ACROSS
         the road and leaves the profile ALONG it exactly as steep as it was.
         And tightening the spacing further cannot touch the lip a flat slab
         presents at its downhill edge. What does work is refusing the grade
         in the first place — a gentlest rung derived from the module, about
         one in eight — and it costs every hill road roughly double its length
         in switchbacks, which is a change to what the worlds look like rather
         than to whether they are right. */
    }

    /* ── the wet tiles ──
       A road module in the sea is a slab floating on the sea, so the tile is
       either skipped (a ford) or BRIDGED. Which one depends on how long the
       wet run is: a couple of modules is a crossing worth decking, and two
       hundred metres is a causeway across a bay that nobody asked for. So the
       wet stretch is measured first, and only short ones get a deck.

       This is what makes a route legible from the air. A road that stops at
       the water and picks up on the far side reads as two roads; the same
       road with a bridge in it reads as one, and the bridge is the thing the
       eye lands on. */
    // Where the tiles of THIS leg fall, continuing the rhythm the last leg
    // left off on rather than restarting inside it.
    const spacing = run / steps;
    if (carry == null) carry = spacing / 2;
    const offs = [];
    for (let d = carry; d < run - 1e-6; d += spacing) offs.push(d);
    carry = (offs.length ? offs[offs.length - 1] + spacing : carry) - run;

    const wet = new Array(offs.length);
    for (let i = 0; i < offs.length; i++) {
      const t = offs[i] / run;
      const px = a.x + dx * t, pz = a.z + dz * t;
      wet[i] = !!(sampler && sampler(px, pz) < waterLevel + 0.3 && (!wetAt || wetAt(px, pz)));
    }
    const decked = new Array(offs.length).fill(false);
    if (bridge) {
      for (let i = 0; i < offs.length; i++) {
        if (!wet[i] || decked[i]) continue;
        let j = i;
        while (j < offs.length && wet[j]) j++;
        // Measured in metres of carriageway, which is the spacing rather than
        // the module: on a tightened leg the two are not the same number.
        const span = (j - i) * spacing;
        if (span <= bridgeSpan) { for (let k = i; k < j; k++) decked[k] = true; spans++; }
        i = j;
      }
    }

    for (let i = 0; i < offs.length; i++) {
      const t = offs[i] / run;
      const x = a.x + dx * t, z = a.z + dz * t;
      if (wet[i] && !decked[i]) continue;
      if (decked[i]) {
        // The deck rides just over the waterline, level for the whole span.
        place(bridge, x, z, alongTo(uz, -ux), waterLevel + 1.1);
        total += spacing;
        continue;
      }
      place(road, x, z, rot);
      total += spacing;
      if (sinceLastPad++ % padEvery === 0) pads.push({ x: r2(x), z: r2(z), r: padRadius, amount: padAmount });
    }

    // The corner at b, if the road actually turns there.
    const c = route[s + 2];
    if (junction && c) {
      const ex = c.x - b.x, ez = c.z - b.z;
      const el = Math.hypot(ex, ez) || 1;
      const turn = Math.acos(Math.max(-1, Math.min(1, ux * (ex / el) + uz * (ez / el))));
      const dryCorner = !sampler || sampler(b.x, b.z) >= waterLevel + 0.3 || (wetAt && !wetAt(b.x, b.z));
      if (turn > BEND && dryCorner) {
        place(junction, b.x, b.z, rot);
        pads.push({ x: r2(b.x), z: r2(b.z), r: padRadius, amount: padAmount });
      }
    }
  }
  return { records, pads, length: Math.round(total), bridges: spans };
}

/* The step between two consecutive pieces of a way, and the closest they may
   ever be laid. The walk controller climbs 0.55 m; 0.45 leaves the margin
   that keeps a rounded height from tipping a road over the edge of walkable.
   The floor on spacing is what stops a cliff-side leg from being paved in a
   hundred slabs — past that the ground is too steep to be a road, and the
   route's own grade ladder is the thing that should have said so. */
const STEP_RISE = 0.45;
const MIN_TILE = 1.6;

/* A NOTE ON WHAT THE SPACING LADDER DOES NOT FIX, because it is the first
   thing the next person will try. Tightening the spacing keeps the step from
   one tile's CENTRE to the next inside a stride, and that is all it does. It
   cannot touch the lip a slab presents at its downhill edge: a tile is flat
   and six metres long and seated under its own middle, so on a grade its
   downhill end stands half a tile of rise proud of the ground, and laying the
   tiles closer together does not lower that by a millimetre. Deriving the
   router's gentlest rung from the module — one in eight rather than 0.3 — was
   measured and does work, and it costs every hill road roughly double its
   length in switchbacks. It was not kept: a way is a CORRIDOR, and once
   `tools/walk-world.mjs` walks the width the road actually has instead of a
   line down the middle of it, a walker steps round those edges the way a
   person does and the same seeds come back clean at the original grade. */
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
