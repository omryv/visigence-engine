/* landform.js — the geography half of a world grammar.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. Everything downstream of the terrain in
 * this engine is good at its own scale: the composer lays a convincing street
 * grid, the router finds a road a cart could take, the scatter plants a
 * believable wood. None of them decides WHERE, and the thing that used to —
 * habitability scoring — answers only one question, "would people have
 * settled here", and answers it the same way on every world. So four
 * templates that differed in palette, weather and building style still built
 * the same map: two or three towns on the flattest dry ground, joined by a
 * road. The recognisable thing about a place is its GEOGRAPHY, and no amount
 * of re-dressing the houses supplies one.
 *
 * WHAT A LANDFORM IS. An ordered list of ops, exactly like a site recipe, run
 * against the terrain a seed happens to have grown. Some ops READ the ground —
 * find me the broad prominence a citadel would stand on, find me a coast with
 * country behind it, find me the shallowest water in the middle third. Some
 * WRITE it, as ordinary sculpt strokes: raise a mount under the castle, ring
 * it with a channel, cut that channel to the sea so it actually floods. Some
 * declare intent for the stages after this one: this anchor is where a
 * settlement goes, this pair of anchors wants an avenue between them.
 *
 * WHY IT STAYS RECOGNISABLE ACROSS SEEDS. Nothing in a landform is a
 * coordinate. "The castle stands on high ground in the inner half of the
 * world, the town sits a fifth of the world away from it in whichever
 * direction has the most open land, and the water between them is crossed" is
 * true on every seed and produces a different map on each one. That is the
 * whole of the design: the composition is fixed, the geography is not.
 *
 * THE STROKES ARE THE ENGINE'S OWN. `params.terrain.sculpt` is a replayable
 * offset over the noise (engine/terrain/sculpt.js) and it is what the brush
 * writes, what undo restores and what travels in params to an export. A
 * landform emits the same records the brush does, so a generated world is a
 * hand-editable one: the mount under a castle is a stroke you can smooth out.
 * There is no second terrain system here and there must never be one.
 *
 * Pure JS — no three.js, no DOM, no engine. It is handed a sampler and returns
 * data, so the suite runs it and so does the rail's preview drawing.
 */

import { surveyField, pickSites } from "../../kernel/core/survey.js";
import { mulberry32, seedChannel } from "../../kernel/seed.js";
import { fbm } from "../../kernel/terrain/noise.js";
import { strokeOffsetAt } from "../../kernel/terrain/sculpt.js";
import { solveRiver } from "../terrain/river.js";
import { CANONICAL_RES } from "../../kernel/terrain/canonical.js";
import { floodFromSea } from "../../kernel/water/flood.js";

const TAU = Math.PI * 2;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ── the finders ──
   Scorers over the survey grid. Each returns > 0 for a usable cell, and the
   number is a preference rather than a truth: pickSites takes the best and
   then refuses anything too near it.

   They are the reason a grammar can say "on a prominence" and mean it. */
export const FINDERS = {
  /* High, broad and standable. Height alone finds the top of a cliff; the
     slope term is what makes it a shoulder you could build a keep on, and the
     land-around term is what stops it being a stack in the sea. */
  prominence(f, i, j) {
    const h = f.at(i, j);
    if (h <= f.level + 6) return 0;
    const flat = Math.max(0, 1 - f.slope(i, j) * 4.5);
    const broad = f.landAround(i, j, 4);
    const rise = (h - f.level) / Math.max(40, f.hi - f.level);
    return (0.35 + rise) * flat * flat * broad;
  },

  /* Dry ground with the sea in reach and land at its back. A village on a
     sand spit is technically coastal and reads as a mistake. */
  coast(f, i, j) {
    const h = f.at(i, j);
    if (h <= f.level + 1.2) return 0;
    const d = f.seaDistance(i, j, 8);
    if (d > 4) return 0;
    const near = 1 - (d - 1) / 5;
    const hinter = f.landAround(i, j, 6);
    if (hinter < 0.45) return 0;
    const flat = Math.max(0, 1 - f.slope(i, j) * 5);
    return near * hinter * flat * flat;
  },

  // Wide, level, dry: the plain a kingdom's ruins are scattered over.
  plain(f, i, j) {
    const h = f.at(i, j);
    if (h <= f.level + 3) return 0;
    const flat = Math.max(0, 1 - f.slope(i, j) * 6);
    const open = f.landAround(i, j, 5);
    return flat * flat * open * open;
  },

  // The shallowest water there is. An island raised out of a trench needs a
  // hundred metres of fill and comes out as a cone.
  shallow(f, i, j) {
    const h = f.at(i, j);
    if (h > f.level - 1) return 0;
    if (f.landAround(i, j, 5) > 0.02) return 0;     // open water, not a bay
    return 1 / (1 + (f.level - h) / 12);
  },

  // A hollow in dry land: where a pond wants to be.
  low(f, i, j) {
    const h = f.at(i, j);
    if (h <= f.level + 1 || h > f.level + 60) return 0;
    const flat = Math.max(0, 1 - f.slope(i, j) * 7);
    const above = (60 - (h - f.level)) / 60;
    return flat * flat * above * f.landAround(i, j, 4);
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   THE OPS
   ══════════════════════════════════════════════════════════════════════════ */
const OPS = {
  /* Locate one or more anchors with a finder, inside a band of the world's
     radius and away from anchors already found. `band` is a fraction of the
     half-extent, so a grammar reads "in the inner half" rather than "within
     nine hundred metres" and survives a world of another size. */
  anchor(ctx, step) {
    const band = step.band || [0, 1];
    const away = (step.away || []).flatMap((role) => ctx.list(role));
    const sepM = (step.sep ?? 0.16) * ctx.size * 0.5;
    const score = FINDERS[step.find] || FINDERS.plain;
    /* ON THE SAME GROUND, and this is the constraint that turns a set of good
       individual answers into a composition. Two anchors can each be the best
       of their kind and be on opposite sides of a sea: the roads the grammar
       then asks for do not exist, the router burns its whole budget proving
       it, and the world arrives with its settlements unconnected and no
       explanation. Asking for the same landmass costs one flood fill. */
    const kin = step.sameLand ? ctx.list(step.sameLand) : [];
    const wanted = new Set();
    for (const a of kin) {
      const id = ctx.field.landmassAtWorld(a.x, a.z);
      if (id >= 0) wanted.add(id);
    }
    const minLand = step.minLand ?? 0;

    const picks = pickSites(ctx.field, (f, i, j) => {
      const t = f.radius01(i, j);
      if (t < band[0] || t > band[1]) return 0;
      if (wanted.size && !wanted.has(f.landmassAt(i, j))) return 0;
      if (minLand > 0 && f.landmassShare(f.landmassAt(i, j)) < minLand) return 0;
      const x = f.xOf(i), z = f.zOf(j);
      for (const a of away) if (Math.hypot(a.x - x, a.z - z) < (step.awayBy ?? 0.16) * ctx.size * 0.5) return 0;
      return score(f, i, j);
    }, { count: step.count || 1, minSep: sepM, rng: ctx.rng, wobble: step.wobble ?? 0.22 });

    if (!picks.length) {
      // A finder can come back empty — an ocean world has no prominence — and
      // the honest answer is a fallback anchor rather than a world that
      // refuses to build. The stages downstream all cope with a poor site;
      // none of them cope with no site at all.
      picks.push(ctx.fallback(band));
    }
    ctx.put(step.role, picks.map((p) => ({ x: r2(p.x), z: r2(p.z), find: step.find })));
  },

  /* An anchor derived from another: so far away, in a direction chosen for
     what is there rather than by angle. `bearing: "open"` sweeps the compass
     and takes the arc with the most usable land, which is what puts the town
     on the landward side of a coastal castle without anybody saying so. */
  offset(ctx, step) {
    const from = ctx.one(step.from);
    if (!from) return;
    const [d0, d1] = step.distance || [0.15, 0.22];
    const dist = (d0 + ctx.rng() * (d1 - d0)) * ctx.size * 0.5;
    const arcs = 24;
    let best = null;
    for (let k = 0; k < arcs; k++) {
      const a = (k / arcs) * TAU + ctx.rng() * 0.0;    // deterministic sweep
      const x = from.x + Math.cos(a) * dist, z = from.z + Math.sin(a) * dist;
      if (Math.hypot(x, z) > ctx.size * 0.42) continue;
      let score = 0;
      // Score the whole leg, not just the end: an anchor across a bay is a
      // town with no road to it.
      for (let s = 1; s <= 6; s++) {
        const t = s / 6;
        const px = from.x + Math.cos(a) * dist * t, pz = from.z + Math.sin(a) * dist * t;
        const h = ctx.height(px, pz);
        score += h > ctx.level + 1 ? 1 : (step.overWater ? 0.35 : -1.4);
      }
      if (step.bearing === "seaward") score = -score;
      const flat = Math.max(0, 1 - ctx.slope(x, z) * 4);
      score = score * (0.5 + flat) + ctx.rng() * 0.5;
      if (!best || score > best.score) best = { x, z, score };
    }
    if (best) ctx.put(step.role, [{ x: r2(best.x), z: r2(best.z), find: "offset" }]);
  },

  /* ── raising ground ──
     `mound` (below the ops) is the whole trick: a cluster of overlapping
     brushes normalised so the SUM hits the asked-for rise, rather than one
     smoothstep. One smoothstep is a bell curve, and a bell curve is a pudding
     — it has no top to build on, and half its area is a slope nothing can
     stand on. The base noise still shows through everywhere, because `raise`
     adds rather than replaces, so a raised hill is the seed's own ground
     lifted rather than a shape stamped over it. */
  mount(ctx, step) {
    for (const at of ctx.list(step.at)) {
      const rise = step.to != null ? Math.max(0, step.to - ctx.height(at.x, at.z)) : (step.rise ?? 40);
      const r = step.r ?? 240;
      // How flat the top is, as a fraction of the radius. THE ONLY KEY THAT
      // SAYS SO: three grammars also carried a `crown` in metres that nothing
      // here ever read, so the hill they described and the hill they got were
      // two different hills and no test could tell. They no longer carry it.
      mound(ctx, at.x, at.z, r, rise, { flatness: step.flatness ?? 0.42, rings: 2 });
      const lobes = step.lobes ?? 5;
      for (let k = 0; k < lobes; k++) {
        const a = ctx.rng() * TAU, d = r * (0.45 + ctx.rng() * 0.5);
        ctx.raise(at.x + Math.cos(a) * d, at.z + Math.sin(a) * d, r * 0.34, rise * (0.06 + ctx.rng() * 0.16));
      }
      at.mount = { r, rise: r2(rise) };
    }
  },

  /* Broad soft terraces: each tier is a mound of a fraction of the rise over
     a smaller radius, so the sum is a stair with rounded nosings — which is
     what the plateau term in the noise is already doing at world scale,
     brought down to the scale of a kingdom. */
  terraces(ctx, step) {
    for (const at of ctx.list(step.at)) {
      const tiers = Math.max(2, step.tiers ?? 3);
      const rise = step.rise ?? 40, r = step.r ?? 300;
      for (let k = 0; k < tiers; k++) {
        const rr = r * (1 - k / (tiers + 0.7));
        mound(ctx, at.x, at.z, rr, rise / tiers, { flatness: 0.5, rings: 1 });
        // Each tier's edge wanders, or the whole thing is a wedding cake.
        for (let m = 0; m < 3; m++) {
          const a = ctx.rng() * TAU;
          ctx.raise(at.x + Math.cos(a) * rr * 0.72, at.z + Math.sin(a) * rr * 0.72,
            rr * 0.42, (rise / tiers) * 0.26);
        }
      }
      at.mount = { r, rise: r2(rise) };
    }
  },

  /* An island, in two parts, and the first part is why it works.
     THE SHELF COMES FIRST. Lifting a hundred-metre disc out of forty-five
     metres of water gives a cone: the smoothstep is only near its peak for
     the innermost fifth, so everything outside that is still under the sea
     and what surfaces is a rock, not an island. So the reef platform is
     raised first — a very wide, very shallow mound bringing the seabed up to
     a few metres under the line — and the island is then a small rise on top
     of a shallow lagoon. Which is also what an atoll IS, and it is where the
     ring of pale turquoise round the sand comes from: the water shades by
     depth, and there is now a shelf for it to shade. */
  island(ctx, step) {
    for (const at of ctx.list(step.at)) {
      const r = step.r ?? 120;
      const target = step.to ?? 7;
      const base = ctx.height(at.x, at.z);
      /* Two shelves, not one. A single wide platform brings the middle up and
         leaves the ring at half its radius still forty metres down, which
         renders as deep water right up to the beach — the one thing the
         reference is NOT. A broad outer bank and a tighter inner one give a
         lagoon that shallows toward the sand, which is where the pale
         turquoise comes from: the water shades by depth and there is now a
         depth for it to shade. */
      const outer = ctx.level - (step.shelfDeep ?? 18);
      if (base < outer) mound(ctx, at.x, at.z, r * (step.shelfR ?? 4.2), outer - base, { flatness: 0.62, rings: 2 });
      const inner = ctx.level - (step.shelf ?? 6);
      const midBase = ctx.height(at.x, at.z);
      if (midBase < inner) mound(ctx, at.x, at.z, r * (step.lagoonR ?? 2.3), inner - midBase, { flatness: 0.58, rings: 2 });
      const lifted = ctx.height(at.x, at.z);
      if (target > lifted) mound(ctx, at.x, at.z, r, target - lifted, { flatness: 0.46, rings: 2 });
      // The coastline has to be irregular or it reads as a poker chip.
      const lobes = step.lobes ?? 4;
      const rise = target - base;
      for (let k = 0; k < lobes; k++) {
        const a = ctx.rng() * TAU, d = r * (0.3 + ctx.rng() * 0.45);
        ctx.raise(at.x + Math.cos(a) * d, at.z + Math.sin(a) * d, r * 0.5,
          rise * (0.03 + ctx.rng() * 0.07));
      }
      at.mount = { r, rise: r2(rise) };
    }
  },

  // Take the edge off. Not a plateau: a few overlapping shallow raises that
  // fill hollows without flattening the relief the world was screened for.
  level(ctx, step) {
    for (const at of ctx.list(step.at)) {
      const r = step.r ?? 150;
      ctx.stroke({ x: at.x, z: at.z, r, amount: step.amount ?? 6, mode: "smooth" });
      ctx.stroke({ x: at.x, z: at.z, r: r * 0.55, amount: step.amount ?? 6, mode: "smooth" });
    }
  },

  /* A ring of water round something.
     On its own this is a hole in the ground: engine/water/flood.js only wets
     what has a path to the open sea, so a moat with no outlet stays a dry
     ditch. That is correct behaviour and it is why `channel` exists — a
     grammar that digs a moat has to say where the water comes from. */
  moat(ctx, step) {
    for (const at of ctx.list(step.at)) {
      const r = step.r ?? 200, w = step.width ?? 90, depth = step.depth ?? 8;
      const ground = ctx.dry;
      /* AT HALF STEPS, for the reason `channel` spells out below: a stroke
         every brush-width leaves the ground BETWEEN two strokes cut only by
         their overlapping skirts, and one unbroken cell of dry ground
         anywhere on the ring is a dam — the flood fill stops at it and the
         moat upstream of it stays a ditch. Measured on the shipped grammar,
         a nominally 96 m moat flooded to a median of 36. */
      const n = Math.max(24, Math.round((TAU * r) / (w * 0.25)));
      const phase = ctx.rng() * TAU;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        // Two harmonics, not one: a single sine is an ellipse and an
        // ellipse is still a drawn shape. Two out of phase give a ring that
        // reads as a river that happens to come back on itself.
        const wob = 1 + Math.sin(a * 3 + phase) * 0.055 + Math.sin(a * 5 - phase * 1.7) * 0.035;
        const x = at.x + Math.cos(a) * r * wob, z = at.z + Math.sin(a) * r * wob;
        ctx.cutTo(x, z, w * 0.5, depth, ground);
      }
      at.moat = { r, width: w };
    }
  },

  /* A river, found rather than drawn.
     From the source it walks DOWNHILL on the survey grid — the same thing
     water does — until it reaches the sea or runs out of world, and cuts the
     channel along that line. So the course is evidence about the terrain in
     exactly the way a surveyed road is: it swings round the shoulder of a
     hill because there is a shoulder there.

     `from` may be an anchor or a point on an anchor's moat ring, which is how
     a ring of water round a castle gets an outlet without the grammar having
     to know where the sea is.                                              */
  channel(ctx, step) {
    /* EVERY SOURCE, not the first one. This op read `ctx.one` where every
       other op in the file reads `ctx.list`, so a world could declare three
       ponds and get three anchors, three site exclusions and exactly one
       pond — the other two were points on a map with nothing at them. The
       reference hill kingdom is composed around SEVERAL small round ponds
       with a stream out of one of them; it could hold precisely one, and it
       had to be lake-sized to be visible at all. */
    for (const src of ctx.list(step.from)) cutChannel(ctx, step, src);
  },

  /* A river, SOLVED — the editor's River tool as a grammar word.
     `channel` above cuts drainage: it runs to the rim and reads the dry
     ground, which is right for emptying a moat and wrong for a landscape
     feature — it cannot pool a hollow to its spill saddle, and it leaves no
     record for the water surface to stand on. This one hands the course to
     engine/terrain/river.js (the same solver the editor clicks through):
     steepest descent, pool-and-spill, ending on sea-connected water — and
     records the stepped centreline on ctx.rivers, which buildWorld turns
     into params.terrain.rivers so the ribbon renders and the file carries
     the river as data.

     `from` is an anchor role; absent, the highest ground in `band` (the
     same fallback rule anchors use). The strokes go through ctx.stroke like
     every other op's, so replay, undo and the handoff need nothing new. */
  river(ctx, step) {
    const heads = step.from ? ctx.list(step.from) : [ctx.fallback(step.band || [0.05, 0.55])];
    if (!heads.length) return;
    /* The solver wants a real grid, and the survey field is deliberately too
       coarse (56², inset) to carve from. One bake of the CURRENT shaped
       ground — raises and cuts alike: a river dug after a moat should see
       the moat — at half the canonical grid: a quarter of the sampling cost
       per world build, on a 2ⁿ+1 grid whose cells the canonical one halves
       exactly. The flood mask comes from the same field so "the sea" means
       what the renderer will mean by it. */
    const res = (CANONICAL_RES - 1) / 2 + 1;
    const data = new Float32Array(res * res);
    for (let j = 0; j < res; j++) {
      const z = (j / (res - 1) - 0.5) * ctx.size;
      for (let i = 0; i < res; i++) {
        data[j * res + i] = ctx.height((i / (res - 1) - 0.5) * ctx.size, z);
      }
    }
    const field = { res, size: ctx.size, data };
    const wet = floodFromSea(field, null, ctx.level).wet;
    for (const head of heads) {
      const id = `river-${ctx.rivers.length + 1}`;
      const out = solveRiver({
        field, wet, head: { x: head.x, z: head.z },
        width: step.width ?? 18, depth: step.depth ?? 4, meander: step.meander ?? 1,
        level: ctx.level, seed: ctx.seed + ":" + id,
      });
      if (out.path.length < 2) continue;
      const strokeStart = ctx.mark();
      for (const s of out.strokes) ctx.stroke({ x: s.x, z: s.z, r: s.r, amount: s.amount, mode: s.mode });
      ctx.rivers.push({
        id, x: r2(head.x), z: r2(head.z),
        width: step.width ?? 18, depth: step.depth ?? 4, meander: step.meander ?? 1,
        strokeStart, strokeCount: ctx.mark() - strokeStart,
        reachedSea: out.reachedSea,
        path: out.path,
      });
    }
  },

  // Declare a way between two anchors. The build lays it; this only says that
  // it should exist, what kind it is, and what to call it.
  route(ctx, step) {
    const a = ctx.one(step.from), b = ctx.one(step.to);
    if (!a || !b) return;
    ctx.routes.push({ from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z },
      style: step.style || "road", name: step.name || null, anchorRadius: step.anchorRadius ?? 0 });
  },
};

/* ── one watercourse, from one source ──
   Split out of the op above so `channel` can run it once per source without
   the body growing an indent. */
function cutChannel(ctx, step, src) {
    /* THE WALK MUST NOT SEE WHAT IT HAS DUG — including the moat it is
       draining. `ctx.height` sums every stroke so far, which is right for a
       channel cut after a MOUNT and catastrophic for one reading water it
       made itself: descending into its own trench, the course circles the
       moat instead of leaving it, and the "have we reached the sea" test
       fires on the third step because the moat is below the waterline by
       construction. `ctx.dry` is the ground with the raises and none of the
       cuts, which is exactly the surface a river would have found. */
    const ground = ctx.dry;

    let x = src.x, z = src.z;
    if (step.ring != null) {
      // Leave the ring on the side that already slopes away.
      let best = null;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        const px = src.x + Math.cos(a) * step.ring, pz = src.z + Math.sin(a) * step.ring;
        const out = ground(src.x + Math.cos(a) * step.ring * 1.7, src.z + Math.sin(a) * step.ring * 1.7);
        if (!best || out < best.out) best = { x: px, z: pz, out };
      }
      x = best.x; z = best.z;
      src.outlet = { x: r2(x), z: r2(z) };
    }

    const w = step.width ?? 60, depth = step.depth ?? 8;
    if (step.pond) {
      // A widening at the source: the pond the stream drains.
      ctx.cutTo(x, z, step.pond, depth * 1.2, ground);
      ctx.cutTo(x + step.pond * 0.55, z, step.pond * 0.7, depth, ground);
    }
    /* IT RUNS TO THE RIM, NOT TO THE FIRST LOW GROUND.
       Stopping at the first cell below the waterline sounds right and is not:
       a hollow below the line is water only when the sea can reach it
       (engine/water/flood.js), so a channel that ends in a landlocked basin
       has connected a moat to a puddle and the ring stays a dry ditch. The
       plate's own edge falloff submerges the outer margin by construction, so
       running all the way there is the one ending that is guaranteed to be
       the sea. It costs nothing to overshoot: once the ground is already
       below the target depth `cutTo` emits no stroke at all.

       AND IT CUTS AT HALF STEPS. A stroke every step-length leaves the ridge
       BETWEEN two strokes cut only by their overlapping skirts, and one
       unbroken cell of dry ground anywhere along the course is a dam — the
       flood fill stops there and everything upstream of it is dry. */
    const stepLen = Math.max(24, w * 0.4);
    const limit = Math.round((ctx.size * 1.8) / stepLen);
    let dirX = 0, dirZ = 0;
    const course = [];
    for (let s = 0; s < limit; s++) {
      ctx.cutTo(x, z, w * 0.5, depth, ground);
      if (Math.max(Math.abs(x), Math.abs(z)) > ctx.size * 0.487) break;
      // Steepest descent, smoothed by the direction already travelled so the
      // course meanders instead of zig-zagging cell to cell.
      let bx = 0, bz = 0, bh = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        const cx = Math.cos(a), cz = Math.sin(a);
        const h = ground(x + cx * stepLen, z + cz * stepLen)
          - (dirX * cx + dirZ * cz) * (step.inertia ?? 12);
        if (h < bh) { bh = h; bx = cx; bz = cz; }
      }
      dirX = bx; dirZ = bz;
      ctx.cutTo(x + bx * stepLen * 0.5, z + bz * stepLen * 0.5, w * 0.46, depth, ground);
      x += bx * stepLen; z += bz * stepLen;
      course.push({ x, z, dx: bx, dz: bz });
    }

    /* ── where the stream can be crossed ──
       The course was write-only: this op walked a river across the world and
       recorded nothing but the fact that it had, so nothing downstream could
       ever be sited ON it. A bridge is not a thing you place, it is a thing a
       ROUTE does when it meets water it must get over — so the only piece
       missing was a pair of anchors, one on each bank, that a route can be
       declared between. Two lines of grammar then buy the small arched bridge
       the hill kingdom is composed around, and it lands on a different bend
       of a different river on every seed, because the river chose the bend.

       Taken a third of the way down: near the source the stream is still the
       pond, and near the mouth it is the sea. */
    if (step.role && course.length > 3) {
      const at = course[Math.max(1, Math.round(course.length / 3))];
      const px = -at.dz, pz = at.dx;
      /* WALK OUT UNTIL THE GROUND IS DRY, rather than stepping a fixed
         distance and hoping. A river is not the only water near a river: it
         meanders back on itself, it widens where the ground was already low,
         and the pond it drains is a different size on every seed — so a bank
         measured as "half the channel plus thirty metres" was standing in the
         water on three seeds in five, and the route declared across it had
         both ends in the river. This asks the ground it just finished cutting
         where the edge actually is.

         `reach` is also the honest failure: past it there is no bank within
         a bridge of the far side, so no crossing is published and the world
         simply has no bridge on that seed rather than a lane into a lake. */
      const bankAt = (dir) => {
        for (let m = w * 0.5; m <= (step.reach ?? 150); m += 8) {
          const x2 = at.x + px * dir * m, z2 = at.z + pz * dir * m;
          if (ctx.height(x2, z2) > ctx.level + 1.5) return { x: x2, z: z2, m };
        }
        return null;
      };
      const a = bankAt(1), b = bankAt(-1);
      // …and the two banks have to be close enough that a way could deck it.
      if (a && b && a.m + b.m <= (step.span ?? 120)) {
        ctx.put(step.role, [
          { x: r2(a.x), z: r2(a.z), find: "bank" },
          { x: r2(b.x), z: r2(b.z), find: "bank" },
        ]);
      }
    }
}

/* ── a mound with a top on it ──
   A cluster of brush centres inside `flatness · R`, all sharing one brush
   wide enough to reach the rim, with the amount solved so the tallest point
   of the SUM equals the rise asked for. Overlapping smoothsteps add to
   something far flatter than any one of them, which is the difference between
   a hill a castle stands on and a hill it slides off.

   The peak is found by sampling rather than derived, because the pattern is
   not radially symmetric and the maximum is not always at the centre — and a
   mound that overshoots its target by forty per cent is a mount that pokes
   through the sky box. */
function mound(ctx, cx, cz, R, rise, { flatness = 0.45, rings = 2 } = {}) {
  if (!(rise > 0.05) || !(R > 1)) return;
  const spread = R * flatness;
  const brush = R - spread * 0.3;
  const pts = [[0, 0]];
  for (let k = 1; k <= rings; k++) {
    const n = 6 * k, rr = spread * (k / rings);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + k * 0.7;
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
  }
  const unitAt = (px, pz) => {
    let s = 0;
    for (const [qx, qz] of pts) {
      const d = Math.hypot(px - qx, pz - qz);
      if (d >= brush) continue;
      const t = 1 - d / brush;
      s += t * t * (3 - 2 * t);
    }
    return s;
  };
  let peak = 0;
  for (let i = 0; i <= 12; i++) {
    for (let k = 0; k < 6; k++) {
      const d = (i / 12) * R * 0.7, a = (k / 6) * TAU;
      peak = Math.max(peak, unitAt(Math.cos(a) * d, Math.sin(a) * d));
    }
  }
  if (peak <= 1e-6) return;
  const amt = rise / peak;
  for (const [px, pz] of pts) ctx.raise(cx + px, cz + pz, brush, amt);
}

/* ══════════════════════════════════════════════════════════════════════════
   RUNNING ONE

   `sampler(x, z)` is the base ground — the world as the seed grew it, before
   any of this. Everything an op reads goes through `ctx.height`, which adds
   the strokes emitted so far, so a channel cut after a mount knows the mount
   is there. That is the same arithmetic SculptLayer rasterises, evaluated
   analytically instead of on a grid: a few hundred queries against a few
   hundred strokes, which is nothing, and it means the two never disagree
   about what the ground is.
   ══════════════════════════════════════════════════════════════════════════ */
export function shapeWorld({ grammar = [], seed, size, sampler, level = 0, res = 64 }) {
  const rng = mulberry32(seedChannel(seed, "landform"));
  const field = surveyField({ sampler, size, res, level });
  const strokes = [];
  const anchors = new Map();
  const routes = [];
  const rivers = [];
  let dryMark = null;          // strokes.length before the first cut — see ctx.dry

  /* THE arithmetic the engine evaluates, not a copy of it. This used to be a
     second implementation of the brush falloff living here, because the
     grammar has to know the post-stroke height — for slopes, for water
     routing, for where a moat sits — before any of it has been applied. That
     made it a prediction: the surface reasoned about here was exact and the
     surface that rendered was a 16 m raster, so anything narrower than about
     forty metres came out softer than this said, and the vocabulary below was
     kept to broad shapes to stay inside the gap.
     engine/terrain/sculpt.js now evaluates raise and lower rather than
     sampling them, so importing its expression is not a convenience — it is
     what makes the prediction true.

     `smooth` is still not modelled, and honestly cannot be: it pulls toward a
     local average of the result, which only exists once there is a grid. A
     grammar that leans on smooth for SHAPE rather than for finish is reasoning
     about ground it will not get. */
  const offsetAt = (x, z, limit = strokes.length) => strokeOffsetAt(strokes, x, z, limit);
  const height = (x, z) => sampler(x, z) + offsetAt(x, z);

  const MODES = ["raise", "lower", "smooth", "flatten"];
  const ctx = {
    size, level, rng, field, routes, height, seed, rivers,
    slope(x, z) {
      const d = 12;
      return Math.max(Math.abs(height(x + d, z) - height(x - d, z)),
                      Math.abs(height(x, z + d) - height(x, z - d))) / (2 * d);
    },
    stroke(s) {
      strokes.push({ x: r2(s.x), z: r2(s.z), r: r2(s.r),
        a: Math.round((s.amount ?? 0) * 1000) / 1000, m: Math.max(0, MODES.indexOf(s.mode || "raise")) });
    },
    raise(x, z, r, amount) { if (amount > 0.01) ctx.stroke({ x, z, r, amount, mode: "raise" }); },
    mark() { return strokes.length; },
    heightAt(x, z, limit) { return sampler(x, z) + offsetAt(x, z, limit); },
    /* The ground with every RAISE and no CUT — the surface water would have
       run over before anybody dug anything. Every cutting op reads this
       rather than the live height, so a moat does not deepen itself round the
       ring and a river does not drown in its own channel. The mark is taken
       the first time it is asked for, which is by construction the moment
       before the first cut. */
    dry(x, z) {
      if (dryMark == null) dryMark = strokes.length;
      return sampler(x, z) + offsetAt(x, z, dryMark);
    },
    /* Cut the ground at a point down to `depth` BELOW the waterline, whatever
       it happens to be standing at. A fixed-depth dig leaves a river running
       along a hillside above the sea it is supposed to reach.

       OVERDIG is not slack. A stroke's smoothstep peaks at its own centre and
       the offset grid's nearest cell can be half a cell off it, so the actual
       cut on a 16 m grid lands short of what was asked for — and a river that
       comes up ten centimetres shy of the waterline is a dry ditch with a
       castle reflected in nothing. It is all under water; there is no cost to
       being sure. */
    cutTo(x, z, r, depth, read = height) {
      const drop = (read(x, z) - (level - depth)) * 1.3;
      if (drop > 0.05) ctx.stroke({ x, z, r, amount: drop, mode: "lower" });
    },
    list(role) {
      if (!role) return [];
      const m = /^(.*)#(\d+)$/.exec(role);
      if (m) { const all = anchors.get(m[1]) || []; const one = all[+m[2]]; return one ? [one] : []; }
      return anchors.get(role) || [];
    },
    one(role) {
      if (role === "sea") return null;
      return ctx.list(role)[0] || null;
    },
    put(role, list) { anchors.set(role, (anchors.get(role) || []).concat(list)); },
    // Somewhere, when a finder found nothing: the highest cell inside the band.
    fallback(band) {
      let best = null;
      for (let j = 1; j < field.res - 1; j++) {
        for (let i = 1; i < field.res - 1; i++) {
          const t = field.radius01(i, j);
          if (t < band[0] || t > band[1]) continue;
          const h = field.at(i, j);
          if (!best || h > best.h) best = { x: field.xOf(i), z: field.zOf(j), h };
        }
      }
      return best || { x: 0, z: 0 };
    },
  };

  for (const step of grammar) {
    const op = OPS[step.op];
    if (op) op(ctx, step);
  }

  return {
    strokes,
    routes,
    rivers,
    anchors: Object.fromEntries(anchors),
    field,
    // The finished ground, for anything that needs to measure the world this
    // produced without waiting for the engine to rebuild it (the rail's
    // preview draws off exactly this).
    height,
    landFraction: field.landFraction,
  };
}

/* ── where things grow ──
   Planting used to be uniform rejection sampling with a height band, and
   uniform is the one distribution vegetation never has: it produces an even
   green fuzz over the whole map, which is the tell that says "procedural"
   louder than anything else in a generated world.

   So density is a low-frequency noise field — woods and clearings, at a
   wavelength set per world — multiplied by the band and slope rules that were
   already right. A world can then ask for a forest that starts at the edge of
   a village (`near`), for scattered stands over a plain (`clumping` low, a
   long wavelength), or for the dense unbroken cover of a wet valley.

   Nothing is planted on a street, in a settlement, on a road, in the water, or
   on ground a tree could not hold. `taken` is a coarse hash of everything
   already built rather than a distance test against every record — four
   thousand candidates against two thousand records is eight million tests,
   and this has to fit inside one frame's worth of patience. */
export function plantCountry({
  seed, size, sampler, waterLevel = 0, species, count, bands = [0.05, 0.6],
  heightRef = 520, sites = [], roads = [], cell = 26, field = null,
  clumping = 0.62, grain = 3.4, contrast = 2.4, near = null, nearPull = 0,
}) {
  if (!count || !species?.length) return [];
  const rng = mulberry32(seedChannel(seed, "landform:planting"));
  const noiseSeed = seedChannel(seed, "landform:woods");
  const taken = new Set();
  const key = (x, z) => `${Math.round(x / cell)},${Math.round(z / cell)}`;
  const mark = (x, z, r) => {
    const n = Math.ceil(r / cell);
    const ci = Math.round(x / cell), cj = Math.round(z / cell);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) taken.add(`${ci + i},${cj + j}`);
  };
  for (const s of sites) mark(s.x, s.z, (s.r || 60) * 1.15);
  for (const p of roads) mark(p.x, p.z, p.r || 13);

  const half = size * 0.47;
  const out = [];
  /* ── where the candidates come from ──
     Uniform draws over the whole plate are the obvious thing and they are why
     coastal worlds came up bald: on a map that is two-thirds sea, two thirds
     of every draw is spent proposing a tree in the water, and the forest runs
     out of attempts long before it runs out of ground. When the caller has a
     survey grid — the landform already built one — candidates are drawn from
     its DRY CELLS instead, which is the same distribution with the wasted
     two-thirds removed. Everything downstream still re-checks the real
     height: the grid is a hint about where to look, never an answer. */
  const dry = [];
  if (field) {
    for (let j = 1; j < field.res - 1; j++) {
      for (let i = 1; i < field.res - 1; i++) {
        if (field.at(i, j) > waterLevel + 2) dry.push(j * field.res + i);
      }
    }
  }
  const tries = count * (dry.length ? 5 : 9);
  for (let t = 0; t < tries && out.length < count; t++) {
    let x, z;
    if (dry.length) {
      const k = dry[(rng() * dry.length) | 0];
      const i = k % field.res, j = (k - i) / field.res;
      x = field.xOf(i) + (rng() - 0.5) * field.step;
      z = field.zOf(j) + (rng() - 0.5) * field.step;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
    } else {
      x = (rng() * 2 - 1) * half; z = (rng() * 2 - 1) * half;
    }
    if (taken.has(key(x, z))) continue;
    const y = sampler(x, z);
    if (y < waterLevel + 2.5) continue;
    const band = y / heightRef;
    if (band < bands[0] || band > bands[1]) continue;
    // Slope: a canopy on a 30° face reads as a tree lying down.
    const d = 7;
    const slope = Math.max(
      Math.abs(sampler(x + d, z) - sampler(x - d, z)),
      Math.abs(sampler(x, z + d) - sampler(x, z - d))) / (2 * d);
    if (slope > 0.5) continue;
    // Thinning with height: the tree line is what makes a mountain read as
    // one, and a forest that stops abruptly reads as a mask.
    const up = (band - bands[0]) / Math.max(1e-3, bands[1] - bands[0]);
    if (rng() < up * up * 0.75) continue;
    /* The woods. `clumping` is how much of the density comes from the field
       rather than from chance: 0 is the old uniform fuzz, 1 is hard-edged
       stands with bare ground between them. */
    if (clumping > 0) {
      /* THE CONTRAST TERM IS NOT A FUDGE. Value-noise fBm at three octaves
         almost never reaches its own bounds — the raw field sits inside about
         ±0.4 — so mapping it straight to a density gives woods only slightly
         thicker than the clearings, which measures as uniform and LOOKS
         uniform. Gaining it up before the clamp is what turns a gentle
         undulation in probability into stands of trees with open ground
         between them. */
      const n = fbm((x / size) * grain, (z / size) * grain, noiseSeed, 3) * contrast;
      let dens = (n + 1) / 2;
      if (near) {
        // A forest that begins where the town ends. Distance is measured in
        // world half-extents so it means the same on any size of world.
        const dd = Math.hypot(x - near.x, z - near.z) / (size * 0.5);
        dens += nearPull * Math.max(0, 1 - dd / (near.reach ?? 0.4));
      }
      if (rng() > (1 - clumping) + clumping * clamp(dens, 0, 1)) continue;
    }
    out.push({
      id: species[Math.floor(rng() * species.length)],
      x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10,
      rotationY: Math.round(rng() * TAU * 1000) / 1000,
      scale: Math.round((0.72 + rng() * 0.66) * 100) / 100,
    });
  }
  return out;
}

/* ── strays ──
   The single objects that belong to a WORLD rather than to a settlement: an
   isolated watchtower on a rise, broken wall standing in a field, an arch
   with nothing left round it.

   `along` is the one that matters, and it is the difference between ruins
   that were scattered and ruins that were left. Rubble beside an old road is
   evidence of the road; the same rubble at random coordinates is litter. */
export function placeStrays({ seed, size, sampler, waterLevel = 0, specs = [], field,
                              anchors = {}, routes = [], sites = [] }) {
  const out = [];
  const rng = mulberry32(seedChannel(seed, "landform:strays"));
  const clearOf = (x, z, r) => {
    for (const s of sites) if (Math.hypot(s.x - x, s.z - z) < (s.r || 60) * 1.1 + r) return false;
    for (const o of out) if (Math.hypot(o.x - x, o.z - z) < r + (o.r || 8)) return false;
    return true;
  };
  const usable = (x, z, r) => {
    if (Math.max(Math.abs(x), Math.abs(z)) > size * 0.42) return false;
    const y = sampler(x, z);
    if (y < waterLevel + 3) return false;
    const d = 8;
    const slope = Math.max(Math.abs(sampler(x + d, z) - sampler(x - d, z)),
                           Math.abs(sampler(x, z + d) - sampler(x, z - d))) / (2 * d);
    if (slope > 0.34) return false;
    return clearOf(x, z, r);
  };

  for (const spec of specs) {
    const want = spec.count || 1;
    const r = spec.clearance ?? 14;
    let placed = 0;

    if (spec.along) {
      // Beside a way, on alternating sides, at a stand-off that keeps it out
      // of the carriageway but inside the story the road is telling.
      const legs = routes.filter((rt) => !spec.style || rt.style === spec.style);
      const pts = legs.flatMap((rt) => rt.points || []);
      for (let n = 0; n < want * 14 && placed < want; n++) {
        if (!pts.length) break;
        const p = pts[Math.floor(rng() * pts.length)];
        const a = rng() * TAU, d = (spec.offset ?? 26) * (0.6 + rng());
        const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
        if (!usable(x, z, r)) continue;
        out.push({ id: spec.block, x, z, r, rotationY: rng() * TAU });
        placed++;
      }
    } else if (spec.near) {
      const hosts = anchors[spec.near] || [];
      for (let n = 0; n < want * 16 && placed < want; n++) {
        if (!hosts.length) break;
        const host = hosts[Math.floor(rng() * hosts.length)];
        const a = rng() * TAU, d = (spec.spread ?? 200) * (0.35 + rng() * 0.8);
        const x = host.x + Math.cos(a) * d, z = host.z + Math.sin(a) * d;
        if (!usable(x, z, r)) continue;
        out.push({ id: spec.block, x, z, r, rotationY: rng() * TAU });
        placed++;
      }
    } else {
      const band = spec.band || [0.1, 0.8];
      const picks = pickSites(field, (f, i, j) => {
        const t = f.radius01(i, j);
        if (t < band[0] || t > band[1]) return 0;
        return (FINDERS[spec.find] || FINDERS.prominence)(f, i, j);
      }, { count: want * 3, minSep: (spec.sep ?? 0.1) * size * 0.5, rng, wobble: 0.5 });
      for (const p of picks) {
        if (placed >= want) break;
        if (!usable(p.x, p.z, r)) continue;
        out.push({ id: spec.block, x: p.x, z: p.z, r, rotationY: rng() * TAU });
        placed++;
      }
    }
  }
  return out;
}
