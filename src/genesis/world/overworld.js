/* overworld.js — ONE SEED IN 2D: a world's ground, drawn as a top-down
 * adventure level the 2D builder (apps/builder2d) opens and plays.
 *
 * The 3D world and the level are two readings of ONE ground: the canonical
 * bake (engine/terrain/ground.js — the 513² field, eroded, flooded, drained)
 * that the editor stands on, the certificate vouches for and terrain-reach
 * walks. Nothing here generates terrain. It reads that field through a
 * window, one tile per square of it, and says what each square is:
 *
 *   water   most of the square is sea-connected (the wet mask, not "below the
 *           line": a dry hollow is ground, as everywhere else) → POND, or a
 *           WALL where the mean depth is past DEEP_WATER — open sea framed as
 *           the edge of the map rather than a pond nobody can see across
 *   steep   most of the square is ground the body in controller.js cannot
 *           stand on (terrain-reach walkableCells: past maxSlope) → WALL
 *   flat    walkable, mean grade at most FLAT_GRADE → PATH
 *   gentle  walkable and steeper than that → TALL GRASS
 *
 * The start and the goal go on the LARGEST REACHABLE REGION — the biggest
 * stretch of ground a walker can cross on foot (terrain-reach terrainRegions,
 * the same step rule reachTerrain floods with) — and the window is centred
 * on it. The start is the region's tile nearest the region's centre; the goal
 * is the region's tile furthest from the start by the LEVEL's own walk (a
 * 4-connected flood over path and tall grass, which is how the builder's
 * analyser floods a top-down level, apps/builder2d/builder/core/analyze.js
 * topReach), so the goal is reachable in 2D by construction. Both are also on
 * the 3D region, so the 3D route between them always exists; it is priced by
 * terrain-reach parRoute and its par is carried in the report, and honey
 * drops are strewn along it (on tiles the level can reach) so the level says
 * which way the walk on the 3D ground goes.
 *
 * What the projection is NOT: a scale model. A 48 × 32 level over a region
 * kilometres across is tens of metres a tile (85.5 m on the committed K7QN
 * level, apps/builder2d/tools/test/fixtures/overworld-K7QN.json), so a cliff narrower than a tile
 * can vanish into tall grass and a one-tile isthmus can close. The guarantee
 * is the one that matters for a level — its start and goal are joined in 2D
 * and in 3D — and `report` says how coarse the reading was (tileMetres).
 *
 *     projectOverworld(worldDoc, { width, height, res }) -> { project, report }
 *     serializeOverworld(project)                        -> text
 *
 * `project` is a visigame.builder v1 document (apps/builder2d/builder/core/
 * format.js), terrain and decor run-length encoded with the builder's own
 * encoder, ids deterministic. The tile codes are read from the builder's own
 * catalogue by name, so a renumbering there (which its header forbids) would
 * fail here rather than paint the wrong tiles.
 *
 * Deterministic: the same world file gives the same level, byte for byte.
 * No DOM, no three.js, no randomness.
 */

import { groundBundle } from "../../kernel/terrain/ground.js";
import { CORRIDOR_GRADE } from "../../kernel/terrain/condition.js";
import { terrainRegions, parRoute } from "../../kernel/core/terrain-reach.js";
import { CONTROLLER } from "../../kernel/core/controller.js";
import { hex } from "../../kernel/terrain/fingerprint.js";
import { validateWorldFile, paramsFromWorldFile } from "./worldfile.js";
import { bakeGrid } from "./author.js";
import { tileById, genreById } from "../../play2d/core/catalog.js";
import { rleEncode } from "../../play2d/core/grid.js";

export const OVERWORLD_GENRE = "adventure";
export const OVERWORLD_SIZE = Object.freeze({ width: 48, height: 32 });
/* Ground a road could run on (condition.js CORRIDOR_GRADE, rise over run,
   about 7°) is PATH; steeper walkable ground is TALL GRASS. */
export const FLAT_GRADE = CORRIDOR_GRADE;
/* Past this mean depth, metres, a water tile is a WALL. A judgement about
   reading, not a fact about the body: the body wades 0.9 m (controller.js)
   and swims anything deeper, so by the body every water tile is the same
   obstacle; this keeps a band of pond along the shore and frames the open
   sea as the edge of the map. The plate's sea floor falls away fast: tiling
   the default world 48 × 48, 493 tiles are water and the mean depth of 1 is
   under 16 m, 38 under 32 m and 134 under 64 m — so 8 m painted no pond at
   all, and 32 m paints the shore. */
export const DEEP_WATER = 32;
/* How many honey drops the route may carry, at most. */
export const ROUTE_DROPS = 6;

const code = (id) => {
  const t = tileById(id);
  if (!t || !t.genres.includes(OVERWORLD_GENRE)) throw new Error(`overworld: the builder's catalogue has no ${OVERWORLD_GENRE} tile "${id}"`);
  return t.code;
};
export const TILE = Object.freeze({ wall: code("wall"), path: code("path"), pond: code("pond"), tallgrass: code("tallgrass") });
const WALK = new Set([TILE.path, TILE.tallgrass]);

/* The builder's three biomes, read off the world's own. */
const BIOME = { tundra: "snow", alpine: "snow", badlands: "desert", atoll: "desert", shoreland: "meadow" };
const timeOf = (hour) => (!Number.isFinite(hour) ? "day" : hour < 6 || hour >= 20 ? "night" : hour < 8 || hour >= 17 ? "golden" : "day");

/**
 * Project a world file's canonical ground onto a top-down adventure level.
 *
 * @param {object} doc              a world file (js/worldfile.js)
 * @param {object} [opts]
 * @param {number} [opts.width]     tiles across (the adventure genre's bounds)
 * @param {number} [opts.height]    tiles down
 * @param {number|null} [opts.res]  the grid to bake (default the file's
 *                                  ground block's, else CANONICAL_RES;
 *                                  refused outside 2–MAX_VERIFY_RES, as
 *                                  explainWorld refuses it — js/author.js
 *                                  bakeGrid)
 * @returns {{ project: object, report: object }}
 */
export function projectOverworld(doc, { width = OVERWORLD_SIZE.width, height = OVERWORLD_SIZE.height, res = null } = {}) {
  const errors = validateWorldFile(doc);
  if (errors.length) throw new TypeError(`not a valid world file — ${errors.join("; ")}`);
  const g = genreById(OVERWORLD_GENRE);
  for (const [k, v, lo, hi] of [["width", width, g.minSize.width, g.maxSize.width], ["height", height, g.minSize.height, g.maxSize.height]]) {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`overworld: ${k} ${v} is not a whole number of tiles from ${lo} to ${hi}`);
  }
  const grid = bakeGrid(doc, res, "overworld");
  const params = paramsFromWorldFile(doc);
  const b = groundBundle(params, { res: grid });
  /* The file's receipt says which ground it stands on. A level drawn from a
     different bake would be a level of some other world. */
  if (doc.ground && (doc.ground.res !== grid || doc.ground.heightHash !== b.manifest.heightHash)) {
    throw new Error(`overworld: the file's ground block (${doc.ground.res}², ${hex(doc.ground.heightHash)}) is not the ground its params bake at ${grid}² (${hex(b.manifest.heightHash)})`);
  }
  const { field, wet } = b;
  const level = b.manifest.waterLevel;
  const N = field.res, size = field.size, step = size / (N - 1);
  const regions = terrainRegions(field, { level, wet });
  if (regions.largest < 0) throw new Error("overworld: this world has no ground a walker can stand on");
  const L = regions.largest, labels = regions.labels;

  // ── the window: the region's bounding box, at the level's aspect ──
  let i0 = N, i1 = -1, j0 = N, j1 = -1, sx = 0, sz = 0, count = 0;
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] !== L) continue;
    const i = p % N, j = (p - i) / N;
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
    sx += i; sz += j; count++;
  }
  /* Lattice cell i covers [i, i + 1) of the window's coordinate, so lattice
     point i (world x = (i / (N − 1) − ½)·size) sits at i + ½ in it. Cells per
     tile: the box with a tile of margin on every side, never finer than one
     lattice cell, never wider than the lattice. */
  let c = Math.max((i1 - i0 + 1) / Math.max(1, width - 2), (j1 - j0 + 1) / Math.max(1, height - 2), 1);
  c = Math.min(c, N / width, N / height);
  const fit = (lo, hi, span) => {
    let a = (lo + hi + 1) / 2 - span / 2;
    if (a < 0) a = 0;
    if (a + span > N) a = N - span;
    return a;
  };
  const ox = fit(i0, i1, width * c), oz = fit(j0, j1, height * c);

  // ── what each tile is ──
  const grade = (i, j) => {
    const im = i > 0 ? i - 1 : i, ip = i < N - 1 ? i + 1 : i, jm = j > 0 ? j - 1 : j, jp = j < N - 1 ? j + 1 : j;
    const d = field.data;
    const gx = (d[j * N + ip] - d[j * N + im]) / ((ip - im) * step), gz = (d[jp * N + i] - d[jm * N + i]) / ((jp - jm) * step);
    return Math.sqrt(gx * gx + gz * gz);
  };
  const W = width, H = height, T = new Uint16Array(W * H);
  const centre = new Int32Array(W * H); // the lattice cell under each tile's centre
  const counts = { path: 0, tallgrass: 0, pond: 0, wall: 0 };
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const a0 = Math.floor(ox + tx * c), a1 = Math.max(a0 + 1, Math.ceil(ox + (tx + 1) * c));
      const b0 = Math.floor(oz + ty * c), b1 = Math.max(b0 + 1, Math.ceil(oz + (ty + 1) * c));
      let n = 0, wetN = 0, depth = 0, walkN = 0, gsum = 0;
      for (let j = b0; j < b1 && j < N; j++) {
        for (let i = a0; i < a1 && i < N; i++) {
          const p = j * N + i;
          n++;
          if (wet[p]) { wetN++; depth += level - field.data[p]; }
          else if (regions.walkable[p]) { walkN++; gsum += grade(i, j); }
        }
      }
      let t;
      if (wetN * 2 >= n) t = depth / wetN > DEEP_WATER ? "wall" : "pond";
      else if (walkN * 2 < n) t = "wall";
      else t = gsum / walkN <= FLAT_GRADE ? "path" : "tallgrass";
      T[ty * W + tx] = TILE[t];
      counts[t]++;
      const ci = Math.min(N - 1, Math.floor(ox + (tx + 0.5) * c)), cj = Math.min(N - 1, Math.floor(oz + (ty + 0.5) * c));
      centre[ty * W + tx] = cj * N + ci;
    }
  }

  // ── start and goal ──
  const onRegion = (k) => WALK.has(T[k]) && labels[centre[k]] === L;
  const worldOfCell = (p) => { const i = p % N, j = (p - i) / N; return [(i / (N - 1) - 0.5) * size, (j / (N - 1) - 0.5) * size]; };
  // The region's centre, in tile coordinates.
  const cx = (sx / count + 0.5 - ox) / c - 0.5, cz = (sz / count + 0.5 - oz) / c - 0.5;
  let start = -1, best = Infinity;
  for (let k = 0; k < W * H; k++) {
    if (!onRegion(k)) continue;
    const x = k % W, y = (k - x) / W, d = (x - cx) * (x - cx) + (y - cz) * (y - cz);
    if (d < best) { best = d; start = k; }
  }
  if (start < 0) throw new Error(`overworld: no ${W}×${H} tile of the largest region is walkable at this scale — try a larger --size`);
  const dist = flood4(T, W, H, start);
  let goal = -1, far = 0;
  for (let k = 0; k < W * H; k++) if (k !== start && onRegion(k) && dist[k] > far) { far = dist[k]; goal = k; }
  if (goal < 0) throw new Error("overworld: the largest region reads as a single tile at this scale — try a larger --size");

  /* The 3D route between the two, on the field. Both centre cells are in the
     largest region, so it exists; the points are the cells' own positions, so
     neither is snapped anywhere else. */
  const from = worldOfCell(centre[start]), to = worldOfCell(centre[goal]);
  const route = parRoute(field, from, to, { level, wet });
  if (route.verdict === "error") throw new Error(`overworld: no 3D route between the start and the goal (${route.issues[0]?.message})`);

  // Honey drops along the 3D route, on tiles the level reaches.
  const coins = [];
  const used = new Set([start, goal]);
  const path = route.path;
  const lens = [0];
  for (let k = 1; k < path.length; k++) lens.push(lens[k - 1] + Math.sqrt((path[k][0] - path[k - 1][0]) ** 2 + (path[k][1] - path[k - 1][1]) ** 2));
  const total = lens[lens.length - 1];
  for (let m = 1; m <= ROUTE_DROPS && total > 0; m++) {
    const s = (total * m) / (ROUTE_DROPS + 1);
    let k = 1;
    while (k < path.length - 1 && lens[k] < s) k++;
    const u = lens[k] > lens[k - 1] ? (s - lens[k - 1]) / (lens[k] - lens[k - 1]) : 0;
    const x = path[k - 1][0] + (path[k][0] - path[k - 1][0]) * u, z = path[k - 1][1] + (path[k][1] - path[k - 1][1]) * u;
    const tx = Math.floor(((x / size + 0.5) * (N - 1) - ox + 0.5) / c), ty = Math.floor(((z / size + 0.5) * (N - 1) - oz + 0.5) / c);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const t = ty * W + tx;
    if (used.has(t) || dist[t] < 0) continue;
    used.add(t);
    coins.push(t);
  }

  // ── the document ──
  const seed = String(params.seed);
  const tag = seed.replace(/[^\w-]/g, "").slice(0, 28) || "world";
  const ent = (id, type, k) => ({ id, type, x: k % W, y: (k - (k % W)) / W, props: {} });
  const entities = [ent("start", "player", start), ent("goal", "goal", goal), ...coins.map((k, n) => ent(`drop${n + 1}`, "coin", k))];
  const tileMetres = c * step;
  const project = {
    kind: "visigame.builder", version: 1,
    id: `ow-${tag}`,
    title: `${doc.origin ? doc.origin[0].toUpperCase() + doc.origin.slice(1) : "Overworld"} ${seed}`.slice(0, 48),
    studio: "Visigenesis",
    description: `The ground of world ${seed}, read top-down: ${tileMetres.toFixed(1)} m a tile.`.slice(0, 200),
    accent: "#ff9f45",
    genre: OVERWORLD_GENRE,
    template: null,
    settings: { lives: 3, hearts: 3, difficulty: "normal", music: true, sound: true },
    publish: { adBreaks: false, rewardedContinue: false, showCredits: true },
    levels: [{
      id: `l-${tag}`,
      name: "Overworld",
      width: W, height: H,
      biome: BIOME[params.biome] || "meadow",
      time: timeOf(params.sky?.timeOfDay),
      rules: { win: "goal", timeLimit: 0, survive: 60, par: 0, dark: false, slingshot: false },
      terrain: rleEncode(T),
      decor: rleEncode(new Uint16Array(W * H)),
      entities,
      links: [],
      notes: `Projected from world ${seed} (parameter hash ${hex(b.manifest.parameterHash)}, ground ${grid}² ${hex(b.manifest.heightHash)}) ` +
        `by js/overworld.js: ${tileMetres.toFixed(1)} m a tile, water deeper than ${DEEP_WATER} m and ground steeper than ${CONTROLLER.maxSlope} are wall, ` +
        `grade up to ${FLAT_GRADE} is path. The 3D route from the start to the goal is ${route.distance.toFixed(0)} m, par ${route.parSeconds.toFixed(1)} s.`,
    }],
  };
  const xy = (k) => ({ x: k % W, y: (k - (k % W)) / W });
  const report = {
    seed, width: W, height: H, res: grid, tileMetres,
    // The window's north-west corner in world metres, and its extent.
    window: { x: ((ox - 0.5) / (N - 1) - 0.5) * size, z: ((oz - 0.5) / (N - 1) - 0.5) * size, width: W * tileMetres, height: H * tileMetres },
    counts,
    region: { cells: regions.sizes[L], regions: regions.sizes.length, share: regions.sizes[L] / regions.walkableCount },
    start: { ...xy(start), world: from }, goal: { ...xy(goal), world: to },
    steps2d: far, drops: coins.length,
    route: { verdict: route.verdict, parSeconds: route.parSeconds, distance: route.distance, climb: route.climb, maxGrade: route.maxGrade },
  };
  return { project, report };
}

/** The bytes a projected level is saved as: one-space JSON and a newline,
    so a committed level (apps/builder2d/tools/test/fixtures) diffs by line
    and a re-projection can be compared with it byte for byte. */
export function serializeOverworld(project) {
  return JSON.stringify(project, null, 1) + "\n";
}

/* 4-connected steps from `start` over path and tall grass: −1 where the level
   cannot walk. The builder floods a top-down level the same way. */
function flood4(T, W, H, start) {
  const dist = new Int32Array(W * H).fill(-1);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  dist[start] = 0; q[tail++] = start;
  while (head < tail) {
    const k = q[head++], x = k % W, y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (dist[n] >= 0 || !WALK.has(T[n])) continue;
      dist[n] = dist[k] + 1; q[tail++] = n;
    }
  }
  return dist;
}
