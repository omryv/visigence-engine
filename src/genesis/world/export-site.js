/* export-site.js — the world as a SITE: what stands on the ground, and why.
 *
 * The terrain bundle answered "what shape is the land". These two files
 * answer the other two questions a buyer has, and they are different buyers:
 *
 *   placements.json   for the STUDIO. Every placement's authored transform,
 *                     in metres, in the engine's own frame, with the verb it
 *                     affords and the extent the editor measured — enough to
 *                     stand a scene up and swap real prefabs in by uid. The
 *                     Unity importer in the same bundle reads exactly this.
 *
 *   site.json         for the ARCHITECT. The metric room schedule: each
 *                     building with its archetype, its household, its rooms
 *                     — purpose, width x depth, area — and what the
 *                     validator said about the floor. This is the interior
 *                     pipeline's own report, exported rather than restated:
 *                     every number is read off the record the planner and
 *                     the checker actually produced, because a schedule this
 *                     module invented would be worse than none.
 *
 * Both are pure functions of their inputs and read no clock — same world,
 * same bytes, like every serialiser in this repository. GLB imports are the
 * one thing placements cannot fully carry (the bytes live in the session
 * only, exactly as js/worldfile.js refuses them), and they are NAMED in
 * `omitted` rather than silently dropped.
 */

import { CODES } from "./interior-validate.js";

const CODE_COUNT = Object.keys(CODES).length;

/** The checker's verdict over one interior report: which of the named
    failure codes fired and how often, which rooms needed a second or third
    plan, and whether the floor came back clean. Read off the report, never
    typed, so the file cannot disagree with the validator. */
export function verdictOf(rep) {
  const counts = new Map();
  const replanned = [];
  let ok = true;
  for (const r of rep?.rooms || []) {
    for (const v of r.check?.violations || []) {
      counts.set(v.code, (counts.get(v.code) || 0) + 1);
    }
    if (!r.check?.ok) ok = false;
    // `attempt` is zero-based: attempt 1 means it was drawn twice.
    if (r.attempt > 0) replanned.push({ zone: r.zone, purpose: r.purpose, attempts: r.attempt + 1 });
  }
  for (const v of rep?.check?.violations || []) {
    counts.set(v.code, (counts.get(v.code) || 0) + 1);
    ok = false;
  }
  const fired = [...counts].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n);
  return { ok, fired, replanned, codes: CODE_COUNT };
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** One placement, as the wire sees it. `bounds` is the editor's own coarse
    measurement ({size, above, below} in metres) when the caller has one. */
function placementEntry(r, bounds) {
  return {
    uid: r.uid,
    label: r.label || null,
    ref: r.ref || null,
    position: (r.position || [0, 0, 0]).map(round2),
    rotationY: round3(r.rotationY || 0),
    scale: round3(r.scale ?? 1),
    seat: r.seat === "point" ? "point" : "ground",
    tint: r.tint ? r.tint.map(round3) : null,
    stretch: r.stretch ? r.stretch.map(round3) : null,
    style: r.style || null,
    verb: r.use?.verb || null,
    bounds: bounds
      ? { size: round2(bounds.size), above: round2(bounds.above), below: round2(bounds.below) }
      : null,
  };
}

/**
 * placements.json. `boundsFor(uid)` may return {size, above, below} or null;
 * headless callers (the suite) pass nothing and the entries simply carry no
 * extent, which the importer's placeholder default absorbs.
 */
export function buildPlacementsFile({ records, boundsFor = () => null }) {
  const placements = [];
  const omitted = [];
  for (const r of records) {
    // A streamed GLB's transform still travels — the scene layout is real —
    // but the bytes do not, and the file says so instead of hoping.
    if (r.url || r.bytesKey) omitted.push({ uid: r.uid, label: r.label || null, why: "imported GLB — bytes live in the session only" });
    placements.push(placementEntry(r, boundsFor(r.uid)));
  }
  return {
    kind: "worldgence.placements",
    version: 1,
    units: "metres",
    frame: "right-handed, +Y up, origin at the world's centre; Unity mirrors Z and negates yaw (see unity/README.txt)",
    count: placements.length,
    placements,
    omitted,
  };
}

/* ── the room schedule ── */

function roomEntry(z) {
  const w = z.w ?? null, d = z.d ?? null;
  return {
    index: (z.index ?? 0) + 1,
    purpose: z.purpose || null,
    widthMeters: w != null ? round2(w) : null,
    depthMeters: d != null ? round2(d) : null,
    areaM2: w != null && d != null ? round2(w * d) : null,
    opensOffEntry: !!z.door,
  };
}

/** One building's schedule, from the interior pipeline's own report — the
    same object the editor's I panel renders, so the two cannot disagree. */
function buildingEntry(rep, record) {
  /* The verdict is the checker's, computed by the SAME function the editor's
     I panel uses (js/interior-why.js), so a floor this file calls clean is a
     floor the panel calls clean. */
  const verdict = verdictOf(rep);
  const st = rep.check?.stats || {};
  return {
    uid: rep.uid,
    label: rep.label || rep.archetype || null,
    archetype: rep.archetype || null,
    storey: rep.at || "ground",
    position: (record?.position || [0, 0, 0]).map(round2),
    rotationY: round3(record?.rotationY || 0),
    household: rep.people
      ? { occupants: rep.people.occupants ?? null, children: rep.people.children ?? null, trade: rep.people.trade || null }
      : null,
    rooms: (rep.zones || []).map(roomEntry),
    doorways: (rep.doors || []).length,
    validated: {
      ok: verdict.ok,
      violations: verdict.fired.map((f) => ({ code: f.code, count: f.n })),
      roomsReachable: st.reachedZones ?? null,
      roomsTotal: st.zones ?? null,
      walkableFraction: st.walkFrac != null ? round3(st.walkFrac) : null,
    },
  };
}

/**
 * site.json. `interiors` is the build's report list (one per building,
 * ground floor winning — the same rule the editor's panel uses); `records`
 * joins each report back to its shell's transform.
 */
export function buildSiteFile({ params, interiors = [], records = [], spawn = null, origin = null }) {
  const byUid = new Map(records.map((r) => [r.uid, r]));
  const buildings = interiors.map((rep) => buildingEntry(rep, byUid.get(rep.uid)));

  // The schedule totals, so the file leads with what a first reader asks.
  const rooms = buildings.reduce((n, b) => n + b.rooms.length, 0);
  const occupants = buildings.reduce((n, b) => n + (b.household?.occupants || 0), 0);

  return {
    kind: "worldgence.site",
    version: 1,
    units: "metres",
    origin: origin ? String(origin) : null,
    seed: params?.seed || null,
    siteMeters: params?.terrain?.size ?? null,
    waterLevelMeters: params?.water?.level || 0,
    spawn: spawn ? { x: round2(spawn.x), z: round2(spawn.z) } : null,
    totals: { buildings: buildings.length, rooms, occupants },
    buildings,
  };
}
