// ports.js — semantic connection sockets, and the matcher that decides what
// links to what.
//
// The problem this solves: a bridge placed by a recipe lands where the recipe
// says, which is nowhere in particular. It crosses a gap but it does not
// ARRIVE anywhere — it meets a blank wall as readily as a door. Same for
// ramps, stairs and pipes. The result reads as scenery scattered near
// buildings rather than as a place that was built.
//
// A PORT is a declared, semantic attachment point: "a walkway may leave here,
// 2 m wide, facing this way, at this level". Blocks emit them in LOCAL space
// alongside their parts; worldPorts() turns them into world space using the
// placement's own transform. Then matchPorts() scores every compatible pair
// and takes the LOWEST valid score, never the first candidate it finds.
//
// PORTS ARE DERIVED, NEVER AUTHORED. Exactly like doors (props/doors.js) and
// collision boxes (player/collide.js): they are a function of the block spec
// plus the placement transform, so nothing new enters the params contract, a
// world still reloads identically, and a port can never drift out of step
// with the geometry that produced it.
//
// Pure JS — no three.js — so the whole matcher runs under the JavaScriptCore
// tests with the rest of the catalog.

export const PORT_VERSION = 1;

/* ── compatibility ──
   What may legally connect to what. Deliberately not symmetric-by-accident:
   the table is checked both ways round, so declaring one direction is enough.

     walkway  an elevated deck may leave or arrive here
     door     a ground entrance — a path or walkway may terminate here
     roof     a flat deck that can accept a landing, capacity-limited
     pipe     a service run; only ever meets another pipe                   */
const COMPATIBLE = {
  walkway: ["walkway", "roof", "door"],
  roof: ["walkway"],
  door: ["walkway", "path"],
  path: ["door", "path"],
  pipe: ["pipe"],
};

export function compatible(kindA, kindB) {
  return !!(COMPATIBLE[kindA]?.includes(kindB) || COMPATIBLE[kindB]?.includes(kindA));
}

/* ── local → world ──
   Rotation follows the engine's convention (see compose.js alongTo): a
   rotationY of θ maps local +x onto (cos θ, -sin θ). Getting the sign wrong
   here is invisible in a single building and catastrophic in a street, so it
   is asserted in tests/ports.test.js rather than trusted.

   `record.position[1]` is the SEATED ground height — props.add() re-seats
   every placement onto the terrain — so a port's world y is that plus its
   own local height. That is what makes a first-floor walkway port sit at the
   first floor of the building as actually placed, on a slope included.     */
function rotY(x, z, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c + z * s, -x * s + z * c];
}

/* Local point on a placement → world. Exported because interiors.js needs the
   exact same transform for room envelopes; two copies of this would drift,
   and the sign is the one thing here that is easy to get wrong. */
export function toWorld(record, [lx, ly, lz]) {
  const [px, py, pz] = record.position || [0, 0, 0];
  const st = record.stretch || null;
  const s = record.scale ?? 1;
  const [wx, wz] = rotY(lx * s * (st ? st[0] : 1), lz * s * (st ? st[2] : 1), record.rotationY || 0);
  return [px + wx, py + ly * s * (st ? st[1] : 1), pz + wz];
}

export function worldPorts(record, proc = null) {
  const local = (proc || record.proc)?.ports;
  if (!local?.length) return [];
  const [px, py, pz] = record.position || [0, 0, 0];
  const a = record.rotationY || 0;
  // A per-placement stretch squashes a ruin; ports must ride it or they float
  // off the geometry they belong to.
  const st = record.stretch || null;
  const sx = (record.scale ?? 1) * (st ? st[0] : 1);
  const sy = (record.scale ?? 1) * (st ? st[1] : 1);
  const sz = (record.scale ?? 1) * (st ? st[2] : 1);

  return local.map((p, i) => {
    const [lx, ly, lz] = p.pos;
    const [wx, wz] = rotY(lx * sx, lz * sz, a);
    const [nx, nz] = rotY(p.normal[0], p.normal[1], a);
    return {
      uid: record.uid,
      index: i,
      kind: p.kind,
      x: px + wx,
      y: py + ly * sy,
      z: pz + wz,
      nx, nz,
      width: p.width ?? 0,
      radius: p.radius ?? 0,
      level: p.level ?? 0,
      capacity: p.capacity ?? 1,
    };
  });
}

// Every world-space port across a set of placements, in record order — which
// is deterministic, because compose.js builds records deterministically.
export function collectPorts(records) {
  const out = [];
  for (const rec of records) {
    if (!rec?.proc?.ports) continue;
    for (const p of worldPorts(rec)) out.push(p);
  }
  return out;
}

/* ── the score ──
   Lower is better. null means the pair is not legal at all, which is a
   different thing from "legal but poor" — a rejected pair must never be
   chosen no matter how empty the rest of the field is.

     distance     how far apart, against the usable span
     angle        do the two ports actually FACE each other
     height       the climb, against what a walkway may slope
     repetition   how much these two endpoints are already connected
     obstruction  does the straight run pass through something solid       */
export const MATCH_DEFAULTS = {
  minSpan: 4,
  maxSpan: 46,
  maxSlope: 0.28,     // rise over run, from the brief
  minFacing: 0.25,    // dot(normal, direction) below this is not "facing"
  maxPerPort: 1,      // a socket is a socket: one connection each
  maxPerPair: 1,      // never two bridges between the same two buildings
  obstacleClear: 1.5, // metres of slack around an obstacle circle
  weights: { distance: 1, angle: 1.4, height: 1.1, repetition: 2.5, obstruction: 3 },
};

export function scoreMatch(a, b, ctx = {}) {
  const o = { ...MATCH_DEFAULTS, ...ctx };
  const w = { ...MATCH_DEFAULTS.weights, ...(ctx.weights || {}) };

  if (a.uid === b.uid) return null;              // never to itself
  if (!compatible(a.kind, b.kind)) return null;

  const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
  const run = Math.hypot(dx, dz);
  if (run < o.minSpan || run > o.maxSpan) return null;

  // Facing: each port's normal against the direction to the other. Both ends
  // must face, or a walkway leaves through the back of a wall.
  const ux = dx / run, uz = dz / run;
  const faceA = a.nx * ux + a.nz * uz;
  const faceB = b.nx * -ux + b.nz * -uz;
  if (faceA < o.minFacing || faceB < o.minFacing) return null;

  // Slope. A roof landing is exempt in one direction — dropping onto a roof
  // from above is a legal move, climbing steeply to one is not.
  const slope = Math.abs(dy) / run;
  // dy is measured a → b, so the roof end is the LOWER one when we drop onto it.
  const roofLanding = (b.kind === "roof" && dy < 0) || (a.kind === "roof" && dy > 0);
  if (slope > o.maxSlope && !roofLanding) return null;

  const used = ctx.used || null;
  const usedA = used?.port.get(portKey(a)) || 0;
  const usedB = used?.port.get(portKey(b)) || 0;
  if (usedA >= o.maxPerPort || usedB >= o.maxPerPort) return null;
  const pairUse = used?.pair.get(pairKey(a.uid, b.uid)) || 0;
  if (pairUse >= o.maxPerPair) return null;

  // Obstruction: does the straight line cross a claimed circle that is not
  // one of the two endpoints' own buildings? Point-segment distance, which is
  // cheap and does not care about rotation.
  let obstruction = 0;
  for (const ob of ctx.obstacles || []) {
    if (ob.uid === a.uid || ob.uid === b.uid) continue;
    const d = segmentDistance(a.x, a.z, b.x, b.z, ob.x, ob.z);
    const clear = ob.r + o.obstacleClear;
    if (d < clear) {
      if (d < ob.r) return null;                 // straight through it
      obstruction += (clear - d) / clear;
    }
  }

  const distance = (run - o.minSpan) / (o.maxSpan - o.minSpan);
  const angle = (1 - faceA) * 0.5 + (1 - faceB) * 0.5;
  const height = o.maxSlope > 0 ? Math.min(1, slope / o.maxSlope) : 0;
  const repetition = usedA + usedB + pairUse;

  return w.distance * distance
       + w.angle * angle
       + w.height * height
       + w.repetition * repetition
       + w.obstruction * obstruction;
}

const portKey = (p) => `${p.uid}#${p.index}`;
const pairKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`);

// Distance from point (px,pz) to segment (ax,az)-(bx,bz).
function segmentDistance(ax, az, bx, bz, px, pz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * vx + (pz - az) * vz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}

/* ── the matcher ──
   Score every legal pair, take the best, mark both ends used, repeat. Greedy
   over a fully scored field, which is the point: "select the lowest valid
   score, not the first random candidate".

   Ties break on the port key, never on iteration order, so the same records
   always produce the same links — the same guarantee the rest of generation
   makes. Returns links in the order they were chosen.                      */
export function matchPorts(ports, opts = {}) {
  const used = { port: new Map(), pair: new Map() };
  const ctx = { ...opts, used };
  const links = [];
  const limit = opts.maxLinks ?? Math.ceil(ports.length / 2);

  for (let n = 0; n < limit; n++) {
    let best = null, bestScore = Infinity, bestKey = "";
    for (let i = 0; i < ports.length; i++) {
      for (let j = i + 1; j < ports.length; j++) {
        const s = scoreMatch(ports[i], ports[j], ctx);
        if (s === null) continue;
        const key = portKey(ports[i]) + ">" + portKey(ports[j]);
        if (s < bestScore - 1e-9 || (Math.abs(s - bestScore) <= 1e-9 && key < bestKey)) {
          best = [ports[i], ports[j]]; bestScore = s; bestKey = key;
        }
      }
    }
    if (!best) break;
    const [a, b] = best;
    used.port.set(portKey(a), (used.port.get(portKey(a)) || 0) + 1);
    used.port.set(portKey(b), (used.port.get(portKey(b)) || 0) + 1);
    used.pair.set(pairKey(a.uid, b.uid), (used.pair.get(pairKey(a.uid, b.uid)) || 0) + 1);
    links.push({ a, b, score: Math.round(bestScore * 1000) / 1000 });
  }
  return links;
}

/* ── geometry of a link ──
   What the composer needs to lay a bridge: where its midpoint is, how long
   it must be, which way it runs, and how much it climbs. Length is the 3D
   span, because a sloped deck is longer than its plan run.                 */
export function linkGeometry(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
  const run = Math.hypot(dx, dz);
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    run,
    span: Math.hypot(run, dy),
    rise: dy,
    // Matches compose.js alongTo(): lays a run-along-X piece onto the link.
    rotationY: Math.atan2(-dz, dx),
    // Deck tilt about the run axis. Positive rise means b is higher than a.
    pitch: Math.atan2(dy, run),
    width: Math.min(a.width || 2, b.width || 2),
  };
}
