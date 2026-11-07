// compose.js — the site composer. Turns a plan (worldplan.js) into ordinary
// prop records, deterministically.
//
// The composer is where the taste lives: what a village *is*, how far apart
// houses stand, that fences fill the gaps BETWEEN buildings, that clutter
// hugs walls instead of littering the courtyard. A model may one day choose
// the plan; the geometry is always decided here, so a seed still defines a
// world exactly.
//
// Contract: same (kind, size, seed, site) → byte-identical records. No
// randomness that isn't drawn from the seeded stream.
//
// Output records enter through the SAME props.add() path a click takes, so
// the engine never learns that a composer exists.
//
// Pure JS (no three.js) — runs under JavaScriptCore tests.

import { SITE_KINDS, blockSpec, validatePlan, footprintOf } from "./worldplan.js";
import { collectPorts, matchPorts, linkGeometry } from "../../kernel/core/ports.js";
import { bridgeParts } from "./block-shapes.js";
import { composeInteriors } from "./interiors.js";
import { seedChannel, mulberry32 } from "../../kernel/seed.js";
import { makeUid } from "./fusion.js";

const TAU = Math.PI * 2;

/* ── facing ──
   Rotation that turns a block's front (its meta.face axis) toward (tx, tz).
   +z front: θ = atan2(dx, dz). +x front (lamp arms, run-along-x pieces):
   θ = atan2(-dz, dx). */
function faceTo(face, x, z, tx, tz) {
  const dx = tx - x, dz = tz - z;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return face === "+x" ? Math.atan2(-dz, dx) : Math.atan2(dx, dz);
}
// Rotation that lays a run-along-X piece (wall, fence) along a direction.
const alongTo = (dx, dz) => Math.atan2(-dz, dx);

/* ── the working site ──
   Collects placements and refuses overlaps. Circles, not boxes: cheaper,
   and slightly generous spacing reads better than tight packing anyway. */
class Site {
  constructor({ cx, cz, radius, sampler, rng, seed, uidAt, waterLevel = 0 }) {
    this.cx = cx; this.cz = cz; this.radius = radius;
    this.sampler = sampler;
    this.waterLevel = waterLevel; // the flood's waterline, not necessarily 0
    this.rng = rng;
    this.seed = seed;
    this.uidAt = uidAt;
    this.records = [];
    this.pads = [];
    this.taken = [];      // { x, z, r } claimed ground
    this.buildings = [];  // { x, z, r, rotationY } for hugging + perimeter
    this.runs = [];       // wall/fence segments, for hugging
    this.n = 0;
  }

  // Is this spot free, and is the ground good enough for this block?
  free(x, z, r, { ground = "any", clearance = 1.0 } = {}) {
    for (const t of this.taken) {
      if (Math.hypot(t.x - x, t.z - z) < (t.r + r) * clearance) return false;
    }
    if (ground === "flat" && this.sampler) {
      const s = this.slopeAt(x, z, Math.max(r, 2));
      if (s > 0.42) return false;              // ~23°: a house would float
      if (this.sampler(x, z) < this.waterLevel + 0.6) return false; // never in the water
    }
    return true;
  }

  slopeAt(x, z, d) {
    const h = this.sampler;
    const a = h(x - d, z), b = h(x + d, z), c = h(x, z - d), e = h(x, z + d);
    return Math.max(Math.abs(b - a), Math.abs(e - c)) / (2 * d);
  }

  claim(x, z, r) { this.taken.push({ x, z, r }); }

  // Add a placement. y is left at the sampled ground — props.add() re-seats
  // it anyway, and a sane value keeps the record readable.
  place(spec, x, z, rotationY, extra = {}) {
    const rec = {
      uid: this.uidAt(this.n++),
      ref: spec.ref,
      url: null,
      label: spec.label,
      proc: spec.proc,
      position: [round2(x), round2(this.sampler ? this.sampler(x, z) : 0), round2(z)],
      rotationY: round3(rotationY || 0),
      scale: 1,
      autoFit: false,
      ...extra,
    };
    this.records.push(rec);
    this.claimDoorways(rec);
    return rec;
  }

  /* ── nothing stands in a doorway ──
     `free` asks whether two footprint CIRCLES overlap, and a circle round a
     building says nothing about which side of it the door is on. A house nine
     metres across claims a 5 m circle; its front door is on that circle, and
     a street lamp is legally placed half a metre outside it — dead in front
     of the opening, 0.4 m proud, which is the exact height the walk
     controller stops at. Measured on the four worlds, that one geometry put a
     lamp across the door of three of the eleven buildings in a market square.

     So a block that declares a way in claims the ground in front of it too.
     It is the same `taken` list, so every op downstream is kept out of the
     doorway for free, and a block with no door claims nothing. */
  claimDoorways(rec) {
    const proc = rec.proc;
    if (!proc) return;
    const s = rec.scale ?? 1;
    const rot = rec.rotationY || 0;
    const c = Math.cos(rot), sn = Math.sin(rot);
    for (const d of doorwaysOf(proc)) {
      // A step further out than the port itself, so the claim covers where
      // somebody stands to open it rather than the threshold alone.
      const len = Math.hypot(d.x, d.z) || 1;
      const u = (d.x + (d.x / len) * DOOR_STAND) * s;
      const v = (d.z + (d.z / len) * DOOR_STAND) * s;
      this.taken.push({ x: rec.position[0] + u * c + v * sn, z: rec.position[2] - u * sn + v * c,
        r: DOOR_CLEAR });
    }
  }

  pad(x, z, r, amount = 5) {
    this.pads.push({ x: round2(x), z: round2(z), r: round2(r), amount });
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/* How far out from a door the ground is kept clear, and how wide. The player
   is a 0.42 m circle and the doorway it has to line up on is about 1.4 m
   wide, so a metre of standing room in front of it is the least that reads as
   an entrance rather than as a gap between two obstacles. */
const DOOR_STAND = 0.5;   // metres beyond the door port, along its own normal
const DOOR_CLEAR = 1.35;  // the radius kept free there

/* Where a block says you come in, in its own metres. Two declarations, and a
   block may carry either: the composer's door PORT (block-shapes emits one on
   every entrance) and the hinge of an openable leaf (`proc.door`), which is
   what the hand-authored blocks in the catalogue carry. */
export function doorwaysOf(proc) {
  const out = [];
  for (const p of proc?.ports || []) {
    if (p.kind === "door") out.push({ x: p.pos[0], z: p.pos[2] });
  }
  if (!out.length && proc?.door?.hinge) {
    const leaf = (proc.parts || []).find((p) => p.door && p.pos);
    const at = leaf ? leaf.pos : proc.door.hinge;
    out.push({ x: at[0], z: at[2] });
  }
  return out;
}

// Decay: squashed height + rotation jitter + a mossy tint. Uses the existing
// per-placement stretch/tint fields, so a ruin serializes like any block.
function decayExtras(rng, { squash, rot = 0 }, tint) {
  const extra = {};
  if (squash) {
    const y = squash[0] + rng() * (squash[1] - squash[0]);
    extra.stretch = [round3(0.9 + rng() * 0.25), round3(y), round3(0.9 + rng() * 0.25)];
  }
  if (tint) extra.tint = tint.map((v) => round3(v));
  return { extra, rotJitter: (rng() - 0.5) * rot * TAU };
}

/* ── ops ── */
const OPS = {
  // One block at the middle of the site.
  center(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const { extra, rotJitter } = step.decay
      ? decayExtras(site.rng, step.decay, ctx.recipe.decayTint)
      : { extra: {}, rotJitter: 0 };
    site.place(spec, site.cx, site.cz, site.rng() * TAU * 0.02 + rotJitter, extra);
    site.claim(site.cx, site.cz, spec.foot.r + 0.6);
    if (step.pad) site.pad(site.cx, site.cz, step.pad, 4);
  },

  // count blocks around a circle, facing the centre (or away from it).
  ring(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const count = ctx.count(step.count);
    if (count <= 0) return;
    // Leave the approach azimuth clear — that is where the gate goes.
    const arc = TAU - ctx.gateArc;
    const r = site.radius;
    for (let i = 0; i < count; i++) {
      const base = ctx.gateAngle + ctx.gateArc / 2 + (arc * (i + 0.5)) / count;
      const a = base + (site.rng() - 0.5) * (step.jitter || 0);
      const rr = r * (1 + (site.rng() - 0.5) * 0.06);
      const x = site.cx + Math.cos(a) * rr, z = site.cz + Math.sin(a) * rr;
      if (!site.free(x, z, spec.foot.r, { ground: spec.meta.ground })) continue;
      const { extra, rotJitter } = step.decay
        ? decayExtras(site.rng, step.decay, ctx.recipe.decayTint)
        : { extra: {}, rotJitter: 0 };
      const rot = faceTo(spec.meta.face, x, z, site.cx, site.cz) + rotJitter;
      site.place(spec, x, z, rot, extra);
      site.claim(x, z, spec.foot.r + 1.2);
      site.buildings.push({ x, z, r: spec.foot.r, a, rotationY: rot });
      if (step.pad) site.pad(x, z, spec.foot.r * (step.pad || 1.5), 5);
    }
  },

  // Two facing rows either side of a lane through the centre — the market.
  rows(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const count = ctx.count(step.count);
    const per = Math.max(1, Math.round(count / 2));
    const half = (step.lane ?? 8) / 2;
    // The lane runs across the gate axis, so you walk in and down it.
    const la = ctx.gateAngle + Math.PI / 2;
    const ux = Math.cos(la), uz = Math.sin(la);       // along the lane
    const px = Math.cos(ctx.gateAngle), pz = Math.sin(ctx.gateAngle); // across
    const at = (step.at ?? 0) * site.radius;
    for (let s = -1; s <= 1; s += 2) {
      for (let i = 0; i < per; i++) {
        const t = (i - (per - 1) / 2) * (step.spacing || 5);
        const x = site.cx + ux * t + px * (at + s * half);
        const z = site.cz + uz * t + pz * (at + s * half);
        if (!site.free(x, z, spec.foot.r, { ground: spec.meta.ground, clearance: 0.85 })) continue;
        // Stalls look at the lane, not at the site centre.
        const rot = faceTo(spec.meta.face, x, z, x - px * s, z - pz * s);
        site.place(spec, x, z, rot);
        site.claim(x, z, spec.foot.r + 0.4);
      }
    }
  },

  // Explicit polar placements: [angleTurns, radiusFactor].
  spots(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    for (const [turns, rf] of step.at || []) {
      const a = ctx.gateAngle + Math.PI + turns * TAU;
      const rr = site.radius * rf;
      const x = site.cx + Math.cos(a) * rr, z = site.cz + Math.sin(a) * rr;
      if (!site.free(x, z, spec.foot.r, { ground: spec.meta.ground })) continue;
      const { extra, rotJitter } = step.decay
        ? decayExtras(site.rng, step.decay, ctx.recipe.decayTint)
        : { extra: {}, rotJitter: 0 };
      const rot = faceTo(spec.meta.face, x, z, site.cx, site.cz) + rotJitter;
      site.place(spec, x, z, rot, extra);
      site.claim(x, z, spec.foot.r + 1);
      site.buildings.push({ x, z, r: spec.foot.r, a, rotationY: rot });
      if (step.pad) site.pad(x, z, spec.foot.r * step.pad, 5);
    }
  },

  // The enclosure. Ring sites gap-fill BETWEEN buildings (the reference
  // hamlet's fence runs house-to-house); square sites run four walls. Both
  // leave the approach open and stand a gate there, flanked by lamps.
  perimeter(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const tile = spec.meta.tile || 3;
    const square = (step.shape || ctx.recipe.shape) === "square";
    const r = site.radius * 1.16;
    const gateR = square ? r * 0.92 : r;
    const put = (x, z, rot) => {
      if (!site.free(x, z, tile * 0.42, { clearance: 0.62 })) return;
      site.place(spec, x, z, rot);
      site.claim(x, z, tile * 0.38);
      site.runs.push({ x, z, rotationY: rot });
    };

    if (square) {
      const h = gateR;
      for (const side of [0, 1, 2, 3]) {
        const a = ctx.gateAngle + side * (Math.PI / 2);
        const ux = Math.cos(a + Math.PI / 2), uz = Math.sin(a + Math.PI / 2);
        const mx = site.cx + Math.cos(a) * h, mz = site.cz + Math.sin(a) * h;
        const n = Math.max(1, Math.round((h * 2) / tile));
        for (let i = 0; i < n; i++) {
          const t = (i - (n - 1) / 2) * tile;
          // The gate owns the middle of the front side.
          if (side === 0 && Math.abs(t) < tile * 0.9) continue;
          put(mx + ux * t, mz + uz * t, alongTo(ux, uz));
        }
      }
    } else {
      const circ = TAU * r;
      const n = Math.max(4, Math.round(circ / tile));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        // Angular distance to the approach; skip the tiles the gate stands in.
        const d = Math.abs(((a - ctx.gateAngle + Math.PI * 3) % TAU) - Math.PI);
        if (d < ctx.gateArc / 2) continue; // keep the approach clear
        const x = site.cx + Math.cos(a) * r, z = site.cz + Math.sin(a) * r;
        put(x, z, alongTo(-Math.sin(a), Math.cos(a)));
      }
    }

    // Gate on the approach, with a lamp to each side of it.
    const gspec = step.gate && ctx.spec(step.gate);
    if (gspec) {
      const gx = site.cx + Math.cos(ctx.gateAngle) * gateR;
      const gz = site.cz + Math.sin(ctx.gateAngle) * gateR;
      const rot = faceTo(gspec.meta.face, gx, gz, site.cx, site.cz);
      site.place(gspec, gx, gz, rot);
      site.claim(gx, gz, gspec.foot.r);
      const lspec = step.gateLamps && ctx.spec(step.gateLamps);
      if (lspec) {
        const ux = -Math.sin(ctx.gateAngle), uz = Math.cos(ctx.gateAngle);
        for (const s of [-1, 1]) {
          const lx = gx + ux * s * (gspec.foot.w / 2 + 1.1);
          const lz = gz + uz * s * (gspec.foot.w / 2 + 1.1);
          if (!site.free(lx, lz, 0.7, { clearance: 0.8 })) continue;
          site.place(lspec, lx, lz, faceTo(lspec.meta.face, lx, lz, site.cx, site.cz));
          site.claim(lx, lz, 0.7);
        }
      }
    }
  },

  // Clutter. `hug` presses it against the outside of a building or a wall
  // run — the reference images never leave barrels standing in the open.
  scatter(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const count = ctx.count(step.count);
    const [lo, hi] = step.at || [0.35, 0.9];
    for (let i = 0; i < count; i++) {
      let x, z, ok = false;
      for (let tries = 0; tries < 12 && !ok; tries++) {
        if (step.hug) {
          const hosts = step.hug === "run" ? site.runs : site.buildings;
          if (!hosts.length) break;
          const h = hosts[Math.floor(site.rng() * hosts.length)];
          const a = Math.atan2(h.z - site.cz, h.x - site.cx) + (site.rng() - 0.5) * 1.5;
          const off = (h.r || 1.5) * 0.75 + spec.foot.r + (step.jitter || 0) * site.rng();
          x = h.x + Math.cos(a) * off * -1; // tucked toward the courtyard side
          z = h.z + Math.sin(a) * off * -1;
        } else {
          const a = site.rng() * TAU;
          const rr = site.radius * (lo + site.rng() * (hi - lo));
          x = site.cx + Math.cos(a) * rr;
          z = site.cz + Math.sin(a) * rr;
        }
        if (ctx.sideFilter && !ctx.sideFilter(x, z, step.side)) continue;
        ok = site.free(x, z, spec.foot.r, { clearance: 0.8 });
      }
      if (!ok) continue;
      const facing = step.facing === "in" ? faceTo(spec.meta.face, x, z, site.cx, site.cz) : site.rng() * TAU;
      site.place(spec, x, z, facing);
      site.claim(x, z, spec.foot.r * 0.8);
    }
  },

  // Broken pieces: scattered, squashed, heavily jittered.
  fragments(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const count = ctx.count(step.count);
    const [lo, hi] = step.at || [0.3, 0.9];
    for (let i = 0; i < count; i++) {
      const a = site.rng() * TAU;
      const rr = site.radius * (lo + site.rng() * (hi - lo));
      const x = site.cx + Math.cos(a) * rr, z = site.cz + Math.sin(a) * rr;
      if (!site.free(x, z, spec.foot.r * 0.6, { clearance: 0.7 })) continue;
      const { extra } = decayExtras(site.rng, { squash: step.squash }, ctx.recipe.decayTint);
      // Fragments sit tangentially, as if they were once part of an enclosure.
      const rot = alongTo(-Math.sin(a), Math.cos(a)) + (site.rng() - 0.5) * 0.5;
      site.place(spec, x, z, rot, extra);
      site.claim(x, z, spec.foot.r * 0.7);
    }
  },

  // Bridge deck across the found crossing.
  span(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec || !ctx.crossing) return;
    const { ax, az, bx, bz } = ctx.crossing;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const tile = spec.meta.tile || 6.2;
    const n = Math.max(1, Math.round(len / tile));
    // Deck runs along local +z, so face it down the crossing.
    const rot = faceTo("+z", 0, 0, ux, uz);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = ax + dx * t, z = az + dz * t;
      const rec = site.place(spec, x, z, rot);
      // The deck spans the gap: hold it at the bank height, not the river bed.
      rec.position[1] = round2(ctx.crossing.deckY);
      rec.seat = "point";
      site.claim(x, z, tile * 0.4);
    }
  },

  // One prop at each end of the span, on alternating sides.
  ends(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec || !ctx.crossing) return;
    const { ax, az, bx, bz } = ctx.crossing;
    const ux = (bx - ax), uz = (bz - az);
    const len = Math.hypot(ux, uz) || 1;
    const nx = -uz / len, nz = ux / len;
    const off = step.offset ?? 2.4;
    const ends = [[ax - (ux / len) * 1.6, az - (uz / len) * 1.6, 1], [bx + (ux / len) * 1.6, bz + (uz / len) * 1.6, -1]];
    for (const [ex, ez, s] of ends) {
      const x = ex + nx * off * s, z = ez + nz * off * s;
      site.place(spec, x, z, faceTo(spec.meta.face, x, z, ex, ez));
      site.claim(x, z, 0.8);
    }
  },

  // A walled grid. Pieces land on cell edges, so the 6 m pitch tiles exactly
  // — no collision checks needed, and none wanted: walls must meet.
  maze(site, step, ctx) {
    const wallSpec = ctx.spec(step.wall);
    const doorSpec = ctx.spec(step.door) || wallSpec;
    if (!wallSpec) return;
    const n = ctx.n;
    const P = step.pitch || 6;
    const pieces = buildMaze(n, n, ctx.pattern, site.rng, step.doorChance ?? 0.4);
    const ox = site.cx - (n * P) / 2;
    const oz = site.cz - (n * P) / 2;
    for (const e of pieces) {
      const vertical = e.dir === "v";
      const x = ox + (vertical ? e.i : e.i + 0.5) * P;
      const z = oz + (vertical ? e.j + 0.5 : e.j) * P;
      const spec = e.type === "door" ? doorSpec : wallSpec;
      // Run-along-X pieces: a vertical edge needs them turned a quarter turn.
      site.place(spec, x, z, vertical ? Math.PI / 2 : 0);
    }
  },

  /* ══ THE GRID ═════════════════════════════════════════════════════════
     Everything above rings a courtyard. A town is not laid out that way: the
     STREETS come first and the buildings are what fills in between them.

     THE ARITHMETIC IS THE WHOLE DESIGN, and it is why the pitch is 39 rather
     than a round 40. A junction tile is 9 m square (kerb to kerb) and a road
     tile is 6 m long. Between two junction centres 39 m apart there is
     39 − 9 = 30 m of carriageway, which is EXACTLY five road tiles. Any other
     pitch leaves either a gap in the road or two flat slabs overlapping at
     the same height, and two coplanar slabs is z-fighting — a shimmering seam
     down every street in the city, at every camera angle, forever.

     The same 30 m is what the frontage is laid into, so a block edge is five
     terraced units wide with no offcut at either end. Change the pitch and
     both of those break together; the numbers below derive from it rather
     than repeating it. */
  streets(site, step, ctx) {
    const road = ctx.spec(step.road);
    if (!road) return;
    const junction = ctx.spec(step.junction);
    const crossing = ctx.spec(step.crossing) || road;
    const plaza = ctx.spec(step.plaza);

    const P = step.pitch || 39;
    const T = road.meta.tile || 6;        // one road module
    const HALF = 4.5;                     // half a junction, kerb to kerb
    const per = Math.round((P - HALF * 2) / T);  // road tiles between junctions
    const n = ctx.n;                      // grid radius, in cells
    const R = site.radius;

    // Grid axes. The approach azimuth is one of the streets, so you walk in
    // along a road rather than at forty degrees across a terrace.
    const a = ctx.gateAngle;
    const ux = Math.cos(a), uz = Math.sin(a);
    const vx = -Math.sin(a), vz = Math.cos(a);
    const at = (u, v) => [site.cx + ux * u + vx * v, site.cz + uz * u + vz * v];
    const inside = (u, v) => Math.hypot(u, v) <= R;
    const twoWay = (step.axes || "uv") === "uv";

    /* The square. One cell of the grid is paved instead of built on, and the
       landmark stands in the middle of it — a town with no open ground in it
       reads as a warehouse estate. */
    const square = { i: 0, j: 0 };
    site.grid = { P, T, HALF, per, n, R, a, ux, uz, vx, vz, at, inside, twoWay, square };

    const line = (k) => k * P;
    const axis = [];
    for (let i = -n; i <= n; i++) axis.push(i);

    // Junctions first: they own their crossings outright, and a road tile
    // laid over one is the z-fight described above.
    for (const i of axis) {
      for (const j of (twoWay ? axis : [0])) {
        const u = line(i), v = line(j);
        if (!inside(u, v) || !junction) continue;
        const [x, z] = at(u, v);
        site.place(junction, x, z, a);
        site.claim(x, z, HALF);
      }
    }

    // …then the carriageway between them. A tile is placed at the midpoint of
    // its own module, so the run starts flush against the junction's kerb.
    const layRun = (alongU) => {
      const cross = alongU ? axis : (twoWay ? axis : [0]);
      for (const j of cross) {
        const off = line(j);
        for (const i of axis.slice(0, -1)) {
          for (let m = 0; m < per; m++) {
            const t = line(i) + HALF + (m + 0.5) * T;
            const [u, v] = alongU ? [t, off] : [off, t];
            if (!inside(u, v)) continue;
            const [x, z] = at(u, v);
            // The tile against a junction is a zebra: a crossing belongs
            // where people actually cross, which is at the corner.
            const edge = m === 0 || m === per - 1;
            const spec = edge ? crossing : road;
            site.place(spec, x, z, alongU ? alongTo(ux, uz) : alongTo(vx, vz));
            site.claim(x, z, T * 0.34);
          }
        }
      }
    };
    layRun(true);
    if (twoWay) layRun(false);

    // The square: the cell's full interior, paved on the road module.
    if (plaza && twoWay) {
      const tiles = Math.floor((P - HALF * 2) / T);
      for (let m = 0; m < tiles; m++) {
        for (let k = 0; k < tiles; k++) {
          const u = line(square.i) + HALF + (m + 0.5) * T;
          const v = line(square.j) + HALF + (k + 0.5) * T;
          if (!inside(u, v)) continue;
          const [x, z] = at(u, v);
          site.place(plaza, x, z, a);
        }
      }
    }
  },

  /* Terraces along the street. Row units are 6 m of frontage with blind party
     walls, so they are placed WITHOUT a collision check and abut into one
     continuous street wall — which is the point of them. The arithmetic in
     `streets` guarantees five of them fit between two junctions exactly, and
     that the two facing rows leave a 13 m band down the middle of the block
     for whatever `infill` puts there. */
  frontage(site, step, ctx) {
    const g = site.grid;
    if (!g) return;
    const kinds = (step.row || []).map((id) => ctx.spec(id)).filter(Boolean);
    if (!kinds.length) return;
    const depth = step.depth ?? 8.5;
    const set = g.HALF + depth / 2;        // centre line of a terrace row
    const skipInner = step.skipInner ?? 0; // leave the middle to the towers

    for (let i = -g.n; i < g.n; i++) {
      for (let j = (g.twoWay ? -g.n : -1); j < (g.twoWay ? g.n : 1); j++) {
        if (i === g.square.i && j === g.square.j) continue;
        for (const side of [1, -1]) {
          // side +1 faces the street at v = j·P; −1 faces the one beyond it.
          const v = side > 0 ? j * g.P + set : (j + 1) * g.P - set;
          for (let m = 0; m < g.per; m++) {
            const u = i * g.P + g.HALF + (m + 0.5) * g.T;
            if (!g.inside(u, v)) continue;
            const d = Math.hypot(u, v) / g.R;
            if (d < skipInner) continue;
            const [x, z] = g.at(u, v);
            if (site.sampler && site.sampler(x, z) < site.waterLevel + 0.6) continue;
            const spec = kinds[Math.floor(site.rng() * kinds.length)];
            // Front to the street: the target is one street-width beyond the
            // kerb, on the side the unit is set back from.
            const [tx, tz] = g.at(u, v - side * 12);
            const rot = faceTo(spec.meta.face, x, z, tx, tz);
            site.place(spec, x, z, rot);
            site.claim(x, z, 3.1);
            site.buildings.push({ x, z, r: spec.foot.r, a: Math.atan2(z - site.cz, x - site.cx), rotationY: rot });
          }
        }
      }
    }
  },

  /* The one building the town is arranged around, on the square.

     It also LIFTS the paving it stands on. A hall sitting on top of six paving
     tiles is six slabs of geometry nobody will ever see, two coplanar
     surfaces fighting over the same depth values where the plinth meets them,
     and — the reason it was caught — two placements sharing ground, which is
     the one thing the composer promises never to emit. The apron around the
     building stays; only what is underneath it goes. */
  landmark(site, step, ctx) {
    const g = site.grid;
    const spec = ctx.spec(step.block);
    if (!g || !spec) return;
    const u = g.square.i * g.P + g.P / 2;
    const v = g.square.j * g.P + g.P / 2;
    const [x, z] = g.at(u, v);

    const hw = spec.foot.w / 2 + 0.4, hd = spec.foot.d / 2 + 0.4;
    site.records = site.records.filter((r) => {
      if (r.meta?.role !== "pad" && !/\/plaza$/.test(r.ref || "")) return true;
      const dx = r.position[0] - site.cx, dz = r.position[2] - site.cz;
      const du = dx * g.ux + dz * g.uz, dv = dx * g.vx + dz * g.vz;
      return Math.abs(du - u) > hw || Math.abs(dv - v) > hd;
    });
    const rot = faceTo(spec.meta.face, x, z, ...g.at(u, v - 12));
    site.place(spec, x, z, rot);
    site.claim(x, z, spec.foot.r + 1);
    site.buildings.push({ x, z, r: spec.foot.r, a: g.a, rotationY: rot });
    if (step.pad) site.pad(x, z, spec.foot.r * step.pad, 4);
  },

  /* What stands in the middle of a block, behind the terraces. Density falls
     off with distance from the square, which is the one rule that makes a
     grid read as a city rather than as a spreadsheet: towers at the centre,
     three storeys at the edge. */
  infill(site, step, ctx) {
    const g = site.grid;
    if (!g || !g.twoWay) return;
    const kinds = (step.blocks || []).map((id) => ctx.spec(id)).filter(Boolean);
    if (!kinds.length) return;
    const from = step.from ?? 0, within = step.within ?? 1;

    for (let i = -g.n; i < g.n; i++) {
      for (let j = -g.n; j < g.n; j++) {
        if (i === g.square.i && j === g.square.j) continue;
        const u = i * g.P + g.P / 2, v = j * g.P + g.P / 2;
        if (!g.inside(u, v)) continue;
        const d = Math.hypot(u, v) / g.R;
        if (d < from || d >= within) continue;
        const [x, z] = g.at(u, v);
        if (site.slopeAt(x, z, 8) > 0.34) continue;
        if (site.sampler && site.sampler(x, z) < site.waterLevel + 0.6) continue;
        // Deeper into the district, taller: the list is ordered low → high
        // and this reads it from the far end inward.
        const t = within > from ? (within - d) / (within - from) : 1;
        const pick = Math.min(kinds.length - 1,
          Math.floor(t * kinds.length * (0.7 + site.rng() * 0.6)));
        const spec = kinds[Math.max(0, pick)];
        const rot = faceTo(spec.meta.face, x, z, ...g.at(u, v - 12));
        site.place(spec, x, z, rot);
        site.claim(x, z, spec.foot.r * 0.7);
        site.buildings.push({ x, z, r: spec.foot.r, a: Math.atan2(z - site.cz, x - site.cx), rotationY: rot });
      }
    }
  },

  /* Lamps and street trees on the footway — the layer that turns a road
     surface into a street. Placed on the pavement side of the kerb, every
     `every` modules, and collision-checked because unlike the terraces these
     are not on a grid that guarantees they miss anything.

     ON THE PARTY WALL, NOT ON THE DOOR. Both this and `frontage` count the
     same modules, so a lamp at module m stood at the centre of the unit at
     module m — which is exactly where that unit's front door is. It was not
     an unlucky seed: it was every lamp and every tree on every street in the
     grid, and a walk of the market town could not get through a single front
     door on the frontage. Half a module over puts them on the line between
     two units, which is where a street plants them anyway. */
  streetside(site, step, ctx) {
    const g = site.grid;
    const spec = ctx.spec(step.block);
    if (!g || !spec) return;
    const every = Math.max(1, step.every || 2);
    const off = g.HALF - 0.9 + (step.offset || 0);
    const axis = [];
    for (let i = -g.n; i <= g.n; i++) axis.push(i);

    for (const j of (g.twoWay ? axis : [0])) {
      const v0 = j * g.P;
      for (const i of axis.slice(0, -1)) {
        for (let m = 0; m < g.per; m += every) {
          for (const side of [1, -1]) {
            const u = i * g.P + g.HALF + m * g.T;
            const v = v0 + side * off;
            if (!g.inside(u, v)) continue;
            const [x, z] = g.at(u, v);
            if (!site.free(x, z, spec.foot.r * 0.5, { clearance: 0.55 })) continue;
            if (site.sampler && site.sampler(x, z) < site.waterLevel + 0.4) continue;
            // A lamp's arm reaches over the carriageway; a tree does not care.
            const [tx, tz] = g.at(u, v - side * 8);
            site.place(spec, x, z, spec.meta.role === "light"
              ? faceTo(spec.meta.face, x, z, tx, tz)
              : site.rng() * TAU);
            site.claim(x, z, spec.foot.r * 0.55);
          }
        }
      }
    }
  },

  /* ══ OPEN GROUND ══════════════════════════════════════════════════════
     Every op above arranges buildings against something — a ring, a lane, a
     street grid. Some places are not arranged at all: a coastal hamlet is a
     handful of houses standing on grass at whatever distance the ground
     allowed, and laying it out on a circle is what made every generated
     village in this engine read as the same generated village.

     `gap` is the whole recipe. Rejection sampling against a minimum spacing
     gives the loose, unequal, slightly-clumped distribution real settlements
     have, and it is the difference between "houses" and "a formation". */
  spread(site, step, ctx) {
    const kinds = (step.blocks || [step.block]).map((id) => ctx.spec(id)).filter(Boolean);
    if (!kinds.length) return;
    const count = ctx.count(step.count);
    const [lo, hi] = step.at || [0.3, 0.95];
    const gap = step.gap ?? 16;
    for (let i = 0; i < count; i++) {
      const spec = kinds[Math.floor(site.rng() * kinds.length)];
      let placed = false;
      for (let tries = 0; tries < 26 && !placed; tries++) {
        // Uniform over the ANNULUS, not over the radius: sampling r linearly
        // piles two thirds of the houses against the inner edge.
        const a = site.rng() * TAU;
        const t = Math.sqrt(lo * lo + site.rng() * (hi * hi - lo * lo));
        const x = site.cx + Math.cos(a) * site.radius * t;
        const z = site.cz + Math.sin(a) * site.radius * t;
        if (!site.free(x, z, Math.max(spec.foot.r, gap / 2), { ground: spec.meta.ground })) continue;
        // Facing: toward the middle, but loosely. A hamlet where every door
        // points at the well is a hamlet somebody laid out with a compass.
        const rot = step.facing === "free"
          ? site.rng() * TAU
          : faceTo(spec.meta.face, x, z, site.cx, site.cz) + (site.rng() - 0.5) * (step.jitter ?? 0.4) * TAU * 0.25;
        site.place(spec, x, z, rot);
        site.claim(x, z, Math.max(spec.foot.r + 1, gap / 2));
        site.buildings.push({ x, z, r: spec.foot.r, a, rotationY: rot });
        placed = true;
      }
    }
  },

  /* Worked ground: rectangles of a tiling pad block, laid on the module grid
     and squared to the site's own axis. Rows are the entire signal at the
     distance these are read from — a green rectangle is a lawn, a striped one
     is somebody's field. */
  plots(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec) return;
    const tile = spec.meta.tile || 6;
    const cols = Math.max(1, step.w || 3), rows = Math.max(1, step.d || 2);
    const count = ctx.count(step.count);
    const [lo, hi] = step.at || [0.4, 0.9];
    const ux = Math.cos(ctx.gateAngle), uz = Math.sin(ctx.gateAngle);
    const vx = -uz, vz = ux;
    const halfW = (cols * tile) / 2, halfD = (rows * tile) / 2;
    const reach = Math.hypot(halfW, halfD);
    for (let p = 0; p < count; p++) {
      let ox = 0, oz = 0, ok = false;
      for (let tries = 0; tries < 18 && !ok; tries++) {
        const a = site.rng() * TAU;
        const t = Math.sqrt(lo * lo + site.rng() * (hi * hi - lo * lo));
        ox = site.cx + Math.cos(a) * site.radius * t;
        oz = site.cz + Math.sin(a) * site.radius * t;
        ok = site.free(ox, oz, reach, { ground: "flat", clearance: 0.9 });
      }
      if (!ok) continue;
      site.claim(ox, oz, reach);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const du = (i - (cols - 1) / 2) * tile, dv = (j - (rows - 1) / 2) * tile;
          const x = ox + ux * du + vx * dv, z = oz + uz * du + vz * dv;
          if (site.sampler && site.sampler(x, z) < site.waterLevel + 0.6) continue;
          site.place(spec, x, z, alongTo(ux, uz));
        }
      }
    }
  },

  /* One block on the best high ground the site contains.
     "Slightly higher ground" is a real relationship, not a polar coordinate:
     a research hall that lands uphill of the houses on every seed is a
     grammar, and one at a fixed angle is a diagram. */
  crest(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec || !site.sampler) return;
    const [lo, hi] = step.at || [0.4, 0.95];
    let best = null;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * TAU + ctx.gateAngle;
      for (const t of [lo, (lo + hi) / 2, hi]) {
        const x = site.cx + Math.cos(a) * site.radius * t;
        const z = site.cz + Math.sin(a) * site.radius * t;
        if (!site.free(x, z, spec.foot.r, { ground: spec.meta.ground })) continue;
        // Height, less a penalty for standing on a slope: the top of a cliff
        // is high ground a hall cannot be built on.
        const score = site.sampler(x, z) - site.slopeAt(x, z, 8) * 90;
        if (!best || score > best.score) best = { x, z, score };
      }
    }
    if (!best) return;
    const rot = faceTo(spec.meta.face, best.x, best.z, site.cx, site.cz);
    site.place(spec, best.x, best.z, rot);
    site.claim(best.x, best.z, spec.foot.r + 2);
    site.buildings.push({ x: best.x, z: best.z, r: spec.foot.r,
      a: Math.atan2(best.z - site.cz, best.x - site.cx), rotationY: rot });
    if (step.pad) site.pad(best.x, best.z, spec.foot.r * step.pad, 5);
  },

  /* A jetty. Walks downhill from the middle of the site until it is over
     water, then lays deck for a few modules more and holds the whole run at
     the waterline — `seat: "point"`, like a bridge, because a deck seated on
     the terrain is a deck lying on the seabed.

     Downhill rather than a stored bearing: on an island every direction that
     descends ends in the sea, and the steepest one reaches it soonest. */
  pier(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec || !site.sampler) return;
    const tile = spec.meta.tile || 6;
    const wl = site.waterLevel;
    let bx = 0, bz = 0, drop = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      const px = site.cx + Math.cos(a) * site.radius, pz = site.cz + Math.sin(a) * site.radius;
      const d = site.sampler(site.cx, site.cz) - site.sampler(px, pz);
      if (d > drop) { drop = d; bx = Math.cos(a); bz = Math.sin(a); }
    }
    if (!drop) return;
    // The shore: the first step out that is actually below the waterline.
    let shore = null;
    for (let d = tile; d <= site.radius * 2.2; d += tile * 0.5) {
      const x = site.cx + bx * d, z = site.cz + bz * d;
      if (site.sampler(x, z) < wl + 0.2) { shore = d - tile * 0.5; break; }
    }
    if (shore == null) return;
    const rot = alongTo(bx, bz);
    const n = Math.max(2, Math.round(step.length ?? 6));
    for (let i = 0; i < n; i++) {
      const d = shore + (i + 0.5) * tile;
      const x = site.cx + bx * d, z = site.cz + bz * d;
      /* A JETTY STANDS ON ITS LEGS. The deck is held at a fixed height above
         the waterline, which is right, but the piles under it are a fixed
         length — so a run laid straight out over a shelving seabed walks off
         the end of the shelf and the last few bays hang in the air with their
         legs stopping short of the bottom. It is the one detail on the whole
         island that reads as a mistake rather than as a style.
         So the run ENDS where the water gets deeper than the legs are long. */
      if (wl - site.sampler(x, z) > (step.deep ?? 3.4)) break;
      const rec = site.place(spec, x, z, rot);
      rec.position[1] = round2(wl + (step.above ?? 0.9));
      rec.seat = "point";
      site.claim(x, z, tile * 0.4);
    }
  },

  // A barrier line across the near approach.
  line(site, step, ctx) {
    const spec = ctx.spec(step.block);
    if (!spec || !ctx.crossing) return;
    const { ax, az, bx, bz } = ctx.crossing;
    const ux = (bx - ax), uz = (bz - az);
    const len = Math.hypot(ux, uz) || 1;
    const dx = ux / len, dz = uz / len;
    const nx = -dz, nz = dx;
    const tile = spec.meta.tile || 3;
    const back = step.offset ?? 4.5;
    const count = ctx.count(step.count);
    for (let i = 0; i < count; i++) {
      const t = (i - (count - 1) / 2) * tile;
      const x = ax - dx * back + nx * t, z = az - dz * back + nz * t;
      if (!site.free(x, z, tile * 0.4, { clearance: 0.7 })) continue;
      site.place(spec, x, z, alongTo(nx, nz));
      site.claim(x, z, tile * 0.38);
    }
  },
};

/* ── mazes ──
   The grid is cells; the pieces sit on the EDGES between them, one wall block
   per edge, so a 6 m pitch tiles exactly with no seams. An edge is a wall, a
   door, or an opening.

   Patterns:
     cells    every cell walled, each given one door — a block of rooms
     winding  recursive backtracker: a perfect maze, long corridors, dead ends
     braided  the same, then some walls knocked through, so there are loops

   Edge ids: "v,i,j" is the vertical edge left of cell (i,j); "h,i,j" is the
   horizontal edge in front of cell (i,j). i∈[0..cols], j∈[0..rows]. */
export function buildMaze(cols, rows, pattern, rng, doorChance = 0.4) {
  const edges = new Map();
  const key = (d, i, j) => `${d},${i},${j}`;
  for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) edges.set(key("v", i, j), "wall");
  for (let j = 0; j <= rows; j++) for (let i = 0; i < cols; i++) edges.set(key("h", i, j), "wall");

  const between = (a, b) => {
    // the edge shared by two orthogonally adjacent cells
    if (a.i === b.i) return key("h", a.i, Math.max(a.j, b.j));
    return key("v", Math.max(a.i, b.i), a.j);
  };
  const inside = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  {
    // Recursive backtracker — a spanning tree, so every cell is reachable
    // and nothing is ever walled off from the rest.
    const seen = new Set(["0,0"]);
    const stack = [{ i: 0, j: 0 }];
    const carved = [];
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const options = NEI
        .map(([di, dj]) => ({ i: cur.i + di, j: cur.j + dj }))
        .filter((c) => inside(c.i, c.j) && !seen.has(`${c.i},${c.j}`));
      if (!options.length) { stack.pop(); continue; }
      const next = pick(options);
      const e = between(cur, next);
      edges.set(e, "open");
      carved.push(e);
      seen.add(`${next.i},${next.j}`);
      stack.push(next);
    }
    if (pattern === "braided") {
      // Knock through some interior walls so there is more than one route.
      const interior = [];
      for (const [k, v] of edges) {
        if (v !== "wall") continue;
        const [d, i, j] = k.split(",");
        const ii = +i, jj = +j;
        if (d === "v" && ii > 0 && ii < cols) interior.push(k);
        if (d === "h" && jj > 0 && jj < rows) interior.push(k);
      }
      const extra = Math.round(interior.length * 0.18);
      for (let n = 0; n < extra && interior.length; n++) {
        const idx = Math.floor(rng() * interior.length);
        edges.set(interior[idx], "open");
        carved.push(interior[idx]);
        interior.splice(idx, 1);
      }
    }
    // Hang doors on the passages — that is what E is for. "cells" doors
    // every one of them, so it reads as the block of rooms it is meant to be
    // while staying fully walkable.
    const chance = pattern === "cells" ? 1 : doorChance;
    for (const e of carved) if (rng() < chance) edges.set(e, "door");
  }

  // One way in from outside, so the maze is enterable at all.
  const perimeter = [];
  for (let i = 0; i < cols; i++) perimeter.push(key("h", i, 0), key("h", i, rows));
  for (let j = 0; j < rows; j++) perimeter.push(key("v", 0, j), key("v", cols, j));
  edges.set(pick(perimeter), "door");

  const out = [];
  for (const [k, type] of edges) {
    if (type === "open") continue; // nothing to build in an open passage
    const [d, i, j] = k.split(",");
    out.push({ dir: d, i: +i, j: +j, type });
  }
  return out;
}

/* ── crossings ──
   A bridge site is not "flat ground": it is a gap. Probe outward in eight
   directions for the profile high → low → high, and take the narrowest one
   so the deck lands on both banks. */
export function findCrossing(sampler, cx, cz, { maxSpan = 40, step = 1.5 } = {}) {
  const floor = sampler(cx, cz);
  let best = null;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI; // 0..π — the other half is the same line
    const dx = Math.cos(a), dz = Math.sin(a);
    // Walk out to each bank INDEPENDENTLY. A symmetric probe only ever finds
    // a crossing when it happens to start on the channel's axis; walking each
    // side separately handles a gap approached from anywhere inside it.
    const walk = (sign) => {
      for (let d = step; d <= maxSpan; d += step) {
        const x = cx + dx * sign * d, z = cz + dz * sign * d;
        const h = sampler(x, z);
        if (h > 0.8 && h > floor + 2.2) return { x, z, h, d }; // dry, and up
      }
      return null;
    };
    const A = walk(-1), B = walk(1);
    if (!A || !B) continue;
    const gap = A.d + B.d;
    if (gap < 6 || gap > maxSpan) continue;
    // Banks must be level with each other, or the deck buries itself in the
    // high side — a hillside is not a crossing.
    if (Math.abs(A.h - B.h) > 2.5) continue;
    const bank = Math.min(A.h, B.h);
    // Nothing in the middle may rise into the deck.
    let deepest = Infinity, highest = -Infinity;
    for (let i = 3; i <= 17; i++) {
      const t = i / 20; // skip the bank shoulders
      const h = sampler(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
      deepest = Math.min(deepest, h);
      highest = Math.max(highest, h);
    }
    const drop = bank - deepest;
    if (drop < 2.2) continue;              // not a real gap
    if (highest > bank - 1) continue;      // a bump would pierce the deck
    const score = drop / gap;              // deep and narrow wins
    if (!best || score > best.score) {
      best = {
        ax: A.x, az: A.z, bx: B.x, bz: B.z,
        deckY: (A.h + B.h) / 2 + 0.3, gap, drop, score,
      };
    }
  }
  return best;
}

/* ── finding a crossing to build on ──
   Settlement scoring looks for flat, dry, habitable ground — the exact
   opposite of a ravine, so a bridge needs its own search. Coarse-scan for
   dips first and only probe those: testing every cell would cost hundreds of
   thousands of samples for a single click. */
export function searchCrossing(sampler, { cx = 0, cz = 0, reach = 300, cells = 18, probes = 24 } = {}) {
  const step = (reach * 2) / cells;
  const h = [];
  for (let j = 0; j <= cells; j++) {
    h.push([]);
    for (let i = 0; i <= cells; i++) {
      h[j].push(sampler(cx - reach + i * step, cz - reach + j * step));
    }
  }
  // A dip is a cell meaningfully below the highest of its neighbours.
  const dips = [];
  for (let j = 1; j < cells; j++) {
    for (let i = 1; i < cells; i++) {
      const v = h[j][i];
      const hi = Math.max(h[j][i - 1], h[j][i + 1], h[j - 1][i], h[j + 1][i]);
      if (hi - v > 2) dips.push({ x: cx - reach + i * step, z: cz - reach + j * step, drop: hi - v });
    }
  }
  dips.sort((a, b) => b.drop - a.drop);
  let best = null;
  for (const d of dips.slice(0, probes)) {
    const c = findCrossing(sampler, d.x, d.z);
    if (c && (!best || c.score > best.score)) best = c;
  }
  return best;
}

/* ── compose ──
   plan + a site centre → records and pads. `sampler(x,z)` is the live ground.
   Nothing here touches three.js or the engine. */
export function composeSite({ plan, seed, center, sampler, uidStart = 0, siteIndex = 0,
                              waterLevel = 0, interiorBudget = 1, interiorMax = 0,
                              approach = null, dress = null, biome = null,
                              onInterior = null }) {
  const errors = validatePlan(plan);
  if (errors.length) throw new Error("bad plan: " + errors.join(", "));
  const recipe = SITE_KINDS[plan.kind];
  const n = recipe.counts[plan.size] ?? 4;
  const radius = recipe.radius(n);

  // One deterministic stream per (seed, kind, site). Re-rolling a site is
  // just a different siteIndex — free, because no model is involved.
  const rng = mulberry32(seedChannel(seed, `compose:${plan.kind}:${siteIndex}`));

  // A crossing recipe may land away from the requested point (the nearest
  // real gap), so resolve it first — the whole site, and the camera, follow
  // the bridge rather than the original guess.
  let crossing = null;
  if (recipe.ground === "crossing") {
    crossing = findCrossing(sampler, center.x, center.z)
      || searchCrossing(sampler, { cx: center.x, cz: center.z, reach: 90, cells: 10, probes: 10 });
    if (!crossing) return { records: [], pads: [], radius, center, reason: "no crossing found nearby" };
    center = { x: (crossing.ax + crossing.bx) / 2, z: (crossing.az + crossing.bz) / 2 };
  }

  const site = new Site({
    cx: center.x, cz: center.z, radius, sampler, rng, seed, waterLevel,
    uidAt: (i) => makeUid(seed, uidStart + i),
  });

  /* The approach: which way you walk in. Seeded, so it is stable per site —
     UNLESS the caller knows better. A site standing on a routed world is not
     approached from a random bearing, it is approached down its own road, and
     every orientation decision hangs off this one number: the gate stands on
     the road, a town's street grid runs PARALLEL to its avenue rather than at
     forty degrees across it, and a castle's court opens toward the approach
     it was built to command. The rng is still drawn either way, so a site
     keeps the same interior layout whether or not a road found it. */
  const roll = rng() * TAU;
  const gateAngle = approach == null ? roll : approach;
  const ctx = {
    recipe,
    gateAngle,
    gateArc: Math.PI / 3.2,
    n,
    pattern: plan.pattern || null,
    spec: (id) => blockSpec(id),
    count: (c) => (c === "n" ? n : typeof c === "string" ? evalCount(c, n) : (c ?? 1)),
    crossing: null,
  };

  if (crossing) {
    ctx.crossing = crossing;
    const { ax, az, bx, bz } = crossing;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    // "near" = the side you approach from (bank A).
    ctx.sideFilter = (x, z, side) => {
      if (!side) return true;
      const t = ((x - ax) * dx + (z - az) * dz) / (len * len);
      return side === "near" ? t < 0.15 : t > 0.85;
    };
  } else {
    // One soft site-wide pad, then per-building touch-ups: a gently levelled
    // clearing, never a sharp plateau. A maze asks for a firmer one.
    const p = recipe.pad || { scale: 1.2, amount: 3.5 };
    site.pad(center.x, center.z, radius * p.scale, p.amount);
  }

  for (const step of recipe.steps) {
    const op = OPS[step.op];
    if (op) op(site, step, ctx);
  }

  /* Walkways are an idea about TOWERS — a setback terrace with a deck to the
     next one. Run over a terraced street they produce a footbridge between
     two cottages that share a party wall, which is not a feature, so a recipe
     laid out on a street grid says so and the pass is skipped. */
  const links = recipe.walkways === false ? [] : linkWalkways(site);

  /* ── interiors ──
     Last, because it needs the links: a floor is furnished only when
     something can arrive at it, and the walkways are what decides that.
     The pieces come back as ordinary records, so they select, move and undo
     like any other placement rather than being welded into the shell.

     `interiorMax` is the honest limit on all of this. Furnishing is by far
     the most expensive thing the composer does — a hundred and fifty terraced
     houses at full budget is six thousand records and ten seconds of blocked
     main thread — so a caller building a whole district says how many
     buildings it wants dressed, and the ones NEAREST THE MIDDLE get it. That
     is where a visitor lands, where the camera settles, and where the square
     is; the outskirts stay shells, which is what a game would stream anyway. */
  let hosts = site.records;
  if (interiorMax > 0) {
    const shells = site.records.filter((r) => r.proc?.rooms?.length);
    if (shells.length > interiorMax) {
      const near = [...shells].sort((a, b) =>
        Math.hypot(a.position[0] - site.cx, a.position[2] - site.cz) -
        Math.hypot(b.position[0] - site.cx, b.position[2] - site.cz));
      hosts = near.slice(0, interiorMax);
    }
  }
  const interiors = composeInteriors({
    records: hosts, links, seed, index: site.n,
    // The reasoning, out. `report` has existed since the pipeline did and
    // nothing but the suite has ever passed one — which is why the most
    // reasoned-about subsystem here has been the least visible. Collected per
    // building and handed up so js/export-site.js can put it in the file.
    report: onInterior,
    uidAt: (i) => makeUid(seed, uidStart + i),
    // A district of forty buildings furnished at full budget is tens of
    // thousands of records; the caller that knows how big the place is is the
    // caller that gets to say how densely it is dressed.
    budget: interiorBudget,
    dress,
    /* The country the buildings stand in, so what is inside them agrees with
       what is outside. A biome implies a climate, and a climate decides
       whether a house is arranged round a fire or round the shade — see
       climateOf in js/archetype.js. */
    biome,
  });
  site.n += interiors.length;
  site.records.push(...interiors);

  return { records: site.records, pads: site.pads, radius, center, kind: plan.kind, links,
    interiors: interiors.length };
}

/* ── connections ──
   The last pass, and the only one that looks at what was actually built
   rather than at the recipe. Blocks that declare walkway ports (block-shapes
   emits them on every tier head) are matched by ports.js and the winning
   pairs become real decks.

   This is the difference between a bridge that crosses a gap and a bridge
   that ARRIVES somewhere: the matcher will not join two ports that do not
   face each other, that are too far apart, that would climb too steeply, or
   whose straight run passes through a third building. A site with nothing
   worth joining simply gets no links, which is the correct answer — an
   unconnected pair costs nothing, a walkway into a blank wall costs the
   whole illusion.                                                          */
function linkWalkways(site) {
  const hosts = site.records.filter((r) => r.proc?.ports?.length);
  if (hosts.length < 2) return [];

  // Everything with a footprint blocks a span, including blocks that carry no
  // ports of their own — a walkway may not pass through a tower just because
  // that tower was not a candidate.
  const obstacles = site.records.map((r) => ({
    uid: r.uid, x: r.position[0], z: r.position[2], r: footprintOf(r.proc).r,
  }));

  const links = matchPorts(collectPorts(hosts), {
    obstacles,
    maxLinks: Math.max(1, Math.round(hosts.length * 0.6)),
  });

  for (const l of links) {
    const g = linkGeometry(l.a, l.b);
    // Legs reach from the deck to whatever is under its midpoint. Ground is
    // sampled rather than assumed, so a walkway over a slope still lands.
    const groundY = site.sampler ? site.sampler(g.x, g.z) : 0;
    const proc = bridgeParts({
      span: round2(g.run),
      width: round2(g.width),
      rise: round2(g.rise),
      drop: Math.max(1.5, round2(g.y - groundY)),
    });
    const rec = site.place(
      { ref: "generated/walkway", label: "Walkway", proc },
      g.x, g.z, g.rotationY,
    );
    // A deck hangs between two buildings; it is not seated on the terrain.
    rec.position[1] = round2(g.y);
    rec.seat = "point";
  }
  return links;
}

// "n*3" → n * 3. Deliberately tiny: recipes are data, not scripts.
function evalCount(expr, n) {
  const m = /^n\s*\*\s*(\d+(?:\.\d+)?)$/.exec(expr);
  if (m) return Math.round(n * parseFloat(m[1]));
  const v = parseInt(expr, 10);
  return Number.isFinite(v) ? v : 1;
}
