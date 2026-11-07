/**
 * MISSION -> INTENT: what a mission needs of the ground, said in the kernel's own vocabulary.
 *
 * A Visigames mission is a chain of steps (src/world/blueprint.js compileBlueprint): activate the
 * stations, hold off the waves, reach the lookout, get out. Every one of them makes a demand of
 * the land it is played on that today nothing states, because the village it is played in is an
 * 80 m square this engine lays out for itself: a control station wants level ground to stand at,
 * a fight wants an open floor and lines of sight in from cover, a route wants ground a body can
 * climb, the way out wants a way back.
 *
 * The repository's kernel has a vocabulary for exactly those demands. src/kernel/terrain/condition.js
 * reads a list of statements about the ground — a pad of given height, a point, a corridor no
 * steeper than a grade, a ray the ground stays under — and makes them true of a seed's own
 * terrain by the least improbable change to its lattice, reporting what that cost. This module
 * is the translation: a compiled mission, a frame that says where on a kernel plate the level
 * sits, and the player's body, in; a list `createHeightSampler` accepts as
 * `params.terrain.intent`, out.
 *
 * WHO CALLS IT. world/kernelGround.js, when a project stands on its seed's world: the stations, the
 * fight at the square and the way out of the compiled mission, on the site it chose, in a scale-8
 * frame. The integration test is the proof that the seam holds on its own (tools/test/test-mission-intent.mjs:
 * every genre's template mission on two seeds, handed to the kernel on a real world in a scale-8 frame,
 * converged with every pad and point within 0.05 m, every corridor's grade held, every sightline's ground
 * within 0.05 m of its line).
 *
 * WHICH SCALE. The kernel bends ground in the cells of its finest lattice octave, about 72 m on
 * its default world, so a frame at scale 1 puts a whole 80 m village in about one cell and the
 * statements crowd each other. Measured on those missions: at scale 8 (the village as 640 m of
 * plate) the worst pad or point missed by 3.9 cm, and every other mission by under 1.5 mm; at
 * scale 1 every list was still accepted and every solve converged, but a pad missed by up to
 * 9.9 cm and an arena's ground stood 5.6 cm over a sightline. Scale 8 is the frame to build a
 * playable mission on; scale 1 is the default only because it is the identity. A frame below
 * PLAYABLE_SCALE says so in `notes`, with those measured misses, so a caller that keeps the
 * default is told rather than handed pads that miss by a hand's breadth in silence.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME: LEVEL METRES ON A PLATE
 * ---------------------------------------------------------------------------
 * A level is authored in level metres about its own centre. The frame places it on a kernel plate:
 *
 *     plate = (originX, originZ) + R(rotation) · (scale · level)
 *
 * with R the rotation by `rotation` radians in the ground plane (+x east, +z south, as both
 * engines draw it) and `scale` plate metres per level metre in EVERY direction — a similarity,
 * so a slope is a slope on both sides of it and a body's `maxSlope` needs no rescaling. `h` is the
 * height, in plate metres, the mission's floor stands at, and `size` the plate's edge (the
 * kernel's default world, src/kernel/presets.js, when absent). Plate coordinates are rounded to the
 * centimetre: a frame with rotation goes through Math.cos and Math.sin, which the standard lets
 * two engines round differently in the last bit, and a list that differed by 1e-16 m between a
 * browser and Node would carry two different terrain parameter hashes for one mission.
 *
 * ONE FLOOR HEIGHT, ON PURPOSE. Every pad and point stands at `frame.h`. Pads are discs of at
 * least 48 m radius on the plate (the kernel refuses a smaller one: its ring would be its own
 * slope rows), and the sites of an 80 m village sit within 30 m of its centre, so at scale 1 the
 * pads overlap
 * — and two overlapping flats at different heights are a contradiction no ground can meet. At one
 * height every statement here is satisfiable by the same floor, which is what lets the
 * integration test demand that ALL of them hold rather than most. A caller that wants the
 * seed's own ground under the mission (the least bending) passes `h` = the unconditioned
 * sampler's height at the origin, which is what the test does.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH STEP ASKS FOR
 * ---------------------------------------------------------------------------
 *   (spawn)                       a pad: the player starts on level ground.
 *   activate, override            a pad per station (count, at most 4, as compileBlueprint
 *                                 counts interaction locations), each with a corridor from spawn.
 *   waves, eliminate, boss,       one ARENA pad, larger, and RAY sightlines from three cover
 *   survive                       positions on a ring outside it to its centre: the ground
 *                                 between stays under the line from a standing eye to the floor.
 *   reach, barricade              a point per site (barricade: count, at most 4), each with a
 *                                 corridor from spawn.
 *   collect                       a point per drop (count, at most 4: the lane, not every drop)
 *                                 and ONE corridor from spawn through them in order — a lane.
 *   extract                       a corridor from the last site the mission stood at back to
 *                                 spawn: the way out has to be walkable too.
 *
 * Corridors hold `maxGrade` = traversal.maxSlope × GRADE_SHARE between neighbouring samples. The
 * kernel bounds the grade over its 32 m sample step (condition.js CORRIDOR_STEP), not the ground's
 * every bump, and measured there a road held to 0.06 still had 4 m steps as steep as 0.26; a
 * quarter of what the body can stand on leaves that factor in hand. Measured on the template
 * missions (the integration test prints it): the steepest slope a body meets anywhere along any
 * corridor, read every eighth of a sample step with the kernel's slopeAt, is 0.116 at scale 8,
 * against the default body's maxSlope of 0.85.
 *
 * ---------------------------------------------------------------------------
 * WHERE A STEP IS, WHEN IT DOES NOT SAY
 * ---------------------------------------------------------------------------
 * A compiled step carries no position (its x and y are where its node sits on the studio's
 * board). A step MAY carry `at: [x, z]` or `sites: [[x, z], …]` in level metres, and those are
 * used as given. Otherwise each site is drawn from the kernel's seed algebra
 * (src/kernel/core/seedpath.js), in its default v2 mode (sfc32 seeded from a 64-bit path hash), from
 * one stream per site whose path is
 *
 *     <seed>/games3d/mission/<step id>/site:<k>          k = 0, 1, …
 *
 * and a combat step's cover ring takes its turn from
 *
 *     <seed>/games3d/mission/<step id>/cover
 *
 * `<seed>` is `options.seed` (the project's seed, normally) or the verbatim root "visigames" when
 * none is given. Keyed by the step's id rather than its index, so inserting a step before it does
 * not move it. A site stream draws (x, z) pairs uniform on the square of half-width PLACE_RADIUS
 * and keeps the first that lies inside the disc of that radius about the level's centre and at
 * least MIN_SEPARATION from every site already placed — no trigonometry, so every runtime draws
 * the same site — or, after PLACE_TRIES pairs, the in-disc candidate farthest from the rest.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET
 * ---------------------------------------------------------------------------
 * The kernel reads at most MAX_INTENT records and solves at most MAX_ROWS rows, and a list past
 * either is a list intentErrors refuses. Records are kept in tiers — every pad and point first, in
 * mission order, then the corridors, then the sightlines — so a mission too big for the budget
 * loses its sightlines before its roads and its roads before any place it has to stand. Every
 * record left out, for the budget or for reaching off the plate, is named in `notes`.
 *
 * Pure: no three, no DOM, no clock, no Math.random. The same inputs give the same list.
 */
import { MAX_INTENT, MAX_ROWS, FLAT_RING, normalizeIntent, rowsFor, intentErrors } from '../kernel/terrain/condition.js';
import { seedPath, streamFor } from '../kernel/core/seedpath.js';
import { DEFAULT_PARAMS } from '../kernel/presets.js';
import { TRAVERSAL_DEFAULTS } from './buildSpec.js';

/** Bump when a change makes the same mission state different ground. */
export const MISSION_INTENT_VERSION = 1;
/**
 * The smallest frame scale at which the integration test holds every statement to 0.05 m
 * (tools/test/test-mission-intent.mjs, every genre's template mission on two seeds). Below it,
 * compileMissionIntent adds a note; it does not refuse, because the list is still one the kernel
 * accepts and converges on.
 */
export const PLAYABLE_SCALE = 8;
/** The kernel's floor on a pad's radius (condition.js MIN_FLAT_R = 2 × GRADIENT_STEP), plate metres. */
export const PAD_RADIUS = 48;
/**
 * An arena's pad, plate metres: half again a station's. Both grow with the frame's scale past
 * these floors — a station's pad to 6 level metres, an arena's to 15 — so a level scaled up keeps
 * its fights and its stations the size they were authored at.
 */
export const ARENA_RADIUS = 72;
/** Where cover stands, as a multiple of the arena's radius: outside the floor it looks onto. */
export const COVER_RING = 1.6;
/**
 * Cover positions per combat step: alternate points of the kernel's six-point ring (condition.js
 * FLAT_RING, a table rather than Math.cos, so every runtime puts cover in the same place).
 */
export const COVER_RAYS = 3;
/** A standing eye above the floor, metres: the ray's eye at cover. */
export const EYE_HEIGHT = 1.6;
/** Corridor grade as a share of what the body can stand on (see the header). */
export const GRADE_SHARE = 0.25;
/** Sites per multi-site step, as compileBlueprint counts interaction locations. */
export const MAX_SITES = 4;
/**
 * The disc sites are drawn in, level metres about the level's centre. The genre levels' authored
 * sites (src/world/genreContent.js) lie within 28.8 m of it; the village square is 80 m across.
 */
export const PLACE_RADIUS = 30;
/** How far apart two drawn sites must be, level metres, when the stream allows it. */
export const MIN_SEPARATION = 10;
export const PLACE_TRIES = 16;
/** The mission floor's height when the frame does not say, plate metres: above the shelf. */
export const DEFAULT_FLOOR = 40;
/** The seed-path root when the caller gives no seed. Verbatim, not seed-shaped. */
export const DEFAULT_ROOT = 'visigames';

const COMBAT = new Set(['waves', 'eliminate', 'boss', 'survive']);
const STATION = new Set(['activate', 'override']);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const cm = v => Math.round(v * 100) / 100;

/** The frame with its defaults, and the map from level metres onto the plate. */
export function resolveFrame(frame = {}) {
  const f = {
    originX: finite(frame.originX) ? frame.originX : 0,
    originZ: finite(frame.originZ) ? frame.originZ : 0,
    rotation: finite(frame.rotation) ? frame.rotation : 0,
    scale: finite(frame.scale) && frame.scale > 0 ? frame.scale : 1,
    h: finite(frame.h) ? frame.h : DEFAULT_FLOOR,
    size: finite(frame.size) && frame.size > 0 ? frame.size : DEFAULT_PARAMS.terrain.size,
  };
  // Rotation 0 never reaches the trigonometry: the common frame is exact in every runtime.
  const c = f.rotation ? Math.cos(f.rotation) : 1, s = f.rotation ? Math.sin(f.rotation) : 0;
  f.toPlate = (x, z) => {
    const dx = x * f.scale, dz = z * f.scale;
    return [cm(f.originX + dx * c - dz * s), cm(f.originZ + dx * s + dz * c)];
  };
  return f;
}

/** A level-metre position off a step, or null: `[x, z]` or `{ x, z }`. */
function readPoint(p) {
  if (Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])) return [p[0], p[1]];
  if (p && typeof p === 'object' && finite(p.x) && finite(p.z)) return [p.x, p.z];
  return null;
}

/**
 * Draw one site from its own stream (the header's placement rule). `taken` are the level-metre
 * sites already placed, spawn included.
 */
function drawSite(path, taken) {
  const next = streamFor(path);
  let best = null, bestGap = -1;
  for (let i = 0; i < PLACE_TRIES; i++) {
    const x = (next() * 2 - 1) * PLACE_RADIUS, z = (next() * 2 - 1) * PLACE_RADIUS;
    if (x * x + z * z > PLACE_RADIUS * PLACE_RADIUS) continue;
    let gap = Infinity;
    for (const [tx, tz] of taken) gap = Math.min(gap, Math.sqrt((x - tx) ** 2 + (z - tz) ** 2));
    if (gap >= MIN_SEPARATION) return [cm(x), cm(z)];
    if (gap > bestGap) { best = [cm(x), cm(z)]; bestGap = gap; }
  }
  // A pair misses the disc with probability 1 − π/4 ≈ 0.215, so sixteen misses in a row is ≈ 2e-11.
  return best ?? [0, 0];
}

/** How many sites a step stands at. */
function siteCount(step) {
  const n = Math.max(1, Math.round(finite(step.count) ? step.count : 1));
  if (STATION.has(step.objective) || step.objective === 'barricade' || step.objective === 'collect') return Math.min(n, MAX_SITES);
  return 1;
}

/**
 * The kernel intent a compiled mission asks of its ground.
 *
 * @param {{mission: object[]}} compiled  compileBlueprint's output (only `mission` is read: each
 *   step's `id`, `objective`, `count`, and optional `at` / `sites` in level metres)
 * @param {object} [o]
 * @param {{originX?: number, originZ?: number, rotation?: number, scale?: number, h?: number, size?: number}} [o.frame]
 *   where the level sits on the plate (header); rotation 0, scale 1, h 40 m, size 4096 m by default
 * @param {{maxSlope?: number}} [o.traversal]  the body (buildSpec.js TRAVERSAL_DEFAULTS when absent)
 * @param {{x: number, z: number}|number[]} [o.spawn]  the player's start, level metres; the centre by default
 * @param {string} [o.seed]  the seed-path root sites are drawn under (header); "visigames" by default
 * @returns {{
 *   version: number,
 *   intent: object[],           kernel records, ready for params.terrain.intent
 *   sources: {step: string|null, objective: string, role: string}[],   one per record, what asked for it
 *   sites: {step: string, objective: string, k: number, level: number[], plate: number[], placed: 'given'|'seedpath', path?: string}[],
 *   rows: number,               the rows the list states (condition.js rowsFor), at most MAX_ROWS
 *   maxGrade: number, floor: number, frame: object,
 *   notes: string[]             every record left out, and why
 * }}
 * @throws when `seed` or a step id that has to name a stream is not a name the seed-path grammar
 *   accepts (src/kernel/core/seedpath.js): a "/" or ":" in it, a space, an invisible character.
 *   compileBlueprint's ids (letters, digits, "-" and "_") always are.
 */
export function compileMissionIntent(compiled, { frame, traversal, spawn, seed } = {}) {
  const mission = Array.isArray(compiled?.mission) ? compiled.mission : [];
  const F = resolveFrame(frame);
  const maxSlope = finite(traversal?.maxSlope) ? traversal.maxSlope : TRAVERSAL_DEFAULTS.maxSlope;
  const maxGrade = maxSlope * GRADE_SHARE;
  const root = typeof seed === 'string' && seed ? seed : DEFAULT_ROOT;
  const H = F.h, notes = [], sites = [];
  if (F.scale < PLAYABLE_SCALE) {
    notes.push(`frame scale ${F.scale} < ${PLAYABLE_SCALE} (PLAYABLE_SCALE): the level's statements share the kernel's ` +
      `finest lattice cells (about 72 m on its default world), so expect pads and points to miss by up to about 0.1 m ` +
      `and an arena's ground to stand a few cm over a sightline (measured at scale 1: 9.9 cm and 5.6 cm)`);
  }
  const padR = Math.max(PAD_RADIUS, cm(6 * F.scale)), arenaR = Math.max(ARENA_RADIUS, cm(15 * F.scale));

  const spawnLevel = readPoint(spawn) ?? [0, 0];
  const spawnPlate = F.toPlate(...spawnLevel);
  const taken = [spawnLevel];
  // [tier, record, source]: tier 0 places to stand, 1 corridors, 2 sightlines.
  const out = [[0, { type: 'pad', x: spawnPlate[0], z: spawnPlate[1], r: padR, h: H }, { step: null, objective: 'spawn', role: 'pad' }]];
  const corridors = new Set();
  const corridor = (points, src) => {
    const key = [points.map(p => p.join(',')).join(';'), [...points].reverse().map(p => p.join(',')).join(';')].sort()[0];
    if (corridors.has(key)) { notes.push(`${label(src)}: corridor ${pts(points)} already stated by an earlier step, not repeated`); return; }
    corridors.add(key);
    out.push([1, { type: 'corridor', points, maxGrade }, { ...src, role: 'corridor' }]);
  };
  let last = null; // the plate position the mission last stood at, for extract

  mission.forEach((step, i) => {
    const id = typeof step?.id === 'string' && step.id ? step.id : `step${i}`;
    const objective = step?.objective;
    const src = { step: id, objective };
    if (objective === 'extract') {
      if (!last) { notes.push(`${label(src)}: nothing before it to return from, so no corridor`); return; }
      corridor([last, spawnPlate], src);
      return;
    }
    const n = siteCount(step);
    const given = Array.isArray(step?.sites) ? step.sites.map(readPoint).filter(Boolean) : [];
    const at = readPoint(step?.at);
    if (at) given.unshift(at);
    const here = [];
    for (let k = 0; k < n; k++) {
      let level = given[k] ?? null, placed = 'given', path = null;
      if (!level) {
        path = seedPath(root, 'games3d', 'mission', id, `site:${k}`);
        level = drawSite(path, taken);
        placed = 'seedpath';
      }
      taken.push(level);
      const plate = F.toPlate(...level);
      sites.push({ step: id, objective, k, level, plate, placed, ...(path ? { path } : {}) });
      here.push(plate);
    }
    if (STATION.has(objective)) {
      for (const p of here) {
        out.push([0, { type: 'pad', x: p[0], z: p[1], r: padR, h: H }, { ...src, role: 'pad' }]);
        corridor([spawnPlate, p], src);
      }
    } else if (COMBAT.has(objective)) {
      const [cx, cz] = here[0];
      out.push([0, { type: 'pad', x: cx, z: cz, r: arenaR, h: H }, { ...src, role: 'arena' }]);
      const turn = Math.floor(streamFor(seedPath(root, 'games3d', 'mission', id, 'cover'))() * 2);
      for (let j = 0; j < COVER_RAYS; j++) {
        const [u, v] = FLAT_RING[(2 * j + turn) % 6], rho = arenaR * COVER_RING;
        out.push([2, { type: 'ray', eye: [cm(cx + rho * u), cm(H + EYE_HEIGHT), cm(cz + rho * v)], at: [cx, cz], h: H },
          { ...src, role: 'sightline' }]);
      }
    } else if (objective === 'collect') {
      for (const p of here) out.push([0, { type: 'point', x: p[0], z: p[1], h: H }, { ...src, role: 'point' }]);
      corridor([spawnPlate, ...here], src);
    } else if (objective === 'reach' || objective === 'barricade') {
      for (const p of here) {
        out.push([0, { type: 'point', x: p[0], z: p[1], h: H }, { ...src, role: 'point' }]);
        corridor([spawnPlate, p], src);
      }
    } else {
      notes.push(`${label(src)}: not an objective this compiler knows, so it asks nothing of the ground`);
      return;
    }
    last = here[here.length - 1];
  });

  // The budget, tier by tier (header). A stable sort: mission order within a tier.
  const ordered = out.map((e, i) => [...e, i]).sort((a, b) => a[0] - b[0] || a[3] - b[3]);
  const intent = [], sources = [];
  let rows = 0;
  for (const [, rec, src] of ordered) {
    const why = intentErrors([rec], { size: F.size });
    if (why.length) { notes.push(`${label(src)}: ${src.role} left out — ${why[0].replace(/^terrain\.intent\[0\]/, 'it')}`); continue; }
    const r = rowsFor(normalizeIntent([rec])[0]);
    if (intent.length >= MAX_INTENT) { notes.push(`${label(src)}: ${src.role} left out — the kernel reads at most ${MAX_INTENT} records (MAX_INTENT)`); continue; }
    if (rows + r > MAX_ROWS) { notes.push(`${label(src)}: ${src.role} left out — its ${r} rows would carry the list past ${MAX_ROWS} (MAX_ROWS)`); continue; }
    intent.push(rec); sources.push(src); rows += r;
  }
  const { toPlate: _map, ...frameOut } = F;
  return { version: MISSION_INTENT_VERSION, intent, sources, sites, rows, maxGrade, floor: H, frame: frameOut, notes };
}

const label = src => src.step ? `step "${src.step}" (${src.objective})` : src.objective;
const pts = points => points.map(([x, z]) => `(${x}, ${z})`).join(' → ');
